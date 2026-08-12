import { NextResponse } from "next/server";
import { listBrollCatalog } from "@/lib/brollCatalog";

export const runtime = "nodejs";

/** GET /api/broll — local public/*.mp4 + remote Supabase options for the UI picker. */
export async function GET() {
  try {
    const items = await listBrollCatalog();
    return NextResponse.json({
      ok: true,
      items: items.map((i) => ({
        id: i.id,
        label: i.label,
        kind: i.kind,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message, items: [] }, { status: 500 });
  }
}
