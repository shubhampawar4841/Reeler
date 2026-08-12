/**
 * Cut random 2–3 min clips from large public/ B-roll sources, re-encode small
 * for Supabase upload.
 *
 * Usage:
 *   npx tsx scripts/cut-broll-clips.ts
 *   npx tsx scripts/cut-broll-clips.ts --min-mb 80 --clips 3 --out out/supabase-broll
 *
 * Only sources larger than --min-mb are processed (small clips like asmr.mp4 are skipped).
 * Audio is stripped (story pipeline uses separate TTS).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getFfmpegExecutable } from "../lib/binPaths";

type ClipJob = {
  source: string;
  sourceBase: string;
  startSec: number;
  durationSec: number;
  outPath: string;
  outName: string;
};

function parseArgs(argv: string[]) {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const getNum = (flag: string, fallback: number) => {
    const n = Number(get(flag, String(fallback)));
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    publicDir: path.resolve(get("--public", "public")),
    outDir: path.resolve(get("--out", "out/supabase-broll")),
    minMb: getNum("--min-mb", 80),
    clipsPerSource: getNum("--clips", 3),
    minClipSec: getNum("--min-sec", 120),
    maxClipSec: getNum("--max-sec", 180),
    crf: getNum("--crf", 28),
    maxHeight: getNum("--height", 720),
    fps: getNum("--fps", 30),
    /** Only process these basenames (substring match). Empty = all large files. */
    only: argv.includes("--only")
      ? argv
          .slice(argv.indexOf("--only") + 1)
          .filter((a) => !a.startsWith("--"))
      : ([] as string[]),
  };
}

function run(
  bin: string,
  args: string[],
  label: string
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
    console.log(`[${label}] ${bin} ${args.join(" ")}`);
  });
}

async function probeDurationSec(ffmpeg: string, file: string): Promise<number> {
  const { stderr } = await run(
    ffmpeg,
    ["-hide_banner", "-i", file],
    "probe"
  );
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`Could not probe duration: ${file}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  return h * 3600 + min * 60 + sec;
}

function slugify(name: string): string {
  return name
    .replace(/\.(mp4|mov|webm|mkv|m4v)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function pickNonOverlappingStarts(
  totalSec: number,
  clipDurations: number[],
  padSec = 5
): number[] {
  const starts: number[] = [];
  const attempts = 80;

  for (const dur of clipDurations) {
    const maxStart = Math.max(0, totalSec - dur - padSec);
    if (maxStart < padSec) {
      starts.push(0);
      continue;
    }

    let placed = false;
    for (let a = 0; a < attempts; a++) {
      const s = padSec + Math.random() * (maxStart - padSec);
      const overlaps = starts.some((other, i) => {
        const otherDur = clipDurations[i]!;
        return !(s + dur + padSec <= other || other + otherDur + padSec <= s);
      });
      if (!overlaps) {
        starts.push(s);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Fallback: spread evenly
      const idx = starts.length;
      const n = clipDurations.length;
      starts.push(
        Math.min(maxStart, padSec + (idx * (maxStart - padSec)) / Math.max(1, n - 1))
      );
    }
  }
  return starts;
}

function listLargeSources(
  publicDir: string,
  minBytes: number,
  only: string[]
): string[] {
  const files = fs.readdirSync(publicDir).filter((f) =>
    VIDEO_EXT.has(path.extname(f).toLowerCase())
  );

  const out: string[] = [];
  for (const f of files) {
    const full = path.join(publicDir, f);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    if (st.size < minBytes) continue;
    if (only.length && !only.some((q) => f.toLowerCase().includes(q.toLowerCase()))) {
      continue;
    }
    out.push(full);
  }
  return out.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

async function encodeClip(
  ffmpeg: string,
  job: ClipJob,
  opts: { crf: number; maxHeight: number; fps: number }
): Promise<void> {
  // Scale down to max height, keep aspect; strip audio; fast small encode.
  const vf = `scale=-2:min(${opts.maxHeight}\\,ih),fps=${opts.fps},format=yuv420p`;
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    job.startSec.toFixed(3),
    "-t",
    job.durationSec.toFixed(3),
    "-i",
    job.source,
    "-an",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(opts.crf),
    "-movflags",
    "+faststart",
    job.outPath,
  ];

  const { code, stderr } = await run(ffmpeg, args, job.outName);
  if (code !== 0) {
    throw new Error(`FFmpeg failed for ${job.outName}: ${stderr.slice(-800)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ffmpeg = getFfmpegExecutable();
  const minBytes = opts.minMb * 1024 * 1024;

  if (opts.maxClipSec < opts.minClipSec) {
    throw new Error("--max-sec must be >= --min-sec");
  }

  fs.mkdirSync(opts.outDir, { recursive: true });

  const sources = listLargeSources(opts.publicDir, minBytes, opts.only);
  if (!sources.length) {
    console.error(
      `No sources ≥ ${opts.minMb}MB in ${opts.publicDir}` +
        (opts.only.length ? ` matching --only ${opts.only.join(" ")}` : "")
    );
    process.exit(1);
  }

  console.log(`FFmpeg: ${ffmpeg}`);
  console.log(`Out: ${opts.outDir}`);
  console.log(
    `Sources (≥${opts.minMb}MB): ${sources.length} → ${opts.clipsPerSource} clips each (${opts.minClipSec}–${opts.maxClipSec}s)\n`
  );

  const jobs: ClipJob[] = [];
  const manifest: Array<Record<string, unknown>> = [];

  for (const source of sources) {
    const base = path.basename(source);
    const sizeMb = (fs.statSync(source).size / (1024 * 1024)).toFixed(1);
    const dur = await probeDurationSec(ffmpeg, source);
    console.log(`• ${base} (${sizeMb}MB, ${dur.toFixed(0)}s)`);

    if (dur < opts.minClipSec + 10) {
      console.warn(`  skip — source shorter than one clip window`);
      continue;
    }

    const n = Math.max(1, Math.min(opts.clipsPerSource, 8));
    const clipDurs = Array.from({ length: n }, () => {
      const span = opts.maxClipSec - opts.minClipSec;
      return opts.minClipSec + Math.random() * span;
    });

    // Cap total clip length so we can still place non-overlapping windows
    const usable = Math.max(0, dur - 10);
    if (clipDurs.reduce((a, b) => a + b, 0) > usable * 0.95) {
      const scale = (usable * 0.9) / clipDurs.reduce((a, b) => a + b, 0);
      for (let i = 0; i < clipDurs.length; i++) {
        clipDurs[i] = Math.max(opts.minClipSec * 0.75, clipDurs[i]! * scale);
      }
    }

    const starts = pickNonOverlappingStarts(dur, clipDurs);
    const slug = slugify(base);

    for (let i = 0; i < n; i++) {
      const outName = `${slug}-clip${i + 1}.mp4`;
      const outPath = path.join(opts.outDir, outName);
      jobs.push({
        source,
        sourceBase: base,
        startSec: starts[i]!,
        durationSec: clipDurs[i]!,
        outPath,
        outName,
      });
    }
  }

  for (const job of jobs) {
    console.log(
      `\nEncoding ${job.outName}  @${job.startSec.toFixed(1)}s  ${job.durationSec.toFixed(0)}s  from ${job.sourceBase}`
    );
    await encodeClip(ffmpeg, job, opts);
    const mb = fs.statSync(job.outPath).size / (1024 * 1024);
    console.log(`  ✓ ${(mb).toFixed(1)} MB → ${job.outPath}`);
    manifest.push({
      file: job.outName,
      path: job.outPath,
      sizeMb: Number(mb.toFixed(2)),
      startSec: Number(job.startSec.toFixed(2)),
      durationSec: Number(job.durationSec.toFixed(2)),
      source: job.sourceBase,
      supabaseHint: `Upload ${job.outName} to your public bucket, then add to REMOTE_BROLL in lib/brollCatalog.ts`,
    });
  }

  const manifestPath = path.join(opts.outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nDone. ${jobs.length} clips. Manifest: ${manifestPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
