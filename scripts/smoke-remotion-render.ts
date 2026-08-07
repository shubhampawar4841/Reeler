/**
 * Phase 1 smoke: render fixture StoryShort → public/output/remotion-fixture/story.mp4
 * Run: npm run remotion:render
 */
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]!]) process.env[m[1]!] = v;
  }
}

async function main() {
  loadEnv();
  const { buildFixtureStoryInput } = await import("../remotion/utils/fixture");
  const { renderStoryShort } = await import("../lib/remotion/renderStory");

  const outDir = path.join(process.cwd(), "public", "output", "remotion-fixture");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "story.mp4");

  const input = buildFixtureStoryInput();
  console.log(
    `Fixture: "${input.plan.title}" · ${input.captions.length} words · ${input.sceneSchedule.length} scenes`
  );

  const result = await renderStoryShort({
    input,
    outPath,
    onLog: console.log,
  });

  const sizeMb = fs.statSync(outPath).size / (1024 * 1024);
  console.log(
    `OK → ${outPath} (${sizeMb.toFixed(2)} MB, ${result.durationInFrames} frames)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
