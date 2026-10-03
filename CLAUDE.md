# Pixelbadger.OneBlockRpg

## Synopsis

This repo implements the concept of a **"one block CRPG"** as a **TypeScript text adventure engine**.
The one block RPG is Warren Spector's long-standing design ideal: a role-playing game set in a single
city block. Every building, apartment, shop, object and resident is simulated in depth: "an inch wide
and a mile deep". The engine uses **LLMs** to provide dynamic characters and plotlines on top of a
deterministic world simulation. **Claude, accessed through a Claude subscription,** is the default
backend. The LLM layer sits behind a **pluggable provider interface** so that other backends
(the Anthropic API with a key, other vendors, local models or a scripted test double) can be swapped in.

- Implementation baseline: [`README.md`](README.md) and the specification in [`docs/spec/`](docs/spec/index.html).
- Core rule: **a simple simulation grounds the world; LLM-driven characters construct its social reality.**
  The LLM runs only in conversations, set pieces (director), payload-declared callouts and nightly day summaries. It never mutates world state
  directly. It reaches state only through payload-declared hooks and shared-vocabulary actions, which the engine validates and applies.
- **SPECIAL is the only RPG system.** Any mechanical requirement is expressed in SPECIAL terms ([`docs/spec/05-mechanics.html`](docs/spec/05-mechanics.html)).
- Stories are **user-authored** and delivered as a **game payload** (YAML/JSON plus schema, no code) that a coding
  agent builds from the user's story brief. See [`docs/spec/07-game-payload.html`](docs/spec/07-game-payload.html).

# Version control: git

This repo uses plain **git**. The upstream is GitHub and is the source of truth.

## Hard rules

1. **Never push to `main`** or force-push any branch you did not create in this task. Work on a feature branch.
2. **Never rewrite published history** on a shared branch: no rebase, amend or force-push after others may have
   fetched it. Use a merge commit to bring in `main`.
3. **Never delete remote branches** unless explicitly told to.
4. **Never run anything interactive.** Always pass `-m` for commit messages. No `git rebase -i`, `git add -i` or
   `git add -p`, and nothing that opens an editor (set `GIT_EDITOR=false` if in doubt).
5. Don't commit secrets, build outputs or large binaries. The exception is a payload's cut sprite art
   (`examples/*/assets/**/*.png` and `sprites.json`, small pixel-art PNGs written by `pnpm art`); never commit the raw
   generated images (`assets/.raw/`, git-ignored). Check `.gitignore` before adding new kinds of files, and
   stage paths explicitly rather than with `git add -A` when unsure.
6. If something goes wrong, prefer `git revert` or `git reflog` recovery over destructive fixes, and tell the human
   what you did.

## Task workflow

1. **Start**: `git fetch origin`, then branch from the latest `origin/main` (or continue the branch you were given).
2. **Work**: one logical change per commit, described with a Conventional Commit message (below).
3. **Before pushing**: confirm `git log origin/main..HEAD` is the stack you intend. Merge `origin/main` in if it moved,
   then run `pnpm test` and `pnpm lint`.
4. **Push and open a PR**: `git push -u origin <branch>`, then open a PR against `main` using the template below.
5. **Report**: the branch, commits and PR URL, and anything you were unsure about or skipped.

## Responding to review

**Append, don't amend**, while a PR is under review, so reviewers can see what changed. Push follow-up commits
(e.g. `fix: address review on <what>`) to the same branch.

## Project conventions

- Tooling: Node 22+, TypeScript strict/ESM, **pnpm**, **vitest**, **biome** ([`docs/spec/03-architecture.html`](docs/spec/03-architecture.html) §3.10).
  - Test: `pnpm test` · Lint/format check: `pnpm lint` · Format: `pnpm format`
- Commit message style: **[Conventional Commits](https://www.conventionalcommits.org/)**: `<type>(<optional scope>): <summary>`,
  imperative mood and lower case, e.g. `feat(core): add throw action`, `docs(spec): resolve Q19`. Types: `feat`, `fix`,
  `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`. Use `!` or a `BREAKING CHANGE:` footer for payload-schema
  or save-format breaks.
- PR title: a Conventional Commit summary. PR description:
  - **Summary**: what changed and why
  - **Spec**: sections or open questions affected, if any
  - **Testing**: what was run
- Trailers: add `Co-authored-by: <HUMAN NAME> <EMAIL>` when a human directed the work.
