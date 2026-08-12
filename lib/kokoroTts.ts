/**
 * Story VO: Kokoro (local EN) or Microsoft Edge neural TTS (HI always; EN on Vercel).
 * Caption timing still comes from Whisper on the final WAV.
 *
 * Kokoro needs onnxruntime native libs — missing on Vercel → Edge fallback.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { getFfmpegExecutable } from "@/lib/binPaths";
import type { StoryLang } from "@/lib/groqStoryboard";

type KokoroInstance = {
  generate: (
    text: string,
    opts: { voice: string; speed: number }
  ) => Promise<{ save: (p: string) => void | Promise<void> }>;
};

let ttsPromise: Promise<KokoroInstance> | null = null;
let kokoroUnavailable: string | null = null;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Soft char budget for a single Kokoro `generate` call (phoneme / token limit). */
const KOKORO_ONE_SHOT_MAX_CHARS = 420;

/** Soft char budget for a single Edge TTS request (long payloads get flaky). */
const EDGE_ONE_SHOT_MAX_CHARS = 420;

export type VoiceChunk = {
  text: string;
  durationSec: number;
};

export type VoiceResult = {
  path: string;
  durationSec: number;
  /** Optional segments for logging; captions use Whisper on the final WAV. */
  chunks: VoiceChunk[];
  engine: "kokoro" | "edge";
  voice: string;
};

export type VoiceGender = "female" | "male";

/** True on Vercel / Lambda, or when TTS_ENGINE=edge. */
export function preferEdgeTts(): boolean {
  const forced = process.env.TTS_ENGINE?.trim().toLowerCase();
  if (forced === "edge") return true;
  if (forced === "kokoro") return false;
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.AWS_LAMBDA_FUNCTION_NAME
  );
}

async function getKokoroTts(): Promise<KokoroInstance> {
  if (kokoroUnavailable) {
    throw new Error(kokoroUnavailable);
  }
  if (!ttsPromise) {
    ttsPromise = (async () => {
      try {
        // Dynamic import so Vercel doesn't crash on missing libonnxruntime.so.1
        const { KokoroTTS } = await import("kokoro-js");
        return (await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype:
            (process.env.KOKORO_DTYPE as
              | "q8"
              | "fp32"
              | "fp16"
              | "q4"
              | "q4f16") || "q8",
          device: "cpu",
        })) as KokoroInstance;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        kokoroUnavailable = `Kokoro unavailable (${msg})`;
        ttsPromise = null;
        throw new Error(kokoroUnavailable);
      }
    })();
  }
  return ttsPromise;
}

/** Warm Kokoro when it can run; no-op on Vercel / Edge-forced. */
export async function warmKokoroTts(): Promise<void> {
  if (preferEdgeTts()) return;
  try {
    await getKokoroTts();
  } catch {
    /* Edge fallback will handle EN */
  }
}

/** Run async work over items with a fixed concurrency cap (order-preserving results). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

const TTS_SEGMENT_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.TTS_SEGMENT_CONCURRENCY) || 4)
);

function resolveEnKokoroVoice(override?: string | null): string {
  if (override?.trim() && !override.includes("Neural")) return override.trim();
  return process.env.KOKORO_VOICE?.trim() || "af_heart";
}

function resolveEnEdgeVoice(
  override?: string | null,
  gender?: VoiceGender | null
): string {
  if (override?.trim() && /Neural/i.test(override)) return override.trim();
  if (override === "am_fenrir" || gender === "male") {
    return process.env.EN_EDGE_VOICE_MALE?.trim() || "en-US-GuyNeural";
  }
  return process.env.EN_EDGE_VOICE_FEMALE?.trim() || "en-US-JennyNeural";
}

function resolveHiEdgeVoice(override?: string | null): string {
  if (override?.trim()) return override.trim();
  return process.env.HINDI_EDGE_VOICE?.trim() || "hi-IN-MadhurNeural";
}

/** Map UI gender → Kokoro (local EN) / Edge (HI + Vercel EN) voice id. */
export function voiceIdForGender(lang: StoryLang, gender: VoiceGender): string {
  if (lang === "hi") {
    return gender === "male" ? "hi-IN-MadhurNeural" : "hi-IN-SwaraNeural";
  }
  if (preferEdgeTts()) {
    return gender === "male" ? "en-US-GuyNeural" : "en-US-JennyNeural";
  }
  return gender === "male" ? "am_fenrir" : "af_heart";
}

function resolveSpeed(): number {
  const raw = Number(process.env.KOKORO_SPEED);
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 2) return raw;
  return 1.45;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      getFfmpegExecutable(),
      args,
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, _o, stderr) => {
        if (err) {
          reject(
            new Error(
              typeof stderr === "string" && stderr ? stderr.slice(-1500) : err.message
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}

async function probeDurationSec(filePath: string): Promise<number> {
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(
      getFfmpegExecutable(),
      ["-hide_banner", "-nostdin", "-i", filePath],
      { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, _o, e) => {
        const text = typeof e === "string" ? e : "";
        if (text) resolve(text);
        else reject(err ?? new Error("probe failed"));
      }
    );
  });
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) throw new Error(`No Duration for ${path.basename(filePath)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function concatWavParts(partPaths: string[], outPath: string): Promise<void> {
  if (partPaths.length === 1) {
    await fs.copyFile(partPaths[0]!, outPath);
    return;
  }
  const workDir = path.dirname(partPaths[0]!);
  const listFile = path.join(workDir, "concat.txt");
  const listBody = partPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listFile, listBody, "utf8");
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
}

function splitForTts(text: string, maxChars = 280): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts: string[] = [];
  const sentences = cleaned.split(/(?<=[।.!?…])\s+/u).filter(Boolean);
  let buf = "";
  for (const s of sentences) {
    if ((buf + " " + s).trim().length <= maxChars) {
      buf = (buf + " " + s).trim();
    } else {
      if (buf) parts.push(buf);
      if (s.length <= maxChars) {
        buf = s;
      } else {
        for (let i = 0; i < s.length; i += maxChars) {
          parts.push(s.slice(i, i + maxChars).trim());
        }
        buf = "";
      }
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [cleaned];
}

async function synthesizeKokoroEn(
  text: string,
  outPath: string,
  onLog?: (msg: string) => void,
  voiceOverride?: string | null
): Promise<VoiceResult> {
  const voice = resolveEnKokoroVoice(voiceOverride);
  const speed = resolveSpeed();
  onLog?.(
    `Kokoro EN (${MODEL_ID}, voice=${voice}, speed=${speed}) — one continuous WAV…`
  );
  const tts = await getKokoroTts();

  const workDir = path.join(path.dirname(outPath), `kokoro-parts-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    if (text.length <= KOKORO_ONE_SHOT_MAX_CHARS) {
      const audio = await tts.generate(text, {
        voice: voice as "af_bella",
        speed,
      });
      await Promise.resolve(audio.save(outPath));
      onLog?.(`Kokoro EN one-shot generate (${text.length} chars)`);
    } else {
      const parts = splitForTts(text, KOKORO_ONE_SHOT_MAX_CHARS);
      onLog?.(
        `Kokoro EN ${parts.length} generate() segment(s) @ concurrency=${TTS_SEGMENT_CONCURRENCY} → single continuous WAV`
      );
      const partPaths = await mapPool(
        parts,
        TTS_SEGMENT_CONCURRENCY,
        async (piece, i) => {
          const part = path.join(
            workDir,
            `part-${String(i).padStart(3, "0")}.wav`
          );
          const audio = await tts.generate(piece, {
            voice: voice as "af_bella",
            speed,
          });
          await Promise.resolve(audio.save(part));
          onLog?.(
            `  segment ${i + 1}/${parts.length}: "${piece.slice(0, 50)}${piece.length > 50 ? "…" : ""}"`
          );
          return part;
        }
      );
      await concatWavParts(partPaths, outPath);
    }

    const durationSec = await probeDurationSec(outPath);
    onLog?.(`Kokoro EN saved (${durationSec.toFixed(1)}s continuous WAV)`);
    return {
      path: outPath,
      durationSec,
      chunks: [{ text, durationSec }],
      engine: "kokoro",
      voice,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Edge neural TTS (HI always; EN on Vercel / TTS_ENGINE=edge / Kokoro failure).
 */
async function synthesizeEdgeVoice(
  text: string,
  outPathWav: string,
  voice: string,
  label: string,
  onLog?: (msg: string) => void
): Promise<VoiceResult> {
  onLog?.(
    `${label} Edge (${voice}, speed=${resolveSpeed()}) — one continuous WAV…`
  );

  const workDir = path.join(
    path.dirname(outPathWav),
    `edge-parts-${Date.now()}`
  );
  await fs.mkdir(workDir, { recursive: true });

  try {
    const rate = resolveSpeed();

    const synthesizePiece = async (
      piece: string,
      wavDest: string,
      idx: number
    ) => {
      const pieceDir = path.join(
        workDir,
        `edge-${String(idx).padStart(3, "0")}`
      );
      await fs.mkdir(pieceDir, { recursive: true });
      const tts = new MsEdgeTTS();
      await tts.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
      );
      const { audioFilePath } = await tts.toFile(pieceDir, piece, { rate });
      await runFfmpeg([
        "-y",
        "-i",
        audioFilePath,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavDest,
      ]);
      try {
        await fs.rm(pieceDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    if (text.length <= EDGE_ONE_SHOT_MAX_CHARS) {
      await synthesizePiece(text, outPathWav, 0);
      onLog?.(`${label} Edge one-shot generate (${text.length} chars)`);
    } else {
      const parts = splitForTts(text, EDGE_ONE_SHOT_MAX_CHARS);
      onLog?.(
        `${label} Edge ${parts.length} generate() segment(s) @ concurrency=${TTS_SEGMENT_CONCURRENCY} → single continuous WAV`
      );
      const partPaths = await mapPool(
        parts,
        TTS_SEGMENT_CONCURRENCY,
        async (piece, i) => {
          const wav = path.join(
            workDir,
            `part-${String(i).padStart(3, "0")}.wav`
          );
          await synthesizePiece(piece, wav, i);
          onLog?.(
            `  segment ${i + 1}/${parts.length}: "${piece.slice(0, 50)}${piece.length > 50 ? "…" : ""}"`
          );
          return wav;
        }
      );
      if (partPaths.length === 0) throw new Error("Edge TTS produced no audio.");
      await concatWavParts(partPaths, outPathWav);
    }

    const durationSec = await probeDurationSec(outPathWav);
    onLog?.(
      `${label} Edge VO saved (${durationSec.toFixed(1)}s continuous WAV)`
    );
    return {
      path: outPathWav,
      durationSec,
      chunks: [{ text, durationSec }],
      engine: "edge",
      voice,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Synthesize story VO.
 * Local EN → Kokoro (falls back to Edge if ONNX missing).
 * Vercel EN / Hindi → Edge.
 */
export async function synthesizeStoryVoice(
  text: string,
  outPathNoExt: string,
  lang: StoryLang = "en",
  onLog?: (msg: string) => void,
  opts?: { voice?: string | null; gender?: VoiceGender | null }
): Promise<VoiceResult> {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("Cannot synthesize empty narration.");

  const outPath = outPathNoExt.endsWith(".wav")
    ? outPathNoExt
    : `${outPathNoExt}.wav`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const gender =
    opts?.gender === "male" || opts?.gender === "female" ? opts.gender : null;

  if (lang === "hi") {
    const voice =
      opts?.voice?.trim() ||
      (gender ? voiceIdForGender("hi", gender) : null) ||
      resolveHiEdgeVoice(null);
    return synthesizeEdgeVoice(cleaned, outPath, voice, "Hindi", onLog);
  }

  const useEdge = preferEdgeTts();
  if (useEdge) {
    const voice = resolveEnEdgeVoice(opts?.voice, gender);
    onLog?.("Vercel/serverless: using Edge TTS for English (Kokoro ONNX unavailable)");
    return synthesizeEdgeVoice(cleaned, outPath, voice, "English", onLog);
  }

  try {
    return await synthesizeKokoroEn(cleaned, outPath, onLog, opts?.voice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(`Kokoro failed (${msg.slice(0, 160)}); falling back to Edge EN…`);
    const voice = resolveEnEdgeVoice(opts?.voice, gender);
    return synthesizeEdgeVoice(cleaned, outPath, voice, "English", onLog);
  }
}

/** @deprecated use synthesizeStoryVoice */
export async function synthesizeKokoroVoice(
  text: string,
  outPathNoExt: string,
  onLog?: (msg: string) => void
): Promise<string> {
  const r = await synthesizeStoryVoice(text, outPathNoExt, "en", onLog);
  return r.path;
}
