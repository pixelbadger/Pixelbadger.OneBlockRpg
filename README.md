# Pixelbadger.OneBlockRpg

A **one block CRPG** built as a TypeScript text adventure engine. It uses LLMs to provide dynamic characters and
plotlines on top of user-authored stories.

> *"An inch wide and a mile deep."* That is Warren Spector's description of his dream game: an RPG set in a single city
> block where every building, apartment, object and resident is simulated in depth.

## The idea

Most open worlds are huge and shallow. The one city block RPG is the opposite. It is a tiny, bounded place where
everything is *something*, and the people in it have their own goals, secrets and routines.

The engine splits the world in two:

- **Ground.** A deliberately simple simulation. Rooms are descriptive, with no dimensions. Objects sit in rooms and have simulable
  properties (mass, velocity, open, locked…). The player, objects and characters all act through one shared set of actions,
  and objects and characters run scripted behaviours.
- **Construct.** Characters are objects with goals, intents, relationships and SPECIAL attributes. In **multiple-choice
  conversations** an LLM voices them, steered by their high-level and conversation-specific goals. They can act mid-conversation:
  walk off, hand something over, throw a punch. What they say can be as
  hyperreal or magically real as the story wants. It only becomes world state through **hooks** the author declares.
- **Set pieces.** For big scenes, the author gives the player a loose objective and an LLM **director** orchestrates the cast.
- **Days are chapters.** When the player sleeps, each character's day is summarised in their own perspective and carried forward.
- **SPECIAL** is the only RPG system. Combat, stealing, persuasion, fatigue and progression all run on SPECIAL-derived numbers and seeded rolls.

Stories are **authored by the user**: plot, characters, relationships and tensions, and trigger points. A coding agent turns
that brief into a **game payload**, which is YAML/JSON validated against a published schema. The payload holds all the flavour text,
behaviours, conversation specs, hooks and triggers. The engine loads and plays it.

## LLM backends

The model layer is a pluggable provider interface. Planned providers:

- **claude-subscription** (default): Claude via your existing Claude subscription or Claude Code login
- **anthropic-api**: the Anthropic Messages API with an API key
- **scripted / replay**: deterministic fakes and recorded sessions for tests and offline development
- others (OpenAI-compatible, local models) can be added behind the same interface

## Specification

The implementation baseline is in [`docs/spec/`](docs/spec/index.html):

1. [Concept & research](docs/spec/01-concept.html): origin, lineage (Looking Glass, Deus Ex, Arkane, Gone Home, Disco Elysium, Generative Agents)
2. [Design pillars](docs/spec/02-pillars.html)
3. [Engine architecture](docs/spec/03-architecture.html)
4. [World model](docs/spec/04-world-model.html)
5. [Mechanics: SPECIAL](docs/spec/05-mechanics.html)
6. [LLM layer](docs/spec/06-llm-layer.html)
7. [Game payload](docs/spec/07-game-payload.html)
8. [Open questions](docs/spec/08-open-questions.html)

## Status

v0.1: the engine implements the spec end to end. The exploration, conversation, combat, set-piece and day loops run
on a deterministic simulation. Conversations, the director, callouts and day summaries run through the provider
interface. Saves are SQLite and replay identically. Sneaking is a stance, combat has pursuit, and Luck nudges seeded
rolls (§5.4, §5.6). Open questions Q30 and Q31 are still open (see §8). Q31 is implemented as its suggested starting
point (`perceived_by: player`): apparitions are seen only by the player, can't be touched, and have no bodies.

## Quick start

```sh
pnpm install
pnpm build
node bin/oneblock.js validate examples/the-pier
node bin/oneblock.js play examples/the-pier                           # The Pier: the first full story
node bin/oneblock.js play examples/carver-street                      # Claude via your Claude Code login
node bin/oneblock.js play examples/carver-street --provider offline   # no model: authored options only
node bin/oneblock.js replay examples/carver-street carver-street.db   # check a save replays identically
```

`play` saves after every turn to `<game id>.db` and resumes it next time (`--new` starts over). Type `help` in game.
During development, `pnpm oneblock <command>` runs the CLI from source.

[`examples/the-pier`](examples/the-pier) is the first full story: a present-day ghost story on a Victorian pier,
built from its [brief](examples/the-pier/brief.md). [`examples/carver-street`](examples/carver-street) is a small
demo block built from the examples in the spec. Both are playthrough fixtures.

## Making your own game

Write a story brief (spec §7.2) and ask Claude Code to "make me a game from this story". The
[`make-game`](.claude/skills/make-game/SKILL.md) skill follows the [authoring guide](docs/authoring-guide.md): it plans
the block, writes the payload, validates it to zero warnings and writes a playthrough test.

## Layout

| Path | What |
|---|---|
| `src/payload` | zod schema (the source of truth), loader, validator and lints (§7) |
| `src/mechanics` | SPECIAL, skills, checks, combat maths, trade, fatigue, progression, seeded PRNG (§5) |
| `src/core` | world state, event log and ops, conditions, effects, actions, behaviours, triggers, combat, clock (§4) |
| `src/llm` | provider interface; `claude-subscription`, `anthropic-api`, scripted, record and replay (§6.9) |
| `src/narrative` | conversations, hooks, director, callouts, day summaries, context builder (§6) |
| `src/session` | the loops, UI port, parser, action menu and SQLite saves (§3) |
| `src/cli` | the readline CLI, the only frontend adapter |
| `schema/payload.schema.json` | the published payload JSON Schema (`pnpm schema` regenerates it) |
| `docs/authoring-guide.md` | how to build a payload from a story brief (§7.9) |
| `.claude/skills/make-game` | the Claude Code skill that wraps the guide |
| `examples/` | The Pier and Carver Street |

## Development

Node 22.13+, TypeScript, pnpm, vitest and biome (spec §3.10). `pnpm test`, `pnpm lint`, `pnpm format`.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/). See [`CLAUDE.md`](CLAUDE.md) for the git workflow.
