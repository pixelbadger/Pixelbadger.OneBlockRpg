/**
 * The browser build: a static site that plays payloads entirely in the browser (src/cli/web), for GitHub Pages or
 * any static host. Each payload is validated, then embedded with its sprite art in its own page.
 *
 *   pnpm web examples/the-pier examples/carver-street [--out dist/web]
 *
 * writes <out>/index.html (the list of games), <out>/<game id>/index.html, and the shared oneblock.js and xterm.css.
 * The pages fetch nothing, so they also play straight from disk (file://).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { readSpriteFiles } from "../src/cli/tui/sprite-files.js";
import { indexPage, page, type WebGame } from "../src/cli/web/page.js";
import { formatIssue } from "../src/payload/issues.js";
import { validatePayloadAt } from "../src/payload/validate.js";

const ENTRY = fileURLToPath(new URL("../src/cli/web/main.ts", import.meta.url));
const require = createRequire(import.meta.url);

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
    const art = readSpriteFiles(join(path, "assets"));
    return {
      payload: r.payload,
      ...(art
        ? {
            sprites: {
              manifest: art.manifest,
              files: Object.fromEntries([...art.files].map(([f, b]) => [f, Buffer.from(b).toString("base64")])),
            },
          }
        : {}),
    };
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
    minify: o.minify ?? true,
    legalComments: "linked",
    logLevel: "silent",
  });
  writeFileSync(
    join(out, "xterm.css"),
    readFileSync(join(dirname(require.resolve("@xterm/xterm/package.json")), "css/xterm.css")),
  );
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
