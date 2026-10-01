import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { flattenZodIssues, formatPath, type PayloadIssue } from "./issues.js";
import { Payload } from "./schema.js";

/** Collections that are lists of entities with ids. */
export const COLLECTIONS = [
  "rooms",
  "objects",
  "characters",
  "conversations",
  "hooks",
  "behaviours",
  "callouts",
  "set_pieces",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** Where each entity came from, so issues can name a file and a path inside it (§7.7). */
export interface Origins {
  root: string;
  game: string;
  story: string;
  combat_text: string;
  entities: Record<Collection, { file: string; prefix: PropertyKey[] }[]>;
}

export interface LoadResult {
  payload?: Payload;
  issues: PayloadIssue[];
  origins: Origins;
  /** The merged raw data before schema validation. */
  raw: Record<string, unknown>;
}

const DATA_EXT = new Set([".yaml", ".yml", ".json"]);

function readData(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return extname(file) === ".json" ? JSON.parse(text) : parseYaml(text);
}

function findFile(dir: string, stem: string): string | undefined {
  for (const ext of [".yaml", ".yml", ".json"]) {
    const f = join(dir, stem + ext);
    if (existsSync(f)) return f;
  }
  return undefined;
}

function listDir(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => DATA_EXT.has(extname(f)))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Loads a payload from a directory using the §7.3 layout, or from a single YAML/JSON file holding the whole payload.
 * The split across files is a convention: everything is merged and ids are global.
 */
export function loadPayload(path: string): LoadResult {
  const issues: PayloadIssue[] = [];
  const origins: Origins = {
    root: path,
    game: "game.yaml",
    story: "story.yaml",
    combat_text: "combat_text.yaml",
    entities: Object.fromEntries(COLLECTIONS.map((c) => [c, []])) as unknown as Origins["entities"],
  };
  const raw: Record<string, unknown> = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

  const rel = (f: string) => relative(path, f) || basename(f);
  const safeRead = (f: string): unknown => {
    try {
      return readData(f);
    } catch (e) {
      issues.push({ severity: "error", file: rel(f), path: "", message: `cannot parse: ${(e as Error).message}` });
      return undefined;
    }
  };

  if (!existsSync(path)) {
    issues.push({ severity: "error", file: path, path: "", message: "payload path does not exist" });
    return { issues, origins, raw };
  }

  if (statSync(path).isFile()) {
    const data = safeRead(path);
    const file = basename(path);
    origins.game = origins.story = origins.combat_text = file;
    if (data && typeof data === "object") {
      Object.assign(raw, data);
      for (const c of COLLECTIONS) {
        const list = (raw as Record<string, unknown>)[c];
        if (Array.isArray(list)) origins.entities[c] = list.map((_, i) => ({ file, prefix: [c, i] }));
      }
    }
    return finish(raw, issues, origins);
  }

  const single = (stem: "game" | "story" | "combat_text", required: boolean) => {
    const f = findFile(path, stem);
    if (!f) {
      if (required) {
        issues.push({
          severity: "error",
          file: `${stem}.yaml`,
          path: "",
          message: "missing file",
          fix: `create ${stem}.yaml (spec §7.3)`,
        });
      }
      return;
    }
    origins[stem] = rel(f);
    const data = safeRead(f);
    if (data !== undefined && data !== null) raw[stem] = data;
  };
  single("game", true);
  single("story", true);
  single("combat_text", false);

  for (const c of COLLECTIONS) {
    const files = [...(findFile(path, c) ? [findFile(path, c)!] : []), ...listDir(join(path, c))];
    for (const f of files) {
      const data = safeRead(f);
      if (data === undefined || data === null) continue;
      const file = rel(f);
      const list = raw[c] as unknown[];
      let items: unknown[];
      let prefix: (i: number) => PropertyKey[];
      if (Array.isArray(data)) {
        items = data;
        prefix = (i) => [i];
      } else if (typeof data === "object" && Array.isArray((data as Record<string, unknown>)[c])) {
        items = (data as Record<string, unknown[]>)[c]!;
        prefix = (i) => [c, i];
      } else {
        items = [data];
        prefix = () => [];
      }
      items.forEach((item, i) => {
        list.push(item);
        origins.entities[c].push({ file, prefix: prefix(i) });
      });
    }
  }
  return finish(raw, issues, origins);
}

function finish(raw: Record<string, unknown>, issues: PayloadIssue[], origins: Origins): LoadResult {
  if (issues.some((i) => i.severity === "error")) return { issues, origins, raw };
  const parsed = Payload.safeParse(raw);
  if (!parsed.success) {
    for (const f of flattenZodIssues(parsed.error.issues)) {
      const { file, path } = locate(origins, f.path);
      issues.push({ severity: "error", file, path, message: f.message, ...(f.fix ? { fix: f.fix } : {}) });
    }
    return { issues, origins, raw };
  }
  return { payload: parsed.data, issues, origins, raw };
}

/** Maps a path in the merged payload back to a file and a path inside that file. */
export function locate(origins: Origins, path: readonly PropertyKey[]): { file: string; path: string } {
  const [head, idx, ...rest] = path;
  if (head === "game" || head === "story" || head === "combat_text") {
    return { file: origins[head], path: formatPath(path.slice(1)) };
  }
  if (typeof head === "string" && (COLLECTIONS as readonly string[]).includes(head) && typeof idx === "number") {
    const o = origins.entities[head as Collection][idx];
    if (o) return { file: o.file, path: formatPath([...o.prefix, ...rest]) };
  }
  return { file: basename(origins.root), path: formatPath(path) };
}

/** Locates an entity by collection and id (for reference and lint issues). */
export function locateEntity(
  origins: Origins,
  payload: Payload,
  collection: Collection,
  id: string,
  sub: PropertyKey[] = [],
): { file: string; path: string } {
  const list = payload[collection] as { id: string }[];
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) return { file: basename(origins.root), path: formatPath([collection, ...sub]) };
  return locate(origins, [collection, idx, ...sub]);
}
