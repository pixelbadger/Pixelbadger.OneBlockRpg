# Pixelbadger.OneBlockRpg

A **one block CRPG** built as a TypeScript text adventure engine. It uses LLMs to provide dynamic characters and
plotlines on top of user-authored stories.

> *"An inch wide and a mile deep."* That is Warren Spector's description of his dream game: an RPG set in a single city
> block where every building, apartment, object and resident is simulated in depth.

## The idea

Most open worlds are huge and shallow. The one city block RPG is the opposite. It is a tiny, bounded place where
everything is *something*, and the people in it have their own goals, secrets and routines.

The engine splits the world in two:

- **Ground.** A deliberately simple simulation. Rooms are drawn tile maps, like the towns of *Ultima V*: everyone and
  everything stands on a tile, and space answers only "can I step there, reach it, see it, and how far is it". Objects
  have simulable properties (mass, velocity, open, locked…). The player, objects and characters all act through one shared set of actions,
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
on a deterministic simulation. Conversations, the director, callouts, characters weighing what they read and day summaries run through the provider
interface. Saves are SQLite and replay identically. Sneaking is a stance, combat has pursuit, and Luck nudges seeded
rolls (§5.4, §5.6). Every room is a tile map: actions walk to what they need, and fights are fought on the tiles with
movement, reach, range and line of sight (§4.10, Q32). Open questions Q30 and Q31 are still open (see §8). Q31 is implemented as its suggested starting
point (`perceived_by: player`): apparitions are seen only by the player, can't be touched, and have no bodies.

## Quick start

```sh
pnpm install
pnpm oneblock validate examples/the-pier
pnpm oneblock play examples/the-pier                           # The Pier: the first full story, in a window
pnpm oneblock play examples/carver-street --provider offline   # no model: authored options only
pnpm oneblock replay examples/carver-street ~/.local/share/oneblock/saves/carver-street/main.db
```

`play` opens a window (Linux; SDL through `@kmamal/sdl`, drawn with Skia through `@napi-rs/canvas`, both prebuilt).
Characters are played by Claude through your Claude Code login unless `--provider` (or the `provider` setting) says
`anthropic-api` or `offline`; `--model` overrides the model. The game saves after every turn to
`$XDG_DATA_HOME/oneblock/saves/<game id>/<slot>.db` and resumes it next time: `--slot <name>` keeps several games
(default `main`), `--new` starts the slot over and `--seed` fixes a new world. Settings live in
`$XDG_CONFIG_HOME/oneblock/settings.json`: `provider`, `model`, `anthropicApiKey` (or set `ANTHROPIC_API_KEY`) and
`ui.scale` (text and panels, default 1). After `pnpm build`, `node bin/oneblock.js` runs the same commands.

The window is drawn in the manner of *Ultima V*: your room as tiles on the left over the message log, and a column on
the right with the clock, your health, money and level, and the fight or your pack. Water ripples, apparitions
flicker, night falls outdoors and dark rooms are lit only around you; walks play tile by tile and fights show shots,
hits and damage. A payload's sprite art (`<payload>/assets/sprites.json` and PNGs) is drawn where it has it; anything
without a sprite is drawn from its glyph art, so payloads without art still play. Play is keys, or the mouse:

| Keys | |
|---|---|
| Arrows, numpad 1–9 | walk (into a doorway or stairs to leave); in a fight, 1 AP a tile |
| A T L G | attack, talk, look, get |
| U D R H | use, drop, ready, hurl |
| O K P | open/close, lock/unlock, push |
| V F B | give, filch, barter |
| W S Space | wait (or sleep), sneak, pass a minute (end your turn in a fight) |
| Z J N M ? | stats (and spending skill points), journal, introduction, every action here, help |
| PgUp/PgDn (or the wheel), Q | scroll the messages, quit |

Verbs that need a target put up a cursor on the nearest one: arrows move it, Tab cycles, Enter acts, Esc cancels.
Conversations, character creation and trades are menus. Click a tile to step towards it, a person to talk (an enemy,
in a fight, to attack), a thing to get or look at; right-click looks. Menu rows and buttons click too.

**In a browser.** `pnpm web examples/the-pier examples/carver-street` builds a static site in `dist/web` (`--out`
for elsewhere) that runs the whole engine and the same frontend in the page, drawn by xterm.js and its image addon.
Nothing runs on a server: host it anywhere static, or open a game's `index.html` from disk. Characters are played
through the Anthropic API with the player's own key, which the page asks for, checks, and sends only to
api.anthropic.com (and keeps in the browser if asked to). The game saves in the browser's IndexedDB and resumes when
the page comes back; *new game* starts over. One tab plays a game at a time.

The [Pages workflow](.github/workflows/pages.yml) publishes both examples to GitHub Pages on every push to `main`. To
switch it on, set the repository's *Settings → Pages → Source* to *GitHub Actions*.

**Making art.** `pnpm art <payload>` generates a payload's sprites with OpenAI's image API from its art brief
(`assets/art.yaml`: a house style, then one prompt per terrain, exit, effect, character and object), cuts them down to
tiles, and writes `sprites.json`. It needs `OPENAI_API_KEY`; `--dry-run` lists what it would generate, `--only k,k`
and `--force` redo some, and `--reprocess` re-cuts the cached raw images (`assets/.raw/`, git-ignored) without new
calls.

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
| `src/narrative` | conversations, hooks, director, callouts, reading, day summaries, context builder (§6) |
| `src/session` | the loops, UI port, parser, action menu and saves (SQLite on disk) (§3) |
| `src/platform` | the contracts a host supplies (saves, settings, assets, providers, audio), their memory versions, and starting a game on them |
| `src/client` | the presentation shared by every host: model, controller and keymap, scene renderer (Canvas 2D), styled text, theme |
| `src/hosts/node` | the Node platform: SQLite saves and settings under XDG, payload assets from disk, the providers |
| `src/hosts/native` | the native window: SDL events and frame loop, a Skia widget kit and the HUD |
| `src/hosts/cli` | the `oneblock` command: `play` (opens the native window), `validate`, `schema`, `replay` |
| `tools` | development tooling: `art.ts` generates sprite art from a payload's art brief; `web.ts` builds the static site |
| `schema/payload.schema.json` | the published payload JSON Schema (`pnpm schema` regenerates it) |
| `docs/authoring-guide.md` | how to build a payload from a story brief (§7.9) |
| `.claude/skills/make-game` | the Claude Code skill that wraps the guide |
| `examples/` | The Pier and Carver Street |

## Development

Node 22.13+, TypeScript, pnpm, vitest and biome (spec §3.10). `pnpm test`, `pnpm lint`, `pnpm format`.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/). See [`CLAUDE.md`](CLAUDE.md) for the git workflow.
