import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { KokoroTTS } from "kokoro-js";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { getFfmpegExecutable } from "@/lib/binPaths";
import type { StoryLang } from "@/lib/groqStoryboard";

type KokoroInstance = Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>;

let ttsPromise: Promise<KokoroInstance> | null = null;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Soft char budget for a single Kokoro `generate` call (phoneme / token limit). */
const KOKORO_ONE_SHOT_MAX_CHARS = 420;

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

async function getKokoroTts(): Promise<KokoroInstance> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: (process.env.KOKORO_DTYPE as "q8" | "fp32" | "fp16" | "q4" | "q4f16") || "q8",
      device: "cpu",
    }).catch((err) => {
      ttsPromise = null;
      throw err;
    });
  }
  return ttsPromise;
}

function resolveEnVoice(): string {
  return process.env.KOKORO_VOICE?.trim() || "am_fenrir";
}

/** Edge neural voice for Hindi (kokoro-js npm has no hf_/hm_ voices yet). */
function resolveHiEdgeVoice(): string {
  return process.env.HINDI_EDGE_VOICE?.trim() || "hi-IN-MadhurNeural";
}

function resolveSpeed(): number {
  const raw = Number(process.env.KOKORO_SPEED);
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 2) return raw;
  return 1.18;
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
  // Re-encode so the final WAV has a continuous timeline (no concat demuxer quirks).
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

/** Split long text into ~sentence-ish pieces for Edge TTS / safer Kokoro payloads. */
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
  onLog?: (msg: string) => void
): Promise<VoiceResult> {
  const voice = resolveEnVoice();
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
        voice: voice as "af_heart",
        speed,
      });
      await Promise.resolve(audio.save(outPath));
      onLog?.(`Kokoro EN one-shot generate (${text.length} chars)`);
    } else {
      // Phoneme limit: generate sentence groups, then stitch into one continuous WAV.
      const parts = splitForTts(text, KOKORO_ONE_SHOT_MAX_CHARS);
      onLog?.(
        `Kokoro EN ${parts.length} generate() segment(s) → single continuous WAV`
      );
      const partPaths: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const piece = parts[i]!;
        const part = path.join(workDir, `part-${String(i).padStart(3, "0")}.wav`);
        const audio = await tts.generate(piece, {
          voice: voice as "af_heart",
          speed,
        });
        await Promise.resolve(audio.save(part));
        onLog?.(
          `  segment ${i + 1}/${parts.length}: "${piece.slice(0, 50)}${piece.length > 50 ? "…" : ""}"`
        );
        partPaths.push(part);
      }
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
 * Hindi VO via Microsoft Edge online voices.
 * Note: kokoro-js@1.2.1 only ships EN/UK voices (no hf_alpha / hm_omega).
 * Prefer hi-IN-MadhurNeural (male, mystery) — similar role to hm_omega.
 */
async function synthesizeEdgeHi(
  text: string,
  outPathWav: string,
  onLog?: (msg: string) => void
): Promise<VoiceResult> {
  const voice = resolveHiEdgeVoice();
  onLog?.(
    `Hindi VO via Edge TTS (${voice}) — sentence splits → one continuous WAV`
  );

  const workDir = path.join(path.dirname(outPathWav), `edge-parts-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const parts = splitForTts(text, 260);
  const partPaths: string[] = [];

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const rate = resolveSpeed();

    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i]!;
      const { audioFilePath } = await tts.toFile(workDir, piece, { rate });
      const wav = path.join(workDir, `part-${String(i).padStart(3, "0")}.wav`);
      await runFfmpeg(["-y", "-i", audioFilePath, "-ar", "24000", "-ac", "1", wav]);
      try {
        await fs.unlink(audioFilePath);
      } catch {
        /* ignore */
      }
      onLog?.(
        `  [${i + 1}/${parts.length}] "${piece.slice(0, 40)}${piece.length > 40 ? "…" : ""}"`
      );
      partPaths.push(wav);
    }

    if (partPaths.length === 0) throw new Error("Edge TTS produced no audio.");

    await concatWavParts(partPaths, outPathWav);
    const durationSec = await probeDurationSec(outPathWav);
    onLog?.(`Hindi Edge VO saved (${durationSec.toFixed(1)}s continuous WAV)`);
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
 * Synthesize story VO. English → kokoro-js. Hindi → Edge (until kokoro-js ships hf_/hm_).
 * Timing for captions comes from Whisper on the final WAV, not TTS chunk probes.
 */
export async function synthesizeStoryVoice(
  text: string,
  outPathNoExt: string,
  lang: StoryLang = "en",
  onLog?: (msg: string) => void
): Promise<VoiceResult> {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("Cannot synthesize empty narration.");

  const outPath = outPathNoExt.endsWith(".wav") ? outPathNoExt : `${outPathNoExt}.wav`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  if (lang === "hi") {
    return synthesizeEdgeHi(cleaned, outPath, onLog);
  }
  return synthesizeKokoroEn(cleaned, outPath, onLog);
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
