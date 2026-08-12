"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LogLine = { level: "info" | "error"; message: string };

type BrollOpt = { id: string; label: string; kind: string };

type StoryPlanLite = {
  title?: string;
  hook?: string;
  endingQuestion?: string;
  fullNarration?: string;
  scenes?: Array<{ narration?: string }>;
};

const SPEED_PRESETS = [
  { id: "1.25", label: "1.25×", hint: "Slightly snappy" },
  { id: "1.35", label: "1.35×", hint: "Default" },
  { id: "1.5", label: "1.5×", hint: "Fast Shorts pace" },
  { id: "auto", label: "Auto ≤2:59", hint: "Fits YouTube Shorts" },
] as const;

function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function Home() {
  const [storyText, setStoryText] = useState("");
  const [storySource, setStorySource] = useState<"manual" | "youtube">("manual");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [storyVideoUrl, setStoryVideoUrl] = useState<string | null>(null);
  const [storyLogs, setStoryLogs] = useState<LogLine[]>([]);
  const [storyTitle, setStoryTitle] = useState<string | null>(null);
  const [storyPlan, setStoryPlan] = useState<StoryPlanLite | null>(null);
  const [storyMeta, setStoryMeta] = useState<{
    durationSec?: number;
    brollSource?: string;
    renderer?: string;
    lang?: string;
  } | null>(null);
  const [storyLang, setStoryLang] = useState<"en" | "hi">("en");
  const [voiceGender, setVoiceGender] = useState<"female" | "male">("female");
  const [storySpeed, setStorySpeed] = useState<string>("auto");
  const [brollId, setBrollId] = useState("");
  const [brollOptions, setBrollOptions] = useState<BrollOpt[]>([]);

  const [ytConnected, setYtConnected] = useState(false);
  const [ytChannel, setYtChannel] = useState<string | null>(null);
  const [ytUploading, setYtUploading] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState<string | null>(null);
  const [ytPrivacy, setYtPrivacy] = useState<"private" | "unlisted" | "public">(
    "private"
  );

  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [storyLogs]);

  const refreshYoutubeStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube", { cache: "no-store" });
      const j = (await res.json()) as {
        connected?: boolean;
        channel?: { title?: string | null };
      };
      setYtConnected(Boolean(j.connected));
      setYtChannel(j.channel?.title ?? null);
    } catch {
      setYtConnected(false);
      setYtChannel(null);
    }
  }, []);

  useEffect(() => {
    void refreshYoutubeStatus();
  }, [refreshYoutubeStatus]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/broll", { cache: "no-store" });
        const j = (await res.json()) as { ok?: boolean; items?: BrollOpt[] };
        if (j.ok && j.items?.length) {
          setBrollOptions(j.items);
          const firstLocal = j.items.find((i) => i.kind === "local");
          setBrollId((prev) => prev || firstLocal?.id || j.items![0]!.id);
        }
      } catch {
        /* server auto-picks */
      }
    })();
  }, []);

  const runStoryVideo = async () => {
    if (storySource === "manual" && storyText.trim().length < 20) return;
    if (storySource === "youtube" && youtubeUrl.trim().length < 10) return;
    setStoryLoading(true);
    setStoryError(null);
    setStoryVideoUrl(null);
    setStoryTitle(null);
    setStoryPlan(null);
    setStoryMeta(null);
    setYtUrl(null);
    setYtError(null);
    setStoryLogs([{ level: "info", message: "Starting story job…" }]);
    try {
      const fd = new FormData();
      if (storySource === "youtube") {
        fd.append("youtubeUrl", youtubeUrl.trim());
      } else {
        fd.append("story", storyText.trim());
      }
      fd.append("lang", storyLang);
      fd.append("voiceGender", voiceGender);
      fd.append("storySpeed", storySpeed);
      if (brollId) fd.append("brollId", brollId);
      const res = await fetch("/api/story-video", {
        method: "POST",
        body: fd,
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        videoUrl?: string;
        durationSec?: number;
        brollSource?: string;
        renderer?: string;
        lang?: string;
        plan?: StoryPlanLite;
        logs?: LogLine[];
      };
      if (json.logs?.length) setStoryLogs(json.logs);
      if (!res.ok || !json.ok || !json.videoUrl) {
        throw new Error(json.error ?? `Story video failed (${res.status})`);
      }
      setStoryTitle(json.plan?.title ?? null);
      setStoryPlan(json.plan ?? null);
      setStoryMeta({
        durationSec: json.durationSec,
        brollSource: json.brollSource,
        renderer: json.renderer,
        lang: json.lang,
      });
      setStoryVideoUrl(`${json.videoUrl}?t=${Date.now()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStoryError(msg);
      setStoryLogs((prev) => [...prev, { level: "error", message: msg }]);
    } finally {
      setStoryLoading(false);
    }
  };

  const uploadStoryToYoutube = async () => {
    if (!storyVideoUrl) return;
    setYtUploading(true);
    setYtError(null);
    setYtUrl(null);
    try {
      const res = await fetch("/api/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: storyVideoUrl.split("?")[0],
          title: (storyTitle || "AI Story").slice(0, 100),
          description: `Created with Reeler\n\n${
            storySource === "youtube"
              ? `Source: ${youtubeUrl.trim()}`
              : storyText.trim().slice(0, 4000)
          }`,
          tags: [
            "illustration",
            "tattoo",
            "art",
            "pov",
            "procreate",
            "drawing",
            "whydidntmyexcomeback",
            "digitalart",
          ],
          privacyStatus: ytPrivacy,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        url?: string;
      };
      if (!res.ok || !j.ok || !j.url) {
        throw new Error(j.error ?? `YouTube upload failed (${res.status})`);
      }
      setYtUrl(j.url);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    } finally {
      setYtUploading(false);
    }
  };

  const canStoryVideo =
    !storyLoading &&
    (storySource === "youtube"
      ? youtubeUrl.trim().length >= 10
      : storyText.trim().length >= 20);
  const selectedBroll = brollOptions.find((b) => b.id === brollId);

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start">
        <div className="flex flex-col gap-5">
          <header className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-rose-400">
              Reeler
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Story → Short
            </h1>
            <p className="text-sm text-zinc-400">
              Generate a vertical Short from your story, then upload to YouTube.
              Live job logs stay on this page.
            </p>
          </header>

          <section className="flex flex-col gap-5 rounded-2xl border border-rose-900/40 bg-zinc-900/50 p-5 shadow-xl sm:p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-zinc-300">Language</legend>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["en", "English"],
                      ["hi", "Hindi"],
                    ] as const
                  ).map(([v, label]) => (
                    <label
                      key={v}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40"
                    >
                      <input
                        type="radio"
                        name="storyLang"
                        checked={storyLang === v}
                        disabled={storyLoading}
                        onChange={() => setStoryLang(v)}
                        className="accent-rose-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-zinc-300">Voice</legend>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["female", "Female"],
                      ["male", "Male"],
                    ] as const
                  ).map(([v, label]) => (
                    <label
                      key={v}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40"
                    >
                      <input
                        type="radio"
                        name="voiceGender"
                        checked={voiceGender === v}
                        disabled={storyLoading}
                        onChange={() => setVoiceGender(v)}
                        className="accent-rose-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-zinc-300">
                Playback speed
              </legend>
              <div className="flex flex-wrap gap-2">
                {SPEED_PRESETS.map((p) => (
                  <label
                    key={p.id}
                    className="inline-flex min-w-[6.5rem] cursor-pointer flex-col rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40"
                  >
                    <span className="inline-flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="storySpeed"
                        checked={storySpeed === p.id}
                        disabled={storyLoading}
                        onChange={() => setStorySpeed(p.id)}
                        className="accent-rose-500"
                      />
                      {p.label}
                    </span>
                    <span className="pl-6 text-[11px] text-zinc-500">{p.hint}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-zinc-500">
                Auto raises speed if needed so the Short stays under 2:59 for YouTube.
              </p>
            </fieldset>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-300">B-roll background</span>
              <select
                value={brollId}
                disabled={storyLoading || brollOptions.length === 0}
                onChange={(e) => setBrollId(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
              >
                {brollOptions.length === 0 && <option value="">Loading clips…</option>}
                {brollOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    [{opt.kind}] {opt.label}
                  </option>
                ))}
              </select>
              {selectedBroll && (
                <span className="text-xs text-zinc-500">
                  Selected: <span className="text-zinc-300">{selectedBroll.label}</span>{" "}
                  ({selectedBroll.kind}) — FFmpeg seeks a random trim only
                </span>
              )}
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-300">Story input</span>
              <div className="flex flex-wrap gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40">
                  <input
                    type="radio"
                    name="storySource"
                    checked={storySource === "manual"}
                    disabled={storyLoading}
                    onChange={() => setStorySource("manual")}
                    className="accent-rose-500"
                  />
                  Manual paste
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40">
                  <input
                    type="radio"
                    name="storySource"
                    checked={storySource === "youtube"}
                    disabled={storyLoading}
                    onChange={() => setStorySource("youtube")}
                    className="accent-rose-500"
                  />
                  YouTube link
                </label>
              </div>
            </label>

            {storySource === "youtube" ? (
              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-zinc-300">YouTube URL</span>
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={(e) => {
                    setYoutubeUrl(e.target.value);
                    setStoryError(null);
                  }}
                  disabled={storyLoading}
                  placeholder="https://www.youtube.com/watch?v=… or shorts/…"
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                />
                <span className="text-xs text-zinc-500">
                  Pulls captions via youtube-transcript, then the planner retells that
                  transcript like a pasted story. Needs captions on the video.
                </span>
              </label>
            ) : (
              <label className="flex flex-col gap-2">
                <span className="flex items-center justify-between text-sm font-medium text-zinc-300">
                  Your story
                  <span className="font-normal text-zinc-500">
                    {storyText.trim().length} chars
                  </span>
                </span>
                <textarea
                  value={storyText}
                  onChange={(e) => {
                    setStoryText(e.target.value);
                    setStoryError(null);
                  }}
                  disabled={storyLoading}
                  rows={12}
                  placeholder="Paste the full story you want retold as a first-person Short…"
                  className="w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                />
              </label>
            )}

            <button
              type="button"
              onClick={() => void runStoryVideo()}
              disabled={!canStoryVideo}
              className="rounded-xl bg-rose-700 px-4 py-3.5 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              {storyLoading ? "Building story video…" : "Generate story video"}
            </button>

            {storyError && (
              <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {storyError}
              </p>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
          <section className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-200">Live job log</h2>
              {storyLoading && (
                <span className="animate-pulse text-xs text-rose-300">running…</span>
              )}
            </div>
            <div className="max-h-[min(52vh,520px)] min-h-[220px] overflow-auto rounded-xl border border-zinc-800 bg-black/50 p-3 font-mono text-[11px] leading-5 text-zinc-400">
              {storyLogs.length === 0 ? (
                <p className="text-zinc-600">Logs appear here when you generate.</p>
              ) : (
                storyLogs.map((l, i) => (
                  <div
                    key={i}
                    className={l.level === "error" ? "text-red-400" : "text-zinc-400"}
                  >
                    {l.message}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </section>

          <section className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <h2 className="text-sm font-semibold text-zinc-200">Preview & publish</h2>

            {storyMeta && (
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-black/40 px-2.5 py-2">
                  <dt className="text-zinc-500">Duration</dt>
                  <dd className="font-medium text-zinc-100">
                    {formatDuration(storyMeta.durationSec)}
                  </dd>
                </div>
                <div className="rounded-lg bg-black/40 px-2.5 py-2">
                  <dt className="text-zinc-500">Renderer</dt>
                  <dd className="font-medium text-zinc-100">
                    {storyMeta.renderer ?? "—"}
                  </dd>
                </div>
                <div className="col-span-2 rounded-lg bg-black/40 px-2.5 py-2">
                  <dt className="text-zinc-500">B-roll</dt>
                  <dd className="font-medium text-zinc-100">
                    {storyMeta.brollSource ?? "—"}
                  </dd>
                </div>
              </dl>
            )}

            {storyTitle && (
              <p className="text-sm font-medium text-rose-100/90">{storyTitle}</p>
            )}

            {storyVideoUrl ? (
              <video
                key={storyVideoUrl}
                src={storyVideoUrl}
                controls
                playsInline
                className="mx-auto aspect-[9/16] w-full max-w-xs rounded-lg border border-zinc-700 bg-black"
              />
            ) : (
              <div className="flex aspect-[9/16] w-full max-w-xs flex-col items-center justify-center self-center rounded-lg border border-dashed border-zinc-700 bg-black/30 text-center text-xs text-zinc-600">
                Preview appears after generate
              </div>
            )}

            {storyVideoUrl && (
              <a
                href={storyVideoUrl.split("?")[0]}
                download="story.mp4"
                className="inline-flex items-center justify-center rounded-xl border border-rose-800 bg-zinc-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-700"
              >
                Download story MP4
              </a>
            )}

            <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-black/30 p-3">
              <p className="text-xs text-zinc-400">
                YouTube Shorts{" "}
                {ytConnected ? (
                  <span className="text-emerald-400">
                    · connected{ytChannel ? ` as ${ytChannel}` : ""}
                  </span>
                ) : (
                  <span className="text-amber-400">· not connected</span>
                )}
              </p>
              {!ytConnected ? (
                <a
                  href="/auth/youtube"
                  className="inline-flex items-center justify-center rounded-xl bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-red-600"
                >
                  Connect YouTube
                </a>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    Privacy
                    <select
                      value={ytPrivacy}
                      onChange={(e) =>
                        setYtPrivacy(
                          e.target.value as "private" | "unlisted" | "public"
                        )
                      }
                      disabled={ytUploading || !storyVideoUrl}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
                    >
                      <option value="private">Private</option>
                      <option value="unlisted">Unlisted</option>
                      <option value="public">Public</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void uploadStoryToYoutube()}
                    disabled={ytUploading || !storyVideoUrl}
                    className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-zinc-700"
                  >
                    {ytUploading ? "Uploading Short…" : "Upload as YouTube Short"}
                  </button>
                </>
              )}
              {ytError && <p className="text-xs text-red-300">{ytError}</p>}
              {ytUrl && (
                <a
                  href={ytUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-rose-300 underline"
                >
                  Open Short on YouTube
                </a>
              )}
            </div>
          </section>

          {storyPlan?.fullNarration && (
            <section className="flex flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h2 className="text-sm font-semibold text-zinc-200">Spoken narration</h2>
              {storyPlan.hook && (
                <p className="text-xs text-rose-200/80">Hook: {storyPlan.hook}</p>
              )}
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-800 bg-black/40 p-3 text-xs leading-relaxed text-zinc-400">
                {storyPlan.fullNarration}
              </pre>
              {storyPlan.endingQuestion && (
                <p className="text-xs text-zinc-500">
                  Ending: {storyPlan.endingQuestion}
                </p>
              )}
              {storyPlan.scenes && (
                <p className="text-xs text-zinc-600">
                  {storyPlan.scenes.length} scene chunk(s) in plan
                </p>
              )}
            </section>
          )}
        </aside>
      </main>

      {/*
        Legacy tools (image slideshow / crop / upscale / caption burn) removed from UI.
        APIs remain if needed later.
      */}
    </div>
  );
}
