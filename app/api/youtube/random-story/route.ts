import { NextResponse } from "next/server";
import { findRandomYoutubeStory } from "@/lib/youtubeRandomStory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const langParam = new URL(request.url).searchParams.get("lang");
    const lang = langParam === "hi" ? "hi" : "en";
    const story = await findRandomYoutubeStory(lang);

    return NextResponse.json({
      ok: true,
      ...story,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[random-story] ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
