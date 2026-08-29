/**
 * Fetch YouTube captions.
 * Primary: youtube-transcript (works locally).
 * Fallback: Innertube ANDROID client (works on Vercel — no yt-dlp binary).
 * Last resort: yt-dlp (CI / local when installed).
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fetchTranscript } from "youtube-transcript";

const execFileAsync = promisify(execFile);

/** Public Innertube key embedded in YouTube clients (not a secret). */
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/**
 * ANDROID client versions.
 * 19.29.x (and similar) now return HTTP 400 "Precondition check failed".
 * 20.10.38 works for caption track listing.
 */
const ANDROID_CLIENTS: ReadonlyArray<{ version: string; ua: string }> = [
  {
    version: "20.10.38",
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
  },
  {
    version: "19.47.38",
    ua: "com.google.android.youtube/19.47.38 (Linux; U; Android 14) gzip",
  },
];

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
    if (/^\d+$/.test(t)) continue;
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(t)) continue;
    if (/-->/.test(t)) continue;
    const cleaned = decodeEntities(t.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) chunks.push(cleaned);
  }
  const deduped: string[] = [];
  for (const c of chunks) {
    if (deduped[deduped.length - 1] === c) continue;
    deduped.push(c);
  }
  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

export async function resolveYtDlpBin(): Promise<string | null> {
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
  const cookiesFile = process.env.YT_DLP_COOKIES_FILE?.trim() || "";

  const langPref =
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.YT_TRANSCRIPT_ENGINE === "ytdlp"
      ? lang === "hi"
        ? "hi.*,hi,en.*,en,a.hi*,a.en*,all"
        : "en.*,en,hi.*,hi,a.en*,a.hi*,all"
      : lang === "hi"
        ? "hi.*,hi,en.*,en,a.hi,a.en"
        : "en.*,en,hi.*,hi,a.en,a.hi";

  const args = [
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    langPref,
    "--sub-format",
    "vtt/srt/best",
    "--extractor-args",
    "youtube:player_client=android,tv_embedded,web",
    "-o",
    outTpl,
    "--no-warnings",
    "--no-playlist",
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push(url);

  try {
    try {
      await execFileAsync(bin, args, {
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as {
        message?: string;
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
      const stderr = Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf8")
        : String(err.stderr ?? "");
      const stdout = Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf8")
        : String(err.stdout ?? "");
      const detail = (stderr || stdout || err.message || "yt-dlp failed")
        .trim()
        .slice(-500);
      const hint =
        /confirm you.re not a bot/i.test(detail) && !cookiesFile
          ? " Set GitHub secret YT_DLP_COOKIES (Netscape cookies.txt) to unblock CI."
          : "";
      throw new Error(`yt-dlp failed: ${detail}${hint}`);
    }

    const entries = await fs.readdir(workDir);
    const subFiles = entries
      .filter((f) => /\.(vtt|srt)$/i.test(f))
      .sort((a, b) => {
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
      throw new Error(
        `yt-dlp subtitle too short (${text.length} chars) from ${chosen}`
      );
    }

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

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

function pickCaptionTrack(
  tracks: CaptionTrack[],
  lang?: "en" | "hi"
): CaptionTrack | null {
  if (!tracks.length) return null;
  const prefer = lang === "hi" ? ["hi", "en"] : ["en", "hi"];
  for (const code of prefer) {
    const exact = tracks.find(
      (t) => t.languageCode === code && t.baseUrl && t.kind !== "asr"
    );
    if (exact) return exact;
    const asr = tracks.find(
      (t) => t.languageCode === code && t.baseUrl && t.kind === "asr"
    );
    if (asr) return asr;
    const any = tracks.find(
      (t) => t.languageCode?.startsWith(code) && t.baseUrl
    );
    if (any) return any;
  }
  return tracks.find((t) => t.baseUrl) ?? null;
}

function parseTimedTextXml(xml: string): YoutubeTranscriptSegment[] {
  const segments: YoutubeTranscriptSegment[] = [];
  const re =
    /<text\b[^>]*\bstart="([^"]+)"[^>]*\bdur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  for (const m of xml.matchAll(re)) {
    const offset = Number(m[1]);
    const duration = Number(m[2]);
    const text = decodeEntities(
      String(m[3] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!text || !Number.isFinite(offset)) continue;
    segments.push({
      text,
      offset,
      duration: Number.isFinite(duration) ? duration : 0,
    });
  }
  return segments;
}

function parseJson3Events(raw: string): YoutubeTranscriptSegment[] {
  try {
    const data = JSON.parse(raw) as {
      events?: Array<{
        tStartMs?: number;
        dDurationMs?: number;
        segs?: Array<{ utf8?: string }>;
      }>;
    };
    const segments: YoutubeTranscriptSegment[] = [];
    for (const ev of data.events ?? []) {
      const text = (ev.segs ?? [])
        .map((s) => s.utf8 ?? "")
        .join("")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      segments.push({
        text,
        offset: (Number(ev.tStartMs) || 0) / 1000,
        duration: (Number(ev.dDurationMs) || 0) / 1000,
      });
    }
    return segments;
  } catch {
    return [];
  }
}

async function listCaptionTracks(
  videoId: string,
  lang: "en" | "hi" | undefined,
  client: { version: string; ua: string }
): Promise<{ tracks: CaptionTrack[]; ua: string }> {
  const playerRes = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.ua,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: client.version,
            hl: lang === "hi" ? "hi" : "en",
            gl: "US",
          },
        },
        videoId,
      }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!playerRes.ok) {
    throw new Error(`Innertube player HTTP ${playerRes.status}`);
  }

  const player = (await playerRes.json()) as {
    playabilityStatus?: { status?: string; reason?: string };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: CaptionTrack[];
      };
    };
  };

  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(
      `Innertube playability ${status}: ${player.playabilityStatus?.reason ?? "unknown"}`
    );
  }

  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) {
    throw new Error("Innertube: no caption tracks on this video");
  }
  return { tracks, ua: client.ua };
}

/**
 * Innertube ANDROID player — works on Vercel/datacenter IPs where
 * youtube-transcript HTML scraping often reports "Transcript is disabled".
 */
async function fetchViaInnertube(
  videoId: string,
  lang?: "en" | "hi"
): Promise<FetchYoutubeStoryResult> {
  let tracks: CaptionTrack[] = [];
  let ua = ANDROID_CLIENTS[0]!.ua;
  const playerErrors: string[] = [];

  for (const client of ANDROID_CLIENTS) {
    try {
      const result = await listCaptionTracks(videoId, lang, client);
      tracks = result.tracks;
      ua = result.ua;
      break;
    } catch (e) {
      playerErrors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (!tracks.length) {
    throw new Error(playerErrors.join(" | ") || "Innertube player failed");
  }

  const track = pickCaptionTrack(tracks, lang);
  if (!track?.baseUrl) {
    throw new Error("Innertube: no usable caption track on this video");
  }

  const base = track.baseUrl.replace(/&fmt=\w+/g, "");
  const urls = [`${base}&fmt=json3`, base];
  let segments: YoutubeTranscriptSegment[] = [];
  let lastErr = "";

  for (const url of urls) {
    try {
      const subRes = await fetch(url, {
        headers: { "User-Agent": ua },
        signal: AbortSignal.timeout(20_000),
      });
      if (!subRes.ok) {
        lastErr = `HTTP ${subRes.status}`;
        continue;
      }
      const body = await subRes.text();
      segments = body.trimStart().startsWith("{")
        ? parseJson3Events(body)
        : parseTimedTextXml(body);
      if (segments.length) break;
      lastErr = "empty caption payload";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  if (!segments.length) {
    throw new Error(`Innertube captions empty (${lastErr || "no data"})`);
  }

  const text = segmentsToPlainText(segments);
  if (text.length < 20) {
    throw new Error("Innertube transcript too short");
  }

  const last = segments[segments.length - 1]!;
  const durationSec = Math.max(
    0,
    (Number(last.offset) || 0) + (Number(last.duration) || 0)
  );

  return {
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    text,
    segmentCount: segments.length,
    durationSec,
  };
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
 * Local: package first. Vercel: Innertube first. CI: yt-dlp first.
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
  const onVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const preferYtDlp = onCi || process.env.YT_TRANSCRIPT_ENGINE === "ytdlp";
  const ytDlpBin = preferYtDlp || !onVercel ? await resolveYtDlpBin() : null;

  const attempts: Array<() => Promise<FetchYoutubeStoryResult>> = [];
  if (preferYtDlp && ytDlpBin) {
    attempts.push(() => fetchViaYtDlp(videoId, lang));
  }
  if (onVercel || preferYtDlp) {
    attempts.push(() => fetchViaInnertube(videoId, lang));
    attempts.push(() => fetchViaPackage(videoId, lang));
  } else {
    attempts.push(() => fetchViaPackage(videoId, lang));
    attempts.push(() => fetchViaInnertube(videoId, lang));
  }
  if (ytDlpBin && !preferYtDlp) {
    attempts.push(() => fetchViaYtDlp(videoId, lang));
  }

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
