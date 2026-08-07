import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { RenderThemeConfig } from "../config/types";

type Props = {
  endingQuestion?: string;
  variant: RenderThemeConfig["outro"]["variant"];
  config: RenderThemeConfig;
};

/** End card — Follow Part 2 / Subscribe. */
export const CTA: React.FC<Props> = ({ endingQuestion, variant, config }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (variant === "none") return null;

  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 110 } });
  const fade = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const bounce = interpolate(Math.sin(frame / 6), [-1, 1], [0.97, 1.03]);

  const headline =
    variant === "subscribe" ? "SUBSCRIBE" : "FOLLOW FOR PART 2";

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: `linear-gradient(180deg, ${config.colors.background} 0%, #1a0508 55%, #0a0002 100%)`,
        opacity: fade,
        zIndex: 20,
      }}
    >
      <div
        style={{
          transform: `scale(${(0.88 + pop * 0.12) * bounce})`,
          textAlign: "center",
          padding: 40,
        }}
      >
        <div
          style={{
            fontFamily: config.font.family,
            fontSize: 68,
            fontWeight: 900,
            color: config.colors.highlight,
            WebkitTextStroke: "6px #000",
            paintOrder: "stroke fill",
            marginBottom: 20,
            textShadow: `0 0 28px ${config.colors.highlight}`,
          }}
        >
          {headline}
        </div>
        {endingQuestion ? (
          <div
            style={{
              color: config.colors.text,
              fontSize: 34,
              fontFamily: "system-ui, sans-serif",
              maxWidth: 820,
              lineHeight: 1.35,
              opacity: 0.92,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            {endingQuestion}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 40,
            fontSize: 24,
            color: "rgba(255,255,255,0.55)",
            letterSpacing: 3,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          REPLAY · COMMENT YOUR THEORY
        </div>
      </div>
    </AbsoluteFill>
  );
};
