/**
 * B-roll sources for story Shorts — Supabase public URLs by default.
 * Pipeline seeks only the needed trim (-ss / -t) — never downloads whole remotes to disk.
 * Set BROLL_INCLUDE_LOCAL=1 to also list public/*.mp4.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type BrollKind = "local" | "remote";

export type BrollCatalogItem = {
  id: string;
  /** Friendly name for the UI dropdown */
  label: string;
  kind: BrollKind;
  /**
   * local → filename under public/ (not absolute)
   * remote → https URL
   */
  src: string;
};

/** Short label from a long stock filename. */
function shortLabel(filename: string): string {
  let name = filename.replace(/\.(mp4|mov|webm|mkv|m4v)$/i, "");
  name = name
    .replace(/\(No Copyright\)\s*/gi, "")
    .replace(/\s*No[- ]?Copyright[^\-–]*[-–]?\s*/gi, " ")
    .replace(/\(\d+p,\s*h264\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (name.length > 56) name = `${name.slice(0, 53)}…`;
  return name || filename;
}

function remoteItem(
  id: string,
  name: string,
  url: string,
  labelOverride?: string
): BrollCatalogItem {
  return {
    id: `remote:${id}`,
    label: labelOverride ?? shortLabel(name),
    kind: "remote",
    src: url,
  };
}

/** Supabase `meow` bucket — primary B-roll pool. */
export const REMOTE_BROLL: BrollCatalogItem[] = [
  remoteItem(
    "satisfying-1",
    "(No Copyright)Satisfying Videos Reel_Shorts format Satisfying Videos for Repost - Killing tech (480p, h264) (1).mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/%28No%20Copyright%29Satisfying%20Videos%20Reel_Shorts%20format%20Satisfying%20Videos%20for%20Repost%20-%20Killing%20tech%20%28480p%2C%20h264%29%20%281%29.mp4",
    "Satisfying / Killing tech 1"
  ),
  remoteItem(
    "satisfying-2",
    "(No Copyright)Satisfying Videos Reel_Shorts format Satisfying Videos for Repost - Killing tech (480p, h264).mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/%28No%20Copyright%29Satisfying%20Videos%20Reel_Shorts%20format%20Satisfying%20Videos%20for%20Repost%20-%20Killing%20tech%20%28480p%2C%20h264%29.mp4",
    "Satisfying / Killing tech 2"
  ),
  remoteItem(
    "gta-ramp-1",
    "best-gta-5-mega-ramp-no-copyright-gameplay-for-t-clip1.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/best-gta-5-mega-ramp-no-copyright-gameplay-for-t-clip1.mp4",
    "GTA mega ramp clip 1"
  ),
  remoteItem(
    "gta-ramp-2",
    "best-gta-5-mega-ramp-no-copyright-gameplay-for-t-clip2.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/best-gta-5-mega-ramp-no-copyright-gameplay-for-t-clip2.mp4",
    "GTA mega ramp clip 2"
  ),
  remoteItem(
    "halloween-mc-1",
    "halloween-minecraft-parkour-gameplay-no-copyrigh-clip1.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/halloween-minecraft-parkour-gameplay-no-copyrigh-clip1.mp4",
    "Halloween Minecraft clip 1"
  ),
  remoteItem(
    "halloween-mc-2",
    "halloween-minecraft-parkour-gameplay-no-copyrigh-clip2.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/halloween-minecraft-parkour-gameplay-no-copyrigh-clip2.mp4",
    "Halloween Minecraft clip 2"
  ),
  remoteItem(
    "halloween-mc-3",
    "halloween-minecraft-parkour-gameplay-no-copyrigh-clip3.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/halloween-minecraft-parkour-gameplay-no-copyrigh-clip3.mp4",
    "Halloween Minecraft clip 3"
  ),
  remoteItem(
    "minecraft-parkour-1",
    "minecraft-parkour-1.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/minecraft-parkour-1.mp4",
    "Minecraft parkour 1"
  ),
  remoteItem(
    "minecraft-parkour-2",
    "minecraft-parkour-2.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/minecraft-parkour-2.mp4",
    "Minecraft parkour 2"
  ),
  remoteItem(
    "minecraft-76-1",
    "minecraft-parkour-gameplay-no-copyright-4k-76-ga-clip1.mp4",
    "https://xoeejvzsafcxjkgkfunu.supabase.co/storage/v1/object/public/meow/minecraft-parkour-gameplay-no-copyright-4k-76-ga-clip1.mp4",
    "Minecraft parkour 76 clip 1"
  ),
];

const SKIP_DIR_NAMES = new Set(["output", "uploads", "assets"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

function publicRoot(): string {
  return path.join(process.cwd(), "public");
}

/** Absolute disk path for a local catalog filename (must stay under public/). */
export function resolveLocalBrollAbs(filename: string): string {
  const base = path.basename(filename);
  const abs = path.resolve(publicRoot(), base);
  const root = path.resolve(publicRoot()) + path.sep;
  if (!abs.startsWith(root) && abs !== path.resolve(publicRoot())) {
    throw new Error("Invalid B-roll path");
  }
  return abs;
}

async function listLocalPublicVideos(): Promise<BrollCatalogItem[]> {
  const root = publicRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: BrollCatalogItem[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (SKIP_DIR_NAMES.has(ent.name.toLowerCase())) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) continue;
    items.push({
      id: `local:${ent.name}`,
      label: `${shortLabel(ent.name)} (local)`,
      kind: "local",
      src: ent.name,
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/** Catalog for the UI / pipeline — Supabase remotes only unless BROLL_INCLUDE_LOCAL=1. */
export async function listBrollCatalog(): Promise<BrollCatalogItem[]> {
  if (process.env.BROLL_INCLUDE_LOCAL === "1") {
    const local = await listLocalPublicVideos();
    return [...REMOTE_BROLL, ...local];
  }
  return [...REMOTE_BROLL];
}

export function findBrollById(
  catalog: BrollCatalogItem[],
  id: string | null | undefined
): BrollCatalogItem | null {
  if (!id) return null;
  return catalog.find((c) => c.id === id) ?? null;
}

/** Input path/URL for FFmpeg (-i), after resolving locals under public/. */
export function brollFfmpegInput(item: BrollCatalogItem): string {
  if (item.kind === "remote") return item.src;
  return resolveLocalBrollAbs(item.src);
}
