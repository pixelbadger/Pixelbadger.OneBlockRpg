# Pixelbadger.OneBlockRpg

A **one block CRPG** built as a TypeScript text adventure engine. It uses LLMs to provide dynamic characters and
plotlines.

> *"An inch wide and a mile deep."* That is Warren Spector's description of his dream game: an RPG set in a single city
> block where every building, apartment, object, utility and resident is simulated in depth.

## The idea

Most open worlds are huge and shallow. The one city block RPG is the opposite. It is a tiny, bounded place where you can do
almost anything you can think of, because everything in it is *something*. Residents have their own routines, relationships, secrets
and goals, and they pursue them whether you're watching or not.

The idea has never fully shipped because it is expensive to simulate, author and keep coherent. This project attacks those costs
like this:

| Cost | Approach |
|---|---|
| Simulation | **Text.** No rendering or physics tax. An object is state plus rules. |
| Authoring | **LLMs voice the residents**, grounded in what each character actually knows. |
| Coherence | **An LLM director** nudges emergent tensions into plot, using only validated actions. |

The core rule: **the simulation is the source of truth. The LLM proposes, and the simulation disposes.** Model output never
mutates world state directly. It is parsed into typed intents and actions that the engine validates and applies.

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
5. [LLM layer](docs/spec/05-llm-layer.html)
6. [Open questions](docs/spec/06-open-questions.html)

## Status

Pre-implementation. The spec is a draft and the open questions are under discussion.

## Development

Tooling is still to be decided (see open question Q13). This repository uses [Jujutsu](https://jj-vcs.github.io/jj/) (`jj`) colocated with
git. See [`CLAUDE.md`](CLAUDE.md) for the version control workflow.
