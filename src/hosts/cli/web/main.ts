/**
 * The browser build (§3.1 adapter): the whole engine and the full-screen TUI run in the page, drawn by xterm.js with
 * its image addon. Characters are played through the Anthropic API with the player's own key; the game is saved in
 * IndexedDB and resumes when the page comes back. Bundled by tools/web.ts; page.ts embeds the payload.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Terminal } from "@xterm/xterm";
import { AnthropicApiProvider, DEFAULT_MODEL } from "../../../engine/llm/anthropic-api.js";
import { startGame } from "../start-game.js";
import { runTui } from "../tui/app.js";
import { SpriteSet } from "../tui/sprites.js";
import { GAME_DATA_ID, type WebGame } from "./page.js";
import { deleteBrowserSave, openBrowserSave } from "./save-idb.js";
import { xtermTerminal } from "./terminal.js";

const KEY_STORE = "oneblock:anthropic-api-key";
const MODEL_STORE = "oneblock:model";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const stored = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null): void => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Sets the status bar: some text, then buttons. */
function bar(text: string, actions: Record<string, () => void> = {}): void {
  const el = $("#bar");
  el.replaceChildren();
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  for (const [label, run] of Object.entries(actions)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = run;
    el.append(" · ", b);
  }
}

interface Credentials {
  key: string;
  model: string;
}

/** Asks for the API key (and model), checking it against the API before play. */
function askForKey(error?: string): Promise<Credentials> {
  const setup = $("#setup");
  const form = setup.querySelector("form")!;
  const fields = form.elements as unknown as {
    key: HTMLInputElement;
    model: HTMLInputElement;
    remember: HTMLInputElement;
  };
  const shown = form.querySelector(".error")!;
  const button = form.querySelector("button")!;
  fields.key.value = stored.get(KEY_STORE) ?? "";
  fields.model.value = stored.get(MODEL_STORE) ?? DEFAULT_MODEL;
  fields.remember.checked = stored.get(KEY_STORE) !== null;
  shown.textContent = error ?? "";
  setup.hidden = false;
  fields.key.focus();
  return new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const key = fields.key.value.trim();
      const model = fields.model.value.trim() || DEFAULT_MODEL;
      button.disabled = true;
      shown.textContent = "Checking the key…";
      const problem = await check({ key, model });
      if (problem) {
        shown.textContent = problem;
        button.disabled = false;
        return;
      }
      stored.set(KEY_STORE, fields.remember.checked ? key : null);
      stored.set(MODEL_STORE, model === DEFAULT_MODEL ? null : model);
      button.disabled = false;
      setup.hidden = true;
      resolve({ key, model });
    };
  });
}

const client = (apiKey: string) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

/** What is wrong with a key and model, if anything (one free API call). */
async function check({ key, model }: Credentials): Promise<string | undefined> {
  try {
    await client(key).models.retrieve(model);
    return undefined;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return "The API didn't accept that key.";
    if (err instanceof Anthropic.NotFoundError) return `The API doesn't know the model '${model}'.`;
    return `Couldn't reach the API: ${message(err)}`;
  }
}

async function main(): Promise<void> {
  const data = JSON.parse($(`#${GAME_DATA_ID}`).textContent ?? "{}") as WebGame;
  const { payload } = data;
  const saveId = payload.game.id;
  const sprites =
    data.sprites &&
    SpriteSet.fromManifest(data.sprites.manifest, (file) => {
      const b64 = data.sprites!.files[file];
      if (!b64) throw new Error(`sprite file ${file} is missing from the build`);
      return bytes(b64);
    });

  const newGame = async () => {
    if (!confirm(`Start ${payload.game.title} again? The game saved in this browser will be lost.`)) return;
    await deleteBrowserSave(saveId);
    location.reload();
  };
  const changeKey = () => {
    stored.set(KEY_STORE, null);
    location.reload();
  };

  // One tab at a time on a save: two would write over each other.
  const locks = navigator.locks;
  const run = async (): Promise<void> => {
    const key = stored.get(KEY_STORE);
    let creds: Credentials | undefined = key ? { key, model: stored.get(MODEL_STORE) ?? DEFAULT_MODEL } : undefined;
    if (creds) bar("Checking the API key…");
    const problem = creds && (await check(creds));
    if (!creds || problem) {
      bar("", { "new game": newGame });
      creds = await askForKey(problem);
    }
    await play(creds);
  };

  const play = async ({ key, model }: Credentials) => {
    const term = new Terminal({
      fontFamily: 'Menlo, "DejaVu Sans Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 15,
      theme: { background: "#08080a" },
      allowProposedApi: true,
      scrollback: 0,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ImageAddon({ sixelSupport: false, iipSupport: true, storageLimit: 64 }));
    term.open($("#term"));
    fit.fit();
    addEventListener("resize", () => fit.fit());
    term.focus();

    const { store, resuming } = await openBrowserSave(saveId, (err) => bar(`Saving failed: ${message(err)}`));
    const provider = new AnthropicApiProvider({ client: client(key), model });
    const game = startGame(payload, store, provider, { resuming });
    bar(`${resuming ? "Resumed" : "New game"} · ${model} · saved in this browser`, {
      "new game": newGame,
      "change API key": changeKey,
    });
    try {
      await runTui({
        session: game.session,
        title: payload.game.title,
        banner: `${payload.game.title} (model: ${model}; ${resuming ? "resumed" : "new game"}; press ? for keys)`,
        flush: game.flush,
        graphics: sprites ? "iip" : "none",
        truecolor: true,
        terminal: xtermTerminal(term),
        ...(sprites ? { sprites } : {}),
      });
    } finally {
      game.close();
    }
    term.write("\x1b[0m\x1b[2J\x1b[HThe game is saved. Reload the page to carry on.\r\n");
    bar("Game saved", { "carry on": () => location.reload(), "new game": newGame });
  };

  if (!locks) return run();
  await locks.request(`oneblock:${saveId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      bar(`${payload.game.title} is open in another tab. Close it, then reload this one.`, {
        reload: () => location.reload(),
      });
      return;
    }
    await run();
  });
}

main().catch((err) => {
  console.error(err);
  bar(`Couldn't start the game: ${message(err)}`);
});
