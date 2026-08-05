import { NextResponse } from "next/server";
import JSZip from "jszip";
import { parseStoryboardUpload } from "@/lib/multerUpload";
import { extractGridScenesFromSheet } from "@/lib/storyboardCrop";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/crop-storyboard
 * multipart field `storyboards`: one or more images, each a 3×3 storyboard sheet.
 * Sheets are processed A→Z by original filename; scenes are numbered sequentially (scene_001.png…).
 * Response: application/zip with all cropped PNGs.
 */
export async function POST(req: Request) {
  try {
    const files = await parseStoryboardUpload(req);
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Add at least one image (field name: storyboards)." },
        { status: 400 }
      );
    }

    const sorted = [...files].sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, { sensitivity: "base", numeric: true })
    );

    const zip = new JSZip();
    let sceneNum = 1;

    for (const f of sorted) {
      if (!f.buffer?.length) continue;
      const scenes = await extractGridScenesFromSheet(f.buffer, sceneNum);
      sceneNum += scenes.length;
      for (const s of scenes) {
        zip.file(s.filename, s.data);
      }
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
        "Content-Disposition": 'attachment; filename="storyboard-scenes.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[crop-storyboard]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
