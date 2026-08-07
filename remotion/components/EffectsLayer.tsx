import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderThemeConfig } from "../config/types";

type Props = {
  /** 0–1 strength */
  vignette?: number;
  grain?: boolean;
  redFlashAtFrame?: number | null;
  fog?: boolean;
  /** Occasional lightning flicker */
  lightning?: boolean;
  config: RenderThemeConfig;
};

/** Overlay stack (vignette / grain / fog / flash / lightning). */
export const EffectsLayer: React.FC<Props> = ({
  vignette = 0.55,
  grain = true,
  redFlashAtFrame = null,
  fog = false,
  lightning = false,
  config,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  let flash = 0;
  if (redFlashAtFrame != null) {
    const d = frame - redFlashAtFrame;
    if (d >= 0 && d < 12) {
      flash = interpolate(d, [0, 3, 12], [0.65, 0.4, 0]);
    }
  }

  const fogOpacity = fog
    ? interpolate(Math.sin(frame / 16), [-1, 1], [0.1, 0.22])
    : 0;

  // Sparse lightning bursts
  let bolt = 0;
  if (lightning) {
    const cycle = frame % 55;
    if (cycle === 8 || cycle === 10) bolt = 0.55;
    if (cycle === 9) bolt = 0.9;
    if (cycle === 22) bolt = 0.35;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {vignette > 0 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at center, transparent 32%, rgba(0,0,0,${vignette}) 100%)`,
          }}
        />
      )}
      {fog && (
        <AbsoluteFill
          style={{
            background:
              "linear-gradient(180deg, rgba(160,170,190,0.16) 0%, transparent 42%, rgba(10,10,18,0.35) 100%)",
            opacity: fogOpacity,
          }}
        />
      )}
      {grain && (
        <AbsoluteFill
          style={{
            opacity: 0.09,
            backgroundImage:
              "repeating-radial-gradient(circle at 20% 30%, #fff 0 0.5px, transparent 1px 3px)",
            backgroundSize: "110px 110px",
            mixBlendMode: "overlay",
            transform: `translateY(${(frame % 5) - 2}px)`,
          }}
        />
      )}
      {flash > 0 && (
        <AbsoluteFill style={{ background: config.colors.accent, opacity: flash }} />
      )}
      {bolt > 0 && (
        <AbsoluteFill style={{ background: "#eef3ff", opacity: bolt }} />
      )}
      <AbsoluteFill
        style={{
          opacity: interpolate(
            frame,
            [Math.max(0, durationInFrames - 12), durationInFrames],
            [0, 0.35],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          ),
          background: "#000",
        }}
      />
    </AbsoluteFill>
  );
};
