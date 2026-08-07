/**
 * Server-side Remotion render for story Shorts (Phase 1).
 * Only import from Node / API routes — never from client components.
 */

import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { StoryRenderInput } from "@/remotion/config/types";
import { STORY_SHORT_COMPOSITION_ID } from "@/remotion/config/types";
import { getCompositionDurationInFrames } from "@/remotion/utils/fixture";

export type RenderStoryOptions = {
  input: StoryRenderInput;
  outPath: string;
  onLog?: (msg: string) => void;
};

let bundlePathPromise: Promise<string> | null = null;

function getEntryPoint(): string {
  return path.join(process.cwd(), "remotion", "index.ts");
}

async function getBundle(onLog?: (msg: string) => void): Promise<string> {
  if (!bundlePathPromise) {
    onLog?.("Bundling Remotion composition…");
    bundlePathPromise = bundle({
      entryPoint: getEntryPoint(),
      onProgress: (p) => {
        if (p === 1) onLog?.("Remotion bundle ready");
      },
    }).catch((err) => {
      bundlePathPromise = null;
      throw err;
    });
  }
  return bundlePathPromise;
}

/**
 * Render StoryShort → MP4 at outPath.
 * Phase 1: used by smoke script / optional flag (pipeline still defaults to FFmpeg).
 */
export async function renderStoryShort(
  options: RenderStoryOptions
): Promise<{ outPath: string; durationInFrames: number }> {
  const { input, outPath, onLog } = options;
  const serveUrl = await getBundle(onLog);

  const durationInFrames = getCompositionDurationInFrames(input);
  onLog?.(
    `Selecting ${STORY_SHORT_COMPOSITION_ID} (${durationInFrames} frames @ ${input.fps}fps)…`
  );

  const composition = await selectComposition({
    serveUrl,
    id: STORY_SHORT_COMPOSITION_ID,
    inputProps: { input },
  });

  onLog?.(`Rendering Remotion → ${path.basename(outPath)}`);
  await renderMedia({
    composition: {
      ...composition,
      durationInFrames,
      fps: input.fps,
      width: input.width,
      height: input.height,
    },
    serveUrl,
    codec: "h264",
    outputLocation: outPath,
    inputProps: { input },
    concurrency: 1,
    // Remotion finds chromium; on Windows may download on first run
  });

  onLog?.("Remotion render complete");
  return { outPath, durationInFrames };
}

/** Read env flag — default ffmpeg; set STORY_RENDERER=remotion for Remotion mux. */
export function getStoryRendererMode(): "ffmpeg" | "remotion" {
  const raw = (process.env.STORY_RENDERER || "ffmpeg").trim().toLowerCase();
  return raw === "remotion" ? "remotion" : "ffmpeg";
}
