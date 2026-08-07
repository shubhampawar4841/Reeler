import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";
import type { RemotionCaptionStyleId, RenderThemeConfig } from "../config/types";
import { frameToMs } from "../utils/frames";

type Props = {
  captions: Caption[];
  /** Offset ms — body captions are relative to VO start (usually 0 after intro Sequence). */
  timeOffsetMs?: number;
  styleId: RemotionCaptionStyleId;
  config: RenderThemeConfig;
  wordsPerLine?: number;
};

type WordToken = {
  text: string;
  startMs: number;
  endMs: number;
};

function groupWords(words: WordToken[], n: number): WordToken[][] {
  const groups: WordToken[][] = [];
  for (let i = 0; i < words.length; i += n) {
    groups.push(words.slice(i, i + n));
  }
  return groups;
}

/**
 * Whisper-timed karaoke / style variants.
 * Active word = currentMs ∈ [startMs, endMs).
 */
export const CaptionLayer: React.FC<Props> = ({
  captions,
  timeOffsetMs = 0,
  styleId,
  config,
  wordsPerLine = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = frameToMs(frame, fps) + timeOffsetMs;

  const words = useMemo<WordToken[]>(
    () =>
      captions
        .map((c) => ({
          text: c.text.trim(),
          startMs: c.startMs,
          endMs: Math.max(c.startMs + 40, c.endMs),
        }))
        .filter((w) => w.text.length > 0),
    [captions]
  );

  const groups = useMemo(() => groupWords(words, wordsPerLine), [words, wordsPerLine]);

  const activeGroup =
    groups.find((g) => {
      const start = g[0]!.startMs;
      const end = g[g.length - 1]!.endMs;
      return currentMs >= start && currentMs < end + 80;
    }) ??
    groups.find((g) => currentMs < g[0]!.startMs) ??
    groups[groups.length - 1] ??
    [];

  if (activeGroup.length === 0) return null;

  const horrorScale =
    styleId === "horror" || styleId === "animated"
      ? interpolate(Math.sin(frame / 4), [-1, 1], [0.98, 1.04])
      : 1;

  const isReddit = styleId === "reddit";
  const isTikTok = styleId === "tiktok" || styleId === "karaoke";

  return (
    <AbsoluteFill
      style={{
        justifyContent: isReddit ? "flex-start" : "flex-end",
        alignItems: "center",
        paddingBottom: isReddit ? 0 : 340,
        paddingTop: isReddit ? 220 : 0,
        paddingLeft: 36,
        paddingRight: 36,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: isReddit ? 6 : 10,
          maxWidth: "92%",
          transform: `scale(${horrorScale})`,
          background: isReddit ? "rgba(0,0,0,0.55)" : "transparent",
          borderRadius: isReddit ? 12 : 0,
          padding: isReddit ? "14px 18px" : 0,
        }}
      >
        {activeGroup.map((w, i) => {
          const active = currentMs >= w.startMs && currentMs < w.endMs;
          const color = active ? config.colors.highlight : config.colors.text;
          const scale = active && styleId === "animated" ? 1.12 : 1;
          return (
            <span
              key={`${w.startMs}-${i}`}
              style={{
                fontFamily: isReddit
                  ? "Georgia, Times New Roman, serif"
                  : config.font.family,
                fontSize: config.font.sizePx * (isTikTok ? 1 : 0.92),
                fontWeight: 900,
                color,
                transform: `scale(${scale})`,
                textTransform: styleId === "horror" ? "uppercase" : "none",
                WebkitTextStroke:
                  styleId === "reddit"
                    ? "0px transparent"
                    : `${config.font.strokePx}px rgba(0,0,0,0.9)`,
                paintOrder: "stroke fill",
                textShadow:
                  styleId === "horror"
                    ? `0 0 18px ${config.colors.accent}`
                    : "0 4px 12px rgba(0,0,0,0.65)",
                letterSpacing: styleId === "horror" ? 1.5 : 0,
                lineHeight: 1.15,
                transition: "transform 0.05s linear",
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
