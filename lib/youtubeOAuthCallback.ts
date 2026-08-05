import { NextResponse } from "next/server";
import { exchangeYoutubeCode } from "@/lib/youtubeAuth";

const REDIRECT_HINT =
  process.env.YOUTUBE_REDIRECT_URI?.trim() ||
  "http://localhost:3000/api/auth/youtube/callback";

/**
 * Shared OAuth callback handler for YouTube personal-channel connect.
 * Used by `/api/auth/youtube/callback` (primary, matches Google Console).
 */
export async function handleYoutubeOAuthCallback(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (err) {
    return htmlPage(
      "YouTube auth failed",
      `<p class="err">Google error: <code>${escapeHtml(err)}</code></p>
       <p><a href="/auth/youtube">Try again</a></p>`,
      400
    );
  }

  if (!code) {
    return htmlPage(
      "Missing code",
      `<p class="err">No <code>code</code> query param. Start from <a href="/auth/youtube">/auth/youtube</a>.</p>`,
      400
    );
  }

  try {
    const tokens = await exchangeYoutubeCode(code);
    const refresh = tokens.refresh_token;

    if (!refresh) {
      return htmlPage(
        "No refresh token",
        `<p class="err">Google did not return a <code>refresh_token</code>.</p>
         <p>Revoke access at
         <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google Account → Permissions</a>,
         then visit <a href="/auth/youtube">/auth/youtube</a> again.</p>
         <pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`
      );
    }

    return htmlPage(
      "YouTube connected",
      `<p class="ok">Copy this into <code>.env</code> / Vercel env, then restart the server:</p>
       <pre id="tok">YOUTUBE_REFRESH_TOKEN=${escapeHtml(refresh)}</pre>
       <p><button type="button" onclick="navigator.clipboard.writeText('YOUTUBE_REFRESH_TOKEN=${escapeHtml(refresh)}')">Copy line</button>
       <a class="btn" href="/">Back to app</a></p>
       <details><summary>Full token payload</summary><pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre></details>`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return htmlPage(
      "Token exchange failed",
      `<p class="err">${escapeHtml(message)}</p>
       <p><code>YOUTUBE_REDIRECT_URI</code> must match Google Console exactly:</p>
       <pre>${escapeHtml(REDIRECT_HINT)}</pre>
       <p><a href="/auth/youtube">Try again</a> (previous codes expire after one use)</p>`,
      500
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, body: string, status = 200): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Reeler</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background:#09090b; color:#e4e4e7; max-width:42rem; margin:3rem auto; padding:0 1.25rem; line-height:1.5; }
    h1 { font-size:1.35rem; color:#fda4af; }
    pre { background:#18181b; border:1px solid #3f3f46; border-radius:12px; padding:1rem; overflow:auto; font-size:12px; word-break:break-all; white-space:pre-wrap; }
    .ok { color:#86efac; } .err { color:#fca5a5; }
    a { color:#fda4af; } code { color:#fbbf24; }
    button, .btn { display:inline-block; margin-top:.75rem; margin-right:.5rem; background:#be123c; color:#fff; border:0; border-radius:10px; padding:.55rem 1rem; font-weight:600; cursor:pointer; text-decoration:none; font-size:14px; }
    details { margin-top:1.5rem; color:#a1a1aa; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "unsafe-none",
    },
  });
}
