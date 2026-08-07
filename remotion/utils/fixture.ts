import type { Caption } from "@remotion/captions";
import type { ScheduledScene, StoryRenderInput } from "../config/types";
import {
  STORY_REMOTION_FPS,
  STORY_REMOTION_HEIGHT,
  STORY_REMOTION_WIDTH,
} from "../config/types";
import { defaultTheme } from "../config/defaultTheme";
import { secToFrames } from "./frames";

/**
 * Studio fixture — one continuous plate + karaoke captions (no intro/outro).
 */
export function buildFixtureStoryInput(): StoryRenderInput {
  const fps = STORY_REMOTION_FPS;
  const voiceDurationSec = 8;
  const bodyFrames = secToFrames(voiceDurationSec, fps);

  const captions: Caption[] = [
    { text: "I", startMs: 200, endMs: 450, timestampMs: 200, confidence: 1 },
    { text: " kept", startMs: 450, endMs: 700, timestampMs: 450, confidence: 1 },
    { text: " hearing", startMs: 700, endMs: 1100, timestampMs: 700, confidence: 1 },
    { text: " someone", startMs: 1100, endMs: 1500, timestampMs: 1100, confidence: 1 },
    { text: " crying", startMs: 1500, endMs: 2100, timestampMs: 1500, confidence: 1 },
    { text: " next", startMs: 2100, endMs: 2400, timestampMs: 2100, confidence: 1 },
    { text: " door.", startMs: 2400, endMs: 3000, timestampMs: 2400, confidence: 1 },
    { text: " At", startMs: 3200, endMs: 3400, timestampMs: 3200, confidence: 1 },
    { text: " first", startMs: 3400, endMs: 3800, timestampMs: 3400, confidence: 1 },
    { text: " I", startMs: 3800, endMs: 4000, timestampMs: 3800, confidence: 1 },
    { text: " thought", startMs: 4000, endMs: 4400, timestampMs: 4000, confidence: 1 },
    { text: " I", startMs: 4400, endMs: 4600, timestampMs: 4400, confidence: 1 },
    { text: " was", startMs: 4600, endMs: 4900, timestampMs: 4600, confidence: 1 },
    { text: " imagining", startMs: 4900, endMs: 5600, timestampMs: 4900, confidence: 1 },
    { text: " it.", startMs: 5600, endMs: 6200, timestampMs: 5600, confidence: 1 },
    { text: " I", startMs: 6400, endMs: 6600, timestampMs: 6400, confidence: 1 },
    { text: " shouldn't", startMs: 6600, endMs: 7200, timestampMs: 6600, confidence: 1 },
    { text: " have", startMs: 7200, endMs: 7500, timestampMs: 7200, confidence: 1 },
    { text: " knocked.", startMs: 7500, endMs: 8200, timestampMs: 7500, confidence: 1 },
  ];

  const sceneSchedule: ScheduledScene[] = [
    {
      sceneIndex: 0,
      startFrame: 0,
      endFrame: bodyFrames,
      narration:
        "I kept hearing someone crying next door. At first I thought I was imagining it. I shouldn't have knocked.",
      clipPath: null,
      clipStartSec: 0,
      captionStyle: "karaoke",
      camera: "static",
      transition: "cut",
      emotion: "calm",
    },
  ];

  return {
    fps,
    width: STORY_REMOTION_WIDTH,
    height: STORY_REMOTION_HEIGHT,
    voicePath: null,
    voiceDurationSec,
    captions,
    plan: {
      title: "The Knock Next Door",
      hook: "I kept hearing someone crying next door.",
      endingQuestion: "Would you have opened that door?",
      fullNarration:
        "I kept hearing someone crying next door. At first I thought I was imagining it. I shouldn't have knocked.",
    },
    brollClips: [],
    sceneSchedule,
    config: defaultTheme,
  };
}

export function getCompositionDurationInFrames(input: StoryRenderInput): number {
  const last = input.sceneSchedule[input.sceneSchedule.length - 1];
  const bodyEnd =
    last?.endFrame ?? secToFrames(input.voiceDurationSec, input.fps);
  return Math.max(1, bodyEnd);
}
