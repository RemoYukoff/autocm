import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, BrandChip, EndCard, fitWords, FontGate, KineticWords, mix, type TypeStyle } from "./brand.tsx";
import type { ClipCaptionProps } from "./types.ts";

/** Product clip, full bleed, with an animated caption panel and the brand end card. */
const Body: React.FC<ClipCaptionProps> = ({ brand, clip, headline, endCard }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width, height);
  const clipFrames = Math.max(1, Math.round(clip.duration * fps));
  const pad = Math.round(u * 0.06);
  const type: TypeStyle = { fontFamily: brand.sans, fontWeight: 600, letterSpacing: "-0.04em" };
  const lineHeight = 1.06;
  const panelW = Math.round(width > height ? width * 0.5 : width - pad * 2);
  const innerPad = Math.round(u * 0.035);
  const layout = useMemo(
    () => fitWords(headline, { width: panelW - innerPad * 2, height: u * 0.24 }, type, { max: Math.round(u * 0.068), min: Math.round(u * 0.032), lineHeight }),
    // Fonts are loaded before Body mounts (FontGate).
    [headline, panelW, innerPad, u],
  );

  const capIn = Math.round(fps * 0.4);
  const capOut = clipFrames - Math.round(fps * 0.35);
  const panel = interpolate(frame, [capIn - 6, capIn + 6, capOut, capOut + 8], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeToCard = interpolate(frame, [clipFrames - 8, clipFrames + 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      <Backdrop brand={brand} />
      <Sequence durationInFrames={clipFrames + 4} layout="none">
        <AbsoluteFill style={{ opacity: fadeToCard }}>
          <OffthreadVideo src={staticFile(clip.src)} trimBefore={Math.round(clip.trimBefore * fps)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <AbsoluteFill style={{ background: `linear-gradient(0deg, ${mix(brand.colors.bg, 78)} 0%, transparent 46%)` }} />
          <div
            style={{
              position: "absolute",
              left: pad,
              bottom: pad,
              width: panelW,
              padding: innerPad,
              borderRadius: Math.round(u * 0.022),
              background: mix(brand.colors.bg, 82),
              border: `1px solid ${mix(brand.colors.fg, 14)}`,
              boxShadow: `0 30px 80px -20px rgba(0,0,0,0.6)`,
              backdropFilter: "blur(18px)",
              opacity: panel,
              transform: `translateY(${(1 - panel) * 24}px)`,
            }}
          >
            <BrandChip brand={brand} size={Math.round(u * 0.02)} style={{ marginBottom: Math.round(u * 0.022), color: mix(brand.colors.fg, 80, brand.colors.bg) }} />
            <KineticWords brand={brand} lines={layout.lines} fontSize={layout.fontSize} lineHeight={lineHeight} type={type} frame={frame - capIn} exitAt={null} />
          </div>
        </AbsoluteFill>
      </Sequence>
      <Sequence from={clipFrames} durationInFrames={Math.round(endCard * fps)} layout="none">
        <EndCardAt brand={brand} />
      </Sequence>
    </AbsoluteFill>
  );
};

const EndCardAt: React.FC<{ brand: ClipCaptionProps["brand"] }> = ({ brand }) => <EndCard brand={brand} frame={useCurrentFrame()} />;

export const ClipCaption: React.FC<ClipCaptionProps> = (props) => (
  <FontGate brand={props.brand}>
    <Body {...props} />
  </FontGate>
);
