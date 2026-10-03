/** A payload's assets read from disk: `<payload dir>/assets/<path>`. */
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Assets } from "../../platform/index.js";

export function dirAssets(payloadDir: string): Assets {
  const root = resolve(payloadDir, "assets");
  const read = async (path: string): Promise<Buffer | undefined> => {
    const full = resolve(join(root, path));
    const rel = relative(root, full);
    // Never outside the assets directory.
    if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return undefined;
    try {
      return await readFile(full);
    } catch {
      return undefined;
    }
  };
  return {
    bytes: async (path) => {
      const b = await read(path);
      return b && new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
    text: async (path) => (await read(path))?.toString("utf8"),
  };
}
