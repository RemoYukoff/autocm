import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { ClipCaption } from "./ClipCaption.tsx";
import { KineticText } from "./KineticText.tsx";
import type { BrandProps, ClipCaptionProps, KineticProps } from "./types.ts";

// Size, fps and duration all come from the props, so Node decides them per render.
const fromProps: CalculateMetadataFunction<KineticProps | ClipCaptionProps> = ({ props }) => ({
  width: props.width,
  height: props.height,
  fps: props.fps,
  durationInFrames: Math.max(1, Math.round(props.total * props.fps)),
});

const demoBrand: BrandProps = {
  name: "Brand",
  host: "example.com",
  logo: null,
  colors: { bg: "#09090B", fg: "#FAFAFA", muted: "#71717A", hl: "#818CF8", primary: "#4F46E5", accent: "#818CF8" },
  sans: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, monospace",
  fonts: [],
};

const kineticDefaults: KineticProps = {
  width: 1080,
  height: 1080,
  fps: 30,
  brand: demoBrand,
  beats: [{ words: [{ text: "Hello", hl: false }, { text: "world.", hl: true }], start: 0.25, dur: 2 }],
  outro: { start: 2.25, dur: 2.4 },
  total: 4.65,
};

const clipDefaults: ClipCaptionProps = {
  width: 1920,
  height: 1080,
  fps: 30,
  brand: demoBrand,
  clip: { src: "clip.mp4", trimBefore: 0, duration: 4 },
  headline: [{ text: "Caption", hl: true }],
  endCard: 2.4,
  total: 6.4,
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="KineticText"
      component={KineticText}
      width={1080}
      height={1080}
      fps={30}
      durationInFrames={150}
      defaultProps={kineticDefaults}
      calculateMetadata={fromProps as CalculateMetadataFunction<KineticProps>}
    />
    <Composition
      id="ClipCaption"
      component={ClipCaption}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={192}
      defaultProps={clipDefaults}
      calculateMetadata={fromProps as CalculateMetadataFunction<ClipCaptionProps>}
    />
  </>
);
