import { NextResponse } from "next/server";
import path from "node:path";
import type { Caption } from "@remotion/captions";
import { burnCaptionsOnVideo } from "@/lib/captionVideo";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string; name?: string };
  return (
    err.code === "ECONNRESET" ||
    err.name === "AbortError" ||
    /aborted|ECONNRESET/i.test(err.message ?? "")
  );
}

function isCaption(x: unknown): x is Caption {
  if (!x || typeof x !== "object") return false;
  const c = x as Caption;
  return (
    typeof c.text === "string" &&
    typeof c.startMs === "number" &&
    typeof c.endMs === "number"
  );
}

/**
 * POST /api/caption-video
 * multipart:
 * - `video`: video file
 * - `captions`: JSON string of Remotion Caption[] (from @remotion/whisper-web toCaptions)
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const video = form.get("video");
    const captionsRaw = form.get("captions");

    if (!(video instanceof File) || video.size === 0) {
      return NextResponse.json(
        { ok: false, error: "Upload a video (field name: video)." },
        { status: 400 }
      );
    }

    if (typeof captionsRaw !== "string" || !captionsRaw.trim()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Missing captions JSON. Transcribe in the browser with @remotion/whisper-web first.",
        },
        { status: 400 }
      );
    }

    let captions: Caption[];
    try {
      const parsed = JSON.parse(captionsRaw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isCaption)) {
        throw new Error("captions must be an array of Remotion Caption objects");
      }
      captions = parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: `Invalid captions JSON: ${msg}` }, { status: 400 });
    }

    const ext = path.extname(video.name).toLowerCase() || ".mp4";
    if (!ALLOWED.has(ext)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported video type ${ext}. Use mp4, mov, webm, mkv, or m4v.` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await video.arrayBuffer());
    console.log(
      `[caption-video] received ${video.name} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB), ${captions.length} caption token(s)`
    );

    const result = await burnCaptionsOnVideo(buffer, video.name, captions);

    console.log(
      `[caption-video] done ${result.videoUrl} duration=${result.durationSec.toFixed(2)}s cues=${result.cueCount}`
    );

    return NextResponse.json({
      ok: true,
      videoUrl: result.videoUrl,
      durationSec: result.durationSec,
      cueCount: result.cueCount,
      message: "Whisper captions burned in (Remotion Caption[] + createTikTokStyleCaptions).",
    });
  } catch (e) {
    if (isAbortError(e)) {
      console.warn("[caption-video] client aborted upload");
      return NextResponse.json(
        {
          ok: false,
          error: "Upload was aborted. Retry once, use a shorter clip, or keep the file under ~100MB.",
        },
        { status: 400 }
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("[caption-video]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
