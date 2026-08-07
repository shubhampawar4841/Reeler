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
 * Phase 1 fixture — no TTS/Whisper/Groq.
 * Uses solid fallback bg when clipPath is null; captions drive karaoke.
 */
export function buildFixtureStoryInput(): StoryRenderInput {
  const fps = STORY_REMOTION_FPS;
  const voiceDurationSec = 8;
  const introSec = defaultTheme.intro.enabled ? defaultTheme.intro.durationSec : 0;
  const outroSec = defaultTheme.outro.enabled ? defaultTheme.outro.durationSec : 0;
  const bodySec = voiceDurationSec;
  const introFrames = secToFrames(introSec, fps);
  const bodyFrames = secToFrames(bodySec, fps);
  const half = Math.floor(bodyFrames / 2);

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
      startFrame: introFrames,
      endFrame: introFrames + half,
      narration: "I kept hearing someone crying next door.",
      clipPath: null,
      clipStartSec: 0,
      captionStyle: "karaoke",
      camera: "slow_push_in",
      transition: "fade",
      emotion: "curiosity",
    },
    {
      sceneIndex: 1,
      startFrame: introFrames + half,
      endFrame: introFrames + bodyFrames,
      narration: "At first I thought I was imagining it.",
      clipPath: null,
      clipStartSec: 12,
      captionStyle: "horror",
      camera: "handheld_shake",
      transition: "glitch",
      emotion: "panic",
    },
  ];

  return {
    fps,
    width: STORY_REMOTION_WIDTH,
    height: STORY_REMOTION_HEIGHT,
    voicePath: null,
    voiceDurationSec: voiceDurationSec + introSec + outroSec,
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
  const intro = input.config.intro.enabled
    ? secToFrames(input.config.intro.durationSec, input.fps)
    : 0;
  const outro = input.config.outro.enabled
    ? secToFrames(input.config.outro.durationSec, input.fps)
    : 0;
  const last = input.sceneSchedule[input.sceneSchedule.length - 1];
  const bodyEnd = last?.endFrame ?? secToFrames(input.voiceDurationSec, input.fps);
  return Math.max(intro + outro + 1, bodyEnd + outro);
}
