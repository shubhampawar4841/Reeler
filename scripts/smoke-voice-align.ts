/**
 * Smoke: one-shot Kokoro EN + Groq Whisper word align (no B-roll / full Short).
 * Run: npx tsx scripts/smoke-voice-align.ts
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  const workDir = path.join(os.tmpdir(), `reeler-smoke-align-${Date.now()}`);
  await fsp.mkdir(workDir, { recursive: true });

  const { synthesizeStoryVoice } = await import("../lib/kokoroTts");
  const { alignVoiceCaptions } = await import("../lib/alignVoiceCaptions");
  const { buildAssFromVoiceCaptions } = await import("../lib/dummyCaptions");

  const narration =
    "Someone left the door unlocked. That should not matter. Unless something was waiting inside.";

  console.log("TTS…");
  const voice = await synthesizeStoryVoice(
    narration,
    path.join(workDir, "voice"),
    "en",
    console.log
  );
  console.log(`WAV: ${voice.path} (${voice.durationSec.toFixed(2)}s)`);

  console.log("Align…");
  const captions = await alignVoiceCaptions({
    voicePath: voice.path,
    lang: "en",
    narration,
    durationSec: voice.durationSec,
    onLog: console.log,
  });

  console.log(`Words: ${captions.length}`);
  for (const c of captions.slice(0, 12)) {
    console.log(
      `  ${(c.startMs / 1000).toFixed(2)}-${(c.endMs / 1000).toFixed(2)}s  ${JSON.stringify(c.text)}`
    );
  }
  if (captions.length > 12) console.log("  …");

  const last = captions[captions.length - 1];
  if (!captions.length) throw new Error("No captions produced");
  if (last!.endMs > voice.durationSec * 1000 + 800) {
    throw new Error("Caption end drifts past voice duration");
  }
  if (captions[0]!.startMs > 2500) {
    throw new Error("First caption starts too late");
  }

  const ass = buildAssFromVoiceCaptions(captions, 1080, 1920, {
    leadMs: 0,
    wordsPerLine: 4,
  });
  const assPath = path.join(workDir, "smoke.ass");
  await fsp.writeFile(assPath, ass, "utf8");
  console.log(`ASS events: ${(ass.match(/^Dialogue:/gm) || []).length}`);
  console.log("Smoke OK");
  console.log(`Artifacts: ${pathToFileURL(workDir).href}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
