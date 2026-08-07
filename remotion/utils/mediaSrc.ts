import { staticFile } from "remotion";

/**
 * Resolve media for OffthreadVideo / Audio.
 * - http(s) → as-is
 * - public-relative path (e.g. output/job/assets/voice.wav) → staticFile()
 * - null → null
 *
 * Remotion headless Chrome cannot load file:// or raw Windows paths.
 */
export function resolveRemotionSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  const rel = src.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return staticFile(rel);
}
