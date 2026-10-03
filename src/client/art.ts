/**
 * Tile art for the scene when there is no sprite for something, and the light that falls on it: how terrain, exits,
 * objects and characters look as a glyph (or an emoji) on a coloured tile. Payload `look` hints (§7.10) win;
 * otherwise things are dressed by keyword, so any payload looks reasonable without authoring art.
 */

import type { Look, Terrain } from "../engine/payload/schema.js";
import type { SceneThing, ViewOf } from "../engine/session/port.js";

export type RGB = [number, number, number];

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
/** Mixes `a` towards `b` by `t` (0–1). */
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  clamp(a[0] + (b[0] - a[0]) * t),
  clamp(a[1] + (b[1] - a[1]) * t),
  clamp(a[2] + (b[2] - a[2]) * t),
];

/** A CSS colour for Canvas 2D and the DOM. */
export const css = (c: RGB, alpha = 1): string =>
  alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

/** Outside the room: the ground beyond the walls. */
export const VOID: RGB = [8, 8, 10];

export interface Art {
  /** One or two glyphs, drawn centred on the tile. */
  glyph: string;
  fg: RGB;
  bg: RGB;
  /** Drawn instead of the glyph when the host asks for emoji. */
  emoji?: string;
  bold?: boolean;
}

/** A cheap, stable per-tile hash for texture variation. */
export const tileHash = (x: number, y: number): number => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
};
const hash = (x: number, y: number) => tileHash(x, y) % 1000;

interface TerrainStyle {
  bg: RGB;
  fg: RGB;
  glyph: string;
  /** Alternate background for checkered or planked floors. */
  alt?: RGB;
  pattern?: "checker" | "rows" | "cols" | "speckle";
  speck?: string;
}

const TERRAIN: Record<Terrain, TerrainStyle> = {
  floor: { bg: [62, 58, 52], fg: [80, 75, 68], glyph: "  " },
  carpet: { bg: [96, 48, 46], fg: [110, 58, 56], glyph: "  ", alt: [90, 44, 42], pattern: "checker" },
  boards: { bg: [96, 68, 42], fg: [80, 56, 34], glyph: "  ", alt: [88, 62, 38], pattern: "rows" },
  tiles: { bg: [176, 174, 168], fg: [0, 0, 0], glyph: "  ", alt: [52, 52, 54], pattern: "checker" },
  lino: { bg: [96, 108, 86], fg: [110, 122, 98], glyph: "  ", alt: [90, 102, 80], pattern: "checker" },
  concrete: { bg: [86, 86, 84], fg: [110, 110, 106], glyph: "  ", pattern: "speckle", speck: "· " },
  deck: { bg: [106, 80, 52], fg: [84, 62, 40], glyph: "  ", alt: [96, 72, 46], pattern: "cols" },
  grass: { bg: [48, 100, 46], fg: [80, 140, 70], glyph: "  ", pattern: "speckle", speck: " ‚" },
  sand: { bg: [192, 168, 110], fg: [170, 148, 96], glyph: "  ", pattern: "speckle", speck: "· " },
  shingle: { bg: [118, 112, 102], fg: [156, 150, 138], glyph: "  ", pattern: "speckle", speck: "∘ " },
  road: { bg: [44, 44, 48], fg: [64, 64, 68], glyph: "  " },
  pavement: { bg: [112, 112, 108], fg: [96, 96, 92], glyph: "  ", alt: [104, 104, 100], pattern: "checker" },
  stairs: { bg: [74, 70, 66], fg: [140, 134, 126], glyph: "▤▤" },
  wall: { bg: [92, 80, 70], fg: [118, 104, 92], glyph: "▒▒" },
  window: { bg: [42, 72, 104], fg: [150, 205, 240], glyph: "▒▒" },
  railing: { bg: [70, 62, 50], fg: [205, 205, 200], glyph: "┼┼" },
  fence: { bg: [62, 58, 52], fg: [170, 170, 165], glyph: "▦▦" },
  water: { bg: [24, 62, 112], fg: [110, 170, 232], glyph: "≈ " },
  void: { bg: VOID, fg: VOID, glyph: "  " },
};

const WAVES = ["≈ ", "~≈", " ~", "≈~"];

/** Terrain at (x, y), at animation time `t` (ms). */
export function terrainArt(t: Terrain, x: number, y: number, time: number, look?: Look): Art {
  const s = TERRAIN[t];
  let bg = s.bg;
  let fg = s.fg;
  let glyph = s.glyph;
  if (s.alt && s.pattern === "checker" && (x + y) % 2) bg = s.alt;
  if (s.alt && s.pattern === "rows" && y % 2) bg = s.alt;
  if (s.alt && s.pattern === "cols" && x % 2) bg = s.alt;
  if (s.pattern === "speckle" && hash(x, y) % 5 === 0) glyph = s.speck ?? glyph;
  if (t === "water") {
    const phase = Math.floor(time / 450);
    glyph = WAVES[(x + y * 2 + phase) % WAVES.length]!;
    const shimmer = (Math.sin(time / 900 + x * 0.7 + y * 1.3) + 1) / 2;
    bg = mix(s.bg, [34, 82, 140], shimmer * 0.5);
  }
  if (t === "window" && (Math.floor(time / 120) + x * 7 + y * 13) % 97 === 0) fg = [255, 255, 255];
  const art: Art = { glyph, fg, bg };
  if (look) {
    const c = parseColor(look.color);
    if (c) {
      if (look.emoji || look.glyph || t === "window") art.fg = c;
      else art.bg = (x + y) % 2 && s.pattern === "checker" ? scale(c, 0.92) : c;
    }
    if (look.glyph) art.glyph = look.glyph.padEnd(2).slice(0, 2);
    const frames = look.frames;
    const emoji = frames?.length ? frames[Math.floor(time / 500 + hash(x, y)) % frames.length] : look.emoji;
    if (emoji) art.emoji = emoji;
  }
  return art;
}

// ─── Exits ───────────────────────────────────────────────────────────────────

const ARROWS: Record<string, string> = {
  north: "▲ ",
  south: "▼ ",
  east: "▶ ",
  west: "◀ ",
  northeast: "◥ ",
  northwest: "◤ ",
  southeast: "◢ ",
  southwest: "◣ ",
};

export function exitArt(x: ViewOf<"scene">["exits"][number], under: Art): Art {
  const doorway: RGB = mix(under.bg, [200, 190, 160], 0.25);
  const dir = (x.direction ?? "").toLowerCase();
  if (x.blocked) return { glyph: "××", fg: [230, 120, 60], bg: under.bg, emoji: "🚧" };
  if (x.door && !x.open) return { glyph: "▐▌", fg: [150, 100, 60], bg: [70, 46, 28], emoji: "🚪" };
  if (dir === "up") return { glyph: "▲▲", fg: [230, 230, 200], bg: [80, 76, 70], emoji: "🔼" };
  if (dir === "down") return { glyph: "▼▼", fg: [230, 230, 200], bg: [60, 56, 52], emoji: "🔽" };
  if (/^\d+$/.test(x.label) || /floor|stair/i.test(x.label)) {
    return { glyph: `${x.label.slice(0, 1)}▤`, fg: [240, 230, 180], bg: [80, 76, 70], bold: true };
  }
  return { glyph: ARROWS[dir] ?? "◇ ", fg: [240, 220, 150], bg: doorway, bold: true };
}

// ─── Objects and characters ──────────────────────────────────────────────────

/** Keyword → look. The first entry whose pattern matches the thing's id or name wins. */
const OBJECT_LOOKS: [RegExp, Partial<Art>][] = [
  [/kettle|teapot/, { emoji: "🫖", glyph: "♨ ", fg: [200, 200, 210] }],
  [/mug|tea|cup/, { emoji: "☕", glyph: "u ", fg: [220, 200, 170] }],
  [/\bbed\b|camp.?bed|cot\b|bunk/, { glyph: "▀▀", fg: [200, 200, 230] }],
  [/sofa|couch/, { glyph: "▄▄", fg: [130, 90, 140] }],
  [/armchair|chair|seat/, { emoji: "💺", glyph: "h ", fg: [150, 100, 70] }],
  [/bench/, { emoji: "🪑", glyph: "╥╥", fg: [150, 110, 70] }],
  [/desk|table|counter|bar\b|dresser/, { glyph: "▄▄", fg: [150, 100, 60] }],
  [/window/, { glyph: "▒▒", fg: [150, 205, 240] }],
  [/cupboard|cabinet|filing|drawer/, { glyph: "▐▌", fg: [150, 150, 140] }],
  [/floorboard/, { glyph: "▭▭", fg: [140, 100, 60] }],
  [/box|crate|parcel/, { emoji: "📦", glyph: "■ ", fg: [190, 150, 90] }],
  [/key ?board/, { glyph: "▦▦", fg: [180, 160, 110] }],
  [/\bkey\b/, { emoji: "🔑", glyph: "⚷ ", fg: [230, 200, 80] }],
  [/register|ledger|book/, { emoji: "📕", glyph: "▬ ", fg: [170, 60, 60] }],
  [/newspaper/, { emoji: "📰", glyph: "▤ ", fg: [220, 220, 210] }],
  [/photo/, { emoji: "📷", glyph: "▣ ", fg: [200, 200, 200] }],
  [/letter|notice|deed|paper|note|drawings/, { emoji: "📄", glyph: "≡ ", fg: [235, 230, 215] }],
  [/calendar/, { emoji: "📅", glyph: "▦ ", fg: [230, 230, 230] }],
  [/rules|sign|board/, { emoji: "🪧", glyph: "▭ ", fg: [230, 220, 180] }],
  [/knife|blade/, { emoji: "🔪", glyph: "/ ", fg: [200, 200, 210] }],
  [/crowbar|wrench|tool/, { emoji: "🔧", glyph: "⌐ ", fg: [170, 170, 180] }],
  [/petrol|fuel|jerrycan/, { emoji: "⛽", glyph: "▮ ", fg: [200, 40, 40] }],
  [/hard hat|helmet/, { glyph: "◓ ", fg: [240, 200, 40] }],
  [/boots|shoe/, { emoji: "🥾", glyph: "b ", fg: [120, 80, 50] }],
  [/rosary/, { emoji: "📿", glyph: "‡ ", fg: [200, 180, 140] }],
  [/can|tin/, { emoji: "🥫", glyph: "▯ ", fg: [200, 60, 60] }],
  [/hi-?vis|vest/, { emoji: "🦺", glyph: "▲ ", fg: [240, 220, 40] }],
  [/fruit machine|slot/, { emoji: "🎰", glyph: "$$", fg: [230, 180, 40] }],
  [/dartboard/, { emoji: "🎯", glyph: "◎ ", fg: [220, 60, 60] }],
  [/telly|tv|television/, { emoji: "📺", glyph: "▣ ", fg: [140, 160, 200] }],
  [/fairy|lights/, { emoji: "✨", glyph: "**", fg: [250, 230, 150] }],
  [/biscuit|cat\b/, { emoji: "🐈", glyph: "c ", fg: [230, 160, 60] }],
  [/radio/, { emoji: "📻", glyph: "♫ ", fg: [200, 180, 140] }],
  [/payphone|phone/, { emoji: "📞", glyph: "☎ ", fg: [220, 60, 60] }],
  [/generator/, { emoji: "⚡", glyph: "▣ ", fg: [240, 220, 60] }],
  [/fuse/, { emoji: "🔌", glyph: "▦ ", fg: [200, 200, 200] }],
  [/skip/, { glyph: "▙▟", fg: [230, 190, 40] }],
  [/scaffold|tubes/, { glyph: "≡≡", fg: [170, 170, 175] }],
  [/fenc/, { glyph: "╫╫", fg: [180, 180, 180] }],
  [/shelter|kiosk/, { glyph: "▛▜", fg: [90, 140, 120] }],
  [/gull|bird/, { emoji: "🐦", glyph: "v ", fg: [230, 230, 230] }],
  [/rail/, { glyph: "┼┼", fg: [205, 205, 200] }],
  [/legs|pier-legs|pillar|post/, { glyph: "║║", fg: [150, 90, 50] }],
  [/pier/, { glyph: "▒▒", fg: [150, 120, 80] }],
  [/shingle|stones/, { glyph: "∴∴", fg: [170, 165, 150] }],
  [/display/, { emoji: "🪧", glyph: "▭ ", fg: [230, 220, 180] }],
  [/turnstile/, { glyph: "╪╪", fg: [190, 190, 190] }],
  [/ticket/, { emoji: "🎫", glyph: "▭ ", fg: [230, 200, 120] }],
  [/landing stage|jetty/, { glyph: "▬▬", fg: [140, 100, 60] }],
  [/lifebuoy|life ?ring/, { emoji: "🛟", glyph: "○ ", fg: [240, 100, 60] }],
  [/glass house|pavilion/, { glyph: "▒▒", fg: [210, 235, 225] }],
  [/candyfloss|candy/, { emoji: "🍭", glyph: "¥ ", fg: [240, 150, 200] }],
  [/deckchair/, { glyph: "╱╱", fg: [220, 120, 90] }],
  [/wallpaper/, { glyph: "≋≋", fg: [170, 150, 110] }],
  [/bassinet|cradle|basket/, { emoji: "🧺", glyph: "∪ ", fg: [220, 210, 190] }],
  [/hairpin|pin/, { emoji: "📍", glyph: "ˇ ", fg: [200, 200, 210] }],
  [/panelling|panel/, { glyph: "▓▓", fg: [90, 60, 40] }],
  [/dust ?sheet|sheet/, { glyph: "░░", fg: [230, 230, 225] }],
  [/staircase|stairs/, { glyph: "▤▤", fg: [150, 140, 130] }],
  [/doors/, { glyph: "▯▯", fg: [170, 130, 90] }],
  [/match/, { glyph: "┊ ", fg: [230, 120, 60] }],
  [/tray/, { glyph: "▭ ", fg: [200, 200, 200] }],
  [/rattle/, { glyph: "♪ ", fg: [220, 220, 230] }],
  [/tablet|pill|medic|bandage/, { emoji: "💊", glyph: "+ ", fg: [230, 230, 230] }],
  [/gun|pistol|rifle/, { emoji: "🔫", glyph: "¬ ", fg: [160, 160, 170] }],
  [/bat\b|club|pipe/, { emoji: "🏏", glyph: "/ ", fg: [170, 120, 70] }],
  [/plant/, { emoji: "🪴", glyph: "♣ ", fg: [70, 160, 70] }],
];

const PEOPLE = ["🧑", "👩", "👨", "🧔", "👵", "👴", "👱", "🧓"];

/** How a thing in the scene looks (before status, lighting and animation). */
export function thingArt(t: SceneThing, under: Art, index: number): Art {
  const authored = t.look;
  const color = parseColor(authored?.color);
  if (t.kind === "character") {
    const base: Art = {
      glyph: `${(t.name.replace(/^the /i, "")[0] ?? "?").toUpperCase()} `,
      fg: t.player ? [120, 220, 255] : t.hostile || t.side === "b" ? [250, 110, 90] : [240, 220, 160],
      bg: under.bg,
      emoji: authored?.emoji ?? (t.player ? "🧍" : t.apparition ? "👤" : PEOPLE[index % PEOPLE.length]),
      bold: true,
    };
    if (t.player) base.glyph = "@ ";
    if (color) base.fg = color;
    if (authored?.glyph) base.glyph = authored.glyph.padEnd(2).slice(0, 2);
    if (t.status === "dead") return { ...base, emoji: "💀", glyph: "% ", fg: [200, 200, 200] };
    if (t.status === "down") return { ...base, emoji: "💫", glyph: "_ ", fg: [200, 200, 120] };
    if (t.status === "asleep") return { ...base, emoji: "💤", glyph: "z ", fg: [150, 150, 220] };
    return base;
  }
  const key = `${t.id} ${t.name}`.toLowerCase();
  const found = OBJECT_LOOKS.find(([re]) => re.test(key))?.[1];
  const fallback: Partial<Art> =
    t.kind === "item" ? { glyph: "• ", fg: [230, 200, 110] } : { glyph: "▪▪", fg: [150, 150, 145] };
  const art: Art = { glyph: "  ", fg: [200, 200, 200], bg: under.bg, ...fallback, ...found };
  if (t.kind === "item") delete (art as { emoji?: string }).emoji;
  if (t.kind === "item" && found?.emoji) art.emoji = found.emoji;
  if (authored?.emoji) art.emoji = authored.emoji;
  if (authored?.glyph) art.glyph = authored.glyph.padEnd(2).slice(0, 2);
  if (color) art.fg = color;
  // An open container shows its first thing on top.
  if (t.container && t.open === false && art.glyph === "▐▌") art.fg = scale(art.fg, 0.8);
  return art;
}

/** Light: outdoors at night is dim and blue; dark rooms are lit only near the player. */
export function lighting(scene: ViewOf<"scene">, x: number, y: number, player: [number, number] | undefined): number {
  const outdoors = scene.tags.includes("outdoors");
  const dark = scene.tags.includes("dark");
  const m = scene.minute;
  let k = 1;
  if (outdoors) {
    // Dawn 05:30–07:30, dusk 19:30–21:30.
    if (m < 330 || m >= 1290) k = 0.5;
    else if (m < 450) k = 0.5 + ((m - 330) / 120) * 0.5;
    else if (m >= 1170) k = 1 - ((m - 1170) / 120) * 0.5;
  }
  if (dark && player) {
    const d = Math.max(Math.abs(x - player[0]), Math.abs(y - player[1]));
    k *= d <= 2 ? 1 : d <= 4 ? 0.6 : 0.25;
  }
  return k;
}

export function nightTint(c: RGB, k: number): RGB {
  if (k >= 1) return c;
  const dimmed = scale(c, k);
  return mix(dimmed, [dimmed[0] * 0.8, dimmed[1] * 0.9, Math.min(255, dimmed[2] * 1.3 + 8)], 1 - k);
}
