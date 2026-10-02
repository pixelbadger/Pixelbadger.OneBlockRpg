#!/usr/bin/env node
/**
 * The `oneblock` CLI (§3.10): validate, schema, play and replay. src/cli is the only frontend adapter (§3.1).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { World } from "../core/world.js";
import { AnthropicApiProvider } from "../llm/anthropic-api.js";
import { ClaudeSubscriptionProvider } from "../llm/claude-subscription.js";
import type { LlmProvider } from "../llm/provider.js";
import { RecordingProvider, ReplayProvider } from "../llm/scripted.js";
import { offlineProvider } from "../narrative/offline.js";
import { formatIssue } from "../payload/issues.js";
import { payloadJsonSchema } from "../payload/json-schema.js";
import type { Payload } from "../payload/schema.js";
import { validatePayloadAt } from "../payload/validate.js";
import { SaveStore } from "../session/save.js";
import { Session } from "../session/session.js";
import { render } from "./render.js";
import { runTui } from "./tui/app.js";

const USAGE = `oneblock — a one block CRPG engine

Usage:
  oneblock validate <payload> [--json]            Check a payload: schema, references, playability (§7.7)
  oneblock schema [--out <file>]                  Print (or write) the payload JSON Schema
  oneblock play <payload> [options]               Play
      --save <file>        Save database (default: <game id>.db); resumes if it exists
      --new                Start over, replacing the save
      --seed <seed>        PRNG seed for a new game
      --provider <id>      claude-subscription (default) | anthropic-api | offline
      --model <model>      Model override for the provider
      --tui                Full screen, in the manner of Ultima V: each room drawn as animated tiles,
                           keys only (press ? in game for the keys)
      --no-emoji           With --tui: draw with plain characters instead of emoji
      --no-color
  oneblock replay <payload> <save>                Replay a save's inputs against its recorded LLM responses
                                                   and check the result is identical (§3.8)
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

function makeProvider(id: string, model?: string): LlmProvider {
  switch (id) {
    case "claude-subscription":
      return new ClaudeSubscriptionProvider(model ? { model } : {});
    case "anthropic-api":
      return new AnthropicApiProvider(model ? { model } : {});
    case "offline":
    case "scripted":
      return offlineProvider();
    default:
      throw new Error(`unknown provider '${id}' (claude-subscription | anthropic-api | offline)`);
  }
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
      save: { type: "string" },
      new: { type: "boolean" },
      seed: { type: "string" },
      provider: { type: "string", default: "claude-subscription" },
      model: { type: "string" },
      "no-color": { type: "boolean" },
      tui: { type: "boolean" },
      "no-emoji": { type: "boolean" },
    },
  });
  const path = positionals[0];
  if (!path) {
    console.error(USAGE);
    return 2;
  }
  const payload = loadPayload(path, true);
  const savePath = values.save ?? `${payload.game.id}.db`;
  if (values.new) rmSync(savePath, { force: true });
  const resuming = SaveStore.exists(savePath);
  const store = await SaveStore.open(savePath);
  const inner = makeProvider(values.provider!, values.model);
  const provider = new RecordingProvider(inner, (c, req) => store.recordExchange(c, req));

  let w: World;
  if (resuming) {
    w = store.load(payload);
  } else {
    // The seed is the only outside input to a new world; everything after it is deterministic (§3.8).
    w = World.create(payload, values.seed ?? `${payload.game.id}-${Date.now()}`);
    store.init(payload, w, inner.id);
  }
  store.attach(w);
  const session = new Session(w, {
    provider,
    onUsage: (u) => store.recordUsage(u),
    onInput: (i) => store.recordInput(i),
  });
  if (values.tui) {
    try {
      await runTui({
        session,
        title: payload.game.title,
        banner: `${payload.game.title} (provider: ${inner.id}; save: ${savePath}${resuming ? ", resumed" : ""}; type help for commands)`,
        flush: () => store.flush(w),
        emoji: !values["no-emoji"] && process.env.ONEBLOCK_EMOJI !== "0",
      });
    } finally {
      store.flush(w);
      store.close();
    }
    return 0;
  }
  const color = !values["no-color"] && process.stdout.isTTY;
  const print = (text: string) => text && console.log(text);
  console.log(color ? `\x1b[1m${payload.game.title}\x1b[0m` : payload.game.title);
  console.log(`(provider: ${inner.id}; save: ${savePath}${resuming ? ", resumed" : ""}; type help for commands)`);
  print(render(session.start().views, color));
  store.flush(w);

  const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
  const prompt = () => process.stdout.write(color ? "\x1b[36m> \x1b[0m" : "> ");
  try {
    prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (!process.stdin.isTTY && text) console.log(text);
      if (!text) {
        prompt();
        continue;
      }
      if (["quit", "exit", "q"].includes(text.toLowerCase())) break;
      if (text.toLowerCase() === "save") {
        store.flush(w);
        console.log("Saved. (The game saves after every turn.)");
      } else if (text.toLowerCase() === "usage") {
        console.log(JSON.stringify(store.usageByPurpose(), null, 2));
      } else {
        const out = await session.handle({ type: "command", text });
        store.flush(w);
        print(render(out.views, color));
      }
      if (session.mode === "ended") break;
      prompt();
    }
  } finally {
    rl.close();
    store.flush(w);
    store.close();
  }
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
  const store = await SaveStore.open(savePath);
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
