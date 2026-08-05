import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native addons / CLI wrappers external so paths resolve at runtime
  serverExternalPackages: [
    "@huggingface/transformers",
    "@remotion/captions",
    "ffmpeg-static",
    "fluent-ffmpeg",
    "groq-sdk",
    "jszip",
    "kokoro-js",
    "msedge-tts",
    "googleapis",
    "multer",
    "sharp",
    "uuid",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "512mb",
    },
    // Long B-roll uploads for story-video (20–30 min sources)
    proxyClientMaxBodySize: "512mb",
  },
  // Required for @remotion/whisper-web SharedArrayBuffer (WASM Whisper).
  // Skip COOP/COEP on OAuth callbacks so Google redirects are not blocked.
  async headers() {
    return [
      {
        source: "/auth/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Cross-Origin-Embedder-Policy", value: "unsafe-none" },
        ],
      },
      {
        source: "/api/auth/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Cross-Origin-Embedder-Policy", value: "unsafe-none" },
        ],
      },
      {
        source: "/((?!auth/|api/auth/).*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
