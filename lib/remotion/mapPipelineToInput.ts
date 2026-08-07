/**
 * Map prepared story assets → Remotion StoryRenderInput.
 *
 * Simple format: one continuous B-roll + VO + Whisper karaoke captions.
 * No intro/outro, no scene cuts / clip switching.
 *
 * Media must live under public/ and be referenced as public-relative paths
 * (Remotion staticFile).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Caption } from "@remotion/captions";
import type { StoryLang } from "@/lib/groqStoryboard";
import type { StoryPlan } from "@/lib/storyTypes";
import { defaultTheme } from "@/remotion/config/defaultTheme";
import type {
  RenderThemeConfig,
  ScheduledScene,
  StoryRenderInput,
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
  /** Ignored — intro/outro always off in the captions-only Remotion path. */
  enableIntroOutro?: boolean;
  onLog?: (msg: string) => void;
};

function captionsOnlyTheme(lang: StoryLang): RenderThemeConfig {
  return {
    ...defaultTheme,
    font: {
      ...defaultTheme.font,
      family:
        lang === "hi"
          ? "Nirmala UI, Arial Black, sans-serif"
          : defaultTheme.font.family,
    },
    camera: {
      defaultPreset: "static",
      intensity: 1,
    },
    progressBar: {
      enabled: false,
      showCountdown: false,
    },
    intro: {
      ...defaultTheme.intro,
      enabled: false,
    },
    outro: {
      ...defaultTheme.outro,
      enabled: false,
    },
  };
}

/** public-relative path using forward slashes (for staticFile). */
function publicRel(jobId: string, ...parts: string[]): string {
  return ["output", jobId, ...parts].join("/");
}

/**
 * Copy VO + one B-roll into public/output/<jobId>/assets.
 * Returns StoryRenderInput with a single continuous scene for Remotion.
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
    lang,
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

  // One continuous B-roll — pick a random source, one random in-point trim.
  const src = poolMeta[Math.floor(Math.random() * poolMeta.length)]!;
  const destName = `broll${path.extname(src.path) || ".mp4"}`;
  const dest = path.join(assetsDir, destName);
  onLog?.(`Copying continuous B-roll ${src.label} → assets/${destName}`);
  await fs.copyFile(src.path, dest);
  const clipPublic = publicRel(jobId, "assets", destName);

  const needSec = Math.max(0.5, voiceSec);
  const maxStart = Math.max(0, src.dur - needSec - 0.05);
  const clipStartSec = maxStart > 0 ? Math.random() * maxStart : 0;
  if (src.dur + 0.05 < needSec) {
    onLog?.(
      `B-roll ${src.label} (${src.dur.toFixed(1)}s) shorter than VO (${needSec.toFixed(1)}s) — will loop`
    );
  } else {
    onLog?.(
      `Continuous B-roll trim @ ${clipStartSec.toFixed(1)}s for ${needSec.toFixed(1)}s (no scene cuts)`
    );
  }

  const fps = STORY_REMOTION_FPS;
  const config = captionsOnlyTheme(lang);
  const durFrames = secToFrames(needSec, fps);

  const sceneSchedule: ScheduledScene[] = [
    {
      sceneIndex: 0,
      startFrame: 0,
      endFrame: Math.max(1, durFrames),
      title: plan.title,
      narration: plan.fullNarration,
      clipPath: clipPublic,
      clipStartSec,
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
    brollClips: [
      {
        path: clipPublic,
        durationSec: src.dur,
      },
    ],
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
