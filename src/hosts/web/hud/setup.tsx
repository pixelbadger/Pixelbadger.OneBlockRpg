/**
 * Before play: who plays the characters (a provider from the platform, with the API key and model when it needs
 * them), and which save to carry on, start or delete. Starting checks the provider (an API key is tried against the
 * API) and shows what went wrong here.
 */
import { useEffect, useState } from "preact/hooks";
import { DEFAULT_MODEL } from "../../../engine/llm/anthropic-api.js";
import type { Payload } from "../../../engine/payload/schema.js";
import { type Game, startGame } from "../../../platform/game.js";
import { DEFAULT_SLOT, type SaveInfo } from "../../../platform/index.js";
import { overlaySettings } from "../../../platform/memory.js";
import type { WebPlatform } from "../platform.js";

/**
 * Takes the game's lock for as long as it plays, so two tabs never write one save. Resolves to its release, or
 * undefined when another tab holds it.
 */
function lockGame(gameId: string): Promise<(() => void) | undefined> {
  const locks = navigator.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    void locks.request(`oneblock:${gameId}`, { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(undefined);
      return new Promise<void>((release) => resolve(release));
    });
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The first slot name not in use: `main`, then `slot-2`, `slot-3`… */
function freeSlot(saves: SaveInfo[]): string {
  const used = new Set(saves.map((s) => s.slot));
  if (!used.has(DEFAULT_SLOT)) return DEFAULT_SLOT;
  let n = 2;
  while (used.has(`slot-${n}`)) n++;
  return `slot-${n}`;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Setup({
  payload,
  platform,
  notice,
  onStart,
}: {
  payload: Payload;
  platform: WebPlatform;
  /** Something to tell the player (why the last game stopped, another tab…). */
  notice?: string;
  /** `release` lets go of the game's lock when play stops. */
  onStart: (game: Game, label: string, release: () => void) => void;
}) {
  const { settings } = platform;
  const choices = platform.providers.available();
  const [provider, setProvider] = useState(
    choices.find((c) => c.id === settings.get("provider"))?.id ?? choices[0]!.id,
  );
  const [apiKey, setApiKey] = useState(settings.get("anthropicApiKey") ?? "");
  const [model, setModel] = useState(settings.get("model") ?? DEFAULT_MODEL);
  const [remember, setRemember] = useState(settings.get("anthropicApiKey") !== undefined);
  const [saves, setSaves] = useState<SaveInfo[] | undefined>(undefined);
  const [error, setError] = useState(notice ?? "");
  const [busy, setBusy] = useState(false);
  const gameId = payload.game.id;
  const choice = choices.find((c) => c.id === provider)!;
  const needsKey = choice.needs.includes("anthropicApiKey");

  const refresh = () =>
    platform.saves.list(gameId).then(setSaves, (err) => {
      setSaves([]);
      setError(`Couldn't read the saves in this browser: ${message(err)}`);
    });
  useEffect(() => void refresh(), []);

  const start = async (slot: string) => {
    void platform.audio.resume();
    const key = apiKey.trim();
    const chosenModel = model.trim() || DEFAULT_MODEL;
    if (needsKey && !key) {
      setError("Enter an Anthropic API key to play.");
      return;
    }
    setBusy(true);
    const release = await lockGame(gameId);
    if (!release) {
      setError(`${payload.game.title} is open in another tab. Close it there, then try again.`);
      setBusy(false);
      return;
    }
    setError(needsKey ? "Checking the key…" : "");
    try {
      const fixed = needsKey ? { anthropicApiKey: key, model: chosenModel } : {};
      const game = await startGame(
        payload,
        { ...platform, settings: overlaySettings(settings, fixed) },
        {
          slot,
          providerId: provider,
        },
      );
      settings.set("provider", provider);
      if (needsKey) {
        settings.set("anthropicApiKey", remember ? key : undefined);
        settings.set("model", chosenModel === DEFAULT_MODEL ? undefined : chosenModel);
      }
      onStart(game, needsKey ? `${choice.label}, ${chosenModel}` : choice.label, release);
    } catch (err) {
      release();
      setError(message(err));
      setBusy(false);
    }
  };

  const remove = async (slot: string) => {
    if (!confirm(`Delete the saved game '${slot}'? It can't be brought back.`)) return;
    setBusy(true);
    try {
      await platform.saves.delete(gameId, slot);
      await refresh();
    } catch (err) {
      setError(message(err));
    }
    setBusy(false);
  };

  return (
    <div class="setup">
      <form class="panel" onSubmit={(e) => e.preventDefault()}>
        <h1 class="style-title">{payload.game.title}</h1>
        <fieldset disabled={busy}>
          <legend class="style-heading">Who plays the characters</legend>
          {choices.map((c) => (
            <label key={c.id}>
              <input
                type="radio"
                name="provider"
                value={c.id}
                checked={c.id === provider}
                onChange={() => setProvider(c.id)}
              />
              <span class="style-plain">{c.label}</span>
            </label>
          ))}
          {needsKey && (
            <>
              <p class="style-muted">
                Claude plays the characters through the Anthropic API, called from this page with your key. The key goes
                only to api.anthropic.com, and the API bills your account for what you play.{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">
                  Get a key
                </a>
                .
              </p>
              <label class="field">
                <span class="style-plain">Anthropic API key</span>
                <input
                  type="password"
                  name="key"
                  autocomplete="off"
                  spellcheck={false}
                  value={apiKey}
                  onInput={(e) => setApiKey(e.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="style-plain">Model</span>
                <input
                  type="text"
                  name="model"
                  autocomplete="off"
                  spellcheck={false}
                  value={model}
                  onInput={(e) => setModel(e.currentTarget.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  name="remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.currentTarget.checked)}
                />
                <span class="style-plain">Remember the key in this browser</span>
              </label>
            </>
          )}
        </fieldset>
        <fieldset disabled={busy || !saves}>
          <legend class="style-heading">Saved games</legend>
          {saves?.length ? (
            <ul class="slots">
              {saves.map((s) => (
                <li key={s.slot}>
                  <span class="what">
                    <span class="style-strong">{s.slot}</span>
                    <span class="style-muted"> · {when(s.updated)}</span>
                  </span>
                  <button type="button" class="button primary" onClick={() => start(s.slot)}>
                    Continue
                  </button>
                  <button type="button" class="button" onClick={() => remove(s.slot)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class="style-muted">{saves ? "None yet. Games save in this browser as you play." : "Looking…"}</p>
          )}
          <div class="actions">
            <button
              type="button"
              class={saves?.length ? "button" : "button primary"}
              onClick={() => start(freeSlot(saves ?? []))}
            >
              New game
            </button>
          </div>
        </fieldset>
        {error && (
          <p class={busy ? "style-muted" : "style-danger"} role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
