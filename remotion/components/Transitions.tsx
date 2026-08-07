import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { TransitionKind } from "../config/types";

type Props = {
  kind: TransitionKind;
  /** Local frames of this scene */
  durationInFrames: number;
  transitionFrames?: number;
  children: React.ReactNode;
};

/**
 * Scene enter transitions. Prefer enter-only fades so consecutive gameplay
 * doesn't dip to black between beats.
 */
export const Transitions: React.FC<Props> = ({
  kind,
  durationInFrames,
  transitionFrames = 10,
  children,
}) => {
  const frame = useCurrentFrame();
  const tf = Math.max(2, Math.min(transitionFrames, Math.floor(durationInFrames / 4)));

  let opacity = 1;
  let scale = 1;
  let x = 0;
  let blurPx = 0;
  let flashWhite = 0;

  switch (kind) {
    case "fade":
      opacity = interpolate(frame, [0, tf], [0, 1], { extrapolateRight: "clamp" });
      scale = interpolate(frame, [0, tf], [1.04, 1], { extrapolateRight: "clamp" });
      break;
    case "flash":
      opacity = interpolate(frame, [0, tf], [0, 1], { extrapolateRight: "clamp" });
      flashWhite = interpolate(frame, [0, 2, 8], [1, 0.45, 0], {
        extrapolateRight: "clamp",
      });
      break;
    case "glitch": {
      opacity = interpolate(frame, [0, 2, 4, tf], [0, 1, 0.55, 1], {
        extrapolateRight: "clamp",
      });
      x = frame < tf ? (frame % 2 === 0 ? -10 : 8) : 0;
      break;
    }
    case "whip":
    case "match_cut":
      x = interpolate(frame, [0, tf], [120, 0], { extrapolateRight: "clamp" });
      opacity = interpolate(frame, [0, tf], [0, 1], { extrapolateRight: "clamp" });
      blurPx = interpolate(frame, [0, tf], [8, 0], { extrapolateRight: "clamp" });
      break;
    case "cut":
    case "none":
    default:
      break;
  }

  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `translateX(${x}px) scale(${scale})`,
        filter: blurPx > 0.2 ? `blur(${blurPx}px)` : undefined,
      }}
    >
      {children}
      {flashWhite > 0 ? (
        <AbsoluteFill style={{ background: "#fff", opacity: flashWhite }} />
      ) : null}
    </AbsoluteFill>
  );
};
