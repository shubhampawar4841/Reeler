import fs from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue } from "@/lib/types";

export type ImagesTxtEntry = {
  /** Absolute path to image file */
  filePath: string;
  /** How long this image should show (seconds) */
  durationSec: number;
};

/**
 * Builds FFmpeg concat demuxer content.
 * Each block is: file '...' + duration N (last image omits trailing duration in some workflows;
 * we include duration for every segment and duplicate last frame rule is handled by caller if needed).
 *
 * @see https://ffmpeg.org/ffmpeg-formats.html#concat-1
 */
export function buildImagesTxtContent(entries: ImagesTxtEntry[]): string {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    // Use forward slashes for FFmpeg; escape single quotes in path for concat syntax
    const posix = e.filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
    lines.push(`file '${posix}'`);
    lines.push(`duration ${e.durationSec.toFixed(3)}`);
  }
  // Concat demuxer requires the last file listed again without duration (FFmpeg quirk)
  if (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    const posix = last.filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
    lines.push(`file '${posix}'`);
  }
  return lines.join("\n");
}

/**
 * Writes images.txt next to other session assets for debugging / optional FFmpeg concat usage.
 */
export async function writeImagesTxt(
  outputPath: string,
  entries: ImagesTxtEntry[]
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  const body = buildImagesTxtContent(entries);
  await fs.writeFile(outputPath, body, "utf8");
}

/**
 * FFmpeg concat demuxer list: each slide `file` + `duration`, then final `file` line
 * (no duration) as required by FFmpeg.
 */
export async function generateImagesTxt(
  imagePaths: string[],
  cues: SubtitleCue[],
  outputPath: string
): Promise<void> {
  const entries: ImagesTxtEntry[] = cues.map((cue, i) => ({
    filePath: imagePaths[i % imagePaths.length]!,
    durationSec: Math.max(0.2, cue.endSec - cue.startSec),
  }));
  await writeImagesTxt(outputPath, entries);
}
