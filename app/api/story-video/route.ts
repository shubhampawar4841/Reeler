import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import type { StoryLang } from "@/lib/groqStoryboard";
import { buildStoryVideo } from "@/lib/storyVideoPipeline";

export const runtime = "nodejs";
/** Longer narrations (2–6 min) need more headroom than default. */
export const maxDuration = 600;

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

/**
 * POST /api/story-video
 * multipart: story, lang (en|hi), optional video
 * JSON: { story, lang? }
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
    let lang: StoryLang = "en";

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const storyField = form.get("story");
      story = typeof storyField === "string" ? storyField.trim() : "";
      lang = parseLang(form.get("lang"));

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
            `Uploaded B-roll saved (${(buf.length / (1024 * 1024)).toFixed(1)} MB) — Pexels skipped`
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
              'Empty body. Send JSON { "story": "…", "lang": "en"|"hi" } or multipart.',
            logs,
          },
          { status: 400 }
        );
      }
      let body: { story?: string; lang?: string };
      try {
        body = JSON.parse(raw) as { story?: string; lang?: string };
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error: 'Invalid JSON. Send: { "story": "…", "lang": "en"|"hi" }',
            logs,
          },
          { status: 400 }
        );
      }
      story = typeof body.story === "string" ? body.story.trim() : "";
      lang = parseLang(body.lang);
    }

    if (!story || story.length < 20) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide a story (at least ~20 characters).",
          logs,
        },
        { status: 400 }
      );
    }

    push(`Story received (${story.length} chars, lang=${lang})`);
    if (!backgroundVideoPath) {
      push("Using Supabase Minecraft parkour B-roll");
    }
    const result = await buildStoryVideo({
      story,
      lang,
      backgroundVideoPath,
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
