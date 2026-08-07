import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { CameraPreset } from "../config/types";

type Props = {
  preset: CameraPreset;
  intensity?: number;
  children: React.ReactNode;
};

/**
 * Applies camera motion to children via CSS transforms.
 * Phase 1: zoom / pan / shake. Phase 3 can expand blur/vignette mapping.
 */
export const CameraController: React.FC<Props> = ({
  preset,
  intensity = 1,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);
  const i = Math.max(0.2, intensity);

  let scale = 1;
  let x = 0;
  let y = 0;
  let rotate = 0;

  switch (preset) {
    case "slow_push_in":
      scale = interpolate(t, [0, 1], [1, 1 + 0.12 * i]);
      break;
    case "slow_pull_out":
      scale = interpolate(t, [0, 1], [1 + 0.1 * i, 1]);
      break;
    case "drift_left":
      x = interpolate(t, [0, 1], [0, -40 * i]);
      scale = 1.08;
      break;
    case "drift_right":
      x = interpolate(t, [0, 1], [0, 40 * i]);
      scale = 1.08;
      break;
    case "tilt_up":
      y = interpolate(t, [0, 1], [20 * i, -30 * i]);
      scale = 1.06;
      break;
    case "tilt_down":
      y = interpolate(t, [0, 1], [-20 * i, 30 * i]);
      scale = 1.06;
      break;
    case "crash_zoom":
      scale = interpolate(t, [0, 0.25, 1], [1, 1.25 * i, 1.15], {
        extrapolateRight: "clamp",
      });
      break;
    case "handheld_shake":
      x = Math.sin(frame * 0.9) * 4 * i;
      y = Math.cos(frame * 1.1) * 3 * i;
      rotate = Math.sin(frame * 0.7) * 0.4 * i;
      scale = 1.06;
      break;
    case "static":
    case "none":
    default:
      break;
  }

  return (
    <AbsoluteFill
      style={{
        transform: `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotate}deg)`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
