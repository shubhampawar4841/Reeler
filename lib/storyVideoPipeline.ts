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
import { synthesizeStoryVoice } from "@/lib/kokoroTts";
import { alignVoiceCaptions } from "@/lib/alignVoiceCaptions";
import type { StoryPlan, StoryScene } from "@/lib/storyTypes";
import { getStoryRendererMode } from "@/lib/remotion/renderStory";
import {
  mapPipelineToInput,
  type BrollPoolItem,
} from "@/lib/remotion/mapPipelineToInput";

export type StoryVideoLog = (msg: string) => void;

/** Vertical Shorts frame for story videos. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/**
 * Single final encode only (no intermediate H.264 passes).
 * Target ~20–25MB / 60s @ 1080x1920 / 30fps (≈2.7–3.3 Mbps).
 */
const ENCODE_PRESET = "slow";
const ENCODE_CRF = "29";
const ENCODE_MAXRATE = "3.5M";
const ENCODE_BUFSIZE = "7M";
const ENCODE_AUDIO_BITRATE = "64k";

/**
 * Whole Short playback speed (B-roll + VO + captions together).
 * Env: STORY_SPEED (1–2). Default 1.35.
 */
function resolvePlaybackSpeed(): number {
  const raw = Number(process.env.STORY_SPEED ?? process.env.BROLL_SPEED);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 2) return raw;
  return 1.35;
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

/** Remote B-roll (downloaded into the job temp dir each run). */
export const DEFAULT_STORY_BROLL_URLS = [
  // "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/minecraft-parkour-1.mp4",
  // "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/minecraft-parkour-2.mp4",
  "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/(No%20Copyright)Satisfying%20Videos%20Reel_Shorts%20format%20Satisfying%20Videos%20for%20Repost%20-%20Killing%20tech%20(480p,%20h264)%20(1).mp4",
  "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/(No%20Copyright)Satisfying%20Videos%20Reel_Shorts%20format%20Satisfying%20Videos%20for%20Repost%20-%20Killing%20tech%20(480p,%20h264).mp4",
] as const;

export type BuildStoryVideoOptions = {
  story: string;
  lang?: StoryLang;
  /** Optional local override; otherwise downloads DEFAULT_STORY_BROLL_URLS */
  backgroundVideoPath?: string | null;
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
};

async function downloadBrollUrl(
  url: string,
  dest: string,
  onLog?: StoryVideoLog
): Promise<void> {
  onLog?.(`Downloading B-roll ${path.basename(dest)}…`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download B-roll (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
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
  const stat = await fs.stat(filePath);
  const fromContainer = stderr.match(/bitrate:\s*([\d.]+)\s*kb\/s/i);
  const bitrateKbps = fromContainer
    ? Number(fromContainer[1])
    : durationSec > 0
      ? (stat.size * 8) / durationSec / 1000
      : null;
  return {
    durationSec,
    bitrateKbps:
      bitrateKbps != null && Number.isFinite(bitrateKbps) ? bitrateKbps : null,
    sizeBytes: stat.size,
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
    voiceSec,
    playbackSpeed: speed,
    onLog,
  } = args;

  const voiceIn = Math.max(0.2, voiceSec);
  const outDur = voiceIn / speed;
  // Consume speed× source so after setpts it matches outDur.
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

  const srcProbe = await probeMedia(brollPath);
  onLog(
    `Encode BEFORE (source B-roll): size=${formatMb(srcProbe.sizeBytes)}, ` +
      `dur=${srcProbe.durationSec.toFixed(1)}s, ` +
      `avgBitrate=${srcProbe.bitrateKbps != null ? `${srcProbe.bitrateKbps.toFixed(0)} kbps` : "n/a"}`
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
  if (canTrim) {
    ffArgs.push(
      "-ss",
      startSec.toFixed(3),
      "-t",
      sourceNeed.toFixed(3),
      "-i",
      brollPath
    );
  } else {
    ffArgs.push("-stream_loop", "-1", "-i", brollPath);
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
 * Shared prep: B-roll download, Groq plan, TTS, Whisper captions.
 * Rendering (FFmpeg vs Remotion) happens after this.
 */
async function prepareStoryAssets(
  options: BuildStoryVideoOptions
): Promise<PreparedStoryAssets> {
  const { story, lang = "en", onLog = console.log } = options;
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "reeler-story", jobId);
  await fs.mkdir(workDir, { recursive: true });
  const outDir = path.join(process.cwd(), "public", "output", jobId);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "story.mp4");

  const uploadPath = options.backgroundVideoPath?.trim() || "";
  const usedUpload = Boolean(uploadPath);

  const poolMeta: BrollPoolItem[] = [];
  if (usedUpload) {
    try {
      await fs.access(uploadPath);
      poolMeta.push({
        path: uploadPath,
        dur: await probeDurationSec(uploadPath),
        label: path.basename(uploadPath),
      });
    } catch {
      throw new Error(`B-roll upload missing: ${uploadPath}`);
    }
  } else {
    for (let i = 0; i < DEFAULT_STORY_BROLL_URLS.length; i++) {
      const url = DEFAULT_STORY_BROLL_URLS[i]!;
      const dest = path.join(workDir, `broll-${i + 1}.mp4`);
      try {
        await downloadBrollUrl(url, dest, onLog);
        poolMeta.push({
          path: dest,
          dur: await probeDurationSec(dest),
          label: path.basename(new URL(url).pathname),
        });
      } catch (err) {
        onLog?.(
          `Skipping B-roll part ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (poolMeta.length === 0) {
      throw new Error(
        "Failed to download B-roll from Supabase. Check DEFAULT_STORY_BROLL_URLS."
      );
    }
  }

  onLog(`Planning storyboard with Groq (${lang === "hi" ? "Hindi" : "English"})…`);
  const plan = await planStoryWithGroq(story, lang);
  onLog(`Plan ready: "${plan.title}" · ${plan.scenes.length} scene(s)`);

  onLog(
    lang === "hi"
      ? "Synthesizing Hindi voice-over…"
      : "Synthesizing English Kokoro voice-over…"
  );
  const voice = await synthesizeStoryVoice(
    plan.fullNarration,
    path.join(workDir, "voice"),
    lang,
    onLog
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
  const poolLabel = poolMeta.map((m) => m.label).join(" + ");

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

  const speed = resolvePlaybackSpeed();
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
  onLog(
    `B-roll: ${poolLabel} — ${speed}× whole Short ← ${src.label} (VO ${voiceSec.toFixed(1)}s → ~${(voiceSec / speed).toFixed(1)}s)`
  );

  return encodeStoryOnePass({
    brollPath: src.path,
    brollDurSec: src.dur,
    voicePath,
    assPath,
    outPath,
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
