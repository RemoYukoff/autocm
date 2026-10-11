import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { AudioLayer, EditProps, HtmlLayer, VideoLayer } from "./types.ts";

/** `asset:<name>` -> staticFile url. Unknown names are left as they are (and show up as broken). */
const resolver = (assets: Record<string, string>) => (s: string) =>
  s.replace(/asset:([A-Za-z0-9._-]+)/g, (m, name: string) => (assets[name] ? staticFile(assets[name]) : m));

const edgeFade = (t: number, dur: number, fadeIn: number, fadeOut: number) =>
  Math.min(fadeIn > 0 ? Math.min(1, t / fadeIn) : 1, fadeOut > 0 ? Math.min(1, (dur - t) / fadeOut) : 1);

/** Seconds from a CSS time ("0.45s", "450ms"). */
const secs = (v: string) => (v.trim().endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v)) || 0;

/**
 * Show every CSS animation under `root` at `t` seconds of the layer: paused, with its delay shifted back by `t`
 * (each element's own delays are kept in data-d the first time). Style-only, so it paints the same on every render.
 */
function seekCss(root: HTMLElement, t: number): void {
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (el.dataset.d === undefined) {
      const cs = getComputedStyle(el);
      if (cs.animationName === "none") continue;
      el.dataset.d = cs.animationDelay;
    }
    el.style.animationDelay = el.dataset.d.split(",").map((d) => `${secs(d) - t}s`).join(",");
    el.style.animationPlayState = "paused";
  }
}

/**
 * An HTML/CSS scene. Remotion does not drive CSS animations, so on every frame each one is paused at the layer's
 * local time (its own delay still applies), which makes every frame deterministic.
 */
const Html: React.FC<{ layer: HtmlLayer; resolve: (s: string) => string }> = ({ layer, resolve }) => {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const html = useMemo(() => resolve(layer.html), [layer.html, resolve]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.style.setProperty("--t", String(t));
    root.style.setProperty("--p", String(Math.min(1, t / layer.duration)));
    seekCss(root, t);
  });
  return <AbsoluteFill ref={ref} className="layer" dangerouslySetInnerHTML={{ __html: html }} />;
};

const Video: React.FC<{ layer: VideoLayer; resolve: (s: string) => string }> = ({ layer, resolve }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const { box } = layer;
  const scale = interpolate(t, [0, layer.duration], layer.zoom, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: box.radius ?? 0, overflow: "hidden", opacity: edgeFade(t, layer.duration, layer.fadeIn, layer.fadeOut) }}>
      <OffthreadVideo
        src={resolve(`asset:${layer.src}`)}
        trimBefore={Math.round(layer.trim * fps)}
        volume={(f) => layer.volume * edgeFade(f / fps, layer.duration, Math.min(0.3, layer.fadeIn || 0.15), Math.min(0.5, layer.fadeOut || 0.2))}
        style={{ width: "100%", height: "100%", objectFit: layer.fit, transform: `scale(${scale})` }}
      />
    </div>
  );
};

const Sound: React.FC<{ layer: AudioLayer; resolve: (s: string) => string }> = ({ layer, resolve }) => {
  const { fps } = useVideoConfig();
  return <Audio src={resolve(`asset:${layer.src}`)} trimBefore={Math.round(layer.trim * fps)} volume={(f) => layer.volume * edgeFade(f / fps, layer.duration, layer.fadeIn, layer.fadeOut)} />;
};

/** Holds the first frame until fonts and every image the html layers reference are decoded. */
function useAssetsReady(css: string, htmls: string[]): void {
  const [handle] = useState(() => delayRender("edit assets"));
  useLayoutEffect(() => {
    const urls = new Set<string>();
    for (const h of htmls) for (const m of h.matchAll(/(?:src=["']|url\(["']?)([^"')]+)/g)) urls.add(m[1]!);
    for (const m of css.matchAll(/url\(["']?([^"')]+)/g)) if (!/\.(woff2?|ttf|otf)$/i.test(m[1]!)) urls.add(m[1]!);
    const images = [...urls].filter((u) => !/\.(mp4|mov|webm|mp3|wav|m4a)$/i.test(u));
    Promise.all([
      document.fonts.ready,
      ...images.map((u) => {
        const img = new Image();
        img.src = u;
        return img.decode().catch(() => console.error(`image failed: ${u}`));
      }),
    ]).finally(() => continueRender(handle));
  }, [css, htmls, handle]);
}

export const Edit: React.FC<EditProps> = ({ assets, css, layers }) => {
  const { fps } = useVideoConfig();
  const resolve = useMemo(() => resolver(assets), [assets]);
  const resolvedCss = useMemo(() => resolve(css), [css, resolve]);
  const htmls = useMemo(() => layers.filter((l): l is HtmlLayer => l.kind === "html").map((l) => resolve(l.html)), [layers, resolve]);
  useAssetsReady(resolvedCss, htmls);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <style>{resolvedCss}</style>
      {layers.map((l, i) => (
        <Sequence key={i} from={Math.round(l.start * fps)} durationInFrames={Math.max(1, Math.round(l.duration * fps))} layout="none">
          {l.kind === "html" ? <Html layer={l} resolve={resolve} /> : l.kind === "video" ? <Video layer={l} resolve={resolve} /> : <Sound layer={l} resolve={resolve} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
