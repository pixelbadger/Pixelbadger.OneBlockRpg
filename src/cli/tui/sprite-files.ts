/** Reading a payload's sprite art from disk (`<payload>/assets/sprites.json` and its PNGs). */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type SpriteManifest, SpriteSet } from "./sprites.js";

export interface SpriteFiles {
  manifest: SpriteManifest;
  /** Each PNG the manifest names, by its path relative to the manifest. */
  files: Map<string, Uint8Array>;
}

/** Reads `<dir>/sprites.json` and the files it names, or returns undefined if there is none. */
export function readSpriteFiles(dir: string): SpriteFiles | undefined {
  const path = resolve(dir, "sprites.json");
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as SpriteManifest;
  const files = new Map<string, Uint8Array>();
  for (const e of Object.values(manifest.sprites)) {
    if (!files.has(e.file)) files.set(e.file, readFileSync(join(dirname(path), e.file)));
  }
  return { manifest, files };
}

/** Loads `<dir>/sprites.json`, or returns undefined if there is none. */
export function loadSprites(dir: string): SpriteSet | undefined {
  const art = readSpriteFiles(dir);
  return art && SpriteSet.fromManifest(art.manifest, (file) => art.files.get(file)!);
}
