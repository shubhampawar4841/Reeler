import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { parseMultipartUpload } from "@/lib/multerUpload";
import {
  getSessionDir,
  safeAudioName,
  safeImageName,
  writeManifest,
  type SessionManifest,
} from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const ALLOWED_AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

/**
 * POST /api/upload (multipart/form-data)
 * Parsed with **multer** (memory storage); session id from **uuid**.
 *
 * Fields:
 * - images: one or more image files (ordered **A→Z by original file name** in the video)
 * - audio: voice-over narration (synced in the video)
 * - music: optional background music
 *
 * Image **timing** and on-screen lines come from the pasted transcript in `/api/generate-video`, not from Whisper.
 */
export async function POST(req: Request) {
  const logs: { level: "info" | "error"; message: string }[] = [];
  const push = (message: string) => {
    console.log(`[upload] ${message}`);
    logs.push({ level: "info", message });
  };

  try {
    const { images: imageFiles, audio: audioFile, music: musicFile } =
      await parseMultipartUpload(req);

    if (!audioFile?.buffer?.length) {
      return NextResponse.json(
        { ok: false, error: "Missing audio file (field name: audio)", logs },
        { status: 400 }
      );
    }

    if (imageFiles.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Upload at least one image (field name: images)", logs },
        { status: 400 }
      );
    }

    const sessionId = uuidv4();
    const sessionDir = getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    push(`Created session ${sessionId}`);

    const sortedImages = [...imageFiles].sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, { sensitivity: "base", numeric: true })
    );
    push(`Sorted ${sortedImages.length} image(s) A→Z by file name for slide order.`);

    const savedImages: string[] = [];
    for (let i = 0; i < sortedImages.length; i++) {
      const file = sortedImages[i]!;
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_IMAGE_EXT.has(ext)) {
        return NextResponse.json(
          { ok: false, error: `Unsupported image type: ${ext}`, logs },
          { status: 400 }
        );
      }
      const name = safeImageName(i, file.originalname);
      const dest = path.join(sessionDir, name);
      await fs.writeFile(dest, file.buffer);
      savedImages.push(name);
      push(`Saved ${name} (${file.buffer.length} bytes)`);
    }

    const audioExt = path.extname(audioFile.originalname).toLowerCase();
    if (!ALLOWED_AUDIO_EXT.has(audioExt)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported narration audio: ${audioExt}`, logs },
        { status: 400 }
      );
    }
    const audioName = safeAudioName("voice", audioFile.originalname);
    await fs.writeFile(path.join(sessionDir, audioName), audioFile.buffer);
    push(`Saved narration as ${audioName}`);

    let musicName: string | undefined;
    if (musicFile?.buffer?.length) {
      const mExt = path.extname(musicFile.originalname).toLowerCase();
      if (!ALLOWED_AUDIO_EXT.has(mExt)) {
        return NextResponse.json(
          { ok: false, error: `Unsupported music audio: ${mExt}`, logs },
          { status: 400 }
        );
      }
      musicName = safeAudioName("music", musicFile.originalname);
      await fs.writeFile(path.join(sessionDir, musicName), musicFile.buffer);
      push(`Saved background music as ${musicName}`);
    }

    const manifest: SessionManifest = {
      sessionId,
      images: savedImages,
      audio: audioName,
      music: musicName,
    };
    await writeManifest(sessionDir, manifest);
    push("Wrote manifest.json");

    return NextResponse.json({
      ok: true,
      sessionId,
      manifest,
      logs,
      message:
        "Upload complete. POST /api/generate-video with timedTranscript (and the same sessionId).",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[upload]", e);
    logs.push({ level: "error", message });
    return NextResponse.json({ ok: false, error: message, logs }, { status: 500 });
  }
}
