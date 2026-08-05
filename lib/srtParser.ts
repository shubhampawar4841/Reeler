import type { SubtitleCue } from "@/lib/types";

/**
 * Converts SRT timestamp "00:00:04,500" to seconds (float).
 */
export function srtTimestampToSeconds(ts: string): number {
  const normalized = ts.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) {
    throw new Error(`Invalid SRT timestamp: "${ts}"`);
  }
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if ([h, m, s].some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid SRT timestamp: "${ts}"`);
  }
  return h * 3600 + m * 60 + s;
}

/**
 * Parses a full .srt file into structured cues with duration.
 */
export function parseSrtFile(content: string): SubtitleCue[] {
  const blocks = content
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\n+/);

  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;

    let idx = 0;
    const first = lines[0] ?? "";
    const maybeIndex = Number(first);
    if (!Number.isNaN(maybeIndex) && /^\d+$/.test(first.trim())) {
      idx = maybeIndex;
    }

    const timeLineIndex = Number.isNaN(maybeIndex) || !/^\d+$/.test(first.trim()) ? 0 : 1;
    const timeLine = lines[timeLineIndex];
    if (!timeLine || !timeLine.includes("-->")) continue;

    const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim());
    const startSec = srtTimestampToSeconds(startRaw ?? "0");
    const endSec = srtTimestampToSeconds(endRaw ?? "0");
    const durationSec = Math.max(0.05, endSec - startSec);

    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join(" ").replace(/\s+/g, " ").trim();

    cues.push({
      index: idx || cues.length + 1,
      text,
      startSec,
      endSec,
      durationSec,
    });
  }

  return cues;
}
