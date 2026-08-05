import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Stored in each upload folder so later steps can find assets */
export type SessionManifest = {
  sessionId: string;
  /** Filenames only (img-000…), alphabetical by original upload name */
  images: string[];
  /** Narration filename (voice-over), e.g. voice.mp3 */
  audio: string;
  /** Optional background music */
  music?: string;
};

export const MANIFEST_FILENAME = "manifest.json";

/** Ephemeral session assets (not under `public/` — avoids bloating the repo disk). */
export function getUploadsRoot(): string {
  return path.join(os.tmpdir(), "reeler-uploads");
}

export function getSessionDir(sessionId: string): string {
  return path.join(getUploadsRoot(), sessionId);
}

/** Prevents path traversal when reading user-supplied session ids */
export function assertSafeSessionId(sessionId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) {
    throw new Error("Invalid session id");
  }
}

export async function writeManifest(sessionDir: string, manifest: SessionManifest): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
}

export async function readManifest(sessionDir: string): Promise<SessionManifest> {
  const raw = await fs.readFile(path.join(sessionDir, MANIFEST_FILENAME), "utf8");
  return JSON.parse(raw) as SessionManifest;
}

export function safeImageName(index: number, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase() || ".png";
  const allowed = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
  const useExt = allowed.includes(ext) ? ext : ".png";
  return `img-${String(index).padStart(3, "0")}${useExt}`;
}

export function safeAudioName(kind: "voice" | "music", originalName: string): string {
  const ext = path.extname(originalName).toLowerCase() || ".mp3";
  return `${kind}${ext}`;
}
