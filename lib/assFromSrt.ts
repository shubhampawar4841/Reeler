import type { SubtitleCue } from "@/lib/types";

/**
 * Converts seconds to ASS time: H:MM:SS.cc (centiseconds)
 */
function secToAssTime(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const cent = Math.round((s - whole) * 100);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad2(m)}:${pad2(whole)}.${String(cent).padStart(2, "0")}`;
}

/**
 * Escapes ASS special characters in dialogue text.
 */
function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\N").replace(/{/g, "\\{").replace(/}/g, "\\}");
}

/**
 * Styled ASS for 1920×1080: small captions, bottom center (alignment 2), PlayRes matches video frame.
 */
export function buildAssFromCues(cues: SubtitleCue[]): string {
  const header = `[Script Info]
Title: Reeler
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bottom,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,64,64,36,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .map((c) => {
      const start = secToAssTime(c.startSec);
      const end = secToAssTime(c.endSec);
      const fadeMs = Math.min(220, Math.max(80, Math.floor(c.durationSec * 50)));
      const t = escapeAssText(c.text);
      const anim = `{\\fad(${fadeMs},${fadeMs})}`;
      return `Dialogue: 0,${start},${end},Bottom,,0,0,0,,${anim}${t}`;
    })
    .join("\n");

  return `${header}${events}\n`;
}
