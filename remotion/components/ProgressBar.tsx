import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderThemeConfig } from "../config/types";

type Props = {
  config: RenderThemeConfig;
};

/** Bottom progress + optional remaining-time countdown. */
export const ProgressBar: React.FC<Props> = ({ config }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  if (!config.progressBar.enabled) return null;

  const progress = durationInFrames <= 0 ? 0 : frame / durationInFrames;
  const remainSec = Math.max(0, Math.ceil((durationInFrames - frame) / fps));

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 30 }}>
      <div
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          bottom: 48,
          height: 6,
          borderRadius: 999,
          background: "rgba(255,255,255,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(100, progress * 100)}%`,
            height: "100%",
            background: config.colors.highlight,
            boxShadow: `0 0 12px ${config.colors.highlight}`,
          }}
        />
      </div>
      {config.progressBar.showCountdown ? (
        <div
          style={{
            position: "absolute",
            right: 48,
            bottom: 64,
            color: "rgba(255,255,255,0.7)",
            fontSize: 22,
            fontFamily: "system-ui, sans-serif",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {remainSec}s
        </div>
      ) : null}
      {config.watermark?.text ? (
        <div
          style={{
            position: "absolute",
            left: 48,
            top: 56,
            color: "#fff",
            opacity: config.watermark.opacity,
            fontSize: 20,
            fontFamily: "system-ui, sans-serif",
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          {config.watermark.text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
