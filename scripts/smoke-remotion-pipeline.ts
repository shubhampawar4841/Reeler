/**
 * Phase 2 smoke: full story pipeline with Remotion mux.
 * Run: STORY_RENDERER=remotion npx tsx scripts/smoke-remotion-pipeline.ts
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
  process.env.STORY_RENDERER = "remotion";

  const { buildStoryVideo } = await import("../lib/storyVideoPipeline");

  const story = `
I used to hear crying from the apartment next door every night around 2am.
At first I thought the neighbors had a baby. Then I realized the unit had been empty for months.
One night I knocked. Something knocked back from inside the wall.
  `.trim();

  console.log("Building story with STORY_RENDERER=remotion…");
  const result = await buildStoryVideo({
    story,
    lang: "en",
    onLog: console.log,
  });

  console.log("\nRESULT");
  console.log(JSON.stringify(result, null, 2));
  const abs = path.join(process.cwd(), "public", result.videoUrl.replace(/^\//, ""));
  const mb = fs.existsSync(abs) ? fs.statSync(abs).size / (1024 * 1024) : 0;
  console.log(`File: ${abs} (${mb.toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
