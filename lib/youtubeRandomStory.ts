import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getYoutubeClient } from "@/lib/youtubeAuth";
import {
  fetchYoutubeStoryText,
  resolveYtDlpBin,
} from "@/lib/youtubeTranscript";

const execFileAsync = promisify(execFile);

export const STORY_CHANNELS = [
  { id: "UCLzBmIXyMCU3823_KTmSrRA", name: "Scary Window", langs: ["en"] },
  { id: "UCC8jAloh4KND0OvEB3o25GQ", name: "Unknown Whispers", langs: ["en"] },
  {
    id: "UC9SCSAwMFZ-XFjR2SrlnJUw",
    name: "Spooky Hindi Stories",
    langs: ["hi"],
  },
  {
    id: "UCxkNn4i8k0YYoe6_TKvBAig",
    name: "True or False Scary Stories",
    langs: ["en"],
  },
  {
    id: "UCAayg87bUguD2dzrc_O-bjQ",
    name: "Suno Ek Kahani Official",
    langs: ["hi"],
  },
  { id: "UCbNp5Gl_5QSFNZmRytT41Fw", name: "Scary Hub", langs: ["en"] },
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

/** Prefer channels that match the story language, then try the rest. */
function channelsForLang(lang: "en" | "hi") {
  const preferred = STORY_CHANNELS.filter((c) =>
    (c.langs as readonly string[]).includes(lang)
  );
  const other = STORY_CHANNELS.filter(
    (c) => !(c.langs as readonly string[]).includes(lang)
  );
  return [...shuffled(preferred), ...shuffled(other)];
}

async function videosFromChannelOauth(
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

/** List recent uploads via yt-dlp (works on CI with cookies; no OAuth needed). */
async function videosFromChannelYtDlp(
  channel: (typeof STORY_CHANNELS)[number]
): Promise<Array<{ videoId: string; title: string }>> {
  const bin = await resolveYtDlpBin();
  if (!bin) throw new Error("yt-dlp is not installed");

  const cookiesFile = process.env.YT_DLP_COOKIES_FILE?.trim() || "";
  const args = [
    "--flat-playlist",
    "--playlist-end",
    "30",
    "--print",
    "%(id)s\t%(title)s",
    "--no-warnings",
    "--ignore-errors",
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  // /videos is the uploads tab for the channel
  args.push(`https://www.youtube.com/channel/${channel.id}/videos`);

  const { stdout, stderr } = await execFileAsync(bin, args, {
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) {
    const detail = String(stderr || "").trim().slice(-300);
    throw new Error(
      detail || `yt-dlp listed 0 videos for ${channel.name}`
    );
  }

  return shuffled(
    lines
      .map((line) => {
        const tab = line.indexOf("\t");
        const videoId = (tab >= 0 ? line.slice(0, tab) : line).trim();
        const title =
          tab >= 0 ? line.slice(tab + 1).trim() : "Untitled video";
        return { videoId, title };
      })
      .filter((item) => /^[\w-]{11}$/.test(item.videoId))
  );
}

async function videosFromChannel(
  channel: (typeof STORY_CHANNELS)[number],
  onLog: (message: string) => void
): Promise<Array<{ videoId: string; title: string }>> {
  const preferYtDlp =
    Boolean(process.env.YT_DLP_COOKIES_FILE?.trim()) ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.YT_TRANSCRIPT_ENGINE === "ytdlp";

  if (preferYtDlp) {
    try {
      return await videosFromChannelYtDlp(channel);
    } catch (error) {
      onLog(
        `  yt-dlp list failed for ${channel.name}: ${
          error instanceof Error ? error.message : String(error)
        }; trying OAuth…`
      );
    }
  }

  try {
    return await videosFromChannelOauth(channel);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/invalid_grant/i.test(msg)) {
      throw new Error(
        `YouTube OAuth refresh token is invalid (invalid_grant). Reconnect YouTube or list via yt-dlp cookies. Original: ${msg}`
      );
    }
    // If OAuth failed and we haven't tried yt-dlp yet, try it.
    if (!preferYtDlp) {
      onLog(`  OAuth list failed for ${channel.name}; trying yt-dlp…`);
      return await videosFromChannelYtDlp(channel);
    }
    throw error;
  }
}

export async function findRandomYoutubeStory(
  lang: "en" | "hi" = "en",
  onLog: (message: string) => void = console.log
): Promise<RandomYoutubeStory> {
  let lastTranscriptError = "";
  let lastListError = "";

  for (const channel of channelsForLang(lang)) {
    onLog(`Checking random stories from ${channel.name}…`);
    let videos: Array<{ videoId: string; title: string }>;
    try {
      videos = await videosFromChannel(channel, onLog);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onLog(`Could not list ${channel.name}: ${reason}`);
      lastListError = reason;
      continue;
    }

    onLog(`  ${videos.length} video(s) listed; trying transcripts…`);
    for (const video of videos.slice(0, 8)) {
      try {
        const transcript = await fetchYoutubeStoryText(video.videoId, { lang });
        if (transcript.text.length < 80) {
          onLog(
            `  ${video.videoId}: transcript too short (${transcript.text.length})`
          );
          continue;
        }
        return {
          ...transcript,
          title: video.title,
          channel: channel.name,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        onLog(`  ${video.videoId}: ${reason.slice(0, 400)}`);
        lastTranscriptError = reason;
        // Cookies / bot-check — retrying every video wastes the whole request.
        if (
          /LOGIN_REQUIRED|missing login session cookies|no YT_DLP_COOKIES|bot-check/i.test(
            reason
          )
        ) {
          throw new Error(reason);
        }
      }
    }
  }

  throw new Error(
    "No captioned story video was found in the configured YouTube channels." +
      (lastTranscriptError
        ? ` Last transcript error: ${lastTranscriptError}`
        : "") +
      (lastListError ? ` Last list error: ${lastListError}` : "")
  );
}
