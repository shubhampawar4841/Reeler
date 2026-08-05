/**
 * Production Groq story planner for faceless YouTube storytelling.
 *
 * Reddit dump → retention-optimized narration plan (JSON) → Kokoro / Edge TTS → FFmpeg / Remotion.
 *
 * Public API: `planStoryWithGroq(story, lang?)`
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
const WORDS_PER_SEC = 2.4; // spoken pace approx for duration estimates

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

  return {
    storyForPrompt: `${story.slice(0, maxChars)}\n\n[INPUT TRUNCATED for API token limits — dramatize retained beats into a complete spoken story with a twist ending.]`,
    maxTokens,
    truncated: true,
  };
}

// ─── Prompt construction ─────────────────────────────────────────────────────

function languageDirective(lang: StoryLang): string {
  if (lang === "hi") {
    return `LANGUAGE:
- title, hook, fullNarration, timedTranscript, endingQuestion, every scene.narration → natural Hindi (Devanagari).
- Spoken horror-YouTube Hindi. Not stiff. Not Latin Hinglish.
- pexelsQuery, imagePrompt, thumbnailPrompt, hashtags, soundEffect, musicMood enums → English.`;
  }
  return `LANGUAGE:
- All spoken fields in natural English.
- pexelsQuery / imagePrompt always English.`;
}

function buildSystemPrompt(lang: StoryLang): string {
  return `You are the lead writer for a faceless YouTube true-horror channel.
You adapt raw Reddit / nosleep dumps into SPOKEN narration optimized for Kokoro TTS + Remotion captions.

INFLUENCE (pacing only — never copy wording or branded tropes):
MrBallen · Mr. Nightmare · Let's Read · Dark Somnium · Bedtime Stories.
Intimate. Measured. Deadly curious.

${languageDirective(lang)}

═══════════════════════════════════════
HARD RULES — BREAKING THESE FAILS THE JOB
═══════════════════════════════════════

NEVER summarize the Reddit post.
NEVER explain the mystery like a lecturer.
NEVER sound like Wikipedia, ChatGPT, or a movie trailer voice.
NEVER open with greetings, "this is a story about", or long backstory.
ALWAYS make the listener think: "What happens next?"

Every 2–3 sentences must land ONE of:
• mystery · new information · danger · curiosity
Never let curiosity die.

───────────────────────────────────────
HOOK (0–5 sec) — FIRST SENTENCE OF NARRATION
───────────────────────────────────────
Must be an impossible event. No setup first.

Good:
"I answered my dead father's phone call."
"I woke up with mud on my shoes… and locked windows."
"The voicemail was from me. Tomorrow."

Bad:
"So this happened at my grandma's house…"
"I've always been afraid of the upstairs…"

───────────────────────────────────────
RETENTION CURVE
───────────────────────────────────────
0–5s   Impossible hook
5–15s  Tiny context (where / who) — still tense
15–30s First concrete impossibility
30–60s Escalation (closer, louder, more personal)
60–90s Huge reveal / irreversible beat
Ending Plot twist that REFRAMES everything before it
        Leave lingering questions. Never fully explain.

Length: follow what the story needs for that arc (often ~90–180s spoken). Soft ceiling ~350 words so Kokoro + free-tier APIs stay healthy. Prefer a complete twist over dumping every Reddit detail.

───────────────────────────────────────
KOKORO / TTS VOICE
───────────────────────────────────────
Short spoken sentences: 6–14 words.
Natural pauses. No paragraph walls.
Occasional "..." for dramatic breath:
"I heard footsteps.
But...
there was nobody there."
No academic words. Always sound spoken aloud.

Dialogue: rare, short, natural.

───────────────────────────────────────
EMOTION
───────────────────────────────────────
Every scene has exactly one emotion from:
fear | regret | shock | curiosity | dread | confusion | loneliness | guilt | panic | awe | unease

───────────────────────────────────────
VISUALS
───────────────────────────────────────
pexelsQuery: 3–6 concrete English search words.
Bad: forest · house · road
Good: foggy forest at night · abandoned hospital hallway · rainy windshield at night · empty subway platform · lonely motel room · dark bedroom window · moonlit cemetery · old wooden staircase

imagePrompt: cinematic movie-still description (lighting, lens, mood). No text overlays. No celebrity faces.

───────────────────────────────────────
CAPTIONS (Remotion)
───────────────────────────────────────
scene.narration = one short captionable phrase (not a paragraph).
captionHighlightWords = 1–3 key words from that phrase.
captionStyle ∈ center_punch | lower_third | whisper | impact | karaoke

───────────────────────────────────────
OUTPUT — JSON ONLY (no markdown fences)
───────────────────────────────────────
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
  "scenes": [
    {
      "narration": string,
      "startSec": number,
      "durationSec": number,
      "emotion": string,
      "cameraMovement": "static"|"slow_push_in"|"slow_pull_out"|"drift_left"|"drift_right"|"handheld_shake"|"crash_zoom"|"tilt_up"|"tilt_down",
      "captionStyle": string,
      "captionHighlightWords": string[],
      "pexelsQuery": string,
      "imagePrompt": string,
      "transition": "cut"|"fade"|"flash"|"glitch"|"whip"|"match_cut",
      "soundEffect": string
    }
  ]
}

timedTranscript MUST equal fullNarration with (M:SS) markers before each phrase, matching scenes in order.
scenes length: 6–16. Sum of durationSec ≈ estimatedDuration.
endingQuestion leaves a replay-worthy itch.
hashtags: 5–10 lowercase tags without # prefix.`;
}

function buildUserPrompt(lang: StoryLang, storyBody: string): string {
  const langLabel = lang === "hi" ? "Hindi Devanagari" : "English";
  return `Rewrite this raw dump into a ${langLabel} spoken horror narration plan (JSON only).

Rules reminder: impossible hook first. No summary. Retention curve. Twist ending that reframes everything. Kokoro-friendly short sentences.

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

function retimeScenes(scenes: SceneDraft[]): StoryScene[] {
  let t = 0;
  return scenes.map((raw, i) => {
    const narration = String(raw.narration ?? "").trim();
    const durationSec = Math.max(
      1.2,
      Number(raw.durationSec) > 0 ? Number(raw.durationSec) : estimateSpokenSec(narration)
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
      "What would you have done if you were next?",
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
 * Plan a retention-optimized spoken horror story from a raw Reddit-style dump.
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
      const temperature = attempt === 1 ? 0.72 : 0.35;
      const completionUser =
        attempt === 1
          ? user
          : `${user}\n\nPREVIOUS OUTPUT WAS INVALID JSON OR FAILED VALIDATION.
Return ONLY a complete valid JSON object matching the schema. No markdown. No commentary.`;

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
