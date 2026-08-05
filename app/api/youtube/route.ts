import { NextResponse } from "next/server";
import {
  fetchMyChannel,
  publicVideoUrlToAbsolute,
  uploadYoutubeVideo,
  type YoutubePrivacy,
} from "@/lib/youtube";
import { isYoutubeConfigured } from "@/lib/youtubeAuth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/youtube/status — is OAuth + refresh token configured?
 * POST /api/youtube/upload — { videoUrl, title, description?, tags?, privacyStatus?, publishAt? }
 */
export async function GET() {
  const cfg = isYoutubeConfigured();
  let channel: { title?: string | null; id?: string | null } | null = null;
  if (cfg.refreshToken) {
    try {
      const ch = await fetchMyChannel();
      channel = {
        id: ch?.id ?? null,
        title: ch?.snippet?.title ?? null,
      };
    } catch {
      channel = null;
    }
  }
  return NextResponse.json({
    ok: true,
    ...cfg,
    connected: cfg.oauthApp && cfg.refreshToken,
    channel,
    connectUrl: "/auth/youtube",
  });
}

export async function POST(req: Request) {
  try {
    const cfg = isYoutubeConfigured();
    if (!cfg.oauthApp || !cfg.refreshToken) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "YouTube not connected. Set client id/secret, visit /auth/youtube, then paste YOUTUBE_REFRESH_TOKEN into .env.",
        },
        { status: 400 }
      );
    }

    const body = (await req.json()) as {
      videoUrl?: string;
      title?: string;
      description?: string;
      tags?: string[];
      privacyStatus?: YoutubePrivacy;
      publishAt?: string;
      thumbnailPath?: string;
    };

    const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!videoUrl || !title) {
      return NextResponse.json(
        { ok: false, error: "Provide videoUrl (e.g. /output/.../story.mp4) and title." },
        { status: 400 }
      );
    }

    const filePath = publicVideoUrlToAbsolute(videoUrl);
    const uploaded = await uploadYoutubeVideo({
      filePath,
      title,
      description: body.description,
      tags: body.tags,
      privacyStatus: body.privacyStatus ?? "private",
      publishAt: body.publishAt,
      thumbnailPath: body.thumbnailPath,
    });

    return NextResponse.json({
      ok: true,
      ...uploaded,
      message: "Uploaded as a YouTube Short (vertical + #Shorts).",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[youtube/upload]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
