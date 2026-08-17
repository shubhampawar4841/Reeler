/**
 * Fetch a transcript from a specific YouTube URL, or randomly select a
 * captioned video from the configured story channels.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getYoutubeClient } from "../lib/youtubeAuth";
import {
  extractYoutubeVideoId,
  fetchYoutubeStoryText,
} from "../lib/youtubeTranscript";

type CliArgs = {
  youtubeUrl: string;
  lang: "en" | "hi";
  outPath: string;
  metaPath: string;
};

const STORY_CHANNELS = [
  { id: "UCLzBmIXyMCU3823_KTmSrRA", name: "Scary Window" },
  { id: "UCC8jAloh4KND0OvEB3o25GQ", name: "Unknown Whispers" },
  { id: "UC9SCSAwMFZ-XFjR2SrlnJUw", name: "Spooky Hindi Stories" },
  { id: "UCxkNn4i8k0YYoe6_TKvBAig", name: "True or False Scary Stories" },
  { id: "UCAayg87bUguD2dzrc_O-bjQ", name: "Suno Ek Kahani Official" },
  { id: "UCbNp5Gl_5QSFNZmRytT41Fw", name: "Scary Hub" },
] as const;

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

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

async function videosFromChannel(
  channel: (typeof STORY_CHANNELS)[number]
): Promise<Array<{ videoId: string; title: string }>> {
  const youtube = getYoutubeClient();
  const channelResponse = await youtube.channels.list({
    part: ["contentDetails"],
    id: [channel.id],
  });
  const uploadsPlaylist =
    channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) return [];

  const playlistResponse = await youtube.playlistItems.list({
    part: ["snippet", "contentDetails"],
    playlistId: uploadsPlaylist,
    maxResults: 30,
  });

  return shuffled(
    (playlistResponse.data.items ?? [])
      .map((item) => ({
        videoId:
          item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? "",
        title: item.snippet?.title ?? "Untitled video",
      }))
      .filter((item) => /^[\w-]{11}$/.test(item.videoId))
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let chosen:
    | {
        videoId: string;
        videoUrl: string;
        text: string;
        segmentCount: number;
        durationSec: number;
        title: string;
        channel: string;
      }
    | undefined;

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
    for (const channel of shuffled(STORY_CHANNELS)) {
      console.log(`Checking random stories from ${channel.name}…`);
      let videos: Array<{ videoId: string; title: string }>;
      try {
        videos = await videosFromChannel(channel);
      } catch (error) {
        console.warn(
          `Could not list ${channel.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }

      for (const video of videos.slice(0, 12)) {
        try {
          const transcript = await fetchYoutubeStoryText(video.videoId, {
            lang: args.lang,
          });
          if (transcript.text.length < 80) continue;
          chosen = {
            ...transcript,
            title: video.title,
            channel: channel.name,
          };
          break;
        } catch {
          // Many source videos have captions disabled; try another one.
        }
      }
      if (chosen) break;
    }
  }

  if (!chosen) {
    throw new Error(
      "No captioned story video was found in the configured YouTube channels."
    );
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
