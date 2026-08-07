import React from "react";
import { Audio, Sequence } from "remotion";
import { resolveRemotionSrc } from "../utils/mediaSrc";

type Props = {
  src: string | null;
  /** Frame where VO begins (after intro). */
  startFrame?: number;
};

/** Narration track — public-relative path or http(s). */
export const AudioLayer: React.FC<Props> = ({ src, startFrame = 0 }) => {
  const resolved = resolveRemotionSrc(src);
  if (!resolved) return null;
  return (
    <Sequence from={startFrame} name="voice-over">
      <Audio src={resolved} />
    </Sequence>
  );
};
