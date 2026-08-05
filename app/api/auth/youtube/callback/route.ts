import { NextResponse } from "next/server";
import { handleYoutubeOAuthCallback } from "@/lib/youtubeOAuthCallback";

export const runtime = "nodejs";

/**
 * GET /api/auth/youtube/callback?code=...
 * Must match Google Cloud → Authorized redirect URI exactly.
 */
export async function GET(req: Request) {
  return handleYoutubeOAuthCallback(req);
}
