import type { ColourBin, Palette } from './types';

export interface ColourBinInfo {
  id: ColourBin;
  name: string;
  /** Upper bound (exclusive) of the OKLCH hue sector, degrees. The red sector wraps around 0. */
  until: number;
  /** Swatch shown in the filter bar and on colour-sweep dividers. */
  swatch: string;
}

/** Ten OKLCH hue sectors, tuned so common cover colours land where a person would file them. */
export const HUE_BINS: readonly ColourBinInfo[] = [
  { id: 'red', name: 'Red', until: 40, swatch: '#d2413a' },
  { id: 'orange', name: 'Orange', until: 70, swatch: '#e27a2e' },
  { id: 'yellow', name: 'Yellow', until: 110, swatch: '#dcb52c' },
  { id: 'lime', name: 'Lime', until: 135, swatch: '#98b83a' },
  { id: 'green', name: 'Green', until: 165, swatch: '#3f9d58' },
  { id: 'teal', name: 'Teal', until: 200, swatch: '#249488' },
  { id: 'cyan', name: 'Sky', until: 235, swatch: '#2f93c0' },
  { id: 'blue', name: 'Blue', until: 275, swatch: '#3a5fc8' },
  { id: 'violet', name: 'Violet', until: 315, swatch: '#7b4fc0' },
  { id: 'pink', name: 'Pink', until: 350, swatch: '#c8448f' },
];

export const MONO_BIN: ColourBinInfo = { id: 'mono', name: 'Black & white', until: 360, swatch: '#9a948c' };

export const COLOUR_BINS: readonly ColourBinInfo[] = [...HUE_BINS, MONO_BIN];

const BY_ID = new Map(COLOUR_BINS.map((b) => [b.id, b]));

export function colourInfo(id: ColourBin): ColourBinInfo {
  return BY_ID.get(id) ?? MONO_BIN;
}

export function isColourBin(value: string): value is ColourBin {
  return BY_ID.has(value as ColourBin);
}

/** Chroma below which a dominant colour is too grey to have a meaningful hue. */
export const GREY_CHROMA = 0.025;

export function colourBin(palette: Pick<Palette, 'hue' | 'chroma' | 'mono'>): ColourBin {
  if (palette.mono || palette.chroma < GREY_CHROMA) return 'mono';
  const hue = ((palette.hue % 360) + 360) % 360;
  for (const bin of HUE_BINS) {
    if (hue < bin.until) return bin.id;
  }
  return 'red'; // 350..360 wraps into red
}

/** Position on the colour wheel used by the colour-sweep sort: red first, greys last. */
export function sweepKey(palette: Pick<Palette, 'hue' | 'chroma' | 'lightness' | 'mono'>): [number, number] {
  if (palette.mono || palette.chroma < GREY_CHROMA) return [1000, palette.lightness];
  // Rotate so the sweep starts in the reds (~350 degrees) instead of splitting them at 0.
  const hue = (palette.hue + 10) % 360;
  return [hue, palette.lightness];
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.replace(/(.)/g, '$1$1') : v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Relative luminance (WCAG), for picking legible ink on a colour. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
