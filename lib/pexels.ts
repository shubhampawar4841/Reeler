import fs from "node:fs/promises";
import path from "node:path";
import { getPexelsApiKey } from "@/lib/storyTypes";

type PexelsVideoFile = {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
};

type PexelsVideo = {
  id: number;
  url: string;
  image: string;
  duration: number;
  video_files: PexelsVideoFile[];
};

type PexelsSearchResponse = {
  videos: PexelsVideo[];
};

function pickBestFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const mp4 = files.filter(
    (f) =>
      f.file_type.includes("mp4") ||
      f.link.includes(".mp4") ||
      f.quality === "hd" ||
      f.quality === "sd"
  );
  if (mp4.length === 0) return null;
  // Prefer landscape ~1080p
  const landscape = mp4
    .filter((f) => f.width >= f.height)
    .sort((a, b) => {
      const score = (f: PexelsVideoFile) => {
        const near1080 = -Math.abs(f.height - 1080);
        return near1080 * 10000 + f.width;
      };
      return score(b) - score(a);
    });
  return landscape[0] ?? mp4.sort((a, b) => b.width - a.width)[0]!;
}

export async function searchPexelsVideo(query: string): Promise<{
  videoId: number;
  downloadUrl: string;
  previewImage: string;
  duration: number;
}> {
  const key = getPexelsApiKey();
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "8");
  url.searchParams.set("orientation", "landscape");

  const res = await fetch(url.toString(), {
    headers: { Authorization: key },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Pexels search failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as PexelsSearchResponse;
  if (!data.videos?.length) {
    throw new Error(`No Pexels videos for query: "${query}"`);
  }

  for (const v of data.videos) {
    const file = pickBestFile(v.video_files ?? []);
    if (file?.link) {
      return {
        videoId: v.id,
        downloadUrl: file.link,
        previewImage: v.image,
        duration: v.duration,
      };
    }
  }
  throw new Error(`Pexels returned videos but no usable MP4 for: "${query}"`);
}

export async function downloadToFile(
  url: string,
  destPath: string,
  opts?: { timeoutMs?: number; retries?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const retries = Math.max(1, opts?.retries ?? 3);
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const partPath = `${destPath}.part`;
    try {
      await fs.rm(partPath, { force: true });
      await fs.rm(destPath, { force: true });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          redirect: "follow",
        });
        if (!res.ok) {
          throw new Error(`Download failed (HTTP ${res.status})`);
        }
        if (!res.body) {
          throw new Error("Download failed (empty response body)");
        }
        // Stream to disk — avoid buffering entire MP4 in RAM
        await pipeline(
          Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
          createWriteStream(partPath)
        );
      } finally {
        clearTimeout(timer);
      }

      const st = await fs.stat(partPath);
      if (st.size < 1000) {
        throw new Error(`Download failed (file too small: ${st.size} bytes)`);
      }
      await fs.rename(partPath, destPath);
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      await fs.rm(partPath, { force: true }).catch(() => {});
      await fs.rm(destPath, { force: true }).catch(() => {});
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  throw lastErr ?? new Error(`Download failed after ${retries} attempts`);
}
