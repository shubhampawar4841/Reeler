/**
 * Fetch a transcript from a specific YouTube URL, or randomly select a
 * captioned video from the configured story channels.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  extractYoutubeVideoId,
  fetchYoutubeStoryText,
} from "../lib/youtubeTranscript";
import {
  findRandomYoutubeStory,
  type RandomYoutubeStory,
} from "../lib/youtubeRandomStory";

type CliArgs = {
  youtubeUrl: string;
  lang: "en" | "hi";
  outPath: string;
  metaPath: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    youtubeUrl: "",
    lang: "en",
    outPath: "/tmp/reeler/story.txt",
    metaPath: "/tmp/reeler/meta.json",
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!value) continue;
    if (key === "--youtube-url") args.youtubeUrl = value;
    else if (key === "--lang") args.lang = value === "hi" ? "hi" : "en";
    else if (key === "--out") args.outPath = value;
    else if (key === "--meta") args.metaPath = value;
    else continue;
    i++;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let chosen: RandomYoutubeStory;

  if (args.youtubeUrl) {
    const videoId = extractYoutubeVideoId(args.youtubeUrl);
    if (!videoId) throw new Error("Invalid --youtube-url");
    const transcript = await fetchYoutubeStoryText(videoId, { lang: args.lang });
    chosen = {
      ...transcript,
      title: videoId,
      channel: "Manual YouTube source",
    };
  } else {
    chosen = await findRandomYoutubeStory(args.lang);
  }

  const outPath = path.resolve(args.outPath);
  const metaPath = path.resolve(args.metaPath);
  await Promise.all([
    fs.mkdir(path.dirname(outPath), { recursive: true }),
    fs.mkdir(path.dirname(metaPath), { recursive: true }),
  ]);
  await fs.writeFile(outPath, chosen.text, "utf8");
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        videoId: chosen.videoId,
        videoUrl: chosen.videoUrl,
        title: chosen.title,
        channel: chosen.channel,
        segmentCount: chosen.segmentCount,
        durationSec: chosen.durationSec,
        textChars: chosen.text.length,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `Selected "${chosen.title}" from ${chosen.channel} (${chosen.text.length} chars)`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
