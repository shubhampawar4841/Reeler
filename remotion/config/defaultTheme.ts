import type { RenderThemeConfig } from "./types";

/** Single theme object — tweak here to restyle the whole Short. */
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
    defaultPreset: "slow_push_in",
    intensity: 1.1,
  },
  progressBar: {
    enabled: true,
    showCountdown: true,
  },
  intro: {
    enabled: true,
    variant: "true_story",
    durationSec: 2.1,
  },
  outro: {
    enabled: true,
    variant: "follow_part_two",
    durationSec: 2.4,
  },
  watermark: {
    text: "Reeler",
    opacity: 0.35,
  },
};
