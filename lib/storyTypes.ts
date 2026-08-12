/**
 * Shared types for the faceless storytelling pipeline
 * (Groq planner → TTS → captions → Remotion / FFmpeg).
 */

export type StoryLang = "en" | "hi";

export type StoryEmotion =
  | "fear"
  | "regret"
  | "shock"
  | "curiosity"
  | "dread"
  | "confusion"
  | "loneliness"
  | "guilt"
  | "panic"
  | "awe"
  | "unease";

export type CameraMovement =
  | "static"
  | "slow_push_in"
  | "slow_pull_out"
  | "drift_left"
  | "drift_right"
  | "handheld_shake"
  | "crash_zoom"
  | "tilt_up"
  | "tilt_down";

export type CaptionStyle =
  | "center_punch"
  | "lower_third"
  | "whisper"
  | "impact"
  | "karaoke";

export type SceneTransition =
  | "cut"
  | "fade"
  | "flash"
  | "glitch"
  | "whip"
  | "match_cut";

export type MusicMood =
  | "dark_ambient"
  | "tense_pulse"
  | "eerie_drone"
  | "heart_race"
  | "lonely_piano"
  | "apocalyptic"
  | "quiet_dread";

export type StoryScene = {
  index: number;
  /** Spoken line for this shot (Kokoro-friendly, short) */
  narration: string;
  startSec: number;
  durationSec: number;
  emotion: StoryEmotion;
  cameraMovement: CameraMovement;
  captionStyle: CaptionStyle;
  /** Words to highlight in Remotion captions */
  captionHighlightWords: string[];
  /** Short concrete Pexels search (English) */
  pexelsQuery: string;
  /** Cinematic AI image prompt */
  imagePrompt: string;
  transition: SceneTransition;
  /** Suggested SFX label, e.g. "distant footsteps" */
  soundEffect: string;
};

export type StoryPlan = {
  title: string;
  /** First spoken line — impossible event */
  hook: string;
  /** Full voice-over script */
  fullNarration: string;
  /**
   * Timed script for captions, e.g.
   * (0:00) First line. (0:05) Second line.
   */
  timedTranscript: string;
  estimatedDuration: number;
  musicMood: MusicMood;
  thumbnailPrompt: string;
  /** Lingering question left with the viewer */
  endingQuestion: string;
  hashtags: string[];
  scenes: StoryScene[];
};

export function getPexelsApiKey(): string {
  const k =
    process.env.PEXELS_API_KEY?.trim() ||
    process.env.YOUR_PEXELS_API_KEY?.trim() ||
    "";
  if (!k) throw new Error("Missing PEXELS_API_KEY in .env");
  return k;
}

export function getGroqApiKey(): string {
  const k = process.env.GROQ_API_KEY?.trim() || "";
  if (!k) throw new Error("Missing GROQ_API_KEY in .env");
  return k;
}

/** Optional — story planner prefers Gemini when set. */
export function getGeminiApiKey(): string | null {
  const k = process.env.GEMINI_API_KEY?.trim() || "";
  return k || null;
}
