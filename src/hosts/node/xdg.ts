/** Where the native and terminal hosts keep things (XDG base directories, with their usual fallbacks). */
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** `$XDG_DATA_HOME/oneblock`, else `~/.local/share/oneblock`. */
export const dataDir = (env: Env = process.env): string =>
  join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "oneblock");

/** `$XDG_CONFIG_HOME/oneblock`, else `~/.config/oneblock`. */
export const configDir = (env: Env = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "oneblock");
