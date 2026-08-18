import { findRandomYoutubeStory } from "../lib/youtubeRandomStory";

async function main(): Promise<void> {
  const story = await findRandomYoutubeStory("en", console.log);
  console.log(
    JSON.stringify(
      {
        channel: story.channel,
        title: story.title,
        chars: story.text.length,
        videoUrl: story.videoUrl,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
