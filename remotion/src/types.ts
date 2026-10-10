// Props contract between src/media/video.ts (Node) and the compositions. Plain JSON, no zod:
// the root project is on zod 4 and Remotion's schema integration targets zod 3.

export type Word = { text: string; hl: boolean };

export type FontSpec = {
  family: string;
  /** Path under the bundle's public dir (resolved with staticFile). */
  src: string;
  weight: string;
  style: "normal" | "italic";
};

export type BrandProps = {
  name: string;
  host: string;
  /** data: URI, already recolored for the theme. */
  logo: string | null;
  colors: { bg: string; fg: string; muted: string; hl: string; primary: string; accent: string };
  sans: string;
  mono: string;
  fonts: FontSpec[];
};

export type Beat = { words: Word[]; start: number; dur: number };

export type KineticProps = {
  width: number;
  height: number;
  fps: number;
  brand: BrandProps;
  beats: Beat[];
  outro: { start: number; dur: number };
  total: number;
};

export type ClipCaptionProps = {
  width: number;
  height: number;
  fps: number;
  brand: BrandProps;
  clip: {
    /** Path under the bundle's public dir. */
    src: string;
    /** Seconds trimmed from the start of the source. */
    trimBefore: number;
    /** Seconds of source to play. */
    duration: number;
  };
  headline: Word[];
  endCard: number;
  total: number;
};
