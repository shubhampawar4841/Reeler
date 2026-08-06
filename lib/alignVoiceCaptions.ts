import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import Groq from "groq-sdk";
import { toFile } from "groq-sdk";
import type { Caption } from "@remotion/captions";
import { getFfmpegExecutable } from "@/lib/binPaths";
import { getGroqApiKey } from "@/lib/storyTypes";
import type { StoryLang } from "@/lib/groqStoryboard";

export type AlignVoiceLog = (msg: string) => void;

type GroqWord = { word: string; start: number; end: number };

type GroqVerboseTranscription = {
  text?: string;
  words?: GroqWord[];
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    words?: GroqWord[];
  }>;
};

const WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL?.trim() || "whisper-large-v3-turbo";

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

function wordsToCaptions(words: GroqWord[]): Caption[] {
  const captions: Caption[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const raw = w.word.trim();
    if (!raw) continue;
    const startMs = Math.max(0, Math.round(w.start * 1000));
    const endMs = Math.max(startMs + 40, Math.round(w.end * 1000));
    captions.push({
      // Remotion Caption convention: leading space on words after the first
      text: captions.length === 0 ? raw : ` ${raw}`,
      startMs,
      endMs,
      timestampMs: startMs,
      confidence: 1,
    });
  }
  return captions;
}

/** Fallback when Whisper returns no word timings — char-weight spread over known narration. */
export function captionsFromNarrationTimeline(
  narration: string,
  durationSec: number
): Caption[] {
  const words = narration.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0 || durationSec <= 0) return [];
  const weights = words.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, "").length || 1));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((w, i) => {
    const slice = (weights[i]! / totalW) * durationSec;
    const startMs = Math.round(t * 1000);
    t += slice;
    const endMs = Math.round(
      i === words.length - 1 ? durationSec * 1000 : t * 1000
    );
    return {
      text: i === 0 ? w : ` ${w}`,
      startMs,
      endMs: Math.max(startMs + 40, endMs),
      timestampMs: startMs,
      confidence: 0.5,
    } satisfies Caption;
  });
}

async function wavToMp3(wavPath: string, mp3Path: string): Promise<void> {
  await runFfmpeg([
    "-y",
    "-i",
    wavPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-b:a",
    "64k",
    mp3Path,
  ]);
}

function extractWords(result: GroqVerboseTranscription): GroqWord[] {
  if (Array.isArray(result.words) && result.words.length > 0) {
    return result.words.filter((w) => w.word?.trim() && Number.isFinite(w.start));
  }
  const fromSegs: GroqWord[] = [];
  for (const seg of result.segments ?? []) {
    if (Array.isArray(seg.words) && seg.words.length) {
      for (const w of seg.words) {
        if (w.word?.trim() && Number.isFinite(w.start)) fromSegs.push(w);
      }
    }
  }
  return fromSegs;
}

/**
 * Force-align karaoke captions to the final VO WAV via Groq Whisper word timestamps.
 * Falls back to char-weighted narration split if Whisper returns no words.
 */
export async function alignVoiceCaptions(options: {
  voicePath: string;
  lang: StoryLang;
  narration: string;
  durationSec: number;
  onLog?: AlignVoiceLog;
}): Promise<Caption[]> {
  const { voicePath, lang, narration, durationSec, onLog } = options;
  const workDir = path.dirname(voicePath);
  const mp3Path = path.join(workDir, "voice-align.mp3");

  onLog?.(`Aligning captions with Groq Whisper (${WHISPER_MODEL}, ${lang})…`);

  try {
    await wavToMp3(voicePath, mp3Path);
    const client = new Groq({ apiKey: getGroqApiKey() });
    const prompt = narration.replace(/\s+/g, " ").trim().slice(0, 800);

    const file = await toFile(fs.createReadStream(mp3Path), "voice.mp3");
    const raw = (await client.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      language: lang === "hi" ? "hi" : "en",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      temperature: 0,
      ...(prompt ? { prompt } : {}),
    })) as unknown as GroqVerboseTranscription;

    const words = extractWords(raw);
    if (words.length === 0) {
      onLog?.("Whisper returned no word timestamps — using narration timeline fallback");
      return captionsFromNarrationTimeline(narration, durationSec);
    }

    const captions = wordsToCaptions(words);
    onLog?.(
      `Whisper aligned ${captions.length} word(s) across ~${durationSec.toFixed(1)}s`
    );
    return captions;
  } catch (err) {
    onLog?.(
      `Whisper align failed (${err instanceof Error ? err.message : String(err)}) — narration timeline fallback`
    );
    return captionsFromNarrationTimeline(narration, durationSec);
  } finally {
    try {
      await fsp.unlink(mp3Path);
    } catch {
      /* ignore */
    }
  }
}
