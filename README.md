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
  conversations** an LLM voices them, steered by their high-level and conversation-specific goals. What they say can be as
  hyperreal or magically real as the story wants. It only becomes world state through **hooks** the author declares.

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
5. [Conversation & LLM](docs/spec/05-llm-layer.html)
6. [Game payload](docs/spec/06-game-payload.html)
7. [Open questions](docs/spec/07-open-questions.html)

## Status

Pre-implementation. The spec is a draft and the open questions are under discussion.

## Development

Tooling is still to be decided (see open question Q13). This repository uses [Jujutsu](https://jj-vcs.github.io/jj/) (`jj`) colocated with
git. See [`CLAUDE.md`](CLAUDE.md) for the version control workflow.
