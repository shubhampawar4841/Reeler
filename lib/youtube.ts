import fs from "node:fs";
import path from "node:path";
import { getYoutubeClient } from "@/lib/youtubeAuth";

export type YoutubePrivacy = "public" | "unlisted" | "private";

export type UploadYoutubeVideoOptions = {
  /** Absolute path to an .mp4 (or other YouTube-compatible) file */
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  /** YouTube category — 22 = People & Blogs, 24 = Entertainment */
  categoryId?: string;
  privacyStatus?: YoutubePrivacy;
  /** ISO-8601 schedule time; forces private until publishAt */
  publishAt?: string;
  /** Absolute path to thumbnail image (optional) */
  thumbnailPath?: string;
};

export type UploadedYoutubeVideo = {
  videoId: string;
  title: string;
  privacyStatus: string;
  publishedAt?: string | null;
  /** Prefer Shorts URL for vertical uploads */
  url: string;
  watchUrl: string;
  shortsUrl: string;
};

function assertReadableFile(filePath: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size < 100) {
    throw new Error(`${label} is empty or invalid: ${filePath}`);
  }
}

/**
 * YouTube rejects descriptions with angle brackets, most C0 controls, and broken UTF-16.
 * Keep newlines/tabs; strip everything else that commonly triggers
 * "invalid video description".
 */
export function sanitizeYoutubeDescription(raw: string, maxLen = 4900): string {
  let s = String(raw ?? "");
  // Normalize newlines
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Drop null + C0 controls except \n \t
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // YouTube API: angle brackets are treated as invalid markup
  s = s.replace(/[<>]/g, "");
  // Strip unpaired surrogates (no lookbehind — broader JS target safe)
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  s = s.replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1");
  // Collapse runaway blank lines
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/** YouTube Shorts: vertical 9:16 + #Shorts in title/description (no separate "shorts" API flag). */
function formatAsShort(title: string, description: string, tags: string[]) {
  let t = title.trim().replace(/\s*#Shorts\b/gi, "").trim();
  // Leave room for " #Shorts"
  if (t.length > 90) t = t.slice(0, 90).trim();
  const shortsTitle = `${t} #Shorts`.slice(0, 100);

  const descBase = sanitizeYoutubeDescription(description, 4800);
  const shortsDesc = sanitizeYoutubeDescription(
    [descBase, "", "#Shorts #shorts #horror #storytime"]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n"),
    5000
  );

  const tagSet = new Set(
    [...tags, "Shorts", "YouTube Shorts", "shorts", "horror", "story"].map((x) =>
      x.trim()
    )
  );
  const shortsTags = [...tagSet].filter(Boolean).slice(0, 30);

  return { shortsTitle, shortsDesc, shortsTags };
}

/**
 * Upload a local vertical video as a YouTube Short to your connected channel.
 */
export async function uploadYoutubeVideo(
  opts: UploadYoutubeVideoOptions
): Promise<UploadedYoutubeVideo> {
  assertReadableFile(opts.filePath, "Video");
  const youtube = getYoutubeClient();

  const privacyStatus = opts.publishAt
    ? "private"
    : opts.privacyStatus ?? "private";

  const { shortsTitle, shortsDesc, shortsTags } = formatAsShort(
    opts.title,
    opts.description ?? "",
    opts.tags ?? []
  );

  try {
    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: shortsTitle,
          description: shortsDesc,
          tags: shortsTags,
          categoryId: opts.categoryId ?? "24", // Entertainment — common for Shorts
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
          ...(opts.publishAt ? { publishAt: opts.publishAt } : {}),
        },
      },
      media: {
        body: fs.createReadStream(opts.filePath),
      },
    });

    const videoId = res.data.id;
    if (!videoId) throw new Error("YouTube upload succeeded but returned no video id.");

    if (opts.thumbnailPath) {
      await setYoutubeThumbnail(videoId, opts.thumbnailPath);
    }

    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const shortsUrl = `https://www.youtube.com/shorts/${videoId}`;

    return {
      videoId,
      title: res.data.snippet?.title ?? shortsTitle,
      privacyStatus: res.data.status?.privacyStatus ?? privacyStatus,
      publishedAt: res.data.snippet?.publishedAt,
      url: shortsUrl,
      watchUrl,
      shortsUrl,
    };
  } catch (err) {
    const anyErr = err as {
      message?: string;
      errors?: Array<{ message?: string; reason?: string }>;
      response?: { data?: { error?: { message?: string; errors?: unknown } } };
    };
    const apiMsg =
      anyErr?.response?.data?.error?.message ||
      anyErr?.errors?.[0]?.message ||
      anyErr?.message ||
      String(err);
    const preview = shortsDesc.slice(0, 180).replace(/\n/g, "\\n");
    throw new Error(
      `YouTube upload failed: ${apiMsg} (titleLen=${shortsTitle.length}, descLen=${shortsDesc.length}, descPreview="${preview}…")`
    );
  }
}

export async function setYoutubeThumbnail(
  videoId: string,
  thumbnailPath: string
): Promise<void> {
  assertReadableFile(thumbnailPath, "Thumbnail");
  const youtube = getYoutubeClient();
  await youtube.thumbnails.set({
    videoId,
    media: {
      body: fs.createReadStream(thumbnailPath),
    },
  });
}

export async function updateYoutubeTitle(
  videoId: string,
  title: string,
  description?: string,
  categoryId = "22"
): Promise<void> {
  const youtube = getYoutubeClient();
  await youtube.videos.update({
    part: ["snippet"],
    requestBody: {
      id: videoId,
      snippet: {
        title: title.slice(0, 100),
        description: sanitizeYoutubeDescription(description ?? "", 5000),
        categoryId,
      },
    },
  });
}

export async function deleteYoutubeVideo(videoId: string): Promise<void> {
  const youtube = getYoutubeClient();
  await youtube.videos.delete({ id: videoId });
}

export async function fetchMyChannel() {
  const youtube = getYoutubeClient();
  const res = await youtube.channels.list({
    part: ["snippet", "statistics"],
    mine: true,
  });
  return res.data.items?.[0] ?? null;
}

export async function fetchVideoStats(videoId: string) {
  const youtube = getYoutubeClient();
  const res = await youtube.videos.list({
    part: ["statistics", "snippet", "status"],
    id: [videoId],
  });
  return res.data.items?.[0] ?? null;
}

export async function listMyVideos(maxResults = 25) {
  const youtube = getYoutubeClient();
  const res = await youtube.search.list({
    part: ["snippet"],
    forMine: true,
    type: ["video"],
    maxResults,
    order: "date",
  });
  return res.data.items ?? [];
}

export async function createPlaylist(title: string, privacyStatus: YoutubePrivacy = "public") {
  const youtube = getYoutubeClient();
  const res = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title },
      status: { privacyStatus },
    },
  });
  return res.data.id ?? null;
}

export async function addVideoToPlaylist(playlistId: string, videoId: string) {
  const youtube = getYoutubeClient();
  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });
}

/** Resolve a public URL like /output/<id>/story.mp4 to an absolute disk path. */
export function publicVideoUrlToAbsolute(videoUrl: string): string {
  const rel = videoUrl.split("?")[0]!.replace(/^\//, "");
  if (!rel.startsWith("output/")) {
    throw new Error("Only /output/... videos can be uploaded from this app.");
  }
  const abs = path.join(process.cwd(), "public", rel);
  assertReadableFile(abs, "Public video");
  return abs;
}
