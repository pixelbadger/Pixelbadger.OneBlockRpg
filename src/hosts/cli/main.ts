#!/usr/bin/env node
/**
 * The `oneblock` command (§3.10): `play` opens the native window (src/hosts/native); `validate`, `schema` and
 * `replay` are authoring and development tools.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { World } from "../../engine/core/world.js";
import { ReplayProvider } from "../../engine/llm/scripted.js";
import { formatIssue } from "../../engine/payload/issues.js";
import { payloadJsonSchema } from "../../engine/payload/json-schema.js";
import type { Payload } from "../../engine/payload/schema.js";
import type { SaveStore } from "../../engine/session/save.js";
import { Session } from "../../engine/session/session.js";
import { DEFAULT_SLOT } from "../../platform/index.js";
import { overlaySettings } from "../../platform/memory.js";
import { sdlAudio } from "../native/audio.js";
import { validatePayloadAt } from "../node/payload.js";
import { nodePlatform } from "../node/platform.js";
import { openSqliteSave } from "../node/save-sqlite.js";
import { FileSettings } from "../node/settings.js";

const USAGE = `oneblock — a one block CRPG engine

Usage:
  oneblock play <payload> [options]               Play, in a window (press ? in game for the keys)
      --provider <id>      claude-subscription (default) | anthropic-api | offline; else the "provider" setting
      --model <model>      Model override for the provider
      --slot <name>        Save slot (default: ${DEFAULT_SLOT}); resumes the game saved there
      --new                Start over in the slot
      --seed <seed>        PRNG seed for a new game
  oneblock validate <payload> [--json]            Check a payload: schema, references, playability (§7.7)
  oneblock schema [--out <file>]                  Print (or write) the payload JSON Schema
  oneblock replay <payload> <save.db>             Replay a save's inputs against its recorded LLM responses
                                                   and check the result is identical (§3.8)

Saves live in $XDG_DATA_HOME/oneblock/saves/<game id>/<slot>.db, settings (provider, model, anthropicApiKey,
ui.scale) in $XDG_CONFIG_HOME/oneblock/settings.json.
`;

function loadPayload(path: string, quiet = false): Payload {
  const r = validatePayloadAt(path);
  const errors = r.issues.filter((i) => i.severity === "error");
  if (!r.payload || errors.length) {
    for (const i of r.issues) console.error(formatIssue(i));
    console.error(`\n${path}: ${errors.length} error(s). Run 'oneblock validate ${path}'.`);
    process.exit(1);
  }
  if (!quiet) for (const i of r.issues) console.error(formatIssue(i));
  return r.payload;
}

async function validate(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  const path = positionals[0];
  if (!path) {
    console.error(USAGE);
    return 2;
  }
  const r = validatePayloadAt(path);
  if (values.json) {
    console.log(JSON.stringify({ ok: r.ok, issues: r.issues }, null, 2));
  } else {
    for (const i of r.issues) console.log(formatIssue(i));
    const errors = r.issues.filter((i) => i.severity === "error").length;
    const warnings = r.issues.length - errors;
    console.log(r.ok ? `ok: ${path} (${warnings} warning(s))` : `failed: ${errors} error(s), ${warnings} warning(s)`);
  }
  return r.ok ? 0 : 1;
}

async function schema(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { out: { type: "string" } } });
  const text = `${JSON.stringify(payloadJsonSchema(), null, 2)}\n`;
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, text);
    console.log(`wrote ${values.out}`);
  } else process.stdout.write(text);
  return 0;
}

async function play(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      new: { type: "boolean" },
      seed: { type: "string" },
      slot: { type: "string", default: DEFAULT_SLOT },
      provider: { type: "string" },
      model: { type: "string" },
    },
  });
  const path = positionals[0];
  if (!path) {
    console.error(USAGE);
    return 2;
  }
  const payload = loadPayload(path, true);
  const settings = new FileSettings();
  const platform = nodePlatform(path, {
    settings: values.model ? overlaySettings(settings, { model: values.model }) : settings,
    audio: sdlAudio(),
  });
  const providerId = values.provider ?? settings.get("provider") ?? platform.providers.available()[0]!.id;
  // SDL loads only to play, so the other commands run where it can't.
  const { runNative } = await import("../native/app.js");
  const app = await runNative({
    payload,
    platform,
    providerId,
    slot: values.slot!,
    title: payload.game.title,
    settingsPath: settings.path,
    ...(values.new ? { fresh: true } : {}),
    ...(values.seed ? { seed: values.seed } : {}),
  });
  await app.closed;
  return 0;
}

async function replay(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const [payloadPath, savePath] = positionals;
  if (!payloadPath || !savePath) {
    console.error(USAGE);
    return 2;
  }
  const payload = loadPayload(payloadPath, true);
  const store = await openSqliteSave(savePath);
  const result = await replaySave(payload, store);
  store.close();
  console.log(
    result.ok
      ? `replay ok: ${result.inputs} inputs, ${result.events} events, identical state`
      : `replay MISMATCH: ${result.detail}`,
  );
  return result.ok ? 0 : 1;
}

export interface ReplayResult {
  ok: boolean;
  inputs: number;
  events: number;
  detail?: string;
}

/** Re-runs a save from its seed, inputs and cassettes and compares the final state (P11). */
export async function replaySave(payload: Payload, store: SaveStore): Promise<ReplayResult> {
  const meta = store.meta();
  const recorded = store.load(payload);
  const w = World.create(payload, meta.seed ?? "");
  const provider = new ReplayProvider(store.cassettes());
  const session = new Session(w, { provider });
  session.start();
  const inputs = store.inputs();
  for (const i of inputs) await session.handle(i);
  const a = JSON.stringify(w.state);
  const b = JSON.stringify(recorded.state);
  if (a === b && w.log.length === recorded.log.length) return { ok: true, inputs: inputs.length, events: w.log.length };
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return {
    ok: false,
    inputs: inputs.length,
    events: w.log.length,
    detail: `events ${w.log.length} vs ${recorded.log.length}; state differs near …${a.slice(Math.max(0, at - 60), at + 60)}… (cassette misses: ${provider.misses})`,
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "validate":
      return validate(rest);
    case "schema":
      return schema(rest);
    case "play":
      return play(rest);
    case "replay":
      return replay(rest);
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

const isMain = process.argv[1] && /(?:main\.(?:ts|js)|oneblock(?:\.js)?)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
