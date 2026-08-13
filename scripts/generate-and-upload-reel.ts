/**
 * Headless reel job for GitHub Actions (or local):
 *   STORY_RENDERER=ffmpeg TTS_ENGINE=edge npx tsx scripts/generate-and-upload-reel.ts --story "..."
 *
 * Reads secrets only from process.env. Never prints secret values.
 */

import fs from "node:fs/promises";
import path from "node:path";

type CliArgs = {
  story: string;
  lang: "en" | "hi";
  privacy: "public" | "unlisted" | "private";
  gender: "female" | "male";
};

function parseArgs(argv: string[]): CliArgs {
  let story = "";
  let lang: "en" | "hi" = "en";
  let privacy: "public" | "unlisted" | "private" = "private";
  let gender: "female" | "male" = "female";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--story" && next) {
      story = next;
      i++;
    } else if (a.startsWith("--story=")) {
      story = a.slice("--story=".length);
    } else if (a === "--lang" && next) {
      lang = next.trim().toLowerCase() === "hi" ? "hi" : "en";
      i++;
    } else if (a === "--privacy" && next) {
      const p = next.trim().toLowerCase();
      if (p === "public" || p === "unlisted" || p === "private") privacy = p;
      i++;
    } else if (a === "--gender" && next) {
      gender = next.trim().toLowerCase() === "male" ? "male" : "female";
      i++;
    }
  }

  // Workflow may pass the story via env to avoid shell escaping issues.
  if (!story.trim() && process.env.STORY_TEXT?.trim()) {
    story = process.env.STORY_TEXT.trim();
  }

  story = story.replace(/\s+/g, " ").trim();
  if (story.length < 20) {
    throw new Error(
      "Missing story. Pass --story \"...\" (or STORY_TEXT env) with at least ~20 characters."
    );
  }

  return { story, lang, privacy, gender };
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function jobIdFromVideoUrl(videoUrl: string): string | null {
  const m = videoUrl.match(/\/output\/([^/]+)\/story\.mp4$/);
  return m?.[1] ?? null;
}

function safeLog(msg: string): void {
  // Never echo env / tokens
  const redacted = msg
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/ya29\.[0-9A-Za-z._-]+/g, "[redacted]")
    .replace(/gsk_[0-9A-Za-z]+/g, "[redacted]");
  console.log(redacted);
}

async function removeOutputJob(jobId: string | null): Promise<void> {
  if (!jobId) return;
  const outDir = path.join(process.cwd(), "public", "output", jobId);
  try {
    await fs.rm(outDir, { recursive: true, force: true });
    safeLog(`Cleaned public/output/${jobId}/`);
  } catch (e) {
    safeLog(
      `Cleanup warning for public/output/${jobId}/: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

async function main(): Promise<void> {
  // Force GHA-safe engines before importing pipeline.
  process.env.STORY_RENDERER = "ffmpeg";
  process.env.TTS_ENGINE = "edge";

  const args = parseArgs(process.argv.slice(2));

  requireEnv("GROQ_API_KEY");
  requireEnv("YOUTUBE_CLIENT_ID");
  requireEnv("YOUTUBE_CLIENT_SECRET");
  requireEnv("YOUTUBE_REFRESH_TOKEN");
  // GEMINI_API_KEY recommended but planner can fall back to Groq

  safeLog(
    `Starting reel job (lang=${args.lang}, privacy=${args.privacy}, storyChars=${args.story.length}, renderer=ffmpeg, tts=edge)`
  );

  const { buildStoryVideo } = await import("../lib/storyVideoPipeline");
  const { uploadYoutubeVideo } = await import("../lib/youtube");

  let jobId: string | null = null;

  try {
    const result = await buildStoryVideo({
      story: args.story,
      lang: args.lang,
      voiceGender: args.gender,
      storySpeed: Number(process.env.STORY_SPEED) || 1.5,
      autoFitSpeed: true,
      onLog: safeLog,
    });

    jobId = jobIdFromVideoUrl(result.videoUrl);
    if (!jobId) {
      throw new Error(`Unexpected videoUrl: ${result.videoUrl}`);
    }

    const absMp4 = path.resolve(
      process.cwd(),
      "public",
      "output",
      jobId,
      "story.mp4"
    );
    await fs.access(absMp4);

    const title =
      result.plan.title?.trim() ||
      result.plan.hook?.trim() ||
      "Story Short";
    const description = [
      result.plan.hook?.trim() || "",
      "",
      result.plan.endingQuestion?.trim() || "",
      "",
      "Created with Reeler",
    ]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n")
      .trim();

    safeLog(
      `Uploading ${absMp4} (${result.durationSec.toFixed(1)}s, broll=${result.brollSource})…`
    );

    const uploaded = await uploadYoutubeVideo({
      filePath: absMp4,
      title,
      description,
      tags: result.plan.hashtags ?? [],
      privacyStatus: args.privacy,
    });

    safeLog(`YouTube upload OK: ${uploaded.shortsUrl || uploaded.url}`);
    safeLog(`videoId=${uploaded.videoId} privacy=${uploaded.privacyStatus}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Reel job failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    await removeOutputJob(jobId);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
