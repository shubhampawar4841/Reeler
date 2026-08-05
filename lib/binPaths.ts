/**
 * Resolve external binaries (FFmpeg, etc.) for child_process.spawn.
 * GUI/IDE-launched Node often has a shorter PATH than your shell — use absolute paths via env.
 */

import { createRequire } from "node:module";
import path from "node:path";

/**
 * Absolute path to the `ffmpeg-static` binary (ships with `npm install`), or null if missing.
 */
function getBundledFfmpegPath(): string | null {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const p = require("ffmpeg-static") as string | undefined;
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * FFmpeg executable used for WAV conversion and video renders.
 *
 * Resolution order:
 * 1. `FFMPEG_PATH` in `.env.local` (full path — overrides everything)
 * 2. `ffmpeg-static` npm package (portable binary per OS; no system install)
 * 3. `ffmpeg` / `ffmpeg.exe` on PATH (may fail when the IDE trims PATH)
 */
export function getFfmpegExecutable(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  const bundled = getBundledFfmpegPath();
  if (bundled) return bundled;
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * nodejs-whisper shells out to `ffmpeg` (bare name). Prepend our resolved binary directory to PATH once.
 */
export function prependFfmpegBinDirToPath(): void {
  const exe = getFfmpegExecutable();
  const dir = path.dirname(path.resolve(exe));
  const sep = path.delimiter;
  const p = process.env.PATH ?? "";
  if (p.split(sep).some((entry) => entry === dir)) return;
  process.env.PATH = `${dir}${sep}${p}`;
}
