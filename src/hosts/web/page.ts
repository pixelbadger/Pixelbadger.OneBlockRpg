/**
 * The browser build's pages: one per game, embedding the payload and its assets as JSON beside the shared script
 * (main.tsx, bundled) and the bundled font. The look is inlined: the font faces, the theme's tokens (themeCss) and
 * the HUD's stylesheet. Nothing is fetched at run time, so a page also plays from a file:// URL.
 */

import { FONT_FAMILY, FONT_FILES, themeCss } from "../../client/theme.js";
import type { Payload } from "../../engine/payload/schema.js";
import { HUD_CSS, INDEX_CSS } from "./style.js";

/** What a game's page embeds. */
export interface WebGame {
  payload: Payload;
  /** The payload's assets (`sprites.json` and the PNGs it names), path → base64. */
  assets?: Record<string, string>;
}

export const GAME_DATA_ID = "oneblock-game";

/** Where a font file (theme.ts FONT_FILES) lands in the build, relative to its root. */
export const fontPath = (file: string): string => `fonts/${file.slice(file.lastIndexOf("/") + 1)}`;

const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** JSON safe inside a <script> element (read back with JSON.parse, so only "</" and "<!--" matter). */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

function fontFaces(root: string): string {
  return FONT_FILES.map(
    (f) =>
      `@font-face { font-family: "${FONT_FAMILY}"; font-style: ${f.style}; font-weight: ${f.weight}; ` +
      `font-display: swap; src: url("${root}${fontPath(f.file)}") format("woff2"); }`,
  ).join("\n");
}

function head(title: string, root: string, css: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
${fontFaces(root)}
${themeCss()}
${css}
</style>
</head>`;
}

/** `root` is the path from the page to the shared files (oneblock.js, fonts/). */
export function page(game: WebGame, root = "../"): string {
  return `${head(game.payload.game.title, root, HUD_CSS)}
<body>
<div id="app"><p class="loading style-muted">Loading…</p></div>
<noscript><p class="loading">This game runs in the page: it needs JavaScript.</p></noscript>
<script type="application/json" id="${GAME_DATA_ID}">${scriptJson(game)}</script>
<script src="${root}oneblock.js"></script>
</body>
</html>
`;
}

/** The index of a build with several games. */
export function indexPage(games: { id: string; title: string }[]): string {
  const items = games.map((g) => `<li><a href="${html(g.id)}/">${html(g.title)}</a></li>`).join("\n");
  return `${head("One Block", "", INDEX_CSS)}
<body>
<main class="panel">
<h1 class="style-title">One Block</h1>
<ul>
${items}
</ul>
</main>
</body>
</html>
`;
}
