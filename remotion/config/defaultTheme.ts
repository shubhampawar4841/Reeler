import type { RenderThemeConfig } from "./types";

/** Captions-first theme — intro/outro/progress off; Remotion = karaoke on B-roll. */
export const defaultTheme: RenderThemeConfig = {
  theme: "horror_shorts",
  captionStyle: "karaoke",
  colors: {
    highlight: "#39E508",
    text: "#FFFFFF",
    accent: "#FF2D2D",
    overlay: "rgba(0,0,0,0.35)",
    background: "#0a0a0c",
  },
  font: {
    family: "Arial Black, Impact, sans-serif",
    sizePx: 84,
    strokePx: 8,
  },
  animationSpeed: 1,
  transitionDurationSec: 0.42,
  camera: {
    defaultPreset: "static",
    intensity: 1,
  },
  progressBar: {
    enabled: false,
    showCountdown: false,
  },
  intro: {
    enabled: false,
    variant: "true_story",
    durationSec: 2.1,
  },
  outro: {
    enabled: false,
    variant: "follow_part_two",
    durationSec: 2.4,
  },
  watermark: {
    text: "Reeler",
    opacity: 0.35,
  },
};
