/** Payloads on disk: the engine's loader and validator (§7.7) bound to the node file system. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { type LoadResult, loadPayload as load, type PayloadFiles } from "../../engine/payload/loader.js";
import { type ValidationResult, validatePayloadAt as validate } from "../../engine/payload/validate.js";

export const nodeFiles: PayloadFiles = {
  kind: (p) => {
    if (!existsSync(p)) return undefined;
    return statSync(p).isDirectory() ? "dir" : "file";
  },
  list: (dir) => readdirSync(dir),
  read: (p) => readFileSync(p, "utf8"),
};

/** Paths are normalised to "/" so issues name files the same way on every platform. */
const slash = (p: string) => p.replace(/\\/g, "/");

export const loadPayload = (path: string): LoadResult => load(slash(path), nodeFiles);

export const validatePayloadAt = (path: string): ValidationResult => validate(slash(path), nodeFiles);
