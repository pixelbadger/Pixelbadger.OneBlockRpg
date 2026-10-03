/** Colours for the TUI: RGB in, SGR parameters out, in true colour or the 256-colour palette. */

export type RGB = [number, number, number];

let trueColor = true;

/** Picks true colour or 256 colours (from COLORTERM unless told). */
export function setColorDepth(truecolor: boolean = /truecolor|24bit/i.test(process.env.COLORTERM ?? "")): void {
  trueColor = truecolor;
}

const NAMED: Record<string, RGB> = {
  black: [0, 0, 0],
  white: [235, 235, 235],
  grey: [128, 128, 128],
  gray: [128, 128, 128],
  red: [205, 60, 60],
  green: [80, 170, 80],
  yellow: [220, 200, 80],
  blue: [70, 110, 210],
  magenta: [190, 80, 190],
  cyan: [80, 190, 200],
  brown: [140, 90, 50],
  orange: [230, 140, 50],
};

/** "#rrggbb", "#rgb" or a colour name; undefined if unreadable. */
export function parseColor(s: string | undefined): RGB | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  const m6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(t);
  if (m6) return [Number.parseInt(m6[1]!, 16), Number.parseInt(m6[2]!, 16), Number.parseInt(m6[3]!, 16)];
  const m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m3) return [m3[1]!, m3[2]!, m3[3]!].map((h) => Number.parseInt(h + h, 16)) as RGB;
  return undefined;
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export const scale = (c: RGB, k: number): RGB => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  clamp(a[0] + (b[0] - a[0]) * t),
  clamp(a[1] + (b[1] - a[1]) * t),
  clamp(a[2] + (b[2] - a[2]) * t),
];

/** Nearest xterm 256-colour index. */
function to256([r, g, b]: RGB): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const [lr, lg, lb] = [level(r), level(g), level(b)];
  const cube = 16 + 36 * lr + 6 * lg + lb;
  const steps = [0, 95, 135, 175, 215, 255];
  const cubeRgb: RGB = [steps[lr]!, steps[lg]!, steps[lb]!];
  const avg = (r + g + b) / 3;
  const grey = avg > 238 ? 255 : Math.max(0, Math.round((avg - 8) / 10));
  const greyIdx = 232 + Math.min(23, grey);
  const greyRgb: RGB = [8 + 10 * (greyIdx - 232), 8 + 10 * (greyIdx - 232), 8 + 10 * (greyIdx - 232)];
  const d = (a: RGB) => (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;
  return d(greyRgb) < d(cubeRgb) ? greyIdx : cube;
}

export const fg = (c: RGB): string => (trueColor ? `38;2;${c[0]};${c[1]};${c[2]}` : `38;5;${to256(c)}`);
export const bg = (c: RGB): string => (trueColor ? `48;2;${c[0]};${c[1]};${c[2]}` : `48;5;${to256(c)}`);

/** Foreground on background, with optional extra attributes (bold, dim…). */
export function style(fore: RGB | undefined, back: RGB | undefined, ...attrs: string[]): string {
  return [...attrs, ...(fore ? [fg(fore)] : []), ...(back ? [bg(back)] : [])].join(";");
}
