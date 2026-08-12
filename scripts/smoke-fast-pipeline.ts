/**
 * Smoke: faster async pipeline (parallel prep + TTS concurrency + veryfast encode).
 * Run: STORY_RENDERER=ffmpeg npx tsx scripts/smoke-fast-pipeline.ts
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
  process.env.STORY_RENDERER = "ffmpeg";

  const { buildStoryVideo } = await import("../lib/storyVideoPipeline");

  const logs: string[] = [];
  const story = `
I used to hear crying from the apartment next door every night around 2am.
At first I thought the neighbors had a baby. Then I realized the unit had been empty for months.
One night I knocked. Something knocked back from inside the wall.
I called the landlord the next morning. He said nobody had lived there for years.
The crying never stopped after that. It just got quieter, like it was listening.
  `.trim();

  const t0 = Date.now();
  const result = await buildStoryVideo({
    story,
    lang: "en",
    voiceGender: "female",
    storySpeed: 1.5,
    autoFitSpeed: true,
    brollId: "remote:halloween-mc-1",
    onLog: (m) => {
      console.log("[log]", m);
      logs.push(m);
    },
  });

  const summary = {
    ok: true,
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    videoUrl: result.videoUrl,
    durationSec: result.durationSec,
    under60s: result.durationSec < 60,
    under2minWall: (Date.now() - t0) / 1000 < 120,
    renderer: result.renderer,
    broll: result.brollSource,
    hasParallelLog: logs.some((l) => l.includes("Planning + B-roll in parallel")),
    hasFastEncode: logs.some((l) =>
      /preset=(ultrafast|veryfast|superfast)/.test(l)
    ),
    hasCap59: logs.some((l) => /cap 5\ds|≤5\d\.0s|≤59s/.test(l)),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.under60s ||
    !summary.under2minWall ||
    !summary.hasParallelLog ||
    !summary.hasFastEncode
  ) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
