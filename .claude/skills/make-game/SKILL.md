---
name: make-game
description: Build a one block game payload (YAML) from a user's story brief, then validate it and write a playthrough test. Use when the user says "make me a game from this story", gives a story brief or plot to turn into a playable block, or asks to create, extend or fix a payload under examples/.
---

# Make a game from a story brief

You are turning a human's story brief into a game payload for this engine (spec §7). The payload is data only:
YAML validated against `schema/payload.schema.json`. Never add engine code to make a story work. If an effect is
genuinely missing, stop and tell the user what the engine would need.

## Before you start

1. Read `docs/authoring-guide.md` in full. It is the method, the conventions and the gotchas.
2. Read the brief. If the user pasted it rather than pointing at a file, save it as `examples/<game-id>/brief.md`
   using the §7.2 sections (premise & tone, general plot, characters, relationships & tensions, trigger points,
   set pieces, endings).
3. Skim the worked example `examples/the-pier/` (brief and payload) to see the shape of a finished game.
4. If the brief leaves something **decisive** open, such as how it ends, whether there is a deadline, or whether
   ghosts can talk, ask the user before building. Fill smaller gaps yourself in the brief's tone, and list what you
   chose in your final report.

## Build

1. Write the plan from guide section 3: rooms (8–16), cast, flags, the discovery chain, set pieces, endings.
   Sketch each room's floor plan as you go: every room needs a tile `map` (guide: "Drawing the rooms").
2. Write the files in the order `game.yaml`, `story.yaml` (synopsis, beliefs, endings), `rooms/`, `characters/`,
   `behaviours/routines.yaml`, `objects/`, `hooks.yaml`, `conversations/`, `story.yaml` triggers, `set_pieces/`,
   `combat_text.yaml`.
3. Make sure every piece of the critical path has an **authored** route as well as any hook (guide: "Never depend
   on the LLM for the critical path").

## Check, and iterate until clean

```sh
pnpm oneblock validate examples/<game-id>          # must be ok with zero warnings
pnpm oneblock play examples/<game-id> --provider offline --new   # walk the critical path by hand
pnpm oneblock play examples/<game-id> --provider offline --new --tui   # and look at every room drawn
```

Then write `tests/<game-id>.test.ts` following `tests/pier.test.ts`: validation with no issues, one test per ending
(scripted provider for the hook routes, offline provider for the authored routes), and one test for each decision
the brief marks as decided. Run `pnpm test` and `pnpm lint`.

## Report

Tell the user:

- the payload's location, and how to play it (`node bin/oneblock.js play examples/<game-id>`, after `pnpm build`)
- a short map of the block, the cast and the plot's flags
- everything you decided where the brief was silent
- anything in the brief you couldn't express, and what the engine would need for it

Follow the repo's git conventions in `CLAUDE.md` if asked to commit (e.g. `feat(examples): add <title> payload`).
