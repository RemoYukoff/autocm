import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, BrandChip, EndCard, fitWords, FontGate, KineticWords, mix, type TypeStyle } from "./brand.tsx";
import type { ClipCaptionProps } from "./types.ts";

/**
 * Title card with the headline, then the product clip full bleed and unobstructed (product clips carry
 * their own on-screen UI and text, so nothing is overlaid on them), then the brand end card.
 */
const Body: React.FC<ClipCaptionProps> = ({ brand, clip, headline, intro, endCard }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = Math.min(width, height);
  const introFrames = Math.round(intro * fps);
  const clipFrames = Math.max(1, Math.round(clip.duration * fps));
  const pad = Math.round(u * 0.09);
  const type: TypeStyle = { fontFamily: brand.sans, fontWeight: 600, letterSpacing: "-0.04em" };
  const lineHeight = 1.06;
  const layout = useMemo(
    () => fitWords(headline, { width: width - pad * 2, height: height * 0.5 }, type, { max: Math.round(u * 0.11), min: Math.round(u * 0.045), lineHeight }),
    // Fonts are loaded before Body mounts (FontGate).
    [headline, width, height, pad, u],
  );

  const titleOut = interpolate(frame, [introFrames - 8, introFrames + 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const clipIn = interpolate(frame, [introFrames - 6, introFrames + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const clipEnd = introFrames + clipFrames;
  const fadeToCard = interpolate(frame, [clipEnd - 8, clipEnd + 4], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      <Backdrop brand={brand} />
      <Sequence durationInFrames={introFrames + 2} layout="none">
        <AbsoluteFill style={{ opacity: titleOut, padding: pad, justifyContent: "center" }}>
          <BrandChip brand={brand} size={Math.round(u * 0.026)} style={{ marginBottom: Math.round(u * 0.04), color: mix(brand.colors.fg, 80, brand.colors.bg) }} />
          <KineticWords brand={brand} lines={layout.lines} fontSize={layout.fontSize} lineHeight={lineHeight} type={type} frame={frame} exitAt={null} />
        </AbsoluteFill>
      </Sequence>
      <Sequence from={introFrames - 6} durationInFrames={clipFrames + 10} layout="none">
        <AbsoluteFill style={{ opacity: Math.min(clipIn, fadeToCard) }}>
          <OffthreadVideo src={staticFile(clip.src)} trimBefore={Math.round(clip.trimBefore * fps)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </AbsoluteFill>
      </Sequence>
      <Sequence from={clipEnd} durationInFrames={Math.round(endCard * fps)} layout="none">
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
