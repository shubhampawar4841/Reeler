import { handleYoutubeOAuthCallback } from "@/lib/youtubeOAuthCallback";

export const runtime = "nodejs";

/** Legacy path — prefer /api/auth/youtube/callback (Google Console). */
export async function GET(req: Request) {
  return handleYoutubeOAuthCallback(req);
}
