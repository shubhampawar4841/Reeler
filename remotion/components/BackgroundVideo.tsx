import React from "react";
import { AbsoluteFill, OffthreadVideo, useVideoConfig } from "remotion";
import { resolveRemotionSrc } from "../utils/mediaSrc";

type Props = {
  src: string | null;
  /** Seconds into source to start. */
  startFromSec?: number;
  muted?: boolean;
  fallbackColor?: string;
};

/**
 * Gameplay / B-roll layer. Null src → solid fallback (Phase 1 fixture).
 * Local clips must be under public/ and passed as public-relative paths.
 */
export const BackgroundVideo: React.FC<Props> = ({
  src,
  startFromSec = 0,
  muted = true,
  fallbackColor = "#12121a",
}) => {
  const { fps } = useVideoConfig();
  const startFrom = Math.max(0, Math.round(startFromSec * fps));
  const resolved = resolveRemotionSrc(src);

  if (!resolved) {
    return (
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 40% 30%, #2a1a22 0%, ${fallbackColor} 70%)`,
        }}
      />
    );
  }

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={resolved}
        muted={muted}
        startFrom={startFrom}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
