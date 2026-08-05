"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type LogLine = { level: "info" | "error"; message: string; progress?: number };

type ApiOk = { ok: boolean; logs?: LogLine[]; error?: string; [k: string]: unknown };

function mergeLogs(prev: LogLine[], next?: LogLine[]) {
  if (!next?.length) return prev;
  return [...prev, ...next];
}

export default function Home() {
  const [images, setImages] = useState<File[]>([]);
  const [audio, setAudio] = useState<File | null>(null);
  const [music, setMusic] = useState<File | null>(null);
  /** (M:SS) markers drive slide length + subtitles; voice-over is still your uploaded audio */
  const [timedTranscript, setTimedTranscript] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [storyboards, setStoryboards] = useState<File[]>([]);
  const [cropLoading, setCropLoading] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [upscaleFiles, setUpscaleFiles] = useState<File[]>([]);
  const [upscaleLoading, setUpscaleLoading] = useState(false);
  const [upscaleError, setUpscaleError] = useState<string | null>(null);
  const [captionVideoFile, setCaptionVideoFile] = useState<File | null>(null);
  const [captionLoading, setCaptionLoading] = useState(false);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [captionedUrl, setCaptionedUrl] = useState<string | null>(null);
  const [captionStatus, setCaptionStatus] = useState("");
  const [storyText, setStoryText] = useState("");
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [storyVideoUrl, setStoryVideoUrl] = useState<string | null>(null);
  const [storyLogs, setStoryLogs] = useState<LogLine[]>([]);
  const [storyTitle, setStoryTitle] = useState<string | null>(null);
  const [storyLang, setStoryLang] = useState<"en" | "hi">("en");
  const [ytConnected, setYtConnected] = useState(false);
  const [ytChannel, setYtChannel] = useState<string | null>(null);
  const [ytUploading, setYtUploading] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState<string | null>(null);
  const [ytPrivacy, setYtPrivacy] = useState<"private" | "unlisted" | "public">("private");

  const onStoryboardsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setStoryboards(list);
    setCropError(null);
  };

  const runStoryboardCrop = async () => {
    if (storyboards.length === 0) return;
    setCropLoading(true);
    setCropError(null);
    try {
      const fd = new FormData();
      for (const f of storyboards) {
        fd.append("storyboards", f);
      }
      const res = await fetch("/api/crop-storyboard", { method: "POST", body: fd });
      const ct = res.headers.get("Content-Type") ?? "";
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Crop failed (${res.status})`);
      }
      if (!ct.includes("zip")) {
        throw new Error("Unexpected response (expected a ZIP file).");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "storyboard-scenes.zip";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCropError(msg);
    } finally {
      setCropLoading(false);
    }
  };

  const canCropStoryboards = storyboards.length > 0 && !cropLoading;

  const onUpscaleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setUpscaleFiles(list);
    setUpscaleError(null);
  };

  const runUpscaleBatch = async () => {
    if (upscaleFiles.length === 0) return;
    setUpscaleLoading(true);
    setUpscaleError(null);
    try {
      const fd = new FormData();
      for (const f of upscaleFiles) {
        fd.append("upscaleImages", f);
      }
      const res = await fetch("/api/upscale-batch", { method: "POST", body: fd });
      const ct = res.headers.get("Content-Type") ?? "";
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Upscale failed (${res.status})`);
      }
      if (!ct.includes("zip")) {
        throw new Error("Unexpected response (expected a ZIP file).");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "upscaled-2x.zip";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUpscaleError(msg);
    } finally {
      setUpscaleLoading(false);
    }
  };

  const canUpscaleBatch = upscaleFiles.length > 0 && !upscaleLoading;

  const onCaptionVideoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setCaptionVideoFile(f);
    setCaptionError(null);
    setCaptionedUrl(null);
    setCaptionStatus("");
  };

  const runCaptionVideo = async () => {
    if (!captionVideoFile) return;
    setCaptionLoading(true);
    setCaptionError(null);
    setCaptionedUrl(null);
    setCaptionStatus("Loading Whisper Web…");
    try {
      const {
        canUseWhisperWeb,
        downloadWhisperModel,
        resampleTo16Khz,
        transcribe,
        toCaptions,
      } = await import("@remotion/whisper-web");

      const model = "tiny.en" as const;
      const { supported, detailedReason } = await canUseWhisperWeb(model);
      if (!supported) {
        throw new Error(
          `Whisper Web needs cross-origin isolation (SharedArrayBuffer). Restart the App after next.config headers. Detail: ${detailedReason}`
        );
      }

      setCaptionStatus("Downloading Whisper model (tiny.en, first time only)…");
      await downloadWhisperModel({
        model,
        onProgress: ({ progress }) =>
          setCaptionStatus(`Downloading model… ${Math.round(progress * 100)}%`),
      });

      setCaptionStatus("Resampling audio to 16 kHz…");
      const channelWaveform = await resampleTo16Khz({
        file: captionVideoFile,
        onProgress: (p) => setCaptionStatus(`Resampling… ${Math.round(p * 100)}%`),
      });

      setCaptionStatus("Transcribing (free, on-device)…");
      const whisperWebOutput = await transcribe({
        channelWaveform,
        model,
        onProgress: (p) => setCaptionStatus(`Transcribing… ${Math.round(p * 100)}%`),
      });

      const { captions } = toCaptions({ whisperWebOutput });
      if (!captions.length) {
        throw new Error("Transcription produced no words. Try a clearer / longer clip with speech.");
      }

      setCaptionStatus(`Burning ${captions.length} caption tokens onto video…`);
      const fd = new FormData();
      fd.append("video", captionVideoFile);
      fd.append("captions", JSON.stringify(captions));
      const res = await fetch("/api/caption-video", { method: "POST", body: fd });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        videoUrl?: string;
      };
      if (!res.ok || !json.ok || !json.videoUrl) {
        throw new Error(json.error ?? `Caption burn failed (${res.status})`);
      }
      setCaptionedUrl(`${json.videoUrl}?t=${Date.now()}`);
      setCaptionStatus("Done.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCaptionError(msg);
      setCaptionStatus("");
    } finally {
      setCaptionLoading(false);
    }
  };

  const canCaptionVideo = Boolean(captionVideoFile) && !captionLoading;

  const runStoryVideo = async () => {
    if (storyText.trim().length < 20) return;
    setStoryLoading(true);
    setStoryError(null);
    setStoryVideoUrl(null);
    setStoryTitle(null);
    setStoryLogs([]);
    try {
      const fd = new FormData();
      fd.append("story", storyText.trim());
      fd.append("lang", storyLang);
      const res = await fetch("/api/story-video", {
        method: "POST",
        body: fd,
        cache: "no-store",
      });
      const json = (await res.json()) as ApiOk & {
        videoUrl?: string;
        plan?: { title?: string };
      };
      if (json.logs?.length) {
        setStoryLogs(json.logs);
      }
      if (!res.ok || !json.ok || !json.videoUrl) {
        throw new Error(json.error ?? `Story video failed (${res.status})`);
      }
      setStoryTitle(json.plan?.title ?? null);
      setStoryVideoUrl(`${json.videoUrl}?t=${Date.now()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStoryError(msg);
      setStoryLogs((prev) => [...prev, { level: "error", message: msg }]);
    } finally {
      setStoryLoading(false);
    }
  };

  const canStoryVideo = storyText.trim().length >= 20 && !storyLoading;

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
          description: `Created with Reeler\n\n${storyText.trim().slice(0, 4000)}`,
          tags: ["horror", "story", "ai", "reeler"],
          privacyStatus: ytPrivacy,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        url?: string;
      };
      if (!res.ok || !j.ok || !j.url) {
        throw new Error(j.error ?? `Upload failed (${res.status})`);
      }
      setYtUrl(j.url);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : String(e));
    } finally {
      setYtUploading(false);
    }
  };

  const [progress, setProgress] = useState(0);

  const appendLogs = useCallback((res: ApiOk) => {
    setLogs((prev) => mergeLogs(prev, res.logs));
    if (!res.ok && typeof res.error === "string") {
      setError(res.error);
    }
  }, []);

  const onImagesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setImages(list);
    setError(null);
    setVideoUrl(null);
  };

  const onAudioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setAudio(f);
    setError(null);
    setVideoUrl(null);
  };

  const onMusicChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setMusic(f);
    setError(null);
    setVideoUrl(null);
  };

  const canGenerate = useMemo(
    () =>
      images.length > 0 &&
      Boolean(audio) &&
      timedTranscript.trim().length > 0 &&
      !loading,
    [images.length, audio, timedTranscript, loading]
  );

  const runPipeline = async () => {
    if (!audio || images.length === 0 || !timedTranscript.trim()) return;
    setLoading(true);
    setError(null);
    setLogs([]);
    setVideoUrl(null);
    setProgress(0);
    setSessionId(null);

    try {
      const fd = new FormData();
      for (const img of images) {
        fd.append("images", img);
      }
      fd.append("audio", audio);
      if (music && music.size > 0) {
        fd.append("music", music);
      }

      console.log("[client] POST /api/upload");
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upJson = (await up.json()) as ApiOk & { sessionId?: string };
      appendLogs(upJson);
      if (!up.ok || !upJson.ok || !upJson.sessionId) {
        throw new Error(upJson.error ?? "Upload failed");
      }
      const sid = upJson.sessionId;
      setSessionId(sid);
      setProgress(30);

      console.log("[client] POST /api/generate-video", sid);
      const gv = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, timedTranscript: timedTranscript.trim() }),
      });
      const gvJson = (await gv.json()) as ApiOk & { videoUrl?: string };
      appendLogs(gvJson);
      if (!gv.ok || !gvJson.ok || !gvJson.videoUrl) {
        throw new Error(gvJson.error ?? "Video render failed");
      }
      setVideoUrl(`${gvJson.videoUrl}?t=${Date.now()}`);
      setProgress(100);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[client] pipeline", e);
      setError(msg);
      setLogs((prev) => [...prev, { level: "error", message: msg }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6">
        <header className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-violet-400">
            Reeler
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            AI Shorts generator
          </h1>
          <p className="text-zinc-400">
            Upload your <span className="text-zinc-200">voice-over</span> and images. Paste a
            transcript with <code className="text-violet-300">(M:SS)</code> timestamps so each segment
            knows how long to show the next slide and what subtitle to burn in. FFmpeg builds a
            1920×1080 (16:9) video with hard cuts between slides and small bottom captions.
          </p>
        </header>

        <section className="flex flex-col gap-5 rounded-2xl border border-rose-900/40 bg-zinc-900/50 p-6 shadow-xl">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-rose-200/90">
              Story → Kokoro / Hindi VO + captions
            </h2>
            <p className="text-sm text-zinc-400">
              Paste a raw story. Pick <strong className="text-zinc-300">English</strong> or{" "}
              <strong className="text-zinc-300">Hindi</strong>. Background is always the built-in{" "}
              <strong className="text-zinc-300">Minecraft parkour</strong> clip (random cuts = VO
              length, 9:16 Short). No Pexels. Only <code className="text-zinc-500">story.mp4</code>{" "}
              is saved under <code className="text-zinc-500">public/output</code>.
            </p>
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-1 w-full text-sm font-medium text-zinc-300">Language</legend>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40">
              <input
                type="radio"
                name="storyLang"
                value="en"
                checked={storyLang === "en"}
                disabled={storyLoading}
                onChange={() => setStoryLang("en")}
                className="accent-rose-500"
              />
              English (Kokoro)
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 has-[:checked]:border-rose-500 has-[:checked]:bg-rose-950/40">
              <input
                type="radio"
                name="storyLang"
                value="hi"
                checked={storyLang === "hi"}
                disabled={storyLoading}
                onChange={() => setStoryLang("hi")}
                className="accent-rose-500"
              />
              हिंदी Hindi
            </label>
          </fieldset>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Your story</span>
            <textarea
              value={storyText}
              onChange={(e) => {
                setStoryText(e.target.value);
                setStoryError(null);
                setStoryVideoUrl(null);
              }}
              disabled={storyLoading}
              rows={8}
              placeholder="Write a 30-second horror story about a cabin in the woods…"
              className="w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
            />
          </label>
          <button
            type="button"
            onClick={() => void runStoryVideo()}
            disabled={!canStoryVideo}
            className="rounded-xl bg-rose-700 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {storyLoading ? "Building story video…" : "Generate story video"}
          </button>
          {storyLogs.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-xl border border-zinc-800 bg-black/40 p-3 font-mono text-xs text-zinc-400">
              {storyLogs.map((l, i) => (
                <span key={i} className={l.level === "error" ? "text-red-400" : ""}>
                  {l.message}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
          {storyError && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {storyError}
            </p>
          )}
          {storyVideoUrl && (
            <div className="flex flex-col gap-3">
              {storyTitle && (
                <p className="text-sm font-medium text-rose-100/90">{storyTitle}</p>
              )}
              <video
                key={storyVideoUrl}
                src={storyVideoUrl}
                controls
                playsInline
                className="mx-auto aspect-[9/16] w-full max-w-sm rounded-lg border border-zinc-700 bg-black"
              />
              <a
                href={storyVideoUrl.split("?")[0]}
                download="story.mp4"
                className="inline-flex items-center justify-center rounded-xl border border-rose-800 bg-zinc-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-700"
              >
                Download story MP4
              </a>
              <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-black/30 p-3">
                <p className="text-xs text-zinc-400">
                  YouTube Shorts (9:16 + #Shorts){" "}
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
                    Connect YouTube (one-time)
                  </a>
                ) : (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-zinc-400">
                      Privacy
                      <select
                        value={ytPrivacy}
                        onChange={(e) =>
                          setYtPrivacy(e.target.value as "private" | "unlisted" | "public")
                        }
                        disabled={ytUploading}
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
                      disabled={ytUploading}
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
            </div>
          )}
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Images (slide order = A→Z by file name)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={onImagesChange}
              disabled={loading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-violet-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-violet-500"
            />
            {images.length > 0 && (
              <span className="text-xs text-zinc-500">{images.length} file(s) selected</span>
            )}
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Narration audio</span>
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
              onChange={onAudioChange}
              disabled={loading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-violet-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-violet-500"
            />
            {audio && (
              <span className="truncate text-xs text-zinc-500">{audio.name}</span>
            )}
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Timed transcript <span className="font-normal text-zinc-500">(slide + subtitle timing)</span>
            </span>
            <textarea
              value={timedTranscript}
              onChange={(e) => {
                setTimedTranscript(e.target.value);
                setError(null);
                setVideoUrl(null);
              }}
              disabled={loading}
              rows={10}
              placeholder={`(0:00) First line of narration…\n(0:05) Next beat…\n(0:09) Match timestamps roughly to your voice-over recording.`}
              className="w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <span className="text-xs text-zinc-500">
              Each <code className="text-zinc-400">(M:SS)</code> starts a new segment: that duration maps
              to the next image in <strong className="text-zinc-400">A→Z file name</strong> order (images repeat if there are more segments than images).
            </span>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">
              Background music <span className="font-normal text-zinc-500">(optional)</span>
            </span>
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
              onChange={onMusicChange}
              disabled={loading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-600"
            />
          </label>

          <button
            type="button"
            onClick={() => void runPipeline()}
            disabled={!canGenerate}
            className="rounded-xl bg-violet-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {loading ? "Working…" : "Generate video"}
          </button>

          {loading && (
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500">
                Rough progress (upload → encode). See logs for detail.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-amber-900/40 bg-zinc-900/50 p-6 shadow-xl">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-amber-200/90">Storyboard → scenes (separate tool)</h2>
            <p className="text-sm text-zinc-400">
              Upload one or more <strong className="text-zinc-300">3×3 grid</strong> storyboard sheets (same
              layout as Amazon-style boards). Each sheet is split into 9 PNGs in <strong className="text-zinc-300">A→Z file name</strong> order; all scenes are numbered sequentially{" "}
              <code className="text-amber-300/90">scene_001.png</code> … and packed into one{" "}
              <code className="text-amber-300/90">storyboard-scenes.zip</code> download.
            </p>
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Storyboard images</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={onStoryboardsChange}
              disabled={cropLoading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-amber-600"
            />
            {storyboards.length > 0 && (
              <span className="text-xs text-zinc-500">{storyboards.length} sheet(s) selected</span>
            )}
          </label>
          <button
            type="button"
            onClick={() => void runStoryboardCrop()}
            disabled={!canCropStoryboards}
            className="rounded-xl bg-amber-700 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {cropLoading ? "Cropping…" : "Download scenes (.zip)"}
          </button>
          {cropError && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {cropError}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-cyan-900/40 bg-zinc-900/50 p-6 shadow-xl">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-cyan-200/90">Batch 2× upscale (separate tool)</h2>
            <p className="text-sm text-zinc-400">
              Upload many images at once. Each file is processed in <strong className="text-zinc-300">A→Z</strong>{" "}
              order, scaled to <strong className="text-zinc-300">double width and height</strong> using a
              high-quality Lanczos resize (fast, runs fully on the server — not a generative AI model).{" "}
              <strong className="text-zinc-300">JPEG / PNG / WebP</strong> stay the same type;{" "}
              <strong className="text-zinc-300">GIF</strong> becomes a single PNG frame. Everything is returned
              in one <code className="text-cyan-300/90">upscaled-2x.zip</code> (filenames like{" "}
              <code className="text-cyan-300/90">photo_2x.jpg</code>). For Real-ESRGAN-class AI upscaling, wire a
              native binary separately — this path is meant for reliable batch work in Node.
            </p>
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Images to upscale</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={onUpscaleFilesChange}
              disabled={upscaleLoading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-cyan-600"
            />
            {upscaleFiles.length > 0 && (
              <span className="text-xs text-zinc-500">{upscaleFiles.length} file(s) selected</span>
            )}
          </label>
          <button
            type="button"
            onClick={() => void runUpscaleBatch()}
            disabled={!canUpscaleBatch}
            className="rounded-xl bg-cyan-700 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {upscaleLoading ? "Upscaling…" : "Download upscaled-2x.zip"}
          </button>
          {upscaleError && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {upscaleError}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-5 rounded-2xl border border-lime-900/40 bg-zinc-900/50 p-6 shadow-xl">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-lime-300/90">
              Transcribe + TikTok captions (Whisper Web)
            </h2>
            <p className="text-sm text-zinc-400">
              Free on-device transcription via{" "}
              <code className="text-lime-300/80">@remotion/whisper-web</code> (
              <code className="text-zinc-500">tiny.en</code>), then{" "}
              <code className="text-lime-300/80">toCaptions()</code> →{" "}
              <code className="text-lime-300/80">createTikTokStyleCaptions</code> and burn-in with
              active-word highlight <span className="font-semibold text-[#39E508]">#39E508</span>.
              First run downloads the model in your browser — keep this tab open.
            </p>
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-300">Video file</span>
            <input
              type="file"
              accept="video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm,.mkv,.m4v"
              onChange={onCaptionVideoChange}
              disabled={captionLoading}
              className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-lime-700 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-lime-600"
            />
            {captionVideoFile && (
              <span className="truncate text-xs text-zinc-500">{captionVideoFile.name}</span>
            )}
          </label>
          <button
            type="button"
            onClick={() => void runCaptionVideo()}
            disabled={!canCaptionVideo}
            className="rounded-xl bg-lime-700 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg transition hover:bg-lime-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {captionLoading ? "Working…" : "Transcribe & caption"}
          </button>
          {captionStatus && (
            <p className="text-sm text-lime-200/80">{captionStatus}</p>
          )}
          {captionError && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {captionError}
            </p>
          )}
          {captionedUrl && (
            <div className="flex flex-col gap-3">
              <video
                key={captionedUrl}
                src={captionedUrl}
                controls
                playsInline
                className="mx-auto aspect-video w-full max-w-3xl rounded-lg border border-zinc-700 bg-black"
              />
              <a
                href={captionedUrl.split("?")[0]}
                download="captioned.mp4"
                className="inline-flex items-center justify-center rounded-xl border border-lime-800 bg-zinc-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-700"
              >
                Download captioned MP4
              </a>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Progress logs
          </h2>
          <pre className="max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-black/40 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {logs.length === 0
              ? "Logs appear here after you run the pipeline."
              : logs.map((l, i) => (
                  <span key={`${i}-${l.message}`} className={l.level === "error" ? "text-red-400" : ""}>
                    {l.progress != null ? `[${l.progress}%] ` : ""}
                    {l.message}
                    {"\n"}
                  </span>
                ))}
          </pre>
        </section>

        {videoUrl && sessionId && (
          <section className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
            <h2 className="text-lg font-semibold">Preview</h2>
            <video
              key={videoUrl}
              src={videoUrl}
              controls
              playsInline
              className="mx-auto aspect-video w-full max-w-3xl rounded-lg border border-zinc-700 bg-black"
            />
            <a
              href={videoUrl.split("?")[0]}
              download={`reeler-${sessionId.slice(0, 8)}.mp4`}
              className="inline-flex items-center justify-center rounded-xl border border-zinc-600 bg-zinc-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-700"
            >
              Download MP4
            </a>
          </section>
        )}

        <footer className="border-t border-zinc-800 pt-8 text-xs text-zinc-500">
          <p>
            FFmpeg is bundled via <code className="rounded bg-zinc-800 px-1">ffmpeg-static</code> (override
            with <code className="rounded bg-zinc-800 px-1">FFMPEG_PATH</code>). No Whisper — timings come
            from your pasted transcript. See <code className="rounded bg-zinc-800 px-1">SETUP.md</code>.
          </p>
        </footer>
      </main>
    </div>
  );
}
