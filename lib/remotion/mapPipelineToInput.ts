/**
 * Map prepared story assets → Remotion StoryRenderInput.
 * Used when STORY_RENDERER=remotion (Phase 2).
 *
 * Media must live under public/ and be referenced as public-relative paths
 * (Remotion staticFile) — file:// and raw disk paths fail in headless Chrome.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Caption } from "@remotion/captions";
import type { StoryLang } from "@/lib/groqStoryboard";
import type { StoryPlan } from "@/lib/storyTypes";
import { defaultTheme } from "@/remotion/config/defaultTheme";
import type {
  CameraPreset,
  RenderThemeConfig,
  ScheduledScene,
  StoryRenderInput,
  TransitionKind,
} from "@/remotion/config/types";
import {
  STORY_REMOTION_FPS,
  STORY_REMOTION_HEIGHT,
  STORY_REMOTION_WIDTH,
} from "@/remotion/config/types";
import { secToFrames } from "@/remotion/utils/frames";

export type BrollPoolItem = {
  path: string;
  dur: number;
  label: string;
};

export type MapPipelineToInputArgs = {
  jobId: string;
  /** Absolute dir: public/output/<jobId> */
  outDir: string;
  plan: StoryPlan;
  voicePath: string;
  voiceSec: number;
  captions: Caption[];
  poolMeta: BrollPoolItem[];
  sceneDurations: number[];
  lang: StoryLang;
  /** When false, skip title/outro cards. Default true (Phase 3). Opt out: STORY_REMOTION_INTRO=0 */
  enableIntroOutro?: boolean;
  onLog?: (msg: string) => void;
};

function productionTheme(
  lang: StoryLang,
  enableIntroOutro: boolean
): RenderThemeConfig {
  return {
    ...defaultTheme,
    font: {
      ...defaultTheme.font,
      family:
        lang === "hi"
          ? "Nirmala UI, Arial Black, sans-serif"
          : defaultTheme.font.family,
    },
    intro: {
      ...defaultTheme.intro,
      enabled: enableIntroOutro,
    },
    outro: {
      ...defaultTheme.outro,
      enabled: enableIntroOutro,
    },
  };
}

/** public-relative path using forward slashes (for staticFile). */
function publicRel(jobId: string, ...parts: string[]): string {
  return ["output", jobId, ...parts].join("/");
}

/**
 * Copy VO + B-roll into public/output/<jobId>/assets so Remotion can staticFile them.
 * Returns StoryRenderInput ready for renderMedia.
 */
export async function mapPipelineToInput(
  args: MapPipelineToInputArgs
): Promise<StoryRenderInput> {
  const {
    jobId,
    outDir,
    plan,
    voicePath,
    voiceSec,
    captions,
    poolMeta,
    sceneDurations,
    lang,
    enableIntroOutro = true,
    onLog,
  } = args;

  if (poolMeta.length === 0) {
    throw new Error("mapPipelineToInput: empty B-roll pool");
  }

  const assetsDir = path.join(outDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const voiceDest = path.join(assetsDir, "voice.wav");
  onLog?.("Copying VO into public assets for Remotion…");
  await fs.copyFile(voicePath, voiceDest);
  const voicePublic = publicRel(jobId, "assets", "voice.wav");

  const brollPublicByAbs = new Map<string, string>();
  for (let i = 0; i < poolMeta.length; i++) {
    const item = poolMeta[i]!;
    const destName = `broll-${i + 1}${path.extname(item.path) || ".mp4"}`;
    const dest = path.join(assetsDir, destName);
    onLog?.(`Copying B-roll ${item.label} → assets/${destName}`);
    await fs.copyFile(item.path, dest);
    brollPublicByAbs.set(path.resolve(item.path), publicRel(jobId, "assets", destName));
  }

  const fps = STORY_REMOTION_FPS;
  const config = productionTheme(lang, enableIntroOutro);
  const introFrames = config.intro.enabled
    ? secToFrames(config.intro.durationSec, fps)
    : 0;

  let cursor = introFrames;
  const sceneSchedule: ScheduledScene[] = plan.scenes.map((sc, i) => {
    const durSec = Math.max(0.5, sceneDurations[i] ?? 1);
    const durFrames = secToFrames(durSec, fps);
    const src = poolMeta[Math.floor(Math.random() * poolMeta.length)]!;
    const maxStart = Math.max(0, src.dur - durSec - 0.05);
    const clipStartSec = maxStart > 0 ? Math.random() * maxStart : 0;
    const clipPublic =
      brollPublicByAbs.get(path.resolve(src.path)) ??
      publicRel(jobId, "assets", `broll-1.mp4`);

    const startFrame = cursor;
    const endFrame = cursor + durFrames;
    cursor = endFrame;

    return {
      sceneIndex: i,
      startFrame,
      endFrame,
      title: plan.title,
      narration: sc.narration,
      clipPath: clipPublic,
      clipStartSec,
      captionStyle: sc.captionStyle,
      camera: (sc.cameraMovement || config.camera.defaultPreset) as CameraPreset,
      transition: (sc.transition || "cut") as TransitionKind,
      emotion: sc.emotion,
    };
  });

  const bodyTarget = introFrames + secToFrames(voiceSec, fps);
  if (sceneSchedule.length > 0) {
    const last = sceneSchedule[sceneSchedule.length - 1]!;
    last.endFrame = Math.max(last.startFrame + 1, bodyTarget);
  }

  return {
    fps,
    width: STORY_REMOTION_WIDTH,
    height: STORY_REMOTION_HEIGHT,
    voicePath: voicePublic,
    voiceDurationSec: voiceSec,
    captions,
    plan: {
      title: plan.title,
      hook: plan.hook,
      endingQuestion: plan.endingQuestion,
      fullNarration: plan.fullNarration,
      scenes: plan.scenes,
    },
    brollClips: poolMeta.map((p, i) => ({
      path:
        brollPublicByAbs.get(path.resolve(p.path)) ??
        publicRel(jobId, "assets", `broll-${i + 1}.mp4`),
      durationSec: p.dur,
    })),
    sceneSchedule,
    config,
  };
}

/** Best-effort cleanup of Remotion staging assets (keep story.mp4). */
export async function cleanupRemotionAssets(outDir: string): Promise<void> {
  try {
    await fs.rm(path.join(outDir, "assets"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
