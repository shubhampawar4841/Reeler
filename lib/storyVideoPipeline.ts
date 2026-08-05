import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getFfmpegExecutable } from "@/lib/binPaths";
import { VIDEO_FPS } from "@/lib/ffmpeg";
import { buildAssFromVoiceCaptions } from "@/lib/dummyCaptions";
import type { SubtitleCue } from "@/lib/types";
import type { Caption } from "@remotion/captions";
import { planStoryWithGroq, type StoryLang } from "@/lib/groqStoryboard";
import { synthesizeStoryVoice, type VoiceChunk } from "@/lib/kokoroTts";
import type { StoryPlan, StoryScene } from "@/lib/storyTypes";

export type StoryVideoLog = (msg: string) => void;

/** Vertical Shorts frame for story videos. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/** Built-in parkour B-roll parts (split for GitHub <50MB each). */
export const DEFAULT_STORY_BROLL_PARTS = [
  path.join(process.cwd(), "public", "broll", "minecraft-parkour-1.mp4"),
  path.join(process.cwd(), "public", "broll", "minecraft-parkour-2.mp4"),
] as const;

/** @deprecated Prefer DEFAULT_STORY_BROLL_PARTS — kept as first-part fallback path. */
export const DEFAULT_STORY_BROLL = DEFAULT_STORY_BROLL_PARTS[0];

export type BuildStoryVideoOptions = {
  story: string;
  lang?: StoryLang;
  /** Optional override; otherwise random cuts from DEFAULT_STORY_BROLL_PARTS */
  backgroundVideoPath?: string | null;
  onLog?: StoryVideoLog;
};

function escapePathForFilter(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function runFfmpeg(args: string[], onLog?: StoryVideoLog): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = execFile(
      getFfmpegExecutable(),
      args,
      { maxBuffer: 80 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          const msg =
            typeof stderr === "string" && stderr.trim()
              ? stderr.slice(-2500)
              : err.message;
          reject(new Error(`ffmpeg failed: ${msg}`));
          return;
        }
        resolve();
      }
    );
    ff.stderr?.on("data", (d: Buffer) => {
      const line = d.toString("utf8").trim();
      if (line && onLog && /time=|error|Error/.test(line)) onLog(line.slice(0, 200));
    });
  });
}

async function probeDurationSec(filePath: string): Promise<number> {
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
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) throw new Error(`No Duration for ${path.basename(filePath)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const SCALE_CROP_9x16 = `scale=${STORY_WIDTH}:${STORY_HEIGHT}:force_original_aspect_ratio=increase,crop=${STORY_WIDTH}:${STORY_HEIGHT},fps=${VIDEO_FPS},format=yuv420p`;

function cuesToCaptionTokens(cues: SubtitleCue[]): Caption[] {
  const captions: Caption[] = [];
  for (const c of cues) {
    const words = c.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const slice = ((c.endSec - c.startSec) * 1000) / words.length;
    words.forEach((w, i) => {
      const startMs = Math.round(c.startSec * 1000 + i * slice);
      const endMs = Math.round(
        i === words.length - 1 ? c.endSec * 1000 : c.startSec * 1000 + (i + 1) * slice
      );
      captions.push({
        text: (i === 0 ? "" : " ") + w,
        startMs,
        endMs,
        timestampMs: startMs,
        confidence: 1,
      });
    });
  }
  return captions;
}

/** Lock captions to real TTS sentence timings (not Groq (M:SS) guesses). */
function cuesFromVoiceChunks(chunks: VoiceChunk[]): SubtitleCue[] {
  let t = 0;
  return chunks
    .filter((c) => c.text.trim().length > 0 && c.durationSec > 0)
    .map((c, i) => {
      const startSec = t;
      const endSec = t + c.durationSec;
      t = endSec;
      return {
        index: i + 1,
        text: c.text.trim(),
        startSec,
        endSec,
        durationSec: Math.max(0.15, endSec - startSec),
      };
    });
}

function weightText(s: string): number {
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words > 0) return words;
  // Devanagari fallback: approx syllables by char clusters
  return Math.max(1, Math.ceil(s.replace(/\s+/g, "").length / 4));
}

function sceneDurationsForVoice(
  plan: StoryPlan,
  cues: SubtitleCue[],
  voiceSec: number
): number[] {
  // Prefer voice-synced cue durations when counts match scenes
  if (cues.length === plan.scenes.length) {
    return cues.map((c) => Math.max(0.8, c.durationSec));
  }

  // Else distribute voice time by each scene's narration mass
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

async function trimClip(
  src: string,
  dest: string,
  durationSec: number,
  onLog?: StoryVideoLog,
  startSec = 0
): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-ss",
      Math.max(0, startSec).toFixed(3),
      "-t",
      durationSec.toFixed(3),
      "-i",
      src,
      "-vf",
      SCALE_CROP_9x16,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "22",
      dest,
    ],
    onLog
  );
}

/**
 * Cut `durationSec` from a random place in a (possibly long) source.
 * Output length == durationSec only — never pads past the VO beat.
 * If source is shorter than needed, loops the file until the beat is filled.
 */
async function cutRandomSegment(
  src: string,
  dest: string,
  durationSec: number,
  srcDurationSec: number,
  onLog?: StoryVideoLog
): Promise<void> {
  const need = Math.max(0.2, durationSec);

  if (srcDurationSec >= need + 0.05) {
    const maxStart = srcDurationSec - need;
    const start = Math.random() * maxStart;
    onLog?.(
      `  random cut ${need.toFixed(1)}s @ ${start.toFixed(1)}s / ${srcDurationSec.toFixed(0)}s source`
    );
    await trimClip(src, dest, need, onLog, start);
    return;
  }

  // Short source: loop then trim exact length
  onLog?.(
    `  source shorter than beat (${srcDurationSec.toFixed(1)}s < ${need.toFixed(1)}s) — looping`
  );
  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-stream_loop",
      "-1",
      "-i",
      src,
      "-t",
      need.toFixed(3),
      "-vf",
      SCALE_CROP_9x16,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "22",
      dest,
    ],
    onLog
  );
}

/**
 * Story → Groq plan → Minecraft parkour B-roll (or override) → VO → captioned 9:16 MP4.
 * Only the final story.mp4 is written under public/output (no plan/captions JSON junk).
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
}> {
  const { story, lang = "en", onLog = console.log } = options;
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "reeler-story", jobId);
  await fs.mkdir(workDir, { recursive: true });
  const outDir = path.join(process.cwd(), "public", "output", jobId);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "story.mp4");

  const uploadPath = options.backgroundVideoPath?.trim() || "";
  const usedUpload = Boolean(uploadPath);
  const brollPool = usedUpload
    ? [uploadPath]
    : [...DEFAULT_STORY_BROLL_PARTS];

  try {
    const poolMeta: { path: string; dur: number }[] = [];
    for (const p of brollPool) {
      try {
        await fs.access(p);
        poolMeta.push({ path: p, dur: await probeDurationSec(p) });
      } catch {
        /* skip missing part */
      }
    }
    if (poolMeta.length === 0) {
      throw new Error(
        `B-roll missing. Add files under public/broll/ (minecraft-parkour-1/2.mp4) or upload one.`
      );
    }

    onLog(`Planning storyboard with Groq (${lang === "hi" ? "Hindi" : "English"})…`);
    const plan = await planStoryWithGroq(story, lang);
    onLog(`Plan ready: "${plan.title}" · ${plan.scenes.length} scene(s)`);

    onLog(lang === "hi" ? "Synthesizing Hindi voice-over…" : "Synthesizing English Kokoro voice-over…");
    const voice = await synthesizeStoryVoice(
      plan.fullNarration,
      path.join(workDir, "voice"),
      lang,
      onLog
    );
    const voicePath = voice.path;
    const voiceSec = await probeDurationSec(voicePath);
    const chunkSum = voice.chunks.reduce((a, c) => a + c.durationSec, 0);
    const timeScale = chunkSum > 0.05 ? voiceSec / chunkSum : 1;
    onLog(
      `Voice duration: ${voiceSec.toFixed(2)}s (${voice.engine}/${voice.voice}) — caption scale ${timeScale.toFixed(3)}`
    );

    const cues = cuesFromVoiceChunks(voice.chunks).map((c) => ({
      ...c,
      startSec: c.startSec * timeScale,
      endSec: c.endSec * timeScale,
      durationSec: Math.max(0.12, c.durationSec * timeScale),
    }));
    const captions = cuesToCaptionTokens(cues);
    const assPath = path.join(workDir, "story.ass");
    await fs.writeFile(
      assPath,
      buildAssFromVoiceCaptions(captions, STORY_WIDTH, STORY_HEIGHT, {
        fontName: lang === "hi" ? "Nirmala UI" : "Arial Black",
        leadMs: 140,
        wordsPerLine: 4,
      }),
      "utf8"
    );

    const sceneDurations = sceneDurationsForVoice(plan, cues, voiceSec);
    const clipPaths: string[] = [];
    const poolLabel = poolMeta.map((m) => path.basename(m.path)).join(" + ");
    onLog(
      `B-roll: ${poolLabel} — random cuts totaling ${voiceSec.toFixed(1)}s @ 9:16`
    );
    for (let i = 0; i < plan.scenes.length; i++) {
      const d = sceneDurations[i]!;
      const clipPath = path.join(workDir, `clip-${i}.mp4`);
      const src = poolMeta[Math.floor(Math.random() * poolMeta.length)]!;
      onLog(
        `Scene [${i + 1}/${plan.scenes.length}] ${d.toFixed(1)}s ← ${path.basename(src.path)}`
      );
      await cutRandomSegment(src.path, clipPath, d, src.dur, onLog);
      clipPaths.push(clipPath);
    }

    onLog("Concatenating clips + voice + captions (9:16)…");
    await concatClipsWithVoice(clipPaths, voicePath, assPath, outPath, voiceSec, onLog);

    return {
      videoUrl: `/output/${jobId}/story.mp4`,
      plan,
      durationSec: voiceSec,
      usedUpload,
      lang,
      brollSource: poolLabel,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function concatClipsWithVoice(
  clipPaths: string[],
  voicePath: string,
  assPath: string,
  outPath: string,
  voiceSec: number,
  onLog?: StoryVideoLog
): Promise<void> {
  const n = clipPaths.length;
  const args: string[] = ["-y", "-hide_banner"];
  for (const c of clipPaths) {
    args.push("-i", c);
  }
  args.push("-i", voicePath);

  const labels = clipPaths.map((_, i) => `[${i}:v]`).join("");
  // Keep audio timeline from 0 (no asetpts reset that can desync burned captions)
  const filter = [
    `${labels}concat=n=${n}:v=1:a=0[vcat]`,
    `[vcat]ass='${escapePathForFilter(assPath)}'[vout]`,
    `[${n}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`,
  ].join(";");

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(VIDEO_FPS),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    voiceSec.toFixed(3),
    "-movflags",
    "+faststart",
    outPath
  );

  await runFfmpeg(args, onLog);
}

export type { StoryPlan, StoryScene };
