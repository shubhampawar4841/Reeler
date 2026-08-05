import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getFfmpegExecutable } from "@/lib/binPaths";

/** Last `time=HH:MM:SS.xx` in FFmpeg progress (end of encode/decode). */
function parseLastProgressTimeSec(stderr: string): number | null {
  let last: number | null = null;
  const re = /time=(\d+):(\d+):(\d+\.\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const s = Number(m[3]);
    if ([h, min, s].some((x) => Number.isNaN(x))) continue;
    last = h * 3600 + min * 60 + s;
  }
  return last;
}

function parseFirstDurationHeader(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if ([h, min, s].some((x) => Number.isNaN(x))) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * PCM `.wav` duration from RIFF `fmt` + `data` (no FFmpeg). Avoids wrong metadata and
 * spawn/stderr races from probe-only reads.
 */
async function getWavDurationFromRiff(filePath: string): Promise<number | null> {
  const buf = await fs.readFile(filePath);
  if (buf.length < 36) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;
    const padded = chunkSize + (chunkSize % 2);
    if (id === "fmt " && chunkSize >= 16) {
      byteRate = buf.readUInt32LE(chunkDataStart + 8);
    } else if (id === "data") {
      dataSize = chunkSize;
      break;
    }
    offset = chunkDataStart + padded;
  }
  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
      },
      (err, _stdout, stderr) => {
        const text = typeof stderr === "string" ? stderr : "";
        if (err && text.length === 0) {
          reject(err);
          return;
        }
        resolve(text);
      }
    );
  });
}

async function decodeAudioDurationSec(filePath: string): Promise<number> {
  const exe = getFfmpegExecutable();
  const args = [
    "-hide_banner",
    "-nostdin",
    "-stats_period",
    "0.15",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ];
  const stderr = await execFileUtf8(exe, args);

  if (/matches no streams|Could not find stream/i.test(stderr)) {
    throw new Error(
      "Narration file has no audio stream FFmpeg can read. Use WAV/MP3/M4A with a real audio track."
    );
  }

  const decoded = parseLastProgressTimeSec(stderr);
  if (decoded != null && decoded > 0) {
    return decoded;
  }

  const header = parseFirstDurationHeader(stderr);
  if (header != null && header > 0) {
    return header;
  }

  throw new Error("Could not read narration duration (decode + header both failed).");
}

/**
 * True length of the **first audio stream** (seconds).
 *
 * - **WAV**: reads `fmt` / `data` from the file (accurate PCM length, instant).
 * - **Other**: full decode to `null` with `execFile` (full stderr, no early-close race),
 *   using the **last** progress `time=` line (good for VBR MP3 / bad tags), then header.
 */
export async function getMediaDurationSec(filePath: string): Promise<number> {
  if (path.extname(filePath).toLowerCase() === ".wav") {
    const fromRiff = await getWavDurationFromRiff(filePath);
    if (fromRiff != null && fromRiff > 0 && Number.isFinite(fromRiff)) {
      return fromRiff;
    }
  }
  return decodeAudioDurationSec(filePath);
}
