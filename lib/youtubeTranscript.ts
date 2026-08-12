/**
 * Fetch YouTube captions via youtube-transcript (unofficial API).
 * Returns plain text suitable as the raw story input for the planner.
 */

import { fetchTranscript } from "youtube-transcript";

export type YoutubeTranscriptSegment = {
  text: string;
  offset: number;
  duration: number;
};

export type FetchYoutubeStoryResult = {
  videoUrl: string;
  videoId: string;
  text: string;
  segmentCount: number;
  durationSec: number;
};

/** Extract 11-char video id from common YouTube URL shapes (or bare id). */
export function extractYoutubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host === "m.youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      // /shorts/ID /embed/ID /live/ID
      if (
        parts.length >= 2 &&
        ["shorts", "embed", "live", "v"].includes(parts[0]!) &&
        /^[\w-]{11}$/.test(parts[1]!)
      ) {
        return parts[1]!;
      }
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function segmentsToPlainText(segments: YoutubeTranscriptSegment[]): string {
  return segments
    .map((s) => String(s.text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull captions for a YouTube URL/ID and flatten to one story string.
 * Prefers the video's default caption language from YouTube.
 */
export async function fetchYoutubeStoryText(
  youtubeUrlOrId: string,
  opts?: { lang?: "en" | "hi" }
): Promise<FetchYoutubeStoryResult> {
  const videoId = extractYoutubeVideoId(youtubeUrlOrId);
  if (!videoId) {
    throw new Error(
      "Invalid YouTube link. Paste a watch/shorts URL or an 11-character video id."
    );
  }

  const lang = opts?.lang;
  let segments: YoutubeTranscriptSegment[];
  try {
    const raw = await fetchTranscript(videoId, lang ? { lang } : undefined);
    segments = (raw as YoutubeTranscriptSegment[]) ?? [];
  } catch (err) {
    // Retry without lang if a specific track failed
    if (lang) {
      try {
        const raw = await fetchTranscript(videoId);
        segments = (raw as YoutubeTranscriptSegment[]) ?? [];
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        throw new Error(`Could not fetch YouTube transcript: ${msg}`);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not fetch YouTube transcript: ${msg}`);
    }
  }

  if (!segments.length) {
    throw new Error("YouTube returned an empty transcript for this video.");
  }

  const text = segmentsToPlainText(segments);
  if (text.length < 20) {
    throw new Error("Transcript is too short to build a story (~20+ characters needed).");
  }

  const last = segments[segments.length - 1]!;
  // Package returns ms for srv3 tracks, seconds (float) for classic tracks.
  const end = (Number(last.offset) || 0) + (Number(last.duration) || 0);
  const looksLikeMs =
    end > 1000 &&
    segments.every(
      (s) => Number.isInteger(s.offset) && Number.isInteger(s.duration)
    );
  const durationSec = Math.max(0, looksLikeMs ? end / 1000 : end);

  return {
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    text,
    segmentCount: segments.length,
    durationSec,
  };
}
