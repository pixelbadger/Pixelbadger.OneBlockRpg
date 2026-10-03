/**
 * The browser build's page for one game: the payload and its sprite art embedded as JSON, the shared script
 * (main.ts, bundled) and xterm.js's stylesheet beside it. Nothing is fetched, so it also plays from a file:// URL.
 */

import type { Payload } from "../../../engine/payload/schema.js";
import type { SpriteManifest } from "../tui/sprites.js";

/** What the page embeds. */
export interface WebGame {
  payload: Payload;
  sprites?: {
    manifest: SpriteManifest;
    /** Each PNG the manifest names, base64. */
    files: Record<string, string>;
  };
}

export const GAME_DATA_ID = "oneblock-game";

const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** JSON safe inside a <script> element (read back with JSON.parse, so only "</" and "<!--" matter). */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** `root` is the path from the page to the shared files (oneblock.js, xterm.css). */
export function page(game: WebGame, root = "../"): string {
  const title = game.payload.game.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<link rel="stylesheet" href="${root}xterm.css">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #08080a; color: #aaa; font: 13px system-ui, sans-serif; }
  #term { position: absolute; inset: 0 0 22px 0; padding: 6px; }
  #bar { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; line-height: 22px; padding: 0 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bar button { background: none; border: 0; padding: 0; color: #7fbfdf; font: inherit; cursor: pointer; }
  #bar button:hover { text-decoration: underline; }
  #setup { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: #08080a; }
  #setup[hidden] { display: none; }
  #setup form { width: 100%; max-width: 30rem; display: grid; gap: 12px; color: #ccc; font-size: 14px; }
  #setup h1 { margin: 0; font-size: 20px; color: #eee; }
  #setup p { margin: 0; line-height: 1.5; color: #999; }
  #setup label { display: grid; gap: 4px; }
  #setup label.check { display: flex; gap: 8px; align-items: center; }
  #setup input[type=password], #setup input[type=text] { font: 14px ui-monospace, Menlo, monospace; padding: 8px;
    color: #eee; background: #15151a; border: 1px solid #333; border-radius: 4px; }
  #setup button { justify-self: start; padding: 8px 18px; font: inherit; color: #08080a; background: #7fbfdf;
    border: 0; border-radius: 4px; cursor: pointer; }
  #setup button:disabled { opacity: 0.6; cursor: default; }
  #setup .error { color: #e57373; }
  #setup a { color: #7fbfdf; }
</style>
</head>
<body>
<div id="term"></div>
<div id="bar"><span id="state">loading…</span></div>
<div id="setup" hidden>
  <form>
    <h1>${html(title)}</h1>
    <p>The characters are played by Claude through the Anthropic API, called from this page with your API key.
      The key goes only to api.anthropic.com, and the API bills your account for what you play.
      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get a key</a>.</p>
    <label>Anthropic API key <input type="password" name="key" autocomplete="off" spellcheck="false" required></label>
    <label>Model <input type="text" name="model" autocomplete="off" spellcheck="false"></label>
    <label class="check"><input type="checkbox" name="remember"> Remember the key in this browser</label>
    <p class="error" role="alert"></p>
    <button type="submit">Play</button>
  </form>
</div>
<script type="application/json" id="${GAME_DATA_ID}">${scriptJson(game)}</script>
<script src="${root}oneblock.js"></script>
</body>
</html>
`;
}

/** The index of a build with several games. */
export function indexPage(games: { id: string; title: string }[]): string {
  const items = games.map((g) => `<li><a href="${html(g.id)}/">${html(g.title)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>One Block</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px 16px; background: #08080a; color: #ccc; font: 16px system-ui, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; }
  h1 { color: #eee; font-size: 22px; }
  a { color: #7fbfdf; }
  li { margin: 8px 0; }
</style>
</head>
<body>
<main>
<h1>One Block</h1>
<ul>
${items}
</ul>
</main>
</body>
</html>
`;
}
