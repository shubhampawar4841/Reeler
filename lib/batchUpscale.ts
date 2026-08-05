import path from "node:path";
import sharp from "sharp";

export type UpscaledFile = {
  /** e.g. photo_2x.jpg */
  filename: string;
  data: Buffer;
};

/**
 * 2× resize with Lanczos3 (high-quality, fast). Keeps JPEG/PNG/WebP output; GIF → PNG (first frame).
 */
export async function upscale2xLanczos(input: Buffer, originalFilename: string): Promise<UpscaledFile> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  const fmt = meta.format;

  const base = path.basename(originalFilename, path.extname(originalFilename)) || "image";
  const nw = Math.min(w * 2, 16384);
  const nh = Math.min(h * 2, 16384);

  let pipe = sharp(input).resize({
    width: nw,
    height: nh,
    fit: "fill",
    kernel: sharp.kernel.lanczos3,
  });

  if (fmt === "jpeg" || fmt === "jpg") {
    const data = await pipe.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    return { filename: `${base}_2x.jpg`, data };
  }
  if (fmt === "png") {
    const data = await pipe.png({ compressionLevel: 9 }).toBuffer();
    return { filename: `${base}_2x.png`, data };
  }
  if (fmt === "webp") {
    const data = await pipe.webp({ quality: 90 }).toBuffer();
    return { filename: `${base}_2x.webp`, data };
  }
  if (fmt === "gif") {
    const data = await sharp(input, { animated: false, pages: 1 })
      .resize({ width: nw, height: nh, fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { filename: `${base}_2x.png`, data };
  }

  const data = await pipe.png({ compressionLevel: 9 }).toBuffer();
  return { filename: `${base}_2x.png`, data };
}
