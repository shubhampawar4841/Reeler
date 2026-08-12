/**
 * Production story planner for faceless YouTube storytelling.
 *
 * Reddit dump → first-person spoken retell (JSON) → Kokoro / Edge TTS → FFmpeg.
 *
 * Public API: `planStoryWithGroq(story, lang?)` (name kept for callers)
 * Provider order: Gemini (primary) → Groq (fallback).
 *
 * Prompt v3: preserve every important event (no summary); length follows the source.
 */

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import {
  getGeminiApiKey,
  getGroqApiKey,
  type CameraMovement,
  type CaptionStyle,
  type MusicMood,
  type SceneTransition,
  type StoryEmotion,
  type StoryLang,
  type StoryPlan,
  type StoryScene,
} from "@/lib/storyTypes";

export type { StoryLang } from "@/lib/storyTypes";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_TPM_BUDGET = 30_000;
/** Long Reddit dumps need a large completion window so the model doesn't summarize. */
const DEFAULT_MAX_COMPLETION = 5_000;
/** Rough duration estimates in normalize only — not a pacing script for the model. */
const WORDS_PER_SEC = 2.4;

const EMOTIONS = new Set<StoryEmotion>([
  "fear",
  "regret",
  "shock",
  "curiosity",
  "dread",
  "confusion",
  "loneliness",
  "guilt",
  "panic",
  "awe",
  "unease",
]);

const CAMERAS = new Set<CameraMovement>([
  "static",
  "slow_push_in",
  "slow_pull_out",
  "drift_left",
  "drift_right",
  "handheld_shake",
  "crash_zoom",
  "tilt_up",
  "tilt_down",
]);

const CAPTION_STYLES = new Set<CaptionStyle>([
  "center_punch",
  "lower_third",
  "whisper",
  "impact",
  "karaoke",
]);

const TRANSITIONS = new Set<SceneTransition>([
  "cut",
  "fade",
  "flash",
  "glitch",
  "whip",
  "match_cut",
]);

const MUSIC_MOODS = new Set<MusicMood>([
  "dark_ambient",
  "tense_pulse",
  "eerie_drone",
  "heart_race",
  "lonely_piano",
  "apocalyptic",
  "quiet_dread",
]);

// ─── Token budget (Groq free-tier TPM) ───────────────────────────────────────

function estimateTokens(text: string): number {
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  return Math.ceil(text.length / (hasDevanagari ? 2.2 : 3.5));
}

type BudgetFit = {
  storyForPrompt: string;
  maxTokens: number;
  truncated: boolean;
};

function fitToTpmBudget(
  system: string,
  userPrefix: string,
  story: string
): BudgetFit {
  const tpm = Math.max(4_000, Number(process.env.GROQ_TPM_BUDGET) || DEFAULT_TPM_BUDGET);
  const desiredMax = Math.max(
    1_024,
    Number(process.env.GROQ_MAX_TOKENS) || DEFAULT_MAX_COMPLETION
  );
  const safety = 450;
  const fixed =
    estimateTokens(system) +
    estimateTokens(userPrefix) +
    estimateTokens("\n---\n\n---\n") +
    safety;

  let maxTokens = Math.min(desiredMax, tpm - fixed - 600);
  if (maxTokens < 1_024) maxTokens = 1_024;

  const storyTokenBudget = Math.max(700, tpm - fixed - maxTokens);
  const charsPerToken = /[\u0900-\u097F]/.test(story) ? 2.2 : 3.5;
  const maxChars = Math.floor(storyTokenBudget * charsPerToken);

  if (story.length <= maxChars) {
    return { storyForPrompt: story, maxTokens, truncated: false };
  }

  // Prefer keeping as much raw story as possible for complete retells.
  return {
    storyForPrompt: `${story.slice(0, maxChars)}\n\n[INPUT TRUNCATED for API token limits — RETELL every important event present in the retained text. Do NOT invent the missing ending. Do NOT summarize. Spoken length should match what remains.]`,
    maxTokens,
    truncated: true,
  };
}

// ─── Prompt construction ─────────────────────────────────────────────────────

function languageDirective(lang: StoryLang): string {
  if (lang === "hi") {
    return `LANGUAGE: Spoken fields (title, hook, fullNarration, timedTranscript, endingQuestion, scene.narration) = natural Hindi Devanagari — Shorts speech, not stiff or Latin Hinglish. Visual fields (pexelsQuery, imagePrompt, thumbnailPrompt, hashtags, soundEffect) + enums = English.`;
  }
  return `LANGUAGE: Spoken fields = natural spoken English. Visual search/prompts = English.`;
}

/**
 * Viral storyteller prompt v3 — RETELL the same story spoken from memory.
 * Preserve every important event; do not summarize or invent.
 */
function buildSystemPrompt(lang: StoryLang): string {
  return `You are an expert viral storyteller for YouTube Shorts.

Your job is NOT to rewrite or summarize the story.
Your job is to RETELL the exact same story as if the original person is speaking directly to the audience from memory.
The listener should experience every important moment exactly as it happened.

${languageDirective(lang)}

PRIMARY RULE
• Preserve EVERY important event.
• Do not remove plot points.
• Do not merge important events together.
• Do not skip confrontations, twists, dialogue, emotional moments, decisions, consequences, callbacks, or ending payoffs.
• Do not invent new events.
• Do not change the order.
• Output = SAME STORY with smoother spoken wording.
• If the input would take ~5 minutes to tell, fullNarration should also be ~5 minutes of speech.
• Only remove repetitive descriptions that do not affect the story.
• Never shorten major events.
• Target 95–100% story coverage — feel like the original person telling it, not a Reddit summary.

NARRATION STYLE
• FIRST PERSON only.
• Natural spoken English (or Hindi per LANGUAGE). Contractions. Short sentences. Natural pauses.
• Never sound like a novel, Wikipedia, an AI, or a movie trailer.
• Never summarize what happened — the audience discovers the story as it unfolds.

MANDATORY BEATS (when present in the input)
confrontation · dialogue · betrayal · reveal · emotional reaction · plot twist · consequence · decision · callback · ending payoff
Each MUST appear. Example: Mother refuses food → Trevor gets seconds → silence → they leave → father texts about rent = ALL FIVE beats, never collapsed into one summary line.

HOOK
• If the original already starts with a strong hook, KEEP IT (grammar polish only).
• Do not invent clickbait.

PACING
• Tell naturally. Do not rush. Do not compress multiple scenes into one.
• One meaningful event = one scene / narration chunk.
• If there are ~25 important moments, use ~25 chunks (use as many scenes as needed; typically 8–40).

EMOTION
• Do not exaggerate. Show, don't tell.
• FORBIDDEN filler: "I never expected…" · "Things were about to get worse" · "The real horror had only begun" · "You won't believe…" · "This changed my life forever" · "This is the story of" · "Little did I know" · "So this happened" · greetings · trailer voice · summarizing the post.

ENDING
• Preserve the original ending. Do not replace it. Do not invent a cliffhanger.
• If it ends answered, keep it answered. If it ends with an unanswered question, keep that question.
• endingQuestion should reflect the real ending itch (or restated final beat) — not a fake Part-2 bait.

SCENES
• Chunks concatenate in order into fullNarration (no repeats, no mini-summaries).
• Each scene: one narration chunk + emotion + rough durationSec + pexelsQuery (3–6 concrete English words) + imagePrompt (cinematic still, no text/celebrities) + optional captionHighlightWords (1–3) + camera/captionStyle/transition/soundEffect.
• durationSec / startSec are rough only — code will retime.

JSON ONLY (no markdown). Escape every " inside strings as \\". Example dialogue: "She said \\"Leave.\\""
{
  "title": string,
  "hook": string,
  "fullNarration": string,
  "timedTranscript": string,
  "estimatedDuration": number,
  "musicMood": "dark_ambient"|"tense_pulse"|"eerie_drone"|"heart_race"|"lonely_piano"|"apocalyptic"|"quiet_dread",
  "thumbnailPrompt": string,
  "endingQuestion": string,
  "hashtags": string[],
  "scenes": [{
    "narration": string,
    "startSec": number,
    "durationSec": number,
    "emotion": "fear"|"regret"|"shock"|"curiosity"|"dread"|"confusion"|"loneliness"|"guilt"|"panic"|"awe"|"unease",
    "cameraMovement": "static"|"slow_push_in"|"slow_pull_out"|"drift_left"|"drift_right"|"handheld_shake"|"crash_zoom"|"tilt_up"|"tilt_down",
    "captionStyle": "center_punch"|"lower_third"|"whisper"|"impact"|"karaoke",
    "captionHighlightWords": string[],
    "pexelsQuery": string,
    "imagePrompt": string,
    "transition": "cut"|"fade"|"flash"|"glitch"|"whip"|"match_cut",
    "soundEffect": string
  }]
}

timedTranscript = fullNarration with (M:SS) before each scene phrase, same order as scenes.
hashtags: 5–10 lowercase, no #. hook = first spoken sentence of fullNarration.`;
}

function buildUserPrompt(lang: StoryLang, storyBody: string): string {
  const langLabel = lang === "hi" ? "Hindi Devanagari" : "English";
  return `RETELL this raw dump as a ${langLabel} first-person spoken recollection (JSON only).

Do NOT summarize. Do NOT invent events. Do NOT skip confrontations, dialogue, twists, or the original ending.
Preserve every important beat in order. Spoken length should match the source story (longer input → longer fullNarration).
Use as many scene chunks as needed (one meaningful event per chunk).

RAW STORY:
---
${storyBody}
---`;
}

// ─── Groq message helpers ────────────────────────────────────────────────────

type ChatMessage = {
  role?: string;
  content?: string | null | Array<{ type?: string; text?: string }>;
  reasoning?: string | null;
  reasoning_content?: string | null;
};

function extractAssistantText(message: ChatMessage | undefined): string {
  if (!message) return "";

  const c = message.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    const joined = c
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }

  for (const key of ["reasoning", "reasoning_content"] as const) {
    const r = message[key];
    if (typeof r === "string" && r.includes("{")) {
      const start = r.indexOf("{");
      const end = r.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const slice = r.slice(start, end + 1);
        try {
          JSON.parse(slice);
          return slice;
        } catch {
          /* continue */
        }
      }
    }
  }
  return "";
}

async function callGroqOnce(args: {
  client: Groq;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}): Promise<string> {
  const response = await args.client.chat.completions.create({
    model: args.model,
    temperature: args.temperature ?? 0.7,
    max_tokens: args.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  });

  const text = extractAssistantText(response.choices[0]?.message as ChatMessage);
  if (!text) {
    const finish = response.choices[0]?.finish_reason ?? "unknown";
    throw new Error(
      `Empty Groq completion (model=${args.model}, finish=${finish}). Check TPM / GROQ_MAX_TOKENS.`
    );
  }
  return text;
}

async function callGeminiOnce(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey });
  const response = await ai.models.generateContent({
    model: args.model,
    contents: args.user,
    config: {
      systemInstruction: args.system,
      temperature: args.temperature ?? 0.55,
      maxOutputTokens: args.maxTokens,
      responseMimeType: "application/json",
    },
  });
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason) {
    console.log(`[story-planner] Gemini finishReason=${finishReason}`);
  }
  if (String(finishReason || "").toUpperCase().includes("MAX")) {
    console.warn(
      "[story-planner] Gemini hit max output tokens — JSON may be truncated. Raise GEMINI_MAX_TOKENS."
    );
  }
  const text = response.text?.trim() ?? "";
  if (!text) {
    throw new Error(
      `Empty Gemini completion (model=${args.model}, finish=${finishReason ?? "n/a"}). Check GEMINI_API_KEY / quota.`
    );
  }
  return text;
}

// ─── JSON extract + light repair ─────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Escape bare " that appear inside JSON string values (common with dialogue).
 * A quote is treated as structural only when followed (after optional space) by
 * , } ] : or end — otherwise it becomes \".
 */
function escapeInteriorQuotes(jsonish: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < jsonish.length; i++) {
    const ch = jsonish[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < jsonish.length && /\s/.test(jsonish[j]!)) j++;
      const next = jsonish[j] ?? "";
      const structural = next === "" || /[,}\]:]/.test(next);
      if (structural) {
        out += '"';
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    // newlines inside strings break JSON — keep as space
    if (ch === "\n" || ch === "\r") {
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** If truncated mid-string / mid-object, close the open string then balance braces. */
function softRepairJson(text: string): string {
  let s = stripCodeFences(text);
  const start = s.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in model output.");
  s = s.slice(start);
  s = escapeInteriorQuotes(s);

  // Drop trailing incomplete key fragments after last complete value when truncated
  s = s.replace(/,\s*"[^"]*$/, "");
  s = s.replace(/,\s*$/, "");

  s = s.replace(/,\s*([}\]])/g, "$1");

  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) s += '"';
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }

  return s;
}

function parseJsonObject(text: string): unknown {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (first) {
    try {
      const repaired = softRepairJson(text);
      return JSON.parse(repaired);
    } catch {
      throw first instanceof Error ? first : new Error(String(first));
    }
  }
}

function logGeminiRaw(rawText: string): void {
  console.log("========== GEMINI ==========");
  console.log(rawText);
  console.log("============================");
  console.log(
    `[story-planner] Gemini raw length=${rawText.length} chars`
  );
}

// ─── Normalization / validation ──────────────────────────────────────────────

function asEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  const s = String(value ?? "").trim() as T;
  return allowed.has(s) ? s : fallback;
}

function wordCount(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 0) return words.length;
  return Math.max(1, Math.ceil(text.replace(/\s+/g, "").length / 4));
}

function estimateSpokenSec(text: string): number {
  return Math.max(1.2, wordCount(text) / WORDS_PER_SEC);
}

function formatMarker(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `(${m}:${String(r).padStart(2, "0")})`;
}

function pickHighlightWords(narration: string, provided: unknown): string[] {
  if (Array.isArray(provided)) {
    const words = provided
      .map((w) => String(w).trim())
      .filter(Boolean)
      .slice(0, 3);
    if (words.length) return words;
  }
  return narration
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}']+/gu, ""))
    .filter((w) => w.length > 2)
    .slice(0, 2);
}

function rebuildTimedTranscript(scenes: StoryScene[]): string {
  return scenes
    .map((sc) => `${formatMarker(sc.startSec)} ${sc.narration}`.trim())
    .join(" ");
}

type SceneDraft = {
  narration: string;
  startSec?: number;
  durationSec?: number;
  emotion?: unknown;
  cameraMovement?: unknown;
  captionStyle?: unknown;
  captionHighlightWords?: unknown;
  pexelsQuery?: unknown;
  imagePrompt?: unknown;
  transition?: unknown;
  soundEffect?: unknown;
};

/**
 * Retimes scenes from spoken length; model durationSec is a rough hint only.
 * CHANGE: clamps wild model durations toward word-estimate so Shorts timing stays sane
 * without forcing the prompt to prescribe exact second counts.
 */
function retimeScenes(scenes: SceneDraft[]): StoryScene[] {
  let t = 0;
  return scenes.map((raw, i) => {
    const narration = String(raw.narration ?? "").trim();
    const fromWords = estimateSpokenSec(narration);
    const fromModel = Number(raw.durationSec);
    const durationSec = Math.max(
      1.2,
      fromModel > 0 ? Math.min(fromModel, fromWords * 1.35) : fromWords
    );
    const startSec = t;
    t += durationSec;
    return {
      index: i + 1,
      narration,
      startSec,
      durationSec,
      emotion: asEnum(raw.emotion, EMOTIONS, "dread"),
      cameraMovement: asEnum(raw.cameraMovement, CAMERAS, "slow_push_in"),
      captionStyle: asEnum(raw.captionStyle, CAPTION_STYLES, "center_punch"),
      captionHighlightWords: pickHighlightWords(narration, raw.captionHighlightWords),
      pexelsQuery: String(raw.pexelsQuery ?? "foggy forest at night")
        .trim()
        .slice(0, 80) || "foggy forest at night",
      imagePrompt:
        String(raw.imagePrompt ?? "").trim() ||
        `Cinematic still: ${String(raw.pexelsQuery ?? "dark hallway")}, moody lighting, 35mm film grain`,
      transition: asEnum(raw.transition, TRANSITIONS, i === 0 ? "fade" : "cut"),
      soundEffect: String(raw.soundEffect ?? "soft ambience").trim() || "soft ambience",
    };
  });
}

function normalizeHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["horror", "truestory", "scary", "reddit", "mystery"];
  const tags = raw
    .map((t) =>
      String(t)
        .trim()
        .replace(/^#/, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]/gu, "")
    )
    .filter(Boolean)
    .slice(0, 12);
  return tags.length ? tags : ["horror", "truestory", "scary"];
}

/**
 * Coerce model JSON into a valid StoryPlan. Repairs missing timings / transcripts.
 */
export function normalizeStoryPlan(raw: unknown): StoryPlan {
  if (!raw || typeof raw !== "object") {
    throw new Error("Story planner returned a non-object.");
  }
  const o = raw as Record<string, unknown>;
  const scenesIn = Array.isArray(o.scenes) ? o.scenes : [];
  if (scenesIn.length === 0) {
    throw new Error("Story planner returned zero scenes.");
  }

  const mapped = scenesIn.map((s) => {
    const sc = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    return {
      narration: String(sc.narration ?? "").trim(),
      startSec: Number(sc.startSec),
      durationSec: Number(sc.durationSec),
      emotion: sc.emotion,
      cameraMovement: sc.cameraMovement,
      captionStyle: sc.captionStyle,
      captionHighlightWords: sc.captionHighlightWords,
      pexelsQuery: sc.pexelsQuery,
      imagePrompt: sc.imagePrompt,
      transition: sc.transition,
      soundEffect: sc.soundEffect,
    };
  });

  const withLines = mapped.filter((s) => s.narration.length > 0);
  if (withLines.length === 0) {
    throw new Error("All scene narrations were empty.");
  }

  const scenes = retimeScenes(withLines);

  let fullNarration = String(o.fullNarration ?? "").trim();
  if (!fullNarration) {
    fullNarration = scenes.map((s) => s.narration).join(" ");
  }

  let hook = String(o.hook ?? "").trim();
  if (!hook) {
    hook = scenes[0]?.narration ?? fullNarration.split(/(?<=[.!?…])\s+/)[0] ?? "";
  }

  // Prefer rebuilt transcript so (M:SS) matches repaired scene clocks
  const timedTranscript = rebuildTimedTranscript(scenes);

  const estimatedDuration = Math.max(
    Number(o.estimatedDuration) || 0,
    scenes.reduce((a, s) => a + s.durationSec, 0)
  );

  const title = String(o.title ?? "Untitled nightmare").trim() || "Untitled nightmare";

  return {
    title,
    hook,
    fullNarration,
    timedTranscript,
    estimatedDuration,
    musicMood: asEnum(o.musicMood, MUSIC_MOODS, "quiet_dread"),
    thumbnailPrompt:
      String(o.thumbnailPrompt ?? "").trim() ||
      `Cinematic horror thumbnail: ${scenes[0]?.pexelsQuery ?? "dark hallway"}, high contrast, no text`,
    endingQuestion:
      String(o.endingQuestion ?? "").trim() ||
      "What would you have done next?",
    hashtags: normalizeHashtags(o.hashtags),
    scenes,
  };
}

function assertPlanQuality(plan: StoryPlan): void {
  if (plan.scenes.length < 4) {
    throw new Error(`Need at least 4 scenes, got ${plan.scenes.length}.`);
  }
  if (!plan.fullNarration || plan.fullNarration.length < 40) {
    throw new Error("fullNarration too short after normalization.");
  }
  if (!plan.timedTranscript.includes("(")) {
    throw new Error("timedTranscript missing (M:SS) markers after repair.");
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

function finalizePlan(plan: StoryPlan, sourceStory: string): StoryPlan {
  const coverage =
    plan.fullNarration.replace(/\s+/g, " ").trim().length /
    Math.max(1, sourceStory.replace(/\s+/g, " ").trim().length);
  if (coverage < 0.45) {
    console.warn(
      `[story-planner] Narration looks short vs input (coverage≈${(coverage * 100).toFixed(0)}%). Check fullNarration for missing beats.`
    );
  }
  return plan;
}

async function planWithGemini(
  trimmed: string,
  lang: StoryLang,
  system: string,
  user: string,
  maxTokens: number
): Promise<StoryPlan> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  let lastError: Error | null = null;
  let lastRaw = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const temperature = attempt === 1 ? 0.45 : 0.15;
      const completionUser =
        attempt === 1
          ? `${user}

JSON RULES (critical):
- Return ONLY a single JSON object (responseMimeType=application/json).
- Escape every double-quote inside string values as \\".
- Dialogue must use escaped quotes, e.g. "She said \\"Leave.\\""
- No markdown fences. No commentary outside JSON.`
          : `${user}

Your previous response was invalid JSON.

${lastRaw ? `Broken fragment (for reference, do not copy):\n${lastRaw.slice(0, 500)}\n` : ""}
Return ONLY valid JSON.
Do NOT include markdown.
Do NOT include explanations.
Escape all quotation marks inside strings as \\".
The JSON must be directly parsable by JSON.parse().
RETELL every important event — do not summarize or invent.`;

      console.log(
        `[story-planner] Gemini attempt ${attempt} (model=${model}, maxOutputTokens=${maxTokens})…`
      );
      const rawText = await callGeminiOnce({
        apiKey,
        model,
        system,
        user: completionUser,
        maxTokens,
        temperature,
      });
      lastRaw = rawText;
      logGeminiRaw(rawText);

      const plan = normalizeStoryPlan(parseJsonObject(rawText));
      assertPlanQuality(plan);
      return finalizePlan(plan, trimmed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[story-planner] Gemini attempt ${attempt} failed:`,
        lastError.message
      );
    }
  }

  throw new Error(
    `Gemini planner failed: ${lastError?.message ?? "unknown error"}`
  );
}

async function planWithGroq(
  trimmed: string,
  lang: StoryLang,
  system: string
): Promise<StoryPlan> {
  const client = new Groq({ apiKey: getGroqApiKey() });
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  const userPrefix = buildUserPrompt(lang, "");
  const { storyForPrompt, maxTokens, truncated } = fitToTpmBudget(
    system,
    userPrefix,
    trimmed
  );
  const user = buildUserPrompt(lang, storyForPrompt);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const temperature = attempt === 1 ? 0.55 : 0.25;
      const completionUser =
        attempt === 1
          ? user
          : `${user}\n\nPREVIOUS OUTPUT WAS INVALID JSON OR FAILED VALIDATION.
Return ONLY a complete valid JSON object matching the schema. No markdown. No commentary.
RETELL every important event from the raw story — do not summarize or invent. First-person spoken voice only.`;

      console.log(`[story-planner] Groq attempt ${attempt} (model=${model})…`);
      const rawText = await callGroqOnce({
        client,
        model,
        system,
        user: completionUser,
        maxTokens,
        temperature,
      });

      const plan = normalizeStoryPlan(parseJsonObject(rawText));
      assertPlanQuality(plan);

      if (truncated) {
        console.warn(
          "[story-planner] Input story truncated to fit Groq TPM budget; plan covers retained text only."
        );
      }

      return finalizePlan(plan, trimmed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[story-planner] Groq attempt ${attempt} failed:`,
        lastError.message
      );
    }
  }

  throw new Error(
    `Groq planner failed after retry: ${lastError?.message ?? "unknown error"}`
  );
}

/**
 * Plan a first-person spoken retell from a raw Reddit-style dump.
 * Tries Gemini first (when GEMINI_API_KEY is set), then falls back to Groq.
 */
export async function planStoryWithGroq(
  story: string,
  lang: StoryLang = "en"
): Promise<StoryPlan> {
  const trimmed = story.trim();
  if (trimmed.length < 20) {
    throw new Error("Story is too short to plan (need ~20+ characters).");
  }

  const system = buildSystemPrompt(lang);
  const geminiKey = getGeminiApiKey();
  // Gemini gets a larger dedicated budget; Groq still uses TPM-fitted max.
  const geminiMaxTokens = Math.max(
    4_096,
    Number(process.env.GEMINI_MAX_TOKENS) || 8_192
  );

  if (geminiKey) {
    try {
      // Gemini has a large context window — send the full story (no Groq TPM trim).
      const user = buildUserPrompt(lang, trimmed);
      const plan = await planWithGemini(
        trimmed,
        lang,
        system,
        user,
        geminiMaxTokens
      );
      console.log("[story-planner] Using Gemini plan");
      return plan;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[story-planner] Gemini failed → falling back to Groq: ${msg}`);
    }
  } else {
    console.warn(
      "[story-planner] GEMINI_API_KEY missing — using Groq only"
    );
  }

  return planWithGroq(trimmed, lang, system);
}
