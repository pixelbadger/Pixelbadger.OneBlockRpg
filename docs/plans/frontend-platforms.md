# Frontend platforms: decisions and layering plan

Status: agreed, in progress on `claude/frontend-platform-decoupling-xc54ta`.

Decided after review:

- **Fully graphical.** The TUI and the readline `play` go. Play is the web page or the native window only. The
  `oneblock` command stays as authoring and dev tooling (`validate`, `schema`, `replay`), and `oneblock play` opens
  the native window.
- **HTML text panels on the web**, a canvas widget kit natively, but **one visual style everywhere**: a single
  monospace font (JetBrains Mono, from `@fontsource/jetbrains-mono`, loaded by CSS on the web and registered with
  Skia natively) and one set of theme tokens (`src/client/theme.ts`: colours, sizes, spacing, semantic text styles)
  that both hosts render from.
- **Native runs from a checkout** (`pnpm oneblock play <payload>`); no packaging.

## Where we are

The engine side is in good shape: the session speaks only the UI port (`src/session/port.ts`: view models out,
intents in), and saves already sit behind `SaveBackend`. The frontends are what drifted:

- The full-screen TUI (`src/cli/tui`) grew a cell canvas, SGR colour, a software rasteriser, a PNG encoder and the
  kitty/iTerm2 image protocols in order to draw pictures inside a terminal.
- The browser build runs that TUI inside **xterm.js**, decoding terminal key bytes back into Node keypress events.
  So the web page is a terminal emulator showing escape codes that describe pictures. That is the off-piste bit.

Storage on the web is **not** in-memory only: `src/cli/web/save-idb.ts` keeps each save in IndexedDB. It reads the
whole save into a memory mirror when the game opens and writes every change behind it to IndexedDB, a transaction
per microtask batch. The mirror exists because `SaveBackend` is synchronous (the engine writes mid-turn). That design
is sound and stays; what changes is where it lives (the web platform, not `src/cli`) and that it gets a sibling for
settings and a save list.

## Decisions

### Web: browser-native, no terminal

| Concern | Decision |
|---|---|
| Scene | One `<canvas>`, Canvas 2D, `imageSmoothingEnabled = false`, sprites as `ImageBitmap`s. |
| Text UI (log, conversation, menus, sheets, journal, introduction, setup) | **DOM**, rendered with **Preact** (≈4 KB, JSX through esbuild with no extra tooling). Real text: selectable, scrollable, resizable, readable by screen readers, works with touch. |
| Input | Keyboard (same keymap as now), plus pointer: click a tile to walk or target, click menu rows and options. |
| Saves | IndexedDB (the existing write-behind backend), plus a flush on `pagehide`/`visibilitychange`. |
| Settings (API key, model, volume) | `localStorage`, as now, behind the settings interface. |
| Model provider | `anthropic-api` with the player's own key (unchanged). |
| Audio | Web Audio. Stub now. |
| Build | esbuild static site (`pnpm web`, as now). xterm.js and its addons are removed. |

Why Preact rather than plain DOM: the HUD is a dozen stateful panels re-rendered from one model every turn, which is
exactly what a tiny VDOM is for; plain DOM would grow its own ad-hoc diffing. Why not React: size, and nothing here
needs it. Why not draw the HUD on the canvas too: this is a text game first, and long LLM prose wants the browser's
text layout, scrolling and accessibility.

### Native (Linux only): SDL, still Node

| Concern | Decision |
|---|---|
| Window, input, audio device | **`@kmamal/sdl`** (SDL2 bindings for Node, prebuilt binaries for Linux x64/arm64). |
| Drawing | **`@napi-rs/canvas`** (Skia, prebuilt, no system deps): a Canvas 2D implementation in Node. Each frame is drawn to it and handed to the SDL window as an RGBA buffer. |
| Scene | The **same** Canvas 2D scene renderer as the web. |
| Text UI | A small canvas widget kit of our own (panels, wrapped text, scrollable log, list menus, overlays), drawn with Skia's text shaping and a bundled font. Same presentation model as the web DOM HUD; different widgets. |
| Saves | SQLite (`node:sqlite`, as now), in `$XDG_DATA_HOME/oneblock/saves/<game>/<slot>.db`. |
| Settings | JSON in `$XDG_CONFIG_HOME/oneblock/settings.json`. |
| Model provider | `claude-subscription` (default) or `anthropic-api`. Staying on Node is what keeps the Claude Agent SDK, and so the subscription provider, available natively. |
| Audio | SDL audio queue. Stub now. |
| Launch | `oneblock play <payload>` opens a window. |

Spike (done while writing this): `@kmamal/sdl` 0.11 and `@napi-rs/canvas` 1.0 install from prebuilts, render text
into a window, and run headless with `SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy`, so the native host can be
smoke-tested in CI without a display.

### Why not one off-the-shelf UI toolkit for both

Checked and rejected:

- **Electron / Tauri / NW.js**: a browser in a box, i.e. the web frontend again. Fine as a packaging option later,
  but it is not the SDL-style native client asked for.
- **NodeGui (Qt)**: Linux works, but it is a widget toolkit for forms rather than a game surface, and it is thinly
  maintained.
- **Dear ImGui bindings for JS** (e.g. jsimgui): WebGL/browser oriented; not a good fit for a Node+SDL host, and an
  immediate-mode debug-tool look.
- **React Native / Flutter / Qt / Godot**: no first-class Linux desktop (RN), or not TypeScript, which would split the
  engine from its frontends.

So the cross-platform part is **our own decoupling**, not a toolkit: the presentation model, input mapping and scene
renderer are shared; only the text widgets and the platform services differ. Canvas 2D is the common drawing API,
supplied by the browser on the web and by Skia natively.

### The terminal frontends

- Both go (decided): the readline play loop and the TUI (`--tui`, cell canvas, kitty/iTerm2 images). The `oneblock`
  command keeps `validate`, `schema` and `replay`.

## Layering

```
 hosts            cli (readline, commands)     web (DOM + canvas)          native (SDL + Skia)
 ─────────────────────────────────────────────────────────────────────────────────────────────
 client           presentation model · controller · keymap · timeline · scene renderer (Canvas 2D)
 (shared UI)      log/markdown → styled paragraphs (semantic styles, not SGR)
 ─────────────────────────────────────────────────────────────────────────────────────────────
 platform         interfaces: Platform, SaveStorage, Settings, AudioOut, Assets, ProviderFactory
 (contracts)      impls live with each host: memory (tests), node (sqlite, XDG), web (IDB, localStorage)
 ─────────────────────────────────────────────────────────────────────────────────────────────
 engine           payload · mechanics · core · narrative · llm (provider interface) · session (UI port, SaveStore)
```

Rules (enforced, not just documented):

1. **engine** imports nothing above it, and nothing from Node or the DOM. Exceptions move out: `save-sqlite.ts` and
   `llm/claude-subscription.ts` go to the node host side; `llm/anthropic-api.ts` stays (it runs in both).
2. **platform** is types plus the memory implementations. No Node, no DOM.
3. **client** imports engine types and platform interfaces. No Node, no DOM: it draws to a `Canvas2D`-shaped
   interface (the subset of `CanvasRenderingContext2D` we use) and receives abstract input events.
4. **hosts** wire it together and are the only place that touches Node, the DOM, SDL or Skia.

Enforcement: one tsconfig per layer with `lib: ["ES2023"]` and `types: []` for engine/platform/client (so a stray
`document` or `node:fs` fails to compile), plus biome `noRestrictedImports` overrides per directory. Workspace
packages (`@oneblock/engine`, `client`, `web`, `native`, `cli`) are the stronger version; the native package then
keeps `@kmamal/sdl` and Skia out of the web build and out of CI jobs that don't need them. Recommendation: directories
and tsconfigs in phase 0, packages when the native host lands (phase 4).

Target tree:

```
src/
  engine/{payload,mechanics,core,narrative,llm,session}   (today's top-level dirs, moved)
  platform/      index.ts (interfaces) · memory.ts
  client/        model.ts (Ui + absorb) · controller.ts · keymap.ts · timeline.ts · scene.ts · art.ts (tile looks)
                 text.ts (paragraphs, markdown, semantic styles) · sprites.ts (manifest, frame timing)
  hosts/
    cli/         main.ts · readline adapter · render.ts · (tui/ until removed)
    node/        sqlite storage · XDG settings · fs assets · provider factory (shared by cli and native)
    web/         main.tsx · hud/*.tsx · canvas surface · idb storage · local settings · webaudio stub
    native/      main.ts · sdl loop · skia surface · widgets/* · sdl audio stub
```

## Platform interfaces (sketch)

```ts
/** Everything a host supplies; the client and session never reach past this. */
export interface Platform {
  readonly id: "web" | "native" | "cli" | "test";
  saves: SaveStorage;
  settings: Settings;
  audio: AudioOut;
  assets: Assets;
  providers: ProviderFactory;
}

/** Save slots for a game. A slot opens to the engine's synchronous SaveBackend. */
export interface SaveStorage {
  list(gameId: string): Promise<SaveInfo[]>;            // slot, updated, day, clock, payload version
  open(gameId: string, slot: string): Promise<{ backend: SaveBackend; existed: boolean }>;
  delete(gameId: string, slot: string): Promise<void>;
  /** Resolves when every write so far is durable (web: IDB transactions done; native: no-op). */
  settled(): Promise<void>;
}

export interface Settings {
  get(key: SettingKey): string | undefined;
  set(key: SettingKey, value: string | undefined): void;
}
export type SettingKey = "provider" | "model" | "anthropicApiKey" | "volume.master" | "volume.sfx" | "volume.ambience";

/** Payload-shipped files (sprites now, sounds later). Web: embedded; native/cli: read from the payload dir. */
export interface Assets {
  text(path: string): Promise<string | undefined>;
  bytes(path: string): Promise<Uint8Array | undefined>;
}

export interface ProviderFactory {
  available(): ProviderChoice[];                         // web: anthropic-api, offline; native: + claude-subscription
  create(choice: ProviderChoice, settings: Settings): Promise<LlmProvider>;
}

/**
 * TODO(audio): platform-specific, stubbed until there is sound to play. Web: Web Audio (AudioContext, decoded
 * buffers, gain nodes per bus). Native: SDL audio device fed decoded PCM (needs an OGG/WAV decoder in JS or WASM).
 * Every host ships `silentAudio` until then.
 */
export interface AudioOut {
  /** Load a payload's sound manifest (assets/sounds.json, schema TBD). */
  load(manifest: SoundManifest, assets: Assets): Promise<void>;
  /** A one-shot cue: a hit, a door, a footstep. */
  cue(id: string, o?: { volume?: number; pan?: number }): void;
  /** Looping beds keyed by scene: room tags, weather, time of day. Replaces the current set with a crossfade. */
  ambience(ids: string[]): void;
  volume(bus: "master" | "sfx" | "ambience", v: number): void;
  /** Browsers start audio only after a user gesture. */
  resume(): Promise<void>;
  dispose(): void;
}
```

Audio cues come from what the port already emits: `fx` (walk/hit/miss/down/killed), narration kinds, the scene's
tags and minute, and heard sounds (§4.11 `sound.ts` events, if we surface them as a view). Mapping those to cue ids
belongs in `client/`, so both hosts get the same sound design. The payload side (a `sounds.json` beside
`sprites.json`, and `look.sound` hints) is a separate schema change, left as a TODO.

## Phases

Each phase is one PR, keeps `pnpm test` and `pnpm lint` green, and leaves every existing way to play working until
its replacement lands.

0. **Boundaries.** Move dirs into `engine/`, `hosts/cli`; move `save-sqlite.ts` and `claude-subscription.ts` to
   `hosts/node`; per-layer tsconfigs and biome import rules. No behaviour change. Spec §3.1/§3.10 updated with this
   plan's decisions.
1. **Platform contracts and storage.** `platform/` interfaces, memory implementations, `silentAudio`. Node storage
   (SQLite under XDG, settings file) and web storage (move `save-idb.ts`, add the save list, `pagehide` flush,
   localStorage settings). `openGame`/`startGame` take a `Platform`. The CLI uses it. Tests run against memory and
   fake-indexeddb.
2. **Shared client.** Extract `Ui`, `absorb`, `Controller`, `Timeline` and the tile art from `cli/tui` into
   `client/`. Replace SGR spans with semantic styles (`speaker`, `danger`, `muted`, `heading`…) that each host maps to
   CSS classes, Skia paints or SGR. Input becomes `{ key, mods } | { pointer: tile | menuRow }` instead of Node
   keypress shapes. Write the Canvas 2D scene renderer (port of `raster.ts` drawing logic onto `drawImage`), tested by
   rendering to `@napi-rs/canvas` and checking pixels.
3. **Web host.** Canvas scene and Preact HUD; pointer input; drop xterm.js, `web/terminal.ts` and the iip path. Pages
   workflow unchanged. A Playwright smoke test (start, walk, open a conversation with the offline provider, reload,
   resume).
4. **Native host.** `@kmamal/sdl` + `@napi-rs/canvas`, the canvas widget kit, the frame loop (event pump, redraw on
   change or animation tick). `oneblock play` opens it. Workspace packages split here. Headless smoke test with the
   offscreen driver.
5. **Retire the TUI** once native has parity: delete `cli/tui` (cell canvas, SGR colour, kitty/iip, PNG encoder if
   nothing else needs it), the `--tui` and `--graphics` flags, and update the README.
6. **Audio** (when wanted): payload sound manifest, client cue mapping, Web Audio and SDL implementations.

## Open questions

1. **HUD per platform, or one canvas UI everywhere?** This plan has the DOM HUD on the web and a canvas widget kit
   natively: best of each, two HUD implementations over one model. The alternative is one canvas-drawn UI on both
   (less code, identical look) at the cost of the web's text handling and accessibility.
2. **Delete the TUI** after native parity (phase 5), or keep it as a third frontend?
3. **Packaging native**: running from a checkout (`pnpm oneblock play`) is enough for now; an AppImage or Node SEA
   bundle can come later. Fine to defer?
