export interface FitResult {
  scale: number;
  ok: boolean;
}
export function fitScale(fits: (scale: number) => boolean, opts?: { min?: number; max?: number; steps?: number }): FitResult;
export function overflows(el: { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number }): boolean;
