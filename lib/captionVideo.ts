import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Caption } from "@remotion/captions";
import { getFfmpegExecutable } from "@/lib/binPaths";
import {
  buildAssFromTikTokPages,
  captionsToSrt,
  toTikTokPages,
} from "@/lib/dummyCaptions";

function escapePathForFilter(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function parseDurationHeader(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Fast duration from container header only (no full decode). */
async function probeMediaDurationSec(filePath: string): Promise<number> {
  const exe = getFfmpegExecutable();
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(
      exe,
      ["-hide_banner", "-nostdin", "-i", filePath],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, _stdout, errText) => {
        const text = typeof errText === "string" ? errText : "";
        // ffmpeg -i with no output always "fails"; Duration is on stderr
        if (text) resolve(text);
        else reject(err ?? new Error("ffmpeg probe produced no output"));
      }
    );
  });
  const header = parseDurationHeader(stderr);
  if (header != null && header > 0) return header;
  throw new Error("Could not read media duration from file header.");
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      getFfmpegExecutable(),
      args,
      { maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          const msg =
            typeof stderr === "string" && stderr.trim()
              ? stderr.slice(-2500)
              : err.message;
          reject(new Error(`ffmpeg caption burn failed: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Burns Remotion Caption[] (from Whisper Web `toCaptions`) with createTikTokStyleCaptions look.
 */
export async function burnCaptionsOnVideo(
  videoBuffer: Buffer,
  originalName: string,
  captions: Caption[]
): Promise<{ videoUrl: string; absolutePath: string; durationSec: number; cueCount: number }> {
  if (!captions.length) {
    throw new Error("No captions to burn — transcription returned empty.");
  }

  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "reeler-caption", jobId);
  await fs.mkdir(workDir, { recursive: true });

  const ext = path.extname(originalName).toLowerCase() || ".mp4";
  const inPath = path.join(workDir, `input${ext}`);
  const assPath = path.join(workDir, "tiktok.ass");

  const outDir = path.join(process.cwd(), "public", "output", jobId);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "captioned.mp4");

  try {
    await fs.writeFile(inPath, videoBuffer);
    const durationSec = await probeMediaDurationSec(inPath);
    if (!Number.isFinite(durationSec) || durationSec < 0.5) {
      throw new Error("Need a video at least ~0.5s long.");
    }

    const pages = toTikTokPages(captions);
    await fs.writeFile(
      path.join(outDir, "captions.json"),
      JSON.stringify(captions, null, 2),
      "utf8"
    );
    await fs.writeFile(path.join(outDir, "transcript.srt"), captionsToSrt(captions), "utf8");
    await fs.writeFile(assPath, buildAssFromTikTokPages(pages), "utf8");

    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-i",
      inPath,
      "-vf",
      `ass='${escapePathForFilter(assPath)}'`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ]);

    return {
      videoUrl: `/output/${jobId}/captioned.mp4`,
      absolutePath: outPath,
      durationSec,
      cueCount: captions.length,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated use burnCaptionsOnVideo with Whisper captions */
export async function burnDummyCaptionsOnVideo(
  videoBuffer: Buffer,
  originalName: string
): Promise<{ videoUrl: string; absolutePath: string; durationSec: number }> {
  const { buildDummyRemotionCaptions } = await import("@/lib/dummyCaptions");
  const workDir = path.join(os.tmpdir(), "reeler-caption-probe");
  await fs.mkdir(workDir, { recursive: true });
  const ext = path.extname(originalName).toLowerCase() || ".mp4";
  const tmp = path.join(workDir, `probe-${uuidv4()}${ext}`);
  try {
    await fs.writeFile(tmp, videoBuffer);
    const durationSec = await probeMediaDurationSec(tmp);
    const captions = buildDummyRemotionCaptions(durationSec);
    const r = await burnCaptionsOnVideo(videoBuffer, originalName, captions);
    return { videoUrl: r.videoUrl, absolutePath: r.absolutePath, durationSec: r.durationSec };
  } finally {
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
  }
}
