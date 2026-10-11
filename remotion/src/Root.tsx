import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { Edit } from "./Edit.tsx";
import type { EditProps } from "./types.ts";

// Size, fps and duration all come from the props, so Node decides them per render.
const fromProps: CalculateMetadataFunction<EditProps> = ({ props }) => ({
  width: props.width,
  height: props.height,
  fps: props.fps,
  durationInFrames: Math.max(1, Math.round(props.total * props.fps)),
});

const defaults: EditProps = {
  width: 1080,
  height: 1080,
  fps: 30,
  total: 3,
  assets: {},
  css: ".hello{font:600 120px system-ui;color:#fff;animation:in 1s both}@keyframes in{from{opacity:0;transform:translateY(40px)}}",
  layers: [{ kind: "html", start: 0, duration: 3, html: '<div style="background:#111;width:100%;height:100%;display:grid;place-items:center"><div class="hello">Hello</div></div>' }],
};

export const RemotionRoot: React.FC = () => (
  <Composition id="Edit" component={Edit} width={1080} height={1080} fps={30} durationInFrames={90} defaultProps={defaults} calculateMetadata={fromProps} />
);
