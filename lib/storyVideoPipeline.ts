import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Caption } from "@remotion/captions";
import { getFfmpegExecutable } from "@/lib/binPaths";
import { VIDEO_FPS } from "@/lib/ffmpeg";
import { buildAssFromVoiceCaptions } from "@/lib/dummyCaptions";
import { planStoryWithGroq, type StoryLang } from "@/lib/groqStoryboard";
import {
  synthesizeStoryVoice,
  warmKokoroTts,
  preferEdgeTts,
  type VoiceGender,
} from "@/lib/kokoroTts";
import { alignVoiceCaptions } from "@/lib/alignVoiceCaptions";
import type { StoryPlan, StoryScene } from "@/lib/storyTypes";
import { getStoryRendererMode } from "@/lib/remotion/renderStory";
import {
  mapPipelineToInput,
  type BrollPoolItem,
} from "@/lib/remotion/mapPipelineToInput";
import {
  brollFfmpegInput,
  findBrollById,
  listBrollCatalog,
  REMOTE_BROLL,
  type BrollCatalogItem,
} from "@/lib/brollCatalog";
import { downloadToFile } from "@/lib/pexels";

export type StoryVideoLog = (msg: string) => void;

/** Vertical Shorts frame for story videos. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/**
 * Single final encode only (no intermediate H.264 passes).
 * Target ~20–25MB / 60s @ 1080x1920 / 30fps (≈2.7–3.3 Mbps).
 * Override with STORY_ENCODE_PRESET / STORY_ENCODE_CRF (Hobby: prefer veryfast).
 */
const ENCODE_PRESET =
  process.env.STORY_ENCODE_PRESET?.trim() || "ultrafast";
const ENCODE_CRF = process.env.STORY_ENCODE_CRF?.trim() || "29";
const ENCODE_MAXRATE = "3.5M";
const ENCODE_BUFSIZE = "7M";
const ENCODE_AUDIO_BITRATE = "64k";

/** Hard ceiling for finished story Shorts — always under 1 minute. */
export const MAX_SHORTS_DURATION_SEC = 59;

/**
 * Preferred whole-Short speed (B-roll + VO + captions).
 * Env STORY_SPEED used when UI doesn't pass a value.
 */
function resolveBasePlaybackSpeed(preferred?: number | null): number {
  if (preferred != null && Number.isFinite(preferred) && preferred >= 1 && preferred <= 2.5) {
    return preferred;
  }
  const raw = Number(process.env.STORY_SPEED ?? process.env.BROLL_SPEED);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 2.5) return raw;
  return 1.5;
}

/**
 * Speed so final duration ≤ MAX_SHORTS_DURATION_SEC while keeping full narration.
 * When autoFit is true (default), raises speed to fit ≤59s. Max 3.5×.
 */
function resolveShortsPlaybackSpeed(
  voiceSec: number,
  onLog?: StoryVideoLog,
  opts?: { preferredSpeed?: number | null; autoFit?: boolean }
): number {
  const envCap = Number(process.env.MAX_SHORTS_SEC);
  const maxSec = Math.min(
    59,
    Math.max(30, Number.isFinite(envCap) && envCap > 0 ? envCap : MAX_SHORTS_DURATION_SEC)
  );
  const autoFit = opts?.autoFit !== false;
  const base = resolveBasePlaybackSpeed(opts?.preferredSpeed);
  const voiceIn = Math.max(0.2, voiceSec);
  const atBase = voiceIn / base;

  if (!autoFit || atBase <= maxSec + 0.05) {
    onLog?.(
      `Shorts speed ${base.toFixed(2)}× → ~${atBase.toFixed(1)}s` +
        (autoFit ? ` (cap ${maxSec}s)` : " (auto-fit off)")
    );
    return base;
  }

  const needed = voiceIn / maxSec;
  const speed = Math.min(3.5, Math.max(base, needed));
  const outSec = voiceIn / speed;
  onLog?.(
    `Shorts auto-fit: ${base.toFixed(2)}× → ${speed.toFixed(2)}× so ${voiceIn.toFixed(1)}s VO → ~${outSec.toFixed(1)}s (≤${maxSec}s)`
  );
  if (outSec > maxSec + 0.25) {
    onLog?.(
      `Warning: even @ ${speed.toFixed(2)}× output ~${outSec.toFixed(1)}s may exceed ${maxSec}s cap`
    );
  }
  return speed;
}

/** Soft char budget so TTS+Whisper+encode stay under ~2 min wall clock and VO fits ≤59s. */
function narrationCharBudget(): number {
  const raw = Number(process.env.STORY_NARRATION_MAX_CHARS);
  if (Number.isFinite(raw) && raw >= 400 && raw <= 4000) return Math.floor(raw);
  return 1100;
}

/** Trim plan narration at a sentence boundary if the model overshot the Shorts budget. */
function clampNarrationForShort(
  text: string,
  onLog?: StoryVideoLog
): string {
  const maxChars = narrationCharBudget();
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;

  let cut = cleaned.slice(0, maxChars);
  const lastStop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf("। ")
  );
  if (lastStop >= Math.floor(maxChars * 0.55)) {
    cut = cut.slice(0, lastStop + 1).trim();
  } else {
    cut = cut.replace(/\s+\S*$/, "").trim();
  }
  onLog?.(
    `Narration clamped ${cleaned.length} → ${cut.length} chars (budget ${maxChars}) for ≤59s Short`
  );
  return cut || cleaned.slice(0, maxChars);
}

/** atempo only accepts 0.5–2.0 per filter; chain for safety. */
function atempoFilterChain(speed: number): string {
  const parts: string[] = [];
  let remaining = speed;
  while (remaining > 2.0 + 1e-6) {
    parts.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(",");
}

/** Scale Whisper caption timestamps so they stay locked after atempo speedup. */
function scaleCaptionsForSpeed(captions: Caption[], speed: number): Caption[] {
  if (speed === 1) return captions;
  return captions.map((c) => ({
    ...c,
    startMs: Math.round(c.startMs / speed),
    endMs: Math.max(
      Math.round(c.startMs / speed) + 30,
      Math.round(c.endMs / speed)
    ),
    timestampMs:
      typeof c.timestampMs === "number"
        ? Math.round(c.timestampMs / speed)
        : c.timestampMs,
  }));
}

/** Remote B-roll URLs (mirrors REMOTE_BROLL). */
export const DEFAULT_STORY_BROLL_URLS = REMOTE_BROLL.map((r) => r.src);

export type BuildStoryVideoOptions = {
  story: string;
  lang?: StoryLang;
  /** Absolute path from multipart upload */
  backgroundVideoPath?: string | null;
  /** Catalog id from listBrollCatalog() e.g. local:….mp4 or remote:… */
  brollId?: string | null;
  /** male | female — maps to Kokoro / Edge voice */
  voiceGender?: VoiceGender | null;
  /** Preferred playback speed (1–2.5). Auto-raised to fit ≤59s unless autoFitSpeed=false. */
  storySpeed?: number | null;
  /** When true (default), bump speed so output ≤ 0:59. */
  autoFitSpeed?: boolean;
  onLog?: StoryVideoLog;
};

type PreparedStoryAssets = {
  jobId: string;
  workDir: string;
  outDir: string;
  outPath: string;
  plan: StoryPlan;
  voicePath: string;
  voiceSec: number;
  captions: Caption[];
  poolMeta: BrollPoolItem[];
  sceneDurations: number[];
  usedUpload: boolean;
  poolLabel: string;
  lang: StoryLang;
  storySpeed: number | null;
  autoFitSpeed: boolean;
};

/** Resolve one B-roll source. Remotes are downloaded into workDir for reliable FFmpeg on CI. */
async function resolveBrollPool(
  options: BuildStoryVideoOptions,
  onLog: StoryVideoLog,
  workDir: string
): Promise<{ poolMeta: BrollPoolItem[]; usedUpload: boolean; poolLabel: string }> {
  const uploadPath = options.backgroundVideoPath?.trim() || "";
  if (uploadPath) {
    await fs.access(uploadPath);
    const dur = await probeDurationSec(uploadPath);
    const label = path.basename(uploadPath);
    onLog(`B-roll: uploaded file ${label} (${dur.toFixed(0)}s) — seek trim only`);
    return {
      usedUpload: true,
      poolLabel: label,
      poolMeta: [{ path: uploadPath, dur, label }],
    };
  }

  const catalog = await listBrollCatalog();
  const explicit = findBrollById(catalog, options.brollId);
  const autoPick = !explicit;

  // Auto mode: shuffle remotes so we can fall through if one URL fails.
  const candidates: BrollCatalogItem[] = explicit
    ? [explicit]
    : (() => {
        const remote = catalog.filter((c) => c.kind === "remote");
        const pool = remote.length > 0 ? remote : catalog;
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        return shuffled;
      })();

  if (candidates.length === 0) {
    throw new Error(
      "No B-roll available. Configure REMOTE_BROLL in lib/brollCatalog.ts (or set BROLL_INCLUDE_LOCAL=1)."
    );
  }

  if (explicit) {
    onLog(`B-roll: selected "${explicit.label}" (${explicit.kind})`);
  } else {
    onLog(
      `B-roll: auto mode — will try up to ${Math.min(candidates.length, 5)} catalog clip(s)`
    );
  }

  const localPath = path.join(workDir, "broll-remote.mp4");
  let lastErr: Error | null = null;
  const maxAutoTries = explicit ? 1 : Math.min(candidates.length, 5);

  for (let i = 0; i < maxAutoTries; i++) {
    const picked = candidates[i]!;
    if (autoPick) {
      onLog(`B-roll: trying "${picked.label}" (${picked.kind})…`);
    }

    try {
      let ffmpegSrc = brollFfmpegInput(picked);
      if (picked.kind === "remote" || /^https?:\/\//i.test(ffmpegSrc)) {
        onLog(`Downloading remote B-roll to temp (${picked.id})…`);
        await downloadToFile(ffmpegSrc, localPath, {
          timeoutMs: 120_000,
          retries: 3,
        });
        ffmpegSrc = localPath;
        onLog(`Remote B-roll saved locally for FFmpeg`);
      } else {
        onLog(`Seeking local file (no copy): ${picked.src}`);
      }

      const dur = await probeDurationSec(ffmpegSrc);
      onLog(
        `B-roll duration ${dur.toFixed(1)}s — FFmpeg will -ss / -t the needed window only`
      );

      return {
        usedUpload: false,
        poolLabel: picked.label,
        poolMeta: [{ path: ffmpegSrc, dur, label: picked.label }],
      };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      onLog(`B-roll download failed for "${picked.label}": ${lastErr.message}`);
      if (!autoPick || i === maxAutoTries - 1) break;
      onLog(`Trying another catalog clip…`);
    }
  }

  throw lastErr ?? new Error("Failed to download B-roll from catalog");
}

function escapePathForFilter(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function runFfmpeg(
  args: string[],
  onLog?: StoryVideoLog
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const ff = execFile(
      getFfmpegExecutable(),
      args,
      { maxBuffer: 80 * 1024 * 1024, windowsHide: true },
      (err, _stdout, e) => {
        const text = typeof e === "string" ? e : stderr;
        if (err) {
          const msg = text.trim() ? text.slice(-2500) : err.message;
          reject(new Error(`ffmpeg failed: ${msg}`));
          return;
        }
        resolve({ stderr: text });
      }
    );
    ff.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      const line = chunk.trim();
      if (line && onLog && /time=|error|Error/.test(line)) {
        onLog(line.slice(0, 200));
      }
    });
  });
}

function parseDurationFromProbe(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Last `bitrate:` from FFmpeg progress / summary (kbits/s). */
function parseBitrateKbps(stderr: string): number | null {
  const matches = [...stderr.matchAll(/bitrate=\s*([\d.]+)\s*kbits\/s/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]![1];
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

async function probeMedia(
  filePath: string
): Promise<{ durationSec: number; bitrateKbps: number | null; sizeBytes: number }> {
  const isRemote = /^https?:\/\//i.test(filePath);
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(
      getFfmpegExecutable(),
      ["-hide_banner", "-nostdin", "-i", filePath],
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, _o, e) => {
        const text = typeof e === "string" ? e : "";
        if (text) resolve(text);
        else reject(err ?? new Error("probe failed"));
      }
    );
  });
  const durationSec = parseDurationFromProbe(stderr);
  if (durationSec == null) {
    throw new Error(`No Duration for ${path.basename(filePath)}`);
  }
  let sizeBytes = 0;
  if (!isRemote) {
    try {
      sizeBytes = (await fs.stat(filePath)).size;
    } catch {
      sizeBytes = 0;
    }
  }
  const fromContainer = stderr.match(/bitrate:\s*([\d.]+)\s*kb\/s/i);
  const bitrateKbps = fromContainer
    ? Number(fromContainer[1])
    : durationSec > 0 && sizeBytes > 0
      ? (sizeBytes * 8) / durationSec / 1000
      : null;
  return {
    durationSec,
    bitrateKbps:
      bitrateKbps != null && Number.isFinite(bitrateKbps) ? bitrateKbps : null,
    sizeBytes,
  };
}

async function probeDurationSec(filePath: string): Promise<number> {
  const { durationSec } = await probeMedia(filePath);
  return durationSec;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function avgBitrateKbps(sizeBytes: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return (sizeBytes * 8) / durationSec / 1000;
}

const SCALE_CROP_9x16 = `scale=${STORY_WIDTH}:${STORY_HEIGHT}:force_original_aspect_ratio=increase,crop=${STORY_WIDTH}:${STORY_HEIGHT},format=yuv420p`;

function weightText(s: string): number {
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words > 0) return words;
  return Math.max(1, Math.ceil(s.replace(/\s+/g, "").length / 4));
}

/** Distribute VO duration across scenes by narration weight. */
function sceneDurationsForVoice(plan: StoryPlan, voiceSec: number): number[] {
  const weights = plan.scenes.map((sc) => weightText(sc.narration || "…"));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  let allocated = 0;
  return plan.scenes.map((_, i) => {
    const isLast = i === plan.scenes.length - 1;
    if (isLast) return Math.max(0.8, voiceSec - allocated);
    const d = Math.max(0.8, (weights[i]! / totalW) * voiceSec);
    allocated += d;
    return d;
  });
}

/**
 * One FFmpeg pass: trim + scale/crop + overall speed (video+audio) + ASS → story.mp4.
 * Speeds the whole Short (B-roll AND speech) so both feel fast and stay in sync.
 */
async function encodeStoryOnePass(args: {
  brollPath: string;
  brollDurSec: number;
  voicePath: string;
  assPath: string;
  outPath: string;
  workDir: string;
  voiceSec: number;
  playbackSpeed: number;
  onLog: StoryVideoLog;
}): Promise<number> {
  const {
    brollPath,
    brollDurSec,
    voicePath,
    assPath,
    outPath,
    workDir,
    voiceSec,
    playbackSpeed: speed,
    onLog,
  } = args;

  const voiceIn = Math.max(0.2, voiceSec);
  // Hard ceiling — finished Short always under 1:00.
  const outDur = Math.min(voiceIn / speed, MAX_SHORTS_DURATION_SEC);
  const sourceNeed = voiceIn;
  const canTrim = brollDurSec >= sourceNeed + 0.05;
  const startSec = canTrim ? Math.random() * (brollDurSec - sourceNeed) : 0;

  if (canTrim) {
    onLog(
      `One-pass encode: ${sourceNeed.toFixed(1)}s B-roll @ ${startSec.toFixed(1)}s + VO → ${speed}× overall → ${outDur.toFixed(1)}s Short`
    );
  } else {
    onLog(
      `One-pass encode: loop B-roll + VO → ${speed}× overall → ${outDur.toFixed(1)}s Short`
    );
  }

  // Remotes: stage only the needed window locally so the heavy filter pass isn't network-bound.
  let videoInput = brollPath;
  let useLoop = !canTrim;
  let trimStart = startSec;
  const isRemote = /^https?:\/\//i.test(brollPath);
  if (isRemote && canTrim) {
    const staged = path.join(workDir, "broll-stage.mp4");
    onLog(
      `Staging remote B-roll trim locally (${sourceNeed.toFixed(1)}s) for faster encode…`
    );
    try {
      await runFfmpeg(
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          startSec.toFixed(3),
          "-t",
          (sourceNeed + 0.35).toFixed(3),
          "-i",
          brollPath,
          "-an",
          "-c:v",
          "copy",
          staged,
        ],
        onLog
      );
      videoInput = staged;
      trimStart = 0;
      onLog("Remote B-roll staged (stream copy)");
    } catch (e) {
      onLog(
        `Stream-copy stage failed (${e instanceof Error ? e.message : String(e)}); trying ultrafast re-encode stage…`
      );
      await runFfmpeg(
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          startSec.toFixed(3),
          "-t",
          (sourceNeed + 0.35).toFixed(3),
          "-i",
          brollPath,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "28",
          "-pix_fmt",
          "yuv420p",
          staged,
        ],
        onLog
      );
      videoInput = staged;
      trimStart = 0;
      onLog("Remote B-roll staged (ultrafast re-encode)");
    }
  }

  onLog(
    `Encode BEFORE (source B-roll): dur=${brollDurSec.toFixed(1)}s (probed earlier)` +
      (isRemote ? ", remote→local staged" : "")
  );
  onLog(
    `Encode settings: preset=${ENCODE_PRESET} crf=${ENCODE_CRF} maxrate=${ENCODE_MAXRATE} ` +
      `bufsize=${ENCODE_BUFSIZE} aac=${ENCODE_AUDIO_BITRATE} storySpeed=${speed}× (B-roll+speech+captions)`
  );

  const filter = [
    `[0:v]${SCALE_CROP_9x16},setpts=PTS/${speed},fps=${VIDEO_FPS},ass='${escapePathForFilter(assPath)}'[vout]`,
    `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,${atempoFilterChain(speed)}[aout]`,
  ].join(";");

  const ffArgs: string[] = ["-y", "-hide_banner"];
  if (useLoop) {
    ffArgs.push("-stream_loop", "-1", "-i", videoInput);
  } else {
    ffArgs.push(
      "-ss",
      trimStart.toFixed(3),
      "-t",
      sourceNeed.toFixed(3),
      "-i",
      videoInput
    );
  }
  ffArgs.push(
    "-i",
    voicePath,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    ENCODE_PRESET,
    "-crf",
    ENCODE_CRF,
    "-maxrate",
    ENCODE_MAXRATE,
    "-bufsize",
    ENCODE_BUFSIZE,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(VIDEO_FPS),
    "-c:a",
    "aac",
    "-b:a",
    ENCODE_AUDIO_BITRATE,
    "-t",
    outDur.toFixed(3),
    "-movflags",
    "+faststart",
    outPath
  );

  const t0 = performance.now();
  const { stderr } = await runFfmpeg(ffArgs, onLog);
  const encodeMs = performance.now() - t0;

  const out = await probeMedia(outPath);
  const avgKbps = avgBitrateKbps(out.sizeBytes, out.durationSec || outDur);
  const progressKbps = parseBitrateKbps(stderr);

  onLog(
    `Encode AFTER (story.mp4): size=${formatMb(out.sizeBytes)}, ` +
      `dur=${out.durationSec.toFixed(1)}s, ` +
      `avgBitrate=${avgKbps.toFixed(0)} kbps` +
      (progressKbps != null ? ` (ffmpeg last=${progressKbps.toFixed(0)} kbps)` : "") +
      `, encodeTime=${(encodeMs / 1000).toFixed(1)}s`
  );

  const perMinMb =
    (out.sizeBytes / (1024 * 1024)) * (60 / Math.max(1, out.durationSec));
  onLog(
    `Size check: ~${perMinMb.toFixed(1)}MB per 60s (target 20–25MB); ` +
      `effective ${(avgKbps / 1000).toFixed(2)} Mbps`
  );

  return out.durationSec > 0.05 ? out.durationSec : outDur;
}

/**
 * Shared prep: B-roll resolve (seek-only), plan, TTS, Whisper captions.
 * Rendering (FFmpeg vs Remotion) happens after this.
 */
async function prepareStoryAssets(
  options: BuildStoryVideoOptions
): Promise<PreparedStoryAssets> {
  const { story, lang = "en", onLog = console.log, voiceGender } = options;
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "reeler-story", jobId);
  const outDir = path.join(process.cwd(), "public", "output", jobId);
  await Promise.all([
    fs.mkdir(workDir, { recursive: true }),
    fs.mkdir(outDir, { recursive: true }),
  ]);
  const outPath = path.join(outDir, "story.mp4");

  const storySpeed =
    options.storySpeed != null && Number.isFinite(options.storySpeed)
      ? Number(options.storySpeed)
      : null;
  const autoFitSpeed = options.autoFitSpeed !== false;

  onLog(
    `Planning + B-roll in parallel (${lang === "hi" ? "Hindi" : "English"})…`
  );
  const warmTts =
    lang === "en"
      ? warmKokoroTts().then(() => {
          onLog(
            preferEdgeTts()
              ? "TTS: Edge (serverless) — Kokoro skipped"
              : "Kokoro model warm (overlapped with plan/B-roll)"
          );
        })
      : Promise.resolve();

  const [broll, plan] = await Promise.all([
    resolveBrollPool(options, onLog, workDir),
    planStoryWithGroq(story, lang),
    warmTts,
  ]).then(([pool, p]) => {
    onLog(`Plan ready: "${p.title}" · ${p.scenes.length} scene(s)`);
    return [pool, p] as const;
  });

  const { poolMeta, usedUpload, poolLabel } = broll;

  plan.fullNarration = clampNarrationForShort(plan.fullNarration, onLog);
  plan.estimatedDuration = Math.min(
    MAX_SHORTS_DURATION_SEC,
    Math.max(20, Math.round(plan.fullNarration.length / 18))
  );

  const gender = voiceGender === "male" || voiceGender === "female" ? voiceGender : "female";
  onLog(
    lang === "hi"
      ? `Synthesizing Hindi voice-over (${gender})…`
      : preferEdgeTts()
        ? `Synthesizing English Edge voice-over (${gender})…`
        : `Synthesizing English voice-over (${gender}, Kokoro→Edge fallback)…`
  );
  const voice = await synthesizeStoryVoice(
    plan.fullNarration,
    path.join(workDir, "voice"),
    lang,
    onLog,
    { gender }
  );
  const voicePath = voice.path;
  const voiceSec =
    voice.durationSec > 0.05 ? voice.durationSec : await probeDurationSec(voicePath);
  onLog(`Voice duration: ${voiceSec.toFixed(2)}s (${voice.engine}/${voice.voice})`);

  const captions = await alignVoiceCaptions({
    voicePath,
    lang,
    narration: plan.fullNarration,
    durationSec: voiceSec,
    onLog,
  });

  const sceneDurations = sceneDurationsForVoice(plan, voiceSec);

  return {
    jobId,
    workDir,
    outDir,
    outPath,
    plan,
    voicePath,
    voiceSec,
    captions,
    poolMeta,
    sceneDurations,
    usedUpload,
    poolLabel,
    lang,
    storySpeed,
    autoFitSpeed,
  };
}

async function renderWithFfmpeg(
  prepared: PreparedStoryAssets,
  onLog: StoryVideoLog
): Promise<number> {
  const {
    workDir,
    outPath,
    voicePath,
    voiceSec,
    captions,
    poolMeta,
    poolLabel,
    lang,
  } = prepared;

  const speed = resolveShortsPlaybackSpeed(voiceSec, onLog, {
    preferredSpeed: prepared.storySpeed,
    autoFit: prepared.autoFitSpeed,
  });
  const timedCaptions = scaleCaptionsForSpeed(captions, speed);
  const assPath = path.join(workDir, "story.ass");
  await fs.writeFile(
    assPath,
    buildAssFromVoiceCaptions(timedCaptions, STORY_WIDTH, STORY_HEIGHT, {
      fontName: lang === "hi" ? "Nirmala UI" : "Arial Black",
      leadMs: 0,
      wordsPerLine: 3,
    }),
    "utf8"
  );

  const src = poolMeta[Math.floor(Math.random() * poolMeta.length)]!;
  const outEst = voiceSec / speed;
  onLog(
    `B-roll: ${poolLabel} — ${speed.toFixed(2)}× whole Short ← ${src.label} (VO ${voiceSec.toFixed(1)}s → ~${outEst.toFixed(1)}s, Shorts≤${MAX_SHORTS_DURATION_SEC}s)`
  );

  return encodeStoryOnePass({
    brollPath: src.path,
    brollDurSec: src.dur,
    voicePath,
    assPath,
    outPath,
    workDir,
    voiceSec,
    playbackSpeed: speed,
    onLog,
  });
}

async function renderWithRemotion(
  prepared: PreparedStoryAssets,
  onLog: StoryVideoLog
): Promise<number> {
  const { renderStoryShort } = await import("@/lib/remotion/renderStory");
  const { cleanupRemotionAssets } = await import(
    "@/lib/remotion/mapPipelineToInput"
  );
  const input = await mapPipelineToInput({
    jobId: prepared.jobId,
    outDir: prepared.outDir,
    plan: prepared.plan,
    voicePath: prepared.voicePath,
    voiceSec: prepared.voiceSec,
    captions: prepared.captions,
    poolMeta: prepared.poolMeta,
    sceneDurations: prepared.sceneDurations,
    lang: prepared.lang,
    onLog,
  });

  const sc = input.sceneSchedule[0];
  onLog(
    `B-roll: ${prepared.poolLabel} — Remotion captions-only (1 continuous clip` +
      (sc
        ? `, trim @ ${sc.clipStartSec.toFixed(1)}s, frames ${sc.startFrame}-${sc.endFrame}`
        : "") +
      `)`
  );

  try {
    const { durationInFrames } = await renderStoryShort({
      input,
      outPath: prepared.outPath,
      onLog,
    });
    return durationInFrames / (input.fps || 30);
  } finally {
    // Drop staging media; keep story.mp4 only
    await cleanupRemotionAssets(prepared.outDir);
  }
}

/**
 * Story → Groq plan → B-roll → VO → Whisper → FFmpeg (default) or Remotion 9:16 MP4.
 * Only the final story.mp4 is written under public/output.
 * Switch with STORY_RENDERER=ffmpeg|remotion (default ffmpeg).
 */
export async function buildStoryVideo(
  options: BuildStoryVideoOptions
): Promise<{
  videoUrl: string;
  plan: StoryPlan;
  durationSec: number;
  usedUpload: boolean;
  lang: StoryLang;
  brollSource: string;
  renderer: "ffmpeg" | "remotion";
}> {
  const { onLog = console.log } = options;
  const rendererMode = getStoryRendererMode();
  onLog(`Story renderer: ${rendererMode}`);

  let prepared: PreparedStoryAssets | null = null;

  try {
    prepared = await prepareStoryAssets(options);
    let durationSec = prepared.voiceSec;

    if (rendererMode === "remotion") {
      durationSec = await renderWithRemotion(prepared, onLog);
    } else {
      durationSec = await renderWithFfmpeg(prepared, onLog);
    }

    return {
      videoUrl: `/output/${prepared.jobId}/story.mp4`,
      plan: prepared.plan,
      durationSec,
      usedUpload: prepared.usedUpload,
      lang: prepared.lang,
      brollSource: prepared.poolLabel,
      renderer: rendererMode,
    };
  } finally {
    if (prepared?.workDir) {
      try {
        await fs.rm(prepared.workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export type { StoryPlan, StoryScene };
