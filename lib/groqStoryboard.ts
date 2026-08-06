/**
 * Production Groq story planner for faceless YouTube storytelling.
 *
 * Reddit dump → first-person viral horror narration (JSON) → Kokoro / Edge TTS → FFmpeg.
 *
 * Public API: `planStoryWithGroq(story, lang?)`
 *
 * Prompt v2: storyteller-from-memory voice (not summary/screenplay). Schema + normalize/retry/tpm unchanged.
 */

import Groq from "groq-sdk";
import {
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

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_TPM_BUDGET = 12_000;
const DEFAULT_MAX_COMPLETION = 3_500;
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

  // CHANGE: truncation hint asks for spoken memory + unanswered ending (not "twist summary")
  return {
    storyForPrompt: `${story.slice(0, maxChars)}\n\n[INPUT TRUNCATED for API token limits — turn retained beats into a complete first-person spoken recollection that escalates danger and ends on one unanswered question.]`,
    maxTokens,
    truncated: true,
  };
}

// ─── Prompt construction ─────────────────────────────────────────────────────

function languageDirective(lang: StoryLang): string {
  // CHANGE: compressed language rules (~same EN/HI field split, fewer lines)
  if (lang === "hi") {
    return `LANGUAGE: Spoken fields (title, hook, fullNarration, timedTranscript, endingQuestion, scene.narration) = natural Hindi Devanagari — Shorts speech, not stiff or Latin Hinglish. Visual fields (pexelsQuery, imagePrompt, thumbnailPrompt, hashtags, soundEffect) + enums = English.`;
  }
  return `LANGUAGE: Spoken fields = natural spoken English. Visual search/prompts = English.`;
}

/**
 * CHANGE: full system-prompt rewrite — first-person storyteller voice; dropped fixed
 * second-by-second retention curve / trailer / Remotion caption essay; ~30% shorter.
 * JSON field names kept for normalizeStoryPlan / StoryPlan compatibility.
 */
function buildSystemPrompt(lang: StoryLang): string {
  return `You are a horror storyteller speaking from memory — cadence like MrBallen, Mr. Nightmare, Let's Read, Dark Somnium (influence only; never copy wording or branded phrases).

Turn raw Reddit / nosleep dumps into first-person SPOKEN Shorts narration. The listener discovers everything WITH you — never hear a summary of what happened.

${languageDirective(lang)}

VOICE
• Always first person ("I…" / "मैं…"). Inside the terror. Never outside narrator.
• Sound remembered aloud: short sentences, natural pauses, occasional "..."
• Reveal only what you notice in the moment.
• Every 1–3 sentences MUST add mystery, danger, contradiction, reveal, or a question. No filler.
• Soft length ~250–350 spoken words (complete escalation > dumping every Reddit detail).

FORBIDDEN
"This is the story of" · "I never imagined" · "Little did I know" · "Things were about to get worse" · "The real horror had only begun" · "So this happened" · "I've always believed" · greetings · Wikipedia tone · movie-trailer voice · summarizing the post.

HOOK — first sentence of fullNarration
Instant curiosity. Wrong or impossible fact. No setup.
Good: "I answered my dead father's phone." / "I woke up covered in mud." / "मैं रोज पड़ोसी के कमरे से चीखें सुनता था।"
Bad: time/place warmups, "I've always…", "So this begins…"

PACE
Escalate danger every few lines. Each reveal opens a new question. Never let curiosity drop. No fixed second counts.

DIALOGUE
Rare. One short line when it hurts. Beat: He looked at me. "Don't open that door." Then he was gone.

ENDING
Never fully explain. Leave one major unanswered question (Part 2 itch). endingQuestion states that itch.

SCENES
6–14 logical spoken chunks that concatenate into fullNarration (no repeats, no mini-summaries).
Each: one narration chunk + emotion + rough durationSec + pexelsQuery (3–6 concrete English words) + imagePrompt (cinematic still, no text/celebrities) + optional captionHighlightWords (1–3) + camera/captionStyle/transition/soundEffect.
durationSec / startSec are rough only — code will retime.

JSON ONLY (no markdown):
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
hashtags: 5–10 lowercase, no #. hook = first spoken sentence.`;
}

function buildUserPrompt(lang: StoryLang, storyBody: string): string {
  // CHANGE: user brief matches storyteller rules (no fixed retention-curve jargon)
  const langLabel = lang === "hi" ? "Hindi Devanagari" : "English";
  return `Rewrite this raw dump as a ${langLabel} first-person spoken horror recollection (JSON only).

Hook in sentence one. Never summarize. Escalate mystery/danger. End unexplained with one burning question. Short spoken lines.

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

// ─── JSON extract + light repair ─────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Best-effort: close dangling braces/brackets and remove trailing commas. */
function softRepairJson(text: string): string {
  let s = stripCodeFences(text);
  const start = s.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in model output.");
  s = s.slice(start);

  // Trim past last plausible closing brace
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace > 0) s = s.slice(0, lastBrace + 1);

  s = s.replace(/,\s*([}\]])/g, "$1");

  // Balance braces / brackets
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
  } catch {
    const repaired = softRepairJson(text);
    return JSON.parse(repaired);
  }
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
    // CHANGE: Part-2 itch default (not generic "what would you have done")
    endingQuestion:
      String(o.endingQuestion ?? "").trim() ||
      "And if it happens again tonight… who opens the door first?",
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

/**
 * Plan a first-person spoken horror story from a raw Reddit-style dump.
 * Retries once if JSON is unusable; auto-repairs timings and missing fields.
 */
export async function planStoryWithGroq(
  story: string,
  lang: StoryLang = "en"
): Promise<StoryPlan> {
  const trimmed = story.trim();
  if (trimmed.length < 20) {
    throw new Error("Story is too short to plan (need ~20+ characters).");
  }

  const client = new Groq({ apiKey: getGroqApiKey() });
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const system = buildSystemPrompt(lang);
  const userPrefix = buildUserPrompt(lang, ""); // length probe without body
  const { storyForPrompt, maxTokens, truncated } = fitToTpmBudget(
    system,
    userPrefix,
    trimmed
  );
  const user = buildUserPrompt(lang, storyForPrompt);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // CHANGE: warmer first pass for spoken voice; cooler retry for valid JSON
      const temperature = attempt === 1 ? 0.78 : 0.35;
      const completionUser =
        attempt === 1
          ? user
          : `${user}\n\nPREVIOUS OUTPUT WAS INVALID JSON OR FAILED VALIDATION.
Return ONLY a complete valid JSON object matching the schema. No markdown. No commentary. First-person spoken voice only.`;

      const rawText = await callGroqOnce({
        client,
        model,
        system,
        user: completionUser,
        maxTokens,
        temperature,
      });

      const parsed = parseJsonObject(rawText);
      const plan = normalizeStoryPlan(parsed);
      assertPlanQuality(plan);

      if (truncated) {
        // Non-fatal: input was sliced for Groq TPM; plan still valid
        console.warn(
          "[story-planner] Input story truncated to fit Groq TPM budget; plan covers retained beats."
        );
      }

      return plan;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[story-planner] attempt ${attempt} failed:`, lastError.message);
    }
  }

  throw new Error(
    `Story planner failed after retry: ${lastError?.message ?? "unknown error"}`
  );
}
