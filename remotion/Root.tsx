import React from "react";
import { Composition } from "remotion";
import {
  STORY_REMOTION_FPS,
  STORY_REMOTION_HEIGHT,
  STORY_REMOTION_WIDTH,
  STORY_SHORT_COMPOSITION_ID,
} from "./config/types";
import { StoryShort } from "./compositions/StoryShort";
import { buildFixtureStoryInput, getCompositionDurationInFrames } from "./utils/fixture";

const fixture = buildFixtureStoryInput();

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id={STORY_SHORT_COMPOSITION_ID}
        component={StoryShort}
        durationInFrames={getCompositionDurationInFrames(fixture)}
        fps={STORY_REMOTION_FPS}
        width={STORY_REMOTION_WIDTH}
        height={STORY_REMOTION_HEIGHT}
        defaultProps={{ input: fixture }}
        calculateMetadata={async ({ props }) => {
          const input = props.input ?? fixture;
          return {
            durationInFrames: getCompositionDurationInFrames(input),
            fps: input.fps || STORY_REMOTION_FPS,
            width: input.width || STORY_REMOTION_WIDTH,
            height: input.height || STORY_REMOTION_HEIGHT,
          };
        }}
      />
    </>
  );
};
