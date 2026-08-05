import type { Cue, SubtitleCue } from "@/lib/types";

/**
 * Finds each `(M:SS)` marker and the text after it until the next marker (slice-based,
 * so dialogue may contain parentheses unlike a single `[^()]+` match).
 *
 * Each cue ends at the **next** marker time, or `start + 5` for the last cue (then
 * `alignCuesToVoiceDuration` stretches the last cue to the narration end).
 */
export function parseTranscriptCues(raw: string): Cue[] {
  const text = raw.trim();
  if (!text) {
    throw new Error("Transcript is empty");
  }

  const re = /\((\d+):(\d{1,2})\)/g;
  const hits: { start: number; parenOpen: number; afterParen: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const minutes = Number(m[1]);
    const seconds = Number(m[2]);
    if (Number.isNaN(minutes) || Number.isNaN(seconds) || seconds > 59) {
      throw new Error(`Invalid timestamp (${m[1]}:${m[2]})`);
    }
    hits.push({
      start: minutes * 60 + seconds,
      parenOpen: m.index,
      afterParen: m.index + m[0].length,
    });
  }

  if (hits.length === 0) {
    throw new Error('No (M:SS) timestamps found. Example: (0:00) Hello. (0:05) World.');
  }

  const cues: Cue[] = [];
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const next = hits[i + 1];
    const textEnd = next ? next.parenOpen : text.length;
    const cueText = text.slice(cur.afterParen, textEnd).replace(/\s+/g, " ").trim();
    const end = next ? next.start : cur.start + 5;
    cues.push({
      start: cur.start,
      end,
      text: cueText,
    });
  }

  return cues;
}

function cuesToSubtitleCues(cues: Cue[]): SubtitleCue[] {
  return cues.map((c, i) => ({
    index: i + 1,
    text: c.text,
    startSec: c.start,
    endSec: c.end,
    durationSec: Math.max(0.2, c.end - c.start),
  }));
}

/** Parsed cues for ASS/SRT/FFmpeg (`Cue`-like times as `startSec` / `endSec`). */
export function parseParentheticalTimedTranscript(raw: string): SubtitleCue[] {
  return cuesToSubtitleCues(parseTranscriptCues(raw));
}

/**
 * `(M:SS)` markers = when each slide / subtitle line starts. Total runtime follows the
 * narration file: the last slide runs until `voiceSec`, and markers after the voice end
 * are dropped.
 */
export function alignCuesToVoiceDuration(
  cues: SubtitleCue[],
  voiceSec: number
): SubtitleCue[] {
  if (!Number.isFinite(voiceSec) || voiceSec <= 0) {
    throw new Error("Voice-over duration is zero or unreadable.");
  }
  const before = cues.filter((c) => c.startSec < voiceSec);
  if (before.length === 0) {
    throw new Error(
      "Every (M:SS) marker is at or after the end of your narration. Move markers earlier or use a longer voice track."
    );
  }
  return before.map((c, i) => {
    const start = c.startSec;
    const isLast = i === before.length - 1;
    const end = isLast ? voiceSec : Math.min(before[i + 1]!.startSec, voiceSec);
    return {
      ...c,
      index: i + 1,
      startSec: start,
      endSec: end,
      durationSec: Math.max(0.2, end - start),
    };
  });
}

/**
 * Retimes cues to span the full voice track by spoken mass (word count).
 * Groq/author (M:SS) marks are used only for phrase order — not absolute clock time —
 * so captions stay locked to Kokoro (or any) VO instead of lagging inventedy markers.
 */
export function retimeCuesToVoiceByWords(
  cues: SubtitleCue[],
  voiceSec: number
): SubtitleCue[] {
  if (!Number.isFinite(voiceSec) || voiceSec <= 0) {
    throw new Error("Voice-over duration is zero or unreadable.");
  }
  const kept = cues.filter((c) => c.text.trim().length > 0);
  if (kept.length === 0) {
    throw new Error("No caption phrases to align to the voice track.");
  }

  const weights = kept.map((c) => {
    const words = c.text.split(/\s+/).filter(Boolean).length;
    // Prefer real word count; fall back to chars so short “Oh.” still gets a beat
    return Math.max(1, words > 0 ? words : Math.ceil(c.text.trim().length / 6));
  });
  const totalW = weights.reduce((a, b) => a + b, 0);

  let t = 0;
  return kept.map((c, i) => {
    const isLast = i === kept.length - 1;
    const startSec = t;
    const share = (weights[i]! / totalW) * voiceSec;
    const endSec = isLast ? voiceSec : Math.min(voiceSec, t + share);
    t = endSec;
    return {
      ...c,
      index: i + 1,
      startSec,
      endSec,
      durationSec: Math.max(0.15, endSec - startSec),
    };
  });
}

/** Seconds → `H:MM:SS,mmm` for SRT */
function secToSrtTime(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(whole)},${pad3(ms)}`;
}

/** Persist cues as `.srt` and plain `.txt` (one line per cue) for debugging / reuse. */
export function cuesToSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => {
      const n = i + 1;
      return `${n}\n${secToSrtTime(c.startSec)} --> ${secToSrtTime(c.endSec)}\n${c.text}\n`;
    })
    .join("\n");
}

export function cuesToPlainTranscript(cues: SubtitleCue[]): string {
  return cues
    .map(
      (c) =>
        `(${Math.floor(c.startSec / 60)}:${String(Math.floor(c.startSec % 60)).padStart(2, "0")}) ${c.text}`
    )
    .join("\n");
}
