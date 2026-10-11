// Props contract between src/media/edit.ts (Node) and the Edit composition. Plain JSON, no zod:
// the root project is on zod 4 and Remotion's schema integration targets zod 3.
//
// Strings may reference staged files as `asset:<name>` (html, css, src); the composition resolves them with staticFile.

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
};

/** An HTML/CSS scene. CSS animations are seeked to the frame; `--t` (s) and `--p` (0..1) hold the layer's local time. */
export type HtmlLayer = { kind: "html"; start: number; duration: number; html: string };

/** A video file in a box. Opacity fades at the edges; its own sound plays at `volume`. */
export type VideoLayer = {
  kind: "video";
  start: number;
  duration: number;
  src: string;
  /** Seconds skipped at the start of the file. */
  trim: number;
  box: Box;
  fit: "cover" | "contain";
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** Scale at the start and at the end of the layer (slow push-in/out). */
  zoom: [number, number];
};

export type AudioLayer = { kind: "audio"; start: number; duration: number; src: string; trim: number; volume: number; fadeIn: number; fadeOut: number };

export type Layer = HtmlLayer | VideoLayer | AudioLayer;

export type EditProps = {
  width: number;
  height: number;
  fps: number;
  total: number;
  /** Staged files by name -> path under the bundle's public dir. */
  assets: Record<string, string>;
  /** Brand stylesheet (font faces, variables) followed by the editor's own CSS. */
  css: string;
  /** Bottom to top. */
  layers: Layer[];
};
