import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import type { StoryRenderInput } from "../config/types";
import { AudioLayer } from "./AudioLayer";
import { CaptionLayer } from "./CaptionLayer";
import { Scene } from "./Scene";

export type VideoCompositionProps = {
  input: StoryRenderInput;
};

/**
 * Captions-focused composition: continuous B-roll + VO + karaoke captions.
 * No intro/outro cards, progress bar, or multi-clip switches.
 */
export const VideoComposition: React.FC<VideoCompositionProps> = ({ input }) => {
  const { config, sceneSchedule, voicePath } = input;
  const lastEnd = sceneSchedule[sceneSchedule.length - 1]?.endFrame ?? 1;
  const bodyFrames = Math.max(1, lastEnd);

  return (
    <AbsoluteFill style={{ backgroundColor: config.colors.background }}>
      <AudioLayer src={voicePath} startFrame={0} />

      {sceneSchedule.map((scene) => {
        const dur = Math.max(1, scene.endFrame - scene.startFrame);
        return (
          <Sequence
            key={`scene-${scene.sceneIndex}`}
            from={scene.startFrame}
            durationInFrames={dur}
            name={`broll-${scene.sceneIndex}`}
          >
            <Scene scene={scene} config={config} durationInFrames={dur} />
          </Sequence>
        );
      })}

      <Sequence from={0} durationInFrames={bodyFrames} name="captions">
        <CaptionLayer
          captions={input.captions}
          styleId={config.captionStyle}
          config={config}
          wordsPerLine={3}
        />
      </Sequence>
    </AbsoluteFill>
  );
};
