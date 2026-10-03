/**
 * The browser build: a static site that plays payloads entirely in the browser (the web host, src/hosts/web), for
 * GitHub Pages or any static host. Each payload is validated, then embedded with its sprite art in its own page.
 *
 *   pnpm web examples/the-pier examples/carver-street [--out dist/web]
 *
 * writes <out>/index.html (the list of games), <out>/<game id>/index.html, the shared oneblock.js and the font
 * (<out>/fonts/). The pages fetch nothing but the font beside them, so they also play straight from disk (file://).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import type { SpriteManifest } from "../src/client/sprites.js";
import { FONT_FILES } from "../src/client/theme.js";
import { formatIssue } from "../src/engine/payload/issues.js";
import { validatePayloadAt } from "../src/hosts/node/payload.js";
import { fontPath, indexPage, page, type WebGame } from "../src/hosts/web/page.js";

const ENTRY = fileURLToPath(new URL("../src/hosts/web/main.tsx", import.meta.url));
const require = createRequire(import.meta.url);

/** A payload's sprite art (`assets/sprites.json` and the PNGs it names), path → base64, if it ships any. */
function readAssets(payloadDir: string): Record<string, string> | undefined {
  const dir = join(payloadDir, "assets");
  const manifestPath = join(dir, "sprites.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = readFileSync(manifestPath);
  const files: Record<string, string> = { "sprites.json": manifest.toString("base64") };
  for (const e of Object.values((JSON.parse(manifest.toString("utf8")) as SpriteManifest).sprites)) {
    files[e.file] ??= readFileSync(join(dir, e.file)).toString("base64");
  }
  return files;
}

export interface WebBuild {
  out: string;
  games: { id: string; title: string; dir: string }[];
}

/** Builds the site for `payloads` into `out` (emptied first). Throws if a payload has errors. */
export async function buildWeb(payloads: string[], out: string, o: { minify?: boolean } = {}): Promise<WebBuild> {
  const games: WebGame[] = payloads.map((path) => {
    const r = validatePayloadAt(path);
    const errors = r.issues.filter((i) => i.severity === "error");
    if (!r.payload || errors.length) {
      throw new Error(`${path}: ${errors.length} error(s)\n${errors.map(formatIssue).join("\n")}`);
    }
    const assets = readAssets(path);
    return { payload: r.payload, ...(assets ? { assets } : {}) };
  });
  const ids = games.map((g) => g.payload.game.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`two payloads have the game id '${twice}'`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [ENTRY],
    outfile: join(out, "oneblock.js"),
    bundle: true,
    // A classic script, not a module, so pages opened from disk can load it.
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: o.minify ?? true,
    legalComments: "linked",
    logLevel: "silent",
  });
  const fonts = dirname(require.resolve("@fontsource/jetbrains-mono/package.json"));
  mkdirSync(join(out, "fonts"), { recursive: true });
  for (const f of FONT_FILES) copyFileSync(join(fonts, f.file), join(out, fontPath(f.file)));
  copyFileSync(join(fonts, "LICENSE"), join(out, "fonts", "OFL.txt"));
  for (const g of games) {
    const dir = join(out, g.payload.game.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), page(g));
  }
  const listed = games.map((g) => ({ id: g.payload.game.id, title: g.payload.game.title }));
  writeFileSync(join(out, "index.html"), indexPage(listed));
  return { out, games: listed.map((g) => ({ ...g, dir: join(out, g.id) })) };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", default: "dist/web" } },
  });
  if (!positionals.length) {
    console.error("usage: pnpm web <payload>... [--out dist/web]");
    return 2;
  }
  const result = await buildWeb(positionals, values.out!);
  for (const g of result.games) console.log(`${g.title}: ${join(g.dir, "index.html")}`);
  console.log(`wrote ${result.out}/ (serve it as static files, or open a game's index.html)`);
  return 0;
}

if (process.argv[1] && /tools[\\/]web\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
