import { google } from "googleapis";

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

function requireEnv(name: string): string {
  const v = process.env[name]?.trim() || "";
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

/** OAuth2 client for personal YouTube channel automation. */
export function createYoutubeOAuthClient() {
  return new google.auth.OAuth2(
    requireEnv("YOUTUBE_CLIENT_ID"),
    requireEnv("YOUTUBE_CLIENT_SECRET"),
    process.env.YOUTUBE_REDIRECT_URI?.trim() ||
      "http://localhost:3000/api/auth/youtube/callback"
  );
}

/** Consent URL — access_type=offline + prompt=consent so Google returns a refresh_token. */
export function getYoutubeAuthUrl(): string {
  const client = createYoutubeOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...YOUTUBE_SCOPES],
    include_granted_scopes: true,
  });
}

/** Exchange ?code= from Google redirect for tokens. */
export async function exchangeYoutubeCode(code: string) {
  const client = createYoutubeOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Authenticated YouTube Data API v3 client using YOUTUBE_REFRESH_TOKEN.
 * Access tokens refresh automatically via google-auth-library.
 */
export function getYoutubeClient() {
  const oauth2 = createYoutubeOAuthClient();
  oauth2.setCredentials({
    refresh_token: requireEnv("YOUTUBE_REFRESH_TOKEN"),
  });
  return google.youtube({ version: "v3", auth: oauth2 });
}

export function isYoutubeConfigured(): {
  oauthApp: boolean;
  refreshToken: boolean;
} {
  return {
    oauthApp: Boolean(
      process.env.YOUTUBE_CLIENT_ID?.trim() &&
        process.env.YOUTUBE_CLIENT_SECRET?.trim()
    ),
    refreshToken: Boolean(process.env.YOUTUBE_REFRESH_TOKEN?.trim()),
  };
}

export { YOUTUBE_SCOPES };
