import { measureText } from "@remotion/layout-utils";
import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { BrandProps, Word } from "./types.ts";

export const mix = (color: string, pct: number, base = "transparent") => `color-mix(in oklab, ${color} ${pct}%, ${base})`;

/** Registers the brand fonts and renders children only once they are in (text is measured on mount). */
export const FontGate: React.FC<{ brand: BrandProps; children: React.ReactNode }> = ({ brand, children }) => {
  const [handle] = useState(() => delayRender("brand fonts"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all(
      brand.fonts.map(async (f) => {
        const face = new FontFace(f.family, `url("${staticFile(f.src)}")`, { weight: f.weight, style: f.style });
        document.fonts.add(await face.load());
      }),
    )
      .catch((e) => console.error("font load failed", e))
      .finally(() => {
        setReady(true);
        continueRender(handle);
      });
  }, [brand.fonts, handle]);
  return ready ? <>{children}</> : null;
};

/** Ink background with a slowly drifting brand glow and a dot grid (the dot-matrix Q motif). */
export const Backdrop: React.FC<{ brand: BrandProps }> = ({ brand }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const gx = 72 + 9 * Math.sin(t * 0.45);
  const gy = 18 + 7 * Math.cos(t * 0.38);
  const g2x = 12 + 6 * Math.cos(t * 0.31);
  const g2y = 92 + 5 * Math.sin(t * 0.27);
  const size = Math.round(Math.min(width, height) / 46);
  return (
    <AbsoluteFill style={{ background: brand.colors.bg, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(${width * 0.75}px ${width * 0.75}px at ${gx}% ${gy}%, ${mix(brand.colors.primary, 30)} 0%, transparent 62%),
            radial-gradient(${width * 0.6}px ${width * 0.6}px at ${g2x}% ${g2y}%, ${mix(brand.colors.primary, 14)} 0%, transparent 60%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${mix(brand.colors.fg, 14)} 1.3px, transparent 1.8px)`,
          backgroundSize: `${size}px ${size}px`,
          backgroundPosition: `${(t * 5) % size}px ${(t * 3) % size}px`,
          WebkitMaskImage: `radial-gradient(ellipse 65% 60% at ${gx}% ${gy}%, #000 0%, transparent 72%)`,
          maskImage: `radial-gradient(ellipse 65% 60% at ${gx}% ${gy}%, #000 0%, transparent 72%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const BrandChip: React.FC<{ brand: BrandProps; size: number; style?: React.CSSProperties }> = ({ brand, size, style }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.55, fontFamily: brand.sans, fontWeight: 600, fontSize: size, color: brand.colors.fg, letterSpacing: "-0.01em", ...style }}>
    {brand.logo ? <Img src={brand.logo} style={{ height: size * 1.6, width: "auto" }} /> : null}
    <span>{brand.name}</span>
  </div>
);

export const MonoLabel: React.FC<{ brand: BrandProps; size: number; color?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({
  brand,
  size,
  color,
  children,
  style,
}) => (
  <div style={{ fontFamily: brand.mono, fontSize: size, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: color ?? mix(brand.colors.fg, 60, brand.colors.bg), ...style }}>
    {children}
  </div>
);

// ---------- Kinetic words ----------

/** Gap between words, in em; used both for measuring and for rendering. */
export const WORD_GAP_EM = 0.22;

export type TypeStyle = { fontFamily: string; fontWeight: number; letterSpacing: string };

/** Greedy wrap with real glyph widths. Returns null when a single word is wider than the box. */
export function wrapWords(words: Word[], fontSize: number, maxWidth: number, type: TypeStyle): Word[][] | null {
  const m = (text: string) => measureText({ text, fontSize, ...type }).width;
  const space = fontSize * WORD_GAP_EM;
  const lines: Word[][] = [];
  let line: Word[] = [];
  let w = 0;
  for (const word of words) {
    const ww = m(word.text);
    if (ww > maxWidth) return null;
    const next = line.length ? w + space + ww : ww;
    if (next > maxWidth && line.length) {
      lines.push(line);
      line = [word];
      w = ww;
    } else {
      line.push(word);
      w = next;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Largest font size (step 2px) whose wrapped lines fit the box. */
export function fitWords(
  words: Word[],
  box: { width: number; height: number },
  type: TypeStyle,
  opts: { max: number; min: number; lineHeight: number },
): { fontSize: number; lines: Word[][] } {
  for (let size = opts.max; size >= opts.min; size -= 2) {
    const lines = wrapWords(words, size, box.width, type);
    if (lines && lines.length * size * opts.lineHeight <= box.height) return { fontSize: size, lines };
  }
  const size = opts.min;
  return { fontSize: size, lines: wrapWords(words, size, box.width, type) ?? [words] };
}

/**
 * Words rise out of a per-line mask with a short stagger; highlighted words take the brand highlight
 * color and get an underline that sweeps in after them. `exitAt` (frames) starts the exit.
 */
export const KineticWords: React.FC<{
  brand: BrandProps;
  lines: Word[][];
  fontSize: number;
  lineHeight: number;
  type: TypeStyle;
  frame: number;
  exitAt: number | null;
  align?: "left" | "center";
  color?: string;
}> = ({ brand, lines, fontSize, lineHeight, type, frame, exitAt, align = "left", color }) => {
  const { fps } = useVideoConfig();
  let idx = 0;
  const total = lines.reduce((n, l) => n + l.length, 0);
  const stagger = Math.min(2.4, 14 / Math.max(1, total));
  const exit = exitAt === null ? 0 : interpolate(frame, [exitAt, exitAt + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  return (
    <div style={{ fontFamily: type.fontFamily, fontWeight: type.fontWeight, letterSpacing: type.letterSpacing, fontSize, lineHeight, color: color ?? brand.colors.fg, textAlign: align }}>
      {lines.map((line, li) => (
        <div key={li} style={{ overflow: "hidden", padding: "0.06em 0.04em 0.16em", margin: "-0.06em -0.04em -0.16em", whiteSpace: "nowrap" }}>
          {line.map((w, wi) => {
            const i = idx++;
            const p = spring({ frame: frame - i * stagger, fps, config: { damping: 200, mass: 0.55, stiffness: 140 } });
            const ul = w.hl ? spring({ frame: frame - i * stagger - 9, fps, config: { damping: 200, mass: 0.7 } }) : 0;
            const y = (1 - p) * 105 - exit * 70;
            return (
              <span key={wi} style={{ display: "inline-block", position: "relative", transform: `translateY(${y}%)`, opacity: Math.min(p * 1.4, 1) * (1 - exit), marginRight: wi < line.length - 1 ? `${WORD_GAP_EM}em` : 0, color: w.hl ? brand.colors.hl : undefined }}>
                {w.text}
                {w.hl ? (
                  <span style={{ position: "absolute", left: 0, right: "0.04em", bottom: "0.02em", height: "0.075em", borderRadius: "0.04em", background: brand.colors.hl, opacity: 0.85, transformOrigin: "0 50%", transform: `scaleX(${ul})` }} />
                ) : null}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Logo, name and url. `frame` is local to the card. */
export const EndCard: React.FC<{ brand: BrandProps; frame: number }> = ({ brand, frame }) => {
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width, height);
  const p = spring({ frame, fps, config: { damping: 200, mass: 0.8 } });
  const p2 = spring({ frame: frame - 7, fps, config: { damping: 200 } });
  const p3 = spring({ frame: frame - 13, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
      {brand.logo ? (
        <Img src={brand.logo} style={{ height: u * 0.24, width: "auto", opacity: p, transform: `scale(${0.86 + 0.14 * p})` }} />
      ) : null}
      <div style={{ marginTop: u * 0.045, fontFamily: brand.sans, fontWeight: 600, fontSize: u * 0.085, letterSpacing: "-0.045em", color: brand.colors.fg, opacity: p2, transform: `translateY(${(1 - p2) * 24}px)` }}>
        {brand.name}
      </div>
      <div style={{ marginTop: u * 0.018, fontFamily: brand.mono, fontSize: u * 0.03, letterSpacing: "0.08em", color: brand.colors.hl, opacity: p3, transform: `translateY(${(1 - p3) * 18}px)` }}>
        {brand.host} ↗
      </div>
    </AbsoluteFill>
  );
};
