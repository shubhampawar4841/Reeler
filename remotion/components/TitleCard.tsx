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
  title: string;
  hook?: string;
  variant: RenderThemeConfig["intro"]["variant"];
  config: RenderThemeConfig;
};

const VARIANT_LABEL: Record<Exclude<Props["variant"], "none">, string> = {
  true_story: "⚠ TRUE STORY",
  part_one: "PART 1",
  scary_story: "SCARY STORY",
};

/** Animated intro / hook card. */
export const TitleCard: React.FC<Props> = ({ title, hook, variant, config }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  if (variant === "none") return null;

  const pop = spring({ frame, fps, config: { damping: 13, stiffness: 130 } });
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(
    frame,
    [Math.max(12, durationInFrames - 12), durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const accentPulse = interpolate(Math.sin(frame / 5), [-1, 1], [0.85, 1]);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: `radial-gradient(ellipse at 50% 40%, #2a1018 0%, ${config.colors.background} 70%)`,
        opacity: fadeIn * fadeOut,
        zIndex: 20,
      }}
    >
      <div
        style={{
          transform: `scale(${0.82 + pop * 0.18})`,
          textAlign: "center",
          padding: 48,
          maxWidth: "92%",
        }}
      >
        <div
          style={{
            color: config.colors.accent,
            fontFamily: config.font.family,
            fontSize: 44,
            fontWeight: 900,
            letterSpacing: 5,
            marginBottom: 22,
            opacity: accentPulse,
            textShadow: `0 0 24px ${config.colors.accent}`,
          }}
        >
          {VARIANT_LABEL[variant]}
        </div>
        <div
          style={{
            color: config.colors.text,
            fontFamily: config.font.family,
            fontSize: 58,
            fontWeight: 900,
            lineHeight: 1.12,
            WebkitTextStroke: "5px rgba(0,0,0,0.9)",
            paintOrder: "stroke fill",
            marginBottom: 18,
          }}
        >
          {title}
        </div>
        {hook ? (
          <div
            style={{
              marginTop: 10,
              color: "rgba(255,255,255,0.82)",
              fontSize: 30,
              fontFamily: "system-ui, sans-serif",
              lineHeight: 1.35,
              maxWidth: 860,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            {hook}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 36,
            color: config.colors.highlight,
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: 2,
            fontFamily: "system-ui, sans-serif",
            opacity: interpolate(frame, [14, 24], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          READ TILL THE END…
        </div>
      </div>
    </AbsoluteFill>
  );
};
