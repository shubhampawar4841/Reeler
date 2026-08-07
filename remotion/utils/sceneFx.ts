import type { StoryEmotion } from "@/lib/storyTypes";
import type {
  RemotionCaptionStyleId,
  ScheduledScene,
} from "../config/types";

/** Map Groq captionStyle → Remotion style id. */
export function mapCaptionStyle(
  style: ScheduledScene["captionStyle"] | undefined,
  fallback: RemotionCaptionStyleId = "karaoke"
): RemotionCaptionStyleId {
  const key = String(style ?? "");
  const map: Record<string, RemotionCaptionStyleId> = {
    karaoke: "karaoke",
    center_punch: "tiktok",
    lower_third: "tiktok",
    whisper: "reddit",
    impact: "horror",
    tiktok: "tiktok",
    reddit: "reddit",
    horror: "horror",
    animated: "animated",
  };
  return map[key] ?? fallback;
}

export type SceneFx = {
  vignette: number;
  fog: boolean;
  grain: boolean;
  redFlashAtFrame: number | null;
  cameraIntensity: number;
  /** Prefer horror captions on peak emotion scenes */
  forceHorrorCaptions: boolean;
};

export function emotionToFx(
  emotion: StoryEmotion | string | undefined,
  camera: string,
  sceneIndex: number,
  sceneCount: number
): SceneFx {
  const e = String(emotion || "dread");
  const late = sceneCount > 0 && sceneIndex >= Math.floor(sceneCount * 0.65);

  let vignette = 0.52;
  let fog = false;
  let cameraIntensity = 1;
  let redFlashAtFrame: number | null = null;
  let forceHorrorCaptions = false;

  switch (e) {
    case "panic":
    case "shock":
      vignette = 0.72;
      cameraIntensity = 1.45;
      redFlashAtFrame = 1;
      forceHorrorCaptions = true;
      break;
    case "fear":
    case "dread":
    case "unease":
      vignette = 0.65;
      fog = true;
      cameraIntensity = 1.15;
      break;
    case "guilt":
    case "regret":
    case "loneliness":
      vignette = 0.6;
      fog = true;
      cameraIntensity = 0.9;
      break;
    case "curiosity":
    case "confusion":
      vignette = 0.45;
      cameraIntensity = 1.05;
      break;
    case "awe":
      vignette = 0.4;
      cameraIntensity = 1.2;
      break;
    default:
      break;
  }

  if (camera === "crash_zoom" || camera === "handheld_shake") {
    cameraIntensity *= 1.2;
    if (redFlashAtFrame == null && (e === "panic" || e === "shock")) {
      redFlashAtFrame = 2;
    }
  }

  if (late) {
    vignette = Math.min(0.85, vignette + 0.1);
    fog = fog || late;
    forceHorrorCaptions = forceHorrorCaptions || late;
  }

  return {
    vignette,
    fog,
    grain: true,
    redFlashAtFrame,
    cameraIntensity,
    forceHorrorCaptions,
  };
}
