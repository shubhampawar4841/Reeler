import React from "react";
import type { RenderThemeConfig, ScheduledScene } from "../config/types";
import { BackgroundVideo } from "./BackgroundVideo";

type Props = {
  scene: ScheduledScene;
  config: RenderThemeConfig;
  durationInFrames: number;
};

/** Continuous B-roll plate — no camera FX / transitions / emotion overlays. */
export const Scene: React.FC<Props> = ({ scene, config }) => {
  return (
    <BackgroundVideo
      src={scene.clipPath}
      startFromSec={scene.clipStartSec}
      fallbackColor={config.colors.background}
    />
  );
};
