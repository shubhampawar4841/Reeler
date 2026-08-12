import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import type { StoryLang } from "@/lib/groqStoryboard";
import type { VoiceGender } from "@/lib/kokoroTts";
import { buildStoryVideo } from "@/lib/storyVideoPipeline";
import { fetchYoutubeStoryText } from "@/lib/youtubeTranscript";

export const runtime = "nodejs";
/** Longer narrations (2–6 min) need more headroom than default. */
/** Vercel Hobby max is 300s; Pro allows higher. */
export const maxDuration = 300;

type LogEntry = { level: "info" | "error"; message: string };

const VIDEO_EXT = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4v",
  ".avi",
]);

function parseLang(raw: unknown): StoryLang {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "hi" || s === "hindi" ? "hi" : "en";
}

function parseGender(raw: unknown): VoiceGender {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "male" ? "male" : "female";
}

function parseStorySpeed(raw: unknown): {
  storySpeed: number | null;
  autoFitSpeed: boolean;
} {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || s === "auto") {
    return { storySpeed: 1.35, autoFitSpeed: true };
  }
  const n = Number(s);
  if (Number.isFinite(n) && n >= 1 && n <= 2.5) {
    return { storySpeed: n, autoFitSpeed: true };
  }
  return { storySpeed: 1.35, autoFitSpeed: true };
}

/**
 * POST /api/story-video
 * multipart/JSON: story OR youtubeUrl (+ lang, brollId, voiceGender, storySpeed)
 */
export async function POST(req: Request) {
  const logs: LogEntry[] = [];
  const push = (message: string) => {
    console.log(`[story-video] ${message}`);
    logs.push({ level: "info", message });
  };

  const uploadDir = path.join(os.tmpdir(), "reeler-story-uploads", uuidv4());
  let backgroundVideoPath: string | null = null;

  try {
    const ct = req.headers.get("content-type") ?? "";
    let story = "";
    let youtubeUrl = "";
    let lang: StoryLang = "en";
    let brollId: string | null = null;
    let voiceGender: VoiceGender = "female";
    let storySpeed: number | null = 1.35;
    let autoFitSpeed = true;

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const storyField = form.get("story");
      story = typeof storyField === "string" ? storyField.trim() : "";
      const ytField = form.get("youtubeUrl");
      youtubeUrl = typeof ytField === "string" ? ytField.trim() : "";
      lang = parseLang(form.get("lang"));
      voiceGender = parseGender(form.get("voiceGender"));
      const speedParsed = parseStorySpeed(form.get("storySpeed"));
      storySpeed = speedParsed.storySpeed;
      autoFitSpeed = speedParsed.autoFitSpeed;
      const bid = form.get("brollId");
      brollId = typeof bid === "string" && bid.trim() ? bid.trim() : null;

      const videoField = form.get("video");
      if (videoField && typeof videoField !== "string" && "arrayBuffer" in videoField) {
        const file = videoField as File;
        if (file.size > 0) {
          const name = file.name || "upload.mp4";
          const ext = path.extname(name).toLowerCase() || ".mp4";
          if (!VIDEO_EXT.has(ext)) {
            return NextResponse.json(
              {
                ok: false,
                error: `Unsupported video type (${ext}). Use mp4, mov, webm, or mkv.`,
                logs,
              },
              { status: 400 }
            );
          }
          await fs.mkdir(uploadDir, { recursive: true });
          backgroundVideoPath = path.join(uploadDir, `bg${ext}`);
          const buf = Buffer.from(await file.arrayBuffer());
          await fs.writeFile(backgroundVideoPath, buf);
          push(
            `Uploaded B-roll saved (${(buf.length / (1024 * 1024)).toFixed(1)} MB)`
          );
        }
      }
    } else {
      const raw = await req.text();
      if (!raw.trim()) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Empty body. Send JSON { "story" } or { "youtubeUrl" } (+ options).',
            logs,
          },
          { status: 400 }
        );
      }
      let body: {
        story?: string;
        youtubeUrl?: string;
        lang?: string;
        brollId?: string;
        voiceGender?: string;
        storySpeed?: string | number;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Invalid JSON. Send: { "story" } or { "youtubeUrl" } (+ options).',
            logs,
          },
          { status: 400 }
        );
      }
      story = typeof body.story === "string" ? body.story.trim() : "";
      youtubeUrl =
        typeof body.youtubeUrl === "string" ? body.youtubeUrl.trim() : "";
      lang = parseLang(body.lang);
      voiceGender = parseGender(body.voiceGender);
      const speedParsed = parseStorySpeed(body.storySpeed);
      storySpeed = speedParsed.storySpeed;
      autoFitSpeed = speedParsed.autoFitSpeed;
      brollId =
        typeof body.brollId === "string" && body.brollId.trim()
          ? body.brollId.trim()
          : null;
    }

    if (youtubeUrl) {
      push(`Fetching YouTube transcript: ${youtubeUrl}`);
      const yt = await fetchYoutubeStoryText(youtubeUrl, { lang });
      story = yt.text;
      push(
        `YouTube transcript ready (${yt.segmentCount} segments, ~${yt.durationSec.toFixed(0)}s source, ${story.length} chars) from ${yt.videoId}`
      );
    }

    if (!story || story.length < 20) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Provide a story text (≥20 chars) or a YouTube link with captions.",
          logs,
        },
        { status: 400 }
      );
    }

    push(
      `Story received (${story.length} chars, lang=${lang}, voice=${voiceGender}` +
        `, speed=${storySpeed ?? "auto"}×` +
        (brollId ? `, broll=${brollId}` : ", broll=auto") +
        (youtubeUrl ? ", source=youtube" : ", source=manual") +
        `)`
    );

    const result = await buildStoryVideo({
      story,
      lang,
      backgroundVideoPath,
      brollId,
      voiceGender,
      storySpeed,
      autoFitSpeed,
      onLog: push,
    });

    return NextResponse.json({
      ok: true,
      videoUrl: result.videoUrl,
      durationSec: result.durationSec,
      plan: result.plan,
      usedUpload: result.usedUpload,
      brollSource: result.brollSource,
      lang: result.lang,
      renderer: result.renderer,
      sourceStoryChars: story.length,
      youtubeUrl: youtubeUrl || null,
      logs,
      message: `Story Short ready (${result.renderer}, B-roll: ${result.brollSource}).`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[story-video]", e);
    logs.push({ level: "error", message });
    return NextResponse.json({ ok: false, error: message, logs }, { status: 500 });
  } finally {
    try {
      await fs.rm(uploadDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
