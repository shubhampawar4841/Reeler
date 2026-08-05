/**
 * Shared types for the AI Shorts pipeline (SRT cues, FFmpeg progress, etc.).
 */

/** One timed line from `(M:SS)` markers before normalization (start/end in seconds). */
export type Cue = {
  start: number;
  end: number;
  text: string;
};

/** One subtitle line after parsing an SRT file */
export type SubtitleCue = {
  index: number;
  /** Plain subtitle text (newlines preserved as spaces for burn-in if needed) */
  text: string;
  /** Start time in seconds */
  startSec: number;
  /** End time in seconds */
  endSec: number;
  /** endSec - startSec */
  durationSec: number;
};

export type UploadResult = {
  sessionId: string;
  imagePaths: string[];
  musicPath?: string;
};
