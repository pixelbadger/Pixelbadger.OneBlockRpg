/** A payload's assets embedded in the page: path → base64, decoded on first use. */
import type { Assets } from "../../platform/index.js";

function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function embeddedAssets(files: Record<string, string>): Assets {
  const decoded = new Map<string, Uint8Array>();
  const bytes = (path: string): Uint8Array | undefined => {
    const hit = decoded.get(path);
    if (hit) return hit;
    if (!Object.hasOwn(files, path)) return undefined;
    const b = decode(files[path]!);
    decoded.set(path, b);
    return b;
  };
  return {
    bytes: async (path) => bytes(path),
    text: async (path) => {
      const b = bytes(path);
      return b && new TextDecoder().decode(b);
    },
  };
}
