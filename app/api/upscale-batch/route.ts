import { NextResponse } from "next/server";
import JSZip from "jszip";
import path from "node:path";
import { parseUpscaleUpload } from "@/lib/multerUpload";
import { upscale2xLanczos } from "@/lib/batchUpscale";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * POST /api/upscale-batch
 * multipart field `upscaleImages`: multiple still images.
 * Files sorted A→Z by name; each is scaled 2× with Lanczos3; format preserved (JPEG/PNG/WebP; GIF → PNG).
 * Response: `upscaled-2x.zip`
 */
export async function POST(req: Request) {
  try {
    const files = await parseUpscaleUpload(req);
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Add at least one image (field name: upscaleImages)." },
        { status: 400 }
      );
    }

    const sorted = [...files].sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, { sensitivity: "base", numeric: true })
    );

    const zip = new JSZip();

    for (const f of sorted) {
      if (!f.buffer?.length) continue;
      const ext = path.extname(f.originalname).toLowerCase() || ".png";
      if (!ALLOWED_EXT.has(ext)) {
        return NextResponse.json(
          { ok: false, error: `Unsupported type ${ext}. Use PNG, JPG, WebP, or GIF.` },
          { status: 400 }
        );
      }
      const out = await upscale2xLanczos(f.buffer, f.originalname);
      zip.file(out.filename, out.data);
    }

    const buf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="upscaled-2x.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[upscale-batch]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
