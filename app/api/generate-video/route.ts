import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeSessionId, getSessionDir, readManifest } from "@/lib/session";
import {
  alignCuesToVoiceDuration,
  cuesToSrt,
  parseParentheticalTimedTranscript,
} from "@/lib/parseTimedTranscript";
import { getMediaDurationSec } from "@/lib/audioDuration";
import { renderShortVideo } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 300;

type LogEntry = { level: "info" | "error"; message: string; progress?: number };

function jsonLogsResponse(
  ok: boolean,
  data: Record<string, unknown>,
  logs: LogEntry[],
  httpStatus: number
) {
  return NextResponse.json({ ok, logs, ...data }, { status: httpStatus });
}

/**
 * POST /api/generate-video
 * Body: { "sessionId": "<uuid>", "timedTranscript": "(0:00) ... (0:05) ..." }
 *
 * - **timedTranscript** sets when each slide runs and what subtitles say (parsed from `(M:SS)` markers).
 * - **Voice-over** comes from the narration file uploaded with the session (`manifest.audio`).
 */
export async function POST(req: Request) {
  const logs: LogEntry[] = [];
  const push = (message: string, progress?: number) => {
    console.log(`[generate-video] ${message}`);
    logs.push({ level: "info", message, progress });
  };

  try {
    const body = (await req.json()) as { sessionId?: string; timedTranscript?: string };
    const sessionId = body.sessionId;
    const timedTranscript = body.timedTranscript?.trim();

    if (!sessionId) {
      return jsonLogsResponse(false, { error: "sessionId is required" }, logs, 400);
    }
    if (!timedTranscript) {
      return jsonLogsResponse(
        false,
        {
          error:
            'timedTranscript is required. Paste your script with (M:SS) markers, e.g. (0:00) Line one. (0:05) Line two.',
        },
        logs,
        400
      );
    }
    assertSafeSessionId(sessionId);

    const sessionDir = getSessionDir(sessionId);
    const manifest = await readManifest(sessionDir);
    push(`Loaded manifest for session ${sessionId}`);

    const voicePath = path.join(sessionDir, manifest.audio);
    await fs.access(voicePath);
    const voiceDurationSec = await getMediaDurationSec(voicePath);
    push(`Narration length: ${voiceDurationSec.toFixed(2)}s (this sets total video length).`);

    const cues = alignCuesToVoiceDuration(
      parseParentheticalTimedTranscript(timedTranscript),
      voiceDurationSec
    );
    push(
      `Parsed ${cues.length} slide(s) from (M:SS) markers — each marker starts the next image; slides fill the narration (images loop if there are fewer images than slides).`
    );

    const srtBody = cuesToSrt(cues);
    await fs.writeFile(path.join(sessionDir, "subtitles.srt"), srtBody, "utf8");
    await fs.writeFile(path.join(sessionDir, "transcript.txt"), timedTranscript, "utf8");
    push("Wrote subtitles.srt and transcript.txt from your pasted timings");

    const imageAbsPaths = manifest.images.map((f) => path.join(sessionDir, f));
    for (const p of imageAbsPaths) {
      await fs.access(p);
    }

    push(`Using voice-over: ${manifest.audio}`);

    let musicPath: string | undefined = manifest.music
      ? path.join(sessionDir, manifest.music)
      : undefined;
    if (musicPath) {
      try {
        await fs.access(musicPath);
      } catch {
        musicPath = undefined;
      }
    }

    const outAbs = await renderShortVideo({
      sessionId,
      sessionDir,
      cues,
      imagePaths: imageAbsPaths,
      voicePath,
      voiceDurationSec,
      musicPath,
      onLog: (line) => push(line),
      onProgress: (p) => {
        logs.push({
          level: "info",
          message: `Encoding… ${p.percent.toFixed(1)}%`,
          progress: Math.round(p.percent),
        });
      },
    });

    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
      push("Removed temp session folder (images/audio) after encode — only the MP4 under public/output remains.");
    } catch {
      push("Could not delete temp session folder (safe to ignore).");
    }

    const relUrl = `/output/${sessionId}/final.mp4`;
    push(`Video ready: ${relUrl}`, 100);

    return jsonLogsResponse(
      true,
      {
        videoUrl: relUrl,
        absolutePath: outAbs,
        cueCount: cues.length,
        imageCount: manifest.images.length,
      },
      logs,
      200
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[generate-video]", e);
    logs.push({ level: "error", message });
    return jsonLogsResponse(false, { error: message }, logs, 500);
  }
}
