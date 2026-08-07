import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import type {
  RemotionCaptionStyleId,
  ScheduledScene,
  StoryRenderInput,
} from "../config/types";
import { secToFrames } from "../utils/frames";
import { emotionToFx, mapCaptionStyle } from "../utils/sceneFx";
import { AudioLayer } from "./AudioLayer";
import { CaptionLayer } from "./CaptionLayer";
import { CTA } from "./CTA";
import { ProgressBar } from "./ProgressBar";
import { Scene } from "./Scene";
import { TitleCard } from "./TitleCard";

export type VideoCompositionProps = {
  input: StoryRenderInput;
};

function styleForBodyFrame(
  localFrame: number,
  introFrames: number,
  schedule: ScheduledScene[],
  fallback: RemotionCaptionStyleId
): RemotionCaptionStyleId {
  const abs = localFrame + introFrames;
  const scene =
    schedule.find((s) => abs >= s.startFrame && abs < s.endFrame) ??
    schedule[schedule.length - 1];
  if (!scene) return fallback;

  const fx = emotionToFx(
    scene.emotion,
    scene.camera,
    scene.sceneIndex,
    schedule.length
  );
  if (fx.forceHorrorCaptions) return "horror";
  return mapCaptionStyle(scene.captionStyle, fallback);
}

const DynamicCaptions: React.FC<{
  input: StoryRenderInput;
  introFrames: number;
}> = ({ input, introFrames }) => {
  const frame = useCurrentFrame();
  const styleId = useMemo(
    () =>
      styleForBodyFrame(
        frame,
        introFrames,
        input.sceneSchedule,
        input.config.captionStyle
      ),
    [frame, introFrames, input.sceneSchedule, input.config.captionStyle]
  );

  return (
    <CaptionLayer
      captions={input.captions}
      styleId={styleId}
      config={input.config}
      wordsPerLine={styleId === "horror" ? 2 : 3}
    />
  );
};

/**
 * Thin timeline assembler — intro → scenes → captions → outro.
 */
export const VideoComposition: React.FC<VideoCompositionProps> = ({ input }) => {
  const { config, plan, sceneSchedule, voicePath, fps } = input;
  const introFrames = config.intro.enabled
    ? secToFrames(config.intro.durationSec, fps)
    : 0;
  const outroFrames = config.outro.enabled
    ? secToFrames(config.outro.durationSec, fps)
    : 0;
  const lastEnd =
    sceneSchedule[sceneSchedule.length - 1]?.endFrame ?? introFrames;
  const bodyFrames = Math.max(1, lastEnd - introFrames);
  const sceneCount = sceneSchedule.length;

  return (
    <AbsoluteFill style={{ backgroundColor: config.colors.background }}>
      {config.intro.enabled && config.intro.variant !== "none" ? (
        <Sequence from={0} durationInFrames={introFrames} name="intro">
          <TitleCard
            title={plan.title}
            hook={plan.hook}
            variant={config.intro.variant}
            config={config}
          />
        </Sequence>
      ) : null}

      <AudioLayer src={voicePath} startFrame={introFrames} />

      {sceneSchedule.map((scene) => {
        const dur = Math.max(1, scene.endFrame - scene.startFrame);
        return (
          <Sequence
            key={`scene-${scene.sceneIndex}`}
            from={scene.startFrame}
            durationInFrames={dur}
            name={`scene-${scene.sceneIndex}`}
          >
            <Scene
              scene={scene}
              config={config}
              durationInFrames={dur}
              sceneCount={sceneCount}
            />
          </Sequence>
        );
      })}

      <Sequence from={introFrames} durationInFrames={bodyFrames} name="captions">
        <DynamicCaptions input={input} introFrames={introFrames} />
      </Sequence>

      {config.outro.enabled && config.outro.variant !== "none" ? (
        <Sequence from={lastEnd} durationInFrames={outroFrames} name="outro">
          <CTA
            endingQuestion={plan.endingQuestion}
            variant={config.outro.variant}
            config={config}
          />
        </Sequence>
      ) : null}

      <ProgressBar config={config} />
    </AbsoluteFill>
  );
};
