# Reeler — setup

Shorts are built from **images**, **voice-over audio**, and a **pasted transcript** with `(M:SS)` timestamps. Those timestamps control how long each slide runs and what text is burned in as subtitles. **No Whisper** — you author the timing yourself so it matches your recording.

## 1. Install

```bash
cd my-app
npm install
```

Stack: **ffmpeg-static**, **fluent-ffmpeg**, **multer**, **uuid**, plus `lib/parseTimedTranscript.ts` for `(M:SS)` parsing.

## 2. FFmpeg

Bundled via **ffmpeg-static**. Optional override: **`FFMPEG_PATH`** in `.env.local`.

## 3. Run

```bash
npm run dev
```

1. Upload images (order = slide order) and narration audio (voice-over).  
2. Paste your script with markers like `(0:00) … (0:05) …`.  
3. **Generate video** — `POST /api/generate-video` sends `timedTranscript` with the session id; the video uses your uploaded audio and the transcript for timing/subtitles.

Outputs: `public/uploads/<id>/`, `public/output/<id>/final.mp4`.

## 4. Sync tips

- Align `(M:SS)` breaks with pauses in your voice-over so slide length feels natural.  
- Total slide duration comes from the transcript; FFmpeg uses **`-shortest`** so if audio and video lengths differ, the shorter stream wins — tweak timestamps or re-record to match.

## 5. Optional env

See `env.example` (`FFMPEG_PATH`, `BACKGROUND_MUSIC_VOLUME`, etc.).
