/**
 * Profile Remotion fixture render — cold/warm bundle, selectComposition, renderMedia stages.
 * Run: npx tsx scripts/smoke-remotion-profile.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ms(n: number): string {
  if (n < 1000) return `${n.toFixed(0)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  const { buildFixtureStoryInput, getCompositionDurationInFrames } = await import(
    "../remotion/utils/fixture"
  );
  const {
    resetRemotionBundleCache,
    renderStoryShortProfiled,
  } = await import("../lib/remotion/renderStory");

  const outDir = path.join(process.cwd(), "public", "output", "remotion-profile");
  fs.mkdirSync(outDir, { recursive: true });

  // Prefer attaching a real short B-roll if a previous parkour asset exists nearby
  const input = buildFixtureStoryInput();
  const sampleCandidates = [
    path.join(process.cwd(), "public", "output", "remotion-fixture", "story.mp4"),
  ];
  // Look for any leftover assets from prior story jobs
  const outputRoot = path.join(process.cwd(), "public", "output");
  if (fs.existsSync(outputRoot)) {
    for (const job of fs.readdirSync(outputRoot)) {
      const b1 = path.join(outputRoot, job, "assets", "broll-1.mp4");
      if (fs.existsSync(b1)) sampleCandidates.unshift(b1);
    }
  }

  let usedRealBroll = false;
  const publicSample = path.join(outDir, "assets");
  for (const cand of sampleCandidates) {
    if (!fs.existsSync(cand) || !cand.endsWith(".mp4")) continue;
    // Only use dedicated broll assets (not finished story) when possible
    if (cand.includes(`${path.sep}assets${path.sep}`) || cand.includes("/assets/")) {
      fs.mkdirSync(publicSample, { recursive: true });
      const dest = path.join(publicSample, "broll-sample.mp4");
      fs.copyFileSync(cand, dest);
      const rel = "output/remotion-profile/assets/broll-sample.mp4";
      for (const sc of input.sceneSchedule) {
        sc.clipPath = rel;
        sc.clipStartSec = 5 + Math.random() * 20;
      }
      usedRealBroll = true;
      console.log(`Using real B-roll sample: ${cand}`);
      break;
    }
  }
  if (!usedRealBroll) {
    console.log("No leftover B-roll assets found — profiling fixture gradient background (no video decode).");
  }

  const frames = getCompositionDurationInFrames(input);
  console.log(
    `\nCPU=${os.cpus().length} threads | frames=${frames} | fps=${input.fps} | ~${(frames / input.fps).toFixed(1)}s video`
  );
  console.log(`OffthreadVideo=${usedRealBroll} | captions=${input.captions.length} words\n`);

  // --- Cold bundle ---
  resetRemotionBundleCache();
  const coldOut = path.join(outDir, "profile-cold.mp4");
  console.log("=== RUN A: cold bundle + render (concurrency=1) ===");
  const cold = await renderStoryShortProfiled({
    input,
    outPath: coldOut,
    concurrency: 1,
    onLog: (m) => console.log(`  ${m}`),
  });

  // --- Warm bundle, concurrency 1 ---
  const warm1Out = path.join(outDir, "profile-warm-c1.mp4");
  console.log("\n=== RUN B: warm bundle + render (concurrency=1) ===");
  const warm1 = await renderStoryShortProfiled({
    input,
    outPath: warm1Out,
    concurrency: 1,
    onLog: (m) => console.log(`  ${m}`),
  });

  // --- Warm bundle, higher concurrency ---
  const cpu = Math.max(1, os.cpus().length - 1);
  const conc = Math.min(4, cpu);
  const warmNOut = path.join(outDir, `profile-warm-c${conc}.mp4`);
  console.log(`\n=== RUN C: warm bundle + render (concurrency=${conc}) ===`);
  const warmN = await renderStoryShortProfiled({
    input,
    outPath: warmNOut,
    concurrency: conc,
    onLog: (m) => console.log(`  ${m}`),
  });

  const report = {
    meta: {
      frames,
      fps: input.fps,
      durationSec: frames / input.fps,
      offthreadVideo: usedRealBroll,
      captionWords: input.captions.length,
      cpuThreads: os.cpus().length,
    },
    cold,
    warmConcurrency1: warm1,
    warmConcurrencyN: { concurrency: conc, ...warmN },
  };

  const reportPath = path.join(outDir, "profile-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n========== PROFILE SUMMARY ==========");
  const rows = [
    ["phase", "cold", "warm c=1", `warm c=${conc}`],
    [
      "bundle",
      ms(cold.timings.bundleMs),
      ms(warm1.timings.bundleMs),
      ms(warmN.timings.bundleMs),
    ],
    [
      "selectComposition",
      ms(cold.timings.selectMs),
      ms(warm1.timings.selectMs),
      ms(warmN.timings.selectMs),
    ],
    [
      "renderMedia total",
      ms(cold.timings.renderMediaMs),
      ms(warm1.timings.renderMediaMs),
      ms(warmN.timings.renderMediaMs),
    ],
    [
      "  ↳ frames doneIn",
      ms(cold.timings.framesDoneInMs ?? 0),
      ms(warm1.timings.framesDoneInMs ?? 0),
      ms(warmN.timings.framesDoneInMs ?? 0),
    ],
    [
      "  ↳ encode doneIn",
      ms(cold.timings.encodeDoneInMs ?? 0),
      ms(warm1.timings.encodeDoneInMs ?? 0),
      ms(warmN.timings.encodeDoneInMs ?? 0),
    ],
    [
      "TOTAL",
      ms(cold.timings.totalMs),
      ms(warm1.timings.totalMs),
      ms(warmN.timings.totalMs),
    ],
    [
      "ms/frame (render)",
      (cold.timings.renderMediaMs / frames).toFixed(1),
      (warm1.timings.renderMediaMs / frames).toFixed(1),
      (warmN.timings.renderMediaMs / frames).toFixed(1),
    ],
  ];
  for (const r of rows) {
    console.log(r.map((c) => String(c).padEnd(16)).join(""));
  }

  const base = warm1.timings;
  console.log("\nWarm c=1 share of total:");
  console.log(
    `  bundle ${pct(base.bundleMs, base.totalMs)} · select ${pct(base.selectMs, base.totalMs)} · renderMedia ${pct(base.renderMediaMs, base.totalMs)}`
  );
  if (base.framesDoneInMs != null && base.encodeDoneInMs != null) {
    console.log(
      `  within renderMedia — frames ${pct(base.framesDoneInMs, base.renderMediaMs)} · encode ${pct(base.encodeDoneInMs, base.renderMediaMs)}`
    );
  }
  const speedup =
    warm1.timings.renderMediaMs > 0
      ? warm1.timings.renderMediaMs / warmN.timings.renderMediaMs
      : 1;
  console.log(
    `\nConcurrency ${conc} vs 1 renderMedia speedup: ${speedup.toFixed(2)}x`
  );
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
