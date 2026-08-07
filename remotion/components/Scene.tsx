import React from "react";
import type { RenderThemeConfig, ScheduledScene } from "../config/types";
import { emotionToFx } from "../utils/sceneFx";
import { BackgroundVideo } from "./BackgroundVideo";
import { CameraController } from "./CameraController";
import { EffectsLayer } from "./EffectsLayer";
import { Transitions } from "./Transitions";

type Props = {
  scene: ScheduledScene;
  config: RenderThemeConfig;
  durationInFrames: number;
  sceneCount: number;
};

/**
 * One timeline segment: camera + gameplay + emotion-driven effects.
 * Captions are layered once at composition level (Whisper timeline).
 */
export const Scene: React.FC<Props> = ({
  scene,
  config,
  durationInFrames,
  sceneCount,
}) => {
  const fx = emotionToFx(
    scene.emotion,
    scene.camera,
    scene.sceneIndex,
    sceneCount
  );

  return (
    <Transitions
      kind={scene.transition}
      durationInFrames={durationInFrames}
      transitionFrames={Math.round(config.transitionDurationSec * 30)}
    >
      <CameraController
        preset={scene.camera}
        intensity={
          config.camera.intensity * config.animationSpeed * fx.cameraIntensity
        }
      >
        <BackgroundVideo
          src={scene.clipPath}
          startFromSec={scene.clipStartSec}
          fallbackColor={config.colors.background}
        />
      </CameraController>
      <EffectsLayer
        config={config}
        vignette={fx.vignette}
        grain={fx.grain}
        fog={fx.fog}
        redFlashAtFrame={fx.redFlashAtFrame}
        lightning={
          scene.emotion === "panic" ||
          scene.emotion === "shock" ||
          scene.camera === "crash_zoom"
        }
      />
    </Transitions>
  );
};
