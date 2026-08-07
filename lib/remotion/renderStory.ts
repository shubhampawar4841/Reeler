/**
 * Server-side Remotion render for story Shorts.
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
  concurrency?: number;
};

export type RemotionRenderTimings = {
  bundleMs: number;
  selectMs: number;
  renderMediaMs: number;
  totalMs: number;
  /** Remotion: time until all frames rendered (may overlap encode) */
  framesDoneInMs: number | null;
  /** Remotion: time until encode finished */
  encodeDoneInMs: number | null;
  frames: number;
  concurrency: number;
};

export type RemotionProfileResult = {
  outPath: string;
  durationInFrames: number;
  timings: RemotionRenderTimings;
};

let bundlePathPromise: Promise<string> | null = null;

function getEntryPoint(): string {
  return path.join(process.cwd(), "remotion", "index.ts");
}

/** Clear in-memory bundle cache (for cold-start profiling). */
export function resetRemotionBundleCache(): void {
  bundlePathPromise = null;
}

async function getBundle(onLog?: (msg: string) => void): Promise<{
  serveUrl: string;
  bundleMs: number;
}> {
  const t0 = performance.now();
  if (!bundlePathPromise) {
    onLog?.("Bundling Remotion composition…");
    bundlePathPromise = bundle({
      entryPoint: getEntryPoint(),
      // Windows pack cache can corrupt (PackFileCacheStrategy "Expected end of object")
      enableCaching: false,
      onProgress: (p) => {
        if (p === 0 || p === 1) {
          onLog?.(`Remotion bundle ${(p * 100).toFixed(0)}%`);
        }
      },
    }).catch((err) => {
      bundlePathPromise = null;
      throw err;
    });
  }
  const serveUrl = await bundlePathPromise;
  return { serveUrl, bundleMs: performance.now() - t0 };
}

/**
 * Render StoryShort → MP4 at outPath.
 */
export async function renderStoryShort(
  options: RenderStoryOptions
): Promise<{ outPath: string; durationInFrames: number }> {
  const result = await renderStoryShortProfiled(options);
  return { outPath: result.outPath, durationInFrames: result.durationInFrames };
}

/**
 * Same as renderStoryShort but returns stage timings for profiling.
 */
export async function renderStoryShortProfiled(
  options: RenderStoryOptions
): Promise<RemotionProfileResult> {
  const { input, outPath, onLog } = options;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const tTotal = performance.now();

  const { serveUrl, bundleMs } = await getBundle(onLog);
  onLog?.(`Bundle stage ${bundleMs.toFixed(0)}ms (cached=${bundleMs < 50})`);

  const durationInFrames = getCompositionDurationInFrames(input);
  const estSec = (durationInFrames / (input.fps || 30)).toFixed(1);
  onLog?.(
    `Selecting ${STORY_SHORT_COMPOSITION_ID} (${durationInFrames} frames ≈ ${estSec}s @ ${input.fps}fps)…`
  );

  const tSelect = performance.now();
  const composition = await selectComposition({
    serveUrl,
    id: STORY_SHORT_COMPOSITION_ID,
    inputProps: { input },
  });
  const selectMs = performance.now() - tSelect;
  onLog?.(`selectComposition ${selectMs.toFixed(0)}ms`);

  let lastPct = -1;
  let framesDoneInMs: number | null = null;
  let encodeDoneInMs: number | null = null;

  onLog?.(
    `Rendering Remotion → ${path.basename(outPath)} (concurrency=${concurrency})…`
  );
  const tRender = performance.now();
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
    concurrency,
    onProgress: ({ progress, renderedDoneIn, encodedDoneIn }) => {
      if (typeof renderedDoneIn === "number") framesDoneInMs = renderedDoneIn;
      if (typeof encodedDoneIn === "number") encodeDoneInMs = encodedDoneIn;
      const pct = Math.floor(progress * 100);
      if (pct >= lastPct + 10 || pct === 100) {
        lastPct = pct;
        onLog?.(`Remotion render ${pct}%`);
      }
    },
  });
  const renderMediaMs = performance.now() - tRender;
  const totalMs = performance.now() - tTotal;

  onLog?.(
    `Remotion render complete (renderMedia=${renderMediaMs.toFixed(0)}ms, framesDoneIn=${framesDoneInMs ?? "n/a"}, encodeDoneIn=${encodeDoneInMs ?? "n/a"})`
  );

  return {
    outPath,
    durationInFrames,
    timings: {
      bundleMs,
      selectMs,
      renderMediaMs,
      totalMs,
      framesDoneInMs,
      encodeDoneInMs,
      frames: durationInFrames,
      concurrency,
    },
  };
}

/**
 * Story visual mux: ffmpeg (default = continuous B-roll + ASS captions)
 * or remotion (karaoke captions). Set STORY_RENDERER=remotion to opt in.
 */
export function getStoryRendererMode(): "ffmpeg" | "remotion" {
  const raw = (process.env.STORY_RENDERER || "ffmpeg").trim().toLowerCase();
  return raw === "remotion" ? "remotion" : "ffmpeg";
}
