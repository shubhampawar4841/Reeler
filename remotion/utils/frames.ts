import { STORY_REMOTION_FPS } from "../config/types";

export function secToFrames(sec: number, fps = STORY_REMOTION_FPS): number {
  return Math.max(1, Math.round(sec * fps));
}

export function framesToSec(frames: number, fps = STORY_REMOTION_FPS): number {
  return frames / fps;
}

export function msToFrames(ms: number, fps = STORY_REMOTION_FPS): number {
  return Math.round((ms / 1000) * fps);
}

export function frameToMs(frame: number, fps = STORY_REMOTION_FPS): number {
  return (frame / fps) * 1000;
}
