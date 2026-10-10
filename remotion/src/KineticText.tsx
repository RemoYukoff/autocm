import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, BrandChip, EndCard, fitWords, FontGate, KineticWords, mix, MonoLabel, type TypeStyle } from "./brand.tsx";
import type { KineticProps } from "./types.ts";

const pad2 = (n: number) => String(n).padStart(2, "0");

const Beats: React.FC<KineticProps> = (props) => {
  const { brand, beats, outro } = props;
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width, height);
  const padX = Math.round(width * (width > height ? 0.09 : 0.085));
  const type: TypeStyle = { fontFamily: brand.sans, fontWeight: 600, letterSpacing: "-0.045em" };
  const box = { width: width - padX * 2, height: height * 0.56 };
  const lineHeight = 1.04;

  const layouts = useMemo(
    () => beats.map((b, i) => fitWords(b.words, box, type, { max: Math.round(u * (i === 0 ? 0.118 : 0.104)), min: Math.round(u * 0.045), lineHeight })),
    [beats, box.width, box.height, u],
  );

  const t = frame / fps;
  const active = beats.findIndex((b) => t >= b.start && t < b.start + b.dur);
  const progress = interpolate(t, [beats[0]?.start ?? 0, outro.start], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chromeOut = interpolate(t, [outro.start - 0.2, outro.start + 0.2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const chromeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      <Backdrop brand={brand} />
      <AbsoluteFill style={{ opacity: chromeOut * chromeIn }}>
        <BrandChip brand={brand} size={Math.round(u * 0.026)} style={{ position: "absolute", left: padX, top: Math.round(u * 0.075) }} />
        {beats.length > 1 ? (
          <MonoLabel brand={brand} size={Math.round(u * 0.019)} style={{ position: "absolute", right: padX, top: Math.round(u * 0.083) }}>
            <span style={{ color: brand.colors.hl }}>{pad2(Math.max(1, active + 1))}</span> / {pad2(beats.length)}
          </MonoLabel>
        ) : null}
        <div style={{ position: "absolute", left: padX, right: padX, bottom: Math.round(u * 0.08), height: 2, background: mix(brand.colors.fg, 12) }}>
          <div style={{ width: `${progress * 100}%`, height: "100%", background: brand.colors.hl }} />
        </div>
        <MonoLabel brand={brand} size={Math.round(u * 0.017)} style={{ position: "absolute", left: padX, bottom: Math.round(u * 0.08) + 22 }}>
          {brand.host}
        </MonoLabel>
      </AbsoluteFill>

      {beats.map((b, i) => {
        const from = Math.round(b.start * fps);
        const dur = Math.max(1, Math.round(b.dur * fps));
        const l = layouts[i]!;
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            <BeatView {...props} lines={l.lines} fontSize={l.fontSize} lineHeight={lineHeight} type={type} padX={padX} exitAt={dur - 9} />
          </Sequence>
        );
      })}

      <Sequence from={Math.round(outro.start * fps)} layout="none">
        <OutroView {...props} />
      </Sequence>
    </AbsoluteFill>
  );
};

const BeatView: React.FC<
  KineticProps & { lines: KineticProps["beats"][number]["words"][]; fontSize: number; lineHeight: number; type: TypeStyle; padX: number; exitAt: number }
> = ({ brand, lines, fontSize, lineHeight, type, padX, exitAt }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: padX, paddingRight: padX }}>
      <KineticWords brand={brand} lines={lines} fontSize={fontSize} lineHeight={lineHeight} type={type} frame={frame} exitAt={exitAt} />
    </AbsoluteFill>
  );
};

const OutroView: React.FC<KineticProps> = ({ brand }) => {
  const frame = useCurrentFrame();
  return <EndCard brand={brand} frame={frame} />;
};

export const KineticText: React.FC<KineticProps> = (props) => (
  <FontGate brand={props.brand}>
    <Beats {...props} />
  </FontGate>
);
