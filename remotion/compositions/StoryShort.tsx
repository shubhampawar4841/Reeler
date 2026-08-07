import React from "react";
import { AbsoluteFill } from "remotion";
import type { StoryRenderInput } from "../config/types";
import { VideoComposition } from "../components/VideoComposition";

export type StoryShortProps = {
  input: StoryRenderInput;
};

/** Registered Remotion composition entry for story Shorts. */
export const StoryShort: React.FC<StoryShortProps> = ({ input }) => {
  if (!input) {
    return <AbsoluteFill style={{ backgroundColor: "#000" }} />;
  }
  return <VideoComposition input={input} />;
};
