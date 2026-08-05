import { NextResponse } from "next/server";
import { getYoutubeAuthUrl, isYoutubeConfigured } from "@/lib/youtubeAuth";

export const runtime = "nodejs";

/**
 * GET /auth/youtube
 * Redirects to Google consent (personal channel — do this once to get a refresh_token).
 */
export async function GET() {
  try {
    const { oauthApp } = isYoutubeConfigured();
    if (!oauthApp) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first (Google Cloud → OAuth Web client).",
        },
        { status: 400 }
      );
    }
    const url = getYoutubeAuthUrl();
    return NextResponse.redirect(url);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
