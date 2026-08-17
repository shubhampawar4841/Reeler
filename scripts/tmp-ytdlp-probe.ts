import { fetchYoutubeStoryText } from "../lib/youtubeTranscript";
async function main() {
  const id = process.argv[2] || "0KXfJPKSxb8";
  const t = await fetchYoutubeStoryText(id, { lang: "en" });
  console.log(JSON.stringify({ videoId: t.videoId, chars: t.text.length, durationSec: Math.round(t.durationSec) }, null, 2));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
