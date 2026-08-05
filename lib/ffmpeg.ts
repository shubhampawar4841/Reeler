import fs from "node:fs/promises";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { getFfmpegExecutable } from "@/lib/binPaths";
import type { SubtitleCue } from "@/lib/types";
import { buildAssFromCues } from "@/lib/assFromSrt";
import { generateImagesTxt } from "@/lib/generateImagesTxt";

/** 16:9 landscape output. */
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_FPS = 30;

export type FfmpegProgress = {
  /** 0–100 best-effort */
  percent: number;
  line: string;
};

export type BuildVideoOptions = {
  sessionId: string;
  sessionDir: string;
  cues: SubtitleCue[];
  /** Ordered absolute paths; length may be less than cues — looping handled upstream */
  imagePaths: string[];
  /** Narration file (voice-over); required for normal Shorts with your uploaded audio */
  voicePath: string;
  /** Total narration length in seconds (drives output length; last slide fills remainder). */
  voiceDurationSec: number;
  musicPath?: string;
  onLog?: (line: string) => void;
  onProgress?: (p: FfmpegProgress) => void;
};

let ffmpegPathSet = false;

function ensureFluentFfmpegPath(): void {
  if (!ffmpegPathSet) {
    ffmpeg.setFfmpegPath(getFfmpegExecutable());
    ffmpegPathSet = true;
  }
}

function escapePathForFilter(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if ([h, min, s].some((x) => Number.isNaN(x))) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Builds per-image FFmpeg inputs + filter_complex: scale/pad, concat, ASS burn-in,
 * audio mix, H.264 1920x1080 @ 30fps — **no zoom or fades** (hard cuts between slides).
 */
export async function renderShortVideo(opts: BuildVideoOptions): Promise<string> {
  const {
    sessionId,
    sessionDir,
    cues,
    imagePaths,
    voicePath,
    voiceDurationSec,
    musicPath,
    onLog,
    onProgress,
  } = opts;

  if (!Number.isFinite(voiceDurationSec) || voiceDurationSec <= 0) {
    throw new Error("renderShortVideo: invalid voiceDurationSec");
  }

  const totalDurationSec = voiceDurationSec;

  if (imagePaths.length === 0) {
    throw new Error("renderShortVideo: no images");
  }
  if (cues.length === 0) {
    throw new Error("renderShortVideo: no subtitle cues");
  }

  ensureFluentFfmpegPath();

  const outDir = path.join(process.cwd(), "public", "output", sessionId);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "final.mp4");

  const assPath = path.join(sessionDir, "styled.ass");
  await fs.writeFile(assPath, buildAssFromCues(cues), "utf8");

  const imagesTxtPath = path.join(sessionDir, "images.txt");
  await generateImagesTxt(imagePaths, cues, imagesTxtPath);

  const videoChains: string[] = [];
  let cmd = ffmpeg();

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const img = imagePaths[i % imagePaths.length]!;
    const isLast = i === cues.length - 1;
    const d = isLast
      ? Math.max(0.2, voiceDurationSec - cue.startSec)
      : Math.max(0.2, cue.durationSec);

    cmd = cmd.addInput(img).inputOptions(["-loop", "1", "-t", d.toFixed(3)]);

    // Hard cuts between slides: no zoom, no fades — instant-looking switches.
    const chain =
      [
        `[${i}:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease`,
        `pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
        `setsar=1`,
        `fps=${VIDEO_FPS}`,
        `format=yuv420p`,
        `setpts=PTS-STARTPTS`,
      ].join(",") + `[v${i}]`;

    videoChains.push(chain);
  }

  const concatIn = cues.map((_, i) => `[v${i}]`).join("");
  const n = cues.length;
  const concatAndSubs = `${concatIn}concat=n=${n}:v=1:a=0[vcat];[vcat]ass='${escapePathForFilter(assPath)}'[vout]`;

  const voiceIndex = n;
  cmd = cmd.addInput(voicePath);

  let audioPart: string;
  if (musicPath) {
    const musicIndex = n + 1;
    cmd = cmd.addInput(musicPath);
    const vol = process.env.BACKGROUND_MUSIC_VOLUME ?? "0.18";
    audioPart = `[${voiceIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[voice];[${musicIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,volume=${vol}[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
  } else {
    audioPart = `[${voiceIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[aout]`;
  }

  const filterComplex = [...videoChains, concatAndSubs, audioPart].join(";");

  const plannedVideoSec = cues.reduce((acc, cue, i) => {
    const isLast = i === cues.length - 1;
    const seg = isLast
      ? Math.max(0.2, voiceDurationSec - cue.startSec)
      : Math.max(0.2, cue.durationSec);
    return acc + seg;
  }, 0);
  onLog?.(
    `[ffmpeg] plannedVideoSec=${plannedVideoSec.toFixed(3)} voiceSec=${voiceDurationSec.toFixed(3)} slides=${cues.length}`
  );

  await new Promise<void>((resolve, reject) => {
    const proc = cmd
      .complexFilter(filterComplex)
      .outputOptions([
        "-y",
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
        "-shortest",
      ])
      .on("start", (commandLine: string) => {
        onLog?.(`[ffmpeg] ${commandLine}`);
      })
      .on("stderr", (line: string | Buffer) => {
        const text = typeof line === "string" ? line : line.toString("utf8");
        const trimmed = text.trimEnd();
        onLog?.(trimmed);
        const t = parseFfmpegTime(text);
        if (t != null && totalDurationSec > 0 && onProgress) {
          const pct = Math.min(99, Math.max(0, (t / totalDurationSec) * 100));
          onProgress({ percent: pct, line: trimmed });
        }
      })
      .on("error", (err: Error) => {
        reject(err);
      })
      .on("end", () => {
        onProgress?.({ percent: 100, line: "done" });
        resolve();
      });

    proc.save(outFile);
  });

  return outFile;
}
