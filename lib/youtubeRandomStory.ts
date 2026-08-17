import { getYoutubeClient } from "@/lib/youtubeAuth";
import { fetchYoutubeStoryText } from "@/lib/youtubeTranscript";

export const STORY_CHANNELS = [
  { id: "UCLzBmIXyMCU3823_KTmSrRA", name: "Scary Window" },
  { id: "UCC8jAloh4KND0OvEB3o25GQ", name: "Unknown Whispers" },
  { id: "UC9SCSAwMFZ-XFjR2SrlnJUw", name: "Spooky Hindi Stories" },
  { id: "UCxkNn4i8k0YYoe6_TKvBAig", name: "True or False Scary Stories" },
  { id: "UCAayg87bUguD2dzrc_O-bjQ", name: "Suno Ek Kahani Official" },
  { id: "UCbNp5Gl_5QSFNZmRytT41Fw", name: "Scary Hub" },
] as const;

export type RandomYoutubeStory = {
  videoId: string;
  videoUrl: string;
  text: string;
  segmentCount: number;
  durationSec: number;
  title: string;
  channel: string;
};

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

export async function findRandomYoutubeStory(
  lang: "en" | "hi" = "en",
  onLog: (message: string) => void = console.log
): Promise<RandomYoutubeStory> {
  let lastTranscriptError = "";

  for (const channel of shuffled(STORY_CHANNELS)) {
    onLog(`Checking random stories from ${channel.name}…`);
    let videos: Array<{ videoId: string; title: string }>;
    try {
      videos = await videosFromChannel(channel);
    } catch (error) {
      onLog(
        `Could not list ${channel.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    onLog(`  ${videos.length} video(s) listed; trying transcripts…`);
    for (const video of videos.slice(0, 12)) {
      try {
        const transcript = await fetchYoutubeStoryText(video.videoId, { lang });
        if (transcript.text.length < 80) {
          onLog(`  ${video.videoId}: transcript too short (${transcript.text.length})`);
          continue;
        }
        return {
          ...transcript,
          title: video.title,
          channel: channel.name,
        };
      } catch (error) {
        // Many source videos have captions disabled; try another one.
        const reason = error instanceof Error ? error.message : String(error);
        onLog(`  ${video.videoId}: ${reason.slice(0, 400)}`);
        lastTranscriptError = reason;
      }
    }
  }

  throw new Error(
    "No captioned story video was found in the configured YouTube channels." +
      (lastTranscriptError ? ` Last transcript error: ${lastTranscriptError}` : "")
  );
}
