/**
 * Fetch YouTube captions.
 * Primary: youtube-transcript (works locally).
 * Fallback: yt-dlp (needed on GitHub Actions — YouTube blocks the scrape API from runner IPs).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fetchTranscript } from "youtube-transcript";

const execFileAsync = promisify(execFile);

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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip VTT/SRT cue markup into plain narration text. */
function subtitleFileToPlainText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^WEBVTT/i.test(t)) continue;
    if (/^NOTE\b/i.test(t)) continue;
    if (/^KIND:/i.test(t)) continue;
    if (/^LANGUAGE:/i.test(t)) continue;
    if (/^\d+$/.test(t)) continue; // SRT cue index
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(t)) continue;
    if (/-->/.test(t)) continue;
    const cleaned = decodeEntities(t.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) chunks.push(cleaned);
  }
  // Drop consecutive duplicates common in auto-captions
  const deduped: string[] = [];
  for (const c of chunks) {
    if (deduped[deduped.length - 1] === c) continue;
    deduped.push(c);
  }
  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

async function resolveYtDlpBin(): Promise<string | null> {
  const fromEnv = process.env.YT_DLP_PATH?.trim();
  if (fromEnv) return fromEnv;
  for (const bin of ["yt-dlp", "yt-dlp.exe"]) {
    try {
      await execFileAsync(bin, ["--version"], {
        windowsHide: true,
        timeout: 15_000,
      });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchViaYtDlp(
  videoId: string,
  lang?: "en" | "hi"
): Promise<FetchYoutubeStoryResult> {
  const bin = await resolveYtDlpBin();
  if (!bin) {
    throw new Error("yt-dlp is not installed (needed for CI transcript fallback)");
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "reeler-subs-"));
  const outTpl = path.join(workDir, videoId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Prefer matching lang, then common auto tracks, then any.
  // On CI use a broader set — many Hindi channels only expose auto tracks.
  const langPref =
    process.env.GITHUB_ACTIONS === "true" || process.env.YT_TRANSCRIPT_ENGINE === "ytdlp"
      ? lang === "hi"
        ? "hi.*,hi,en.*,en,a.hi*,a.en*,all"
        : "en.*,en,hi.*,hi,a.en*,a.hi*,all"
      : lang === "hi"
        ? "hi.*,hi,en.*,en,a.hi,a.en"
        : "en.*,en,hi.*,hi,a.en,a.hi";

  try {
    try {
      await execFileAsync(
        bin,
        [
          "--skip-download",
          "--write-auto-subs",
          "--write-subs",
          "--sub-langs",
          langPref,
          "--sub-format",
          "vtt/srt/best",
          // GitHub runner IPs often get blocked on the default web client.
          "--extractor-args",
          "youtube:player_client=android,tv_embedded,web",
          "-o",
          outTpl,
          "--no-warnings",
          "--no-playlist",
          url,
        ],
        {
          windowsHide: true,
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
        }
      );
    } catch (e) {
      const err = e as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer };
      const stderr = Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf8")
        : String(err.stderr ?? "");
      const stdout = Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf8")
        : String(err.stdout ?? "");
      const detail = (stderr || stdout || err.message || "yt-dlp failed")
        .trim()
        .slice(-500);
      throw new Error(`yt-dlp failed: ${detail}`);
    }

    const entries = await fs.readdir(workDir);
    const subFiles = entries
      .filter((f) => /\.(vtt|srt)$/i.test(f))
      .sort((a, b) => {
        // Prefer exact lang matches first
        const score = (name: string) => {
          const n = name.toLowerCase();
          if (lang === "hi") {
            if (n.includes(".hi.")) return 0;
            if (n.includes(".en.")) return 1;
          } else {
            if (n.includes(".en.")) return 0;
            if (n.includes(".hi.")) return 1;
          }
          return 2;
        };
        return score(a) - score(b);
      });

    if (!subFiles.length) {
      throw new Error("yt-dlp wrote no subtitle files");
    }

    const chosen = subFiles[0]!;
    const raw = await fs.readFile(path.join(workDir, chosen), "utf8");
    const text = subtitleFileToPlainText(raw);
    if (text.length < 20) {
      throw new Error(`yt-dlp subtitle too short (${text.length} chars) from ${chosen}`);
    }

    // Rough duration: count unique cue timestamps if present; else estimate by words.
    const cueMatches = [
      ...raw.matchAll(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->/g),
    ];
    let durationSec = 0;
    if (cueMatches.length) {
      const last = cueMatches[cueMatches.length - 1]!;
      durationSec =
        Number(last[1]) * 3600 +
        Number(last[2]) * 60 +
        Number(last[3]) +
        Number(last[4]) / 1000;
    } else {
      durationSec = Math.max(20, Math.round(text.split(/\s+/).length / 2.5));
    }

    return {
      videoUrl: url,
      videoId,
      text,
      segmentCount: Math.max(1, Math.round(text.split(/\s+/).length / 8)),
      durationSec,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchViaPackage(
  videoId: string,
  lang?: "en" | "hi"
): Promise<FetchYoutubeStoryResult> {
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
    throw new Error(
      "Transcript is too short to build a story (~20+ characters needed)."
    );
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

/**
 * Pull captions for a YouTube URL/ID and flatten to one story string.
 * On GitHub Actions, prefers yt-dlp because youtube-transcript is IP-blocked.
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
  const onCi = process.env.GITHUB_ACTIONS === "true";
  const preferYtDlp = onCi || process.env.YT_TRANSCRIPT_ENGINE === "ytdlp";

  const attempts: Array<() => Promise<FetchYoutubeStoryResult>> = preferYtDlp
    ? [() => fetchViaYtDlp(videoId, lang), () => fetchViaPackage(videoId, lang)]
    : [() => fetchViaPackage(videoId, lang), () => fetchViaYtDlp(videoId, lang)];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  throw new Error(
    `Could not fetch YouTube transcript for ${videoId}. ${errors.join(" | ")}`
  );
}
