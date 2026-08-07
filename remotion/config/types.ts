/**
 * Remotion Story Short — shared types for the renderer.
 * Pipeline maps Groq/TTS/Whisper outputs into StoryRenderInput (Phase 2).
 */

import type { Caption } from "@remotion/captions";
import type { CameraMovement, CaptionStyle, SceneTransition, StoryPlan } from "@/lib/storyTypes";

export const STORY_REMOTION_FPS = 30;
export const STORY_REMOTION_WIDTH = 1080;
export const STORY_REMOTION_HEIGHT = 1920;

export type RemotionCaptionStyleId =
  | "karaoke"
  | "tiktok"
  | "reddit"
  | "horror"
  | "animated";

export type CameraPreset = CameraMovement | "none";

export type TransitionKind = SceneTransition | "none";

export type RenderThemeConfig = {
  theme: string;
  captionStyle: RemotionCaptionStyleId;
  colors: {
    highlight: string;
    text: string;
    accent: string;
    overlay: string;
    background: string;
  };
  font: {
    family: string;
    sizePx: number;
    strokePx: number;
  };
  animationSpeed: number;
  transitionDurationSec: number;
  camera: {
    defaultPreset: CameraPreset;
    intensity: number;
  };
  progressBar: {
    enabled: boolean;
    showCountdown: boolean;
  };
  intro: {
    enabled: boolean;
    variant: "true_story" | "part_one" | "scary_story" | "none";
    durationSec: number;
  };
  outro: {
    enabled: boolean;
    variant: "follow_part_two" | "subscribe" | "none";
    durationSec: number;
  };
  watermark?: {
    text: string;
    opacity: number;
  };
};

export type ScheduledScene = {
  sceneIndex: number;
  startFrame: number;
  endFrame: number;
  title?: string;
  narration: string;
  clipPath: string | null;
  /** Seconds into the gameplay file to start (trim). */
  clipStartSec: number;
  captionStyle: CaptionStyle | RemotionCaptionStyleId;
  camera: CameraPreset;
  transition: TransitionKind;
  /** Groq emotion — drives Phase 3 FX intensity */
  emotion?: string;
};

export type BrollClipMeta = {
  path: string;
  durationSec: number;
};

/**
 * Everything Remotion needs to render a Short.
 * Built in Node (Phase 2) — composition stays dumb React.
 */
export type StoryRenderInput = {
  fps: number;
  width: number;
  height: number;
  voicePath: string | null;
  voiceDurationSec: number;
  captions: Caption[];
  plan: Pick<StoryPlan, "title" | "hook" | "endingQuestion" | "fullNarration"> & {
    scenes?: StoryPlan["scenes"];
  };
  brollClips: BrollClipMeta[];
  sceneSchedule: ScheduledScene[];
  config: RenderThemeConfig;
};

export const STORY_SHORT_COMPOSITION_ID = "StoryShort";
