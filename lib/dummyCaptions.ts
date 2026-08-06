import { createTikTokStyleCaptions } from "@remotion/captions";
import type { Caption, TikTokPage } from "@remotion/captions";

/** Remotion docs default — how often caption pages switch */
export const SWITCH_CAPTIONS_EVERY_MS = 1200;

/** Remotion example highlight (#39E508) as ASS BGR */
const HIGHLIGHT_GREEN = "&H0008E539";
const WHITE = "&H00FFFFFF";

const PHRASE_BANK = [
  ["watch", " this", " now"],
  ["you", " won't", " believe"],
  ["wait", " for", " it"],
  ["here", " we", " go"],
  ["this", " is", " crazy"],
  ["look", " at", " that"],
  ["next", " level", " move"],
  ["stay", " until", " end"],
  ["one", " more", " time"],
  ["feel", " the", " energy"],
  ["big", " plot", " twist"],
  ["keep", " scrolling"],
  ["game", " changer"],
  ["real", " talk", " though"],
  ["save", " this", " clip"],
];

/**
 * Dummy word-level captions in Remotion's `Caption` format
 * (same shape you'd get from `parseSrt` / Whisper).
 */
export function buildDummyRemotionCaptions(durationSec: number): Caption[] {
  const durationMs = Math.max(1000, Math.round(durationSec * 1000));
  const captions: Caption[] = [];
  let t = 0;
  let phraseIdx = 0;

  while (t < durationMs) {
    const words = PHRASE_BANK[phraseIdx % PHRASE_BANK.length]!;
    phraseIdx += 1;
    const perWord = 400;
    for (const text of words) {
      if (t >= durationMs) break;
      const endMs = Math.min(durationMs, t + perWord);
      captions.push({
        text,
        startMs: t,
        endMs,
        timestampMs: t,
        confidence: 1,
      });
      t = endMs;
    }
  }

  return captions;
}

/** Remotion `createTikTokStyleCaptions` — same helper as the docs. */
export function toTikTokPages(captions: Caption[]): TikTokPage[] {
  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,
  });
  return pages;
}

function secToAssTime(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const cent = Math.min(99, Math.round((s - whole) * 100));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad2(m)}:${pad2(whole)}.${String(cent).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}");
}

function assHeader(
  playResX: number,
  playResY: number,
  fontName: string,
  fontSize: number,
  alignment: number,
  marginLR: number,
  marginV: number
): string {
  return `[Script Info]
Title: Voice-locked captions
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TikTok,${fontName},${fontSize},&H00FFFFFF,&H0008E539,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,1,${alignment},${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Burn TikTok-look ASS directly from word tokens (startMs/endMs).
 * Skips Remotion page regrouping + 1.2s cutoff — those made captions lag behind the VO.
 *
 * @param leadMs captions appear this many ms early so highlight never trails speech
 */
export function buildAssFromVoiceCaptions(
  captions: Caption[],
  playResX = 1080,
  playResY = 1920,
  opts?: { fontName?: string; leadMs?: number; wordsPerLine?: number }
): string {
  const vertical = playResY > playResX;
  // Shorts need large karaoke text — was 52/64 and read tiny on phone
  const fontSize = vertical ? 84 : 78;
  const marginLR = vertical ? 36 : 100;
  const marginV = vertical ? 340 : 70;
  const alignment = vertical ? 2 : 5;
  const anTag = vertical ? "\\an2" : "\\an5";
  const fontName = (opts?.fontName || "Arial Black").replace(/,/g, "");
  const leadMs = opts?.leadMs ?? 0;
  const wordsPerLine = Math.max(2, opts?.wordsPerLine ?? (vertical ? 3 : 5));

  const tokens = captions
    .map((c) => ({
      text: c.text,
      startMs: Math.max(0, c.startMs),
      endMs: Math.max(c.startMs + 40, c.endMs),
    }))
    .filter((t) => t.text.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  const events: string[] = [];

  for (let g = 0; g < tokens.length; g += wordsPerLine) {
    const group = tokens.slice(g, g + wordsPerLine);
    if (group.length === 0) continue;

    for (let ti = 0; ti < group.length; ti++) {
      const tok = group[ti]!;
      const sliceStart = Math.max(0, tok.startMs - leadMs);
      const nextAbsStart =
        ti < group.length - 1
          ? group[ti + 1]!.startMs
          : g + wordsPerLine < tokens.length
            ? tokens[g + wordsPerLine]!.startMs
            : tok.endMs;
      const sliceEnd = Math.max(sliceStart + 50, nextAbsStart - leadMs);
      if (sliceEnd <= sliceStart) continue;

      const line = group
        .map((t, j) => {
          const color = j === ti ? HIGHLIGHT_GREEN : WHITE;
          return `{\\c${color}&}${escapeAss(t.text)}`;
        })
        .join("");

      events.push(
        `Dialogue: 0,${secToAssTime(sliceStart / 1000)},${secToAssTime(sliceEnd / 1000)},TikTok,,0,0,0,,{${anTag}\\bord8\\shad2\\q2}${line}`
      );
    }
  }

  return `${assHeader(playResX, playResY, fontName, fontSize, alignment, marginLR, marginV)}${events.join("\n")}\n`;
}

/**
 * Remotion page-based burn (caption-video path).
 * Prefers full page duration — no hard 1.2s cap (that lagged speech).
 */
export function buildAssFromTikTokPages(
  pages: TikTokPage[],
  playResX = 1920,
  playResY = 1080,
  opts?: { fontName?: string }
): string {
  const vertical = playResY > playResX;
  const fontSize = vertical ? 52 : 64;
  const marginLR = vertical ? 44 : 100;
  const marginV = vertical ? 320 : 70;
  const alignment = vertical ? 2 : 5;
  const anTag = vertical ? "\\an2" : "\\an5";
  const fontName = (opts?.fontName || "Arial Black").replace(/,/g, "");

  const events: string[] = [];

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const nextPage = pages[index + 1] ?? null;
    const pageEndMs = nextPage
      ? nextPage.startMs
      : page.startMs + Math.max(page.durationMs, SWITCH_CAPTIONS_EVERY_MS);
    if (pageEndMs <= page.startMs) continue;

    const tokens = page.tokens;
    if (tokens.length === 0) continue;

    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti]!;
      const sliceStart = Math.max(0, Math.max(page.startMs, tok.fromMs) - 80);
      const sliceEnd =
        ti < tokens.length - 1
          ? Math.min(pageEndMs, Math.max(page.startMs, tokens[ti + 1]!.fromMs))
          : pageEndMs;
      if (sliceEnd <= sliceStart) continue;

      const line = tokens
        .map((t, j) => {
          const color = j === ti ? HIGHLIGHT_GREEN : WHITE;
          return `{\\c${color}&}${escapeAss(t.text)}`;
        })
        .join("");

      events.push(
        `Dialogue: 0,${secToAssTime(sliceStart / 1000)},${secToAssTime(sliceEnd / 1000)},TikTok,,0,0,0,,{${anTag}\\bord6\\shad1\\q2}${line}`
      );
    }
  }

  return `${assHeader(playResX, playResY, fontName, fontSize, alignment, marginLR, marginV)}${events.join("\n")}\n`;
}

/** @deprecated Prefer buildAssFromVoiceCaptions */
export function buildAssSyncedPhrases(
  cues: { text: string; startSec: number; endSec: number }[],
  playResX = 1080,
  playResY = 1920
): string {
  const captions: Caption[] = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const durMs = Math.max(150, (cue.endSec - cue.startSec) * 1000);
    const slice = durMs / words.length;
    words.forEach((w, i) => {
      const startMs = Math.round(cue.startSec * 1000 + i * slice);
      const endMs = Math.round(
        i === words.length - 1 ? cue.endSec * 1000 : cue.startSec * 1000 + (i + 1) * slice
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
  return buildAssFromVoiceCaptions(captions, playResX, playResY);
}

/** Minimal SRT from Remotion Caption[] (for download / Remotion parseSrt round-trip). */
export function captionsToSrt(captions: Caption[]): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const fmt = (ms: number) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = Math.floor(ms % 1000);
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
  };
  return captions
    .map((c, i) => `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text.trim()}\n`)
    .join("\n");
}
