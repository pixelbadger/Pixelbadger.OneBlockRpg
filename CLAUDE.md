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

# Version control: Jujutsu (jj)

This repo uses **Jujutsu** (`jj`) colocated with git. The upstream is a git remote on GitHub and is the
source of truth. You interact with version control **only through `jj`** (and `gh` for PRs).

- Written for jj `0.45`. Run `jj --version` at the start of a session.
- jj's CLI changes between releases. Your training data is mostly git and older jj. **If you are not
  certain a command or flag exists in this version, run `jj help <command>` before using it. Never guess.**
- Agent identity: commits are attributed via `JJ_USER` / `JJ_EMAIL`, set by the harness. Do not
  change them. Do not use `--reset-author` on changes you did not create.

## Hard rules

1. **Never run mutating git commands**: no `git commit`, `checkout`, `switch`, `reset`, `rebase`,
   `stash`, `merge`, `pull`, `push`, `branch`. jj owns the repo state. Read-only git is also
   unnecessary; use the jj equivalent.
2. **Never rewrite immutable commits.** Never pass `--ignore-immutable`.
3. **Never push to, move, or delete `main`/trunk or any bookmark you did not create in this task.**
4. **Never delete remote bookmarks** unless explicitly told to.
5. **Never run anything interactive.** Always pass `-m` for messages. If a command would open an
   editor, diff editor or merge tool, don't run it; find the non-interactive form or stop and ask.
6. If you see **divergent changes** (one change ID, multiple visible commits) or anything else you
   don't understand in `jj log`, **stop and report**. Do not attempt a fix.
7. If something goes wrong, prefer `jj undo` / `jj op restore` over manual repair, and tell the human
   what you undid.

## Non-interactive setup

Expect these to be set by the harness. If they are not, pass the flags explicitly:

- `--no-pager` on commands that produce long output (or `ui.paginate = "never"`)
- `--color=never` when you intend to parse output
- `JJ_EDITOR=false` so any accidental editor invocation fails instead of hanging
- `ui.conflict-marker-style = "git"` so conflicts look like standard git markers

## Mental model (differences from git that will trip you up)

- **The working copy is a commit (`@`).** Every jj command snapshots file changes into it
  automatically. There is no staging area and no `add`.
- **New files are tracked automatically** unless ignored. Before creating secrets, build outputs or
  large binaries, make sure they are in `.gitignore`. If something gets tracked by mistake, add it to
  `.gitignore`, then `jj file untrack <path>`.
- **Change IDs** (letters, e.g. `kxqmzvyt`) are stable across rewrites. **Commit IDs** (hex) change on
  every rewrite. Always refer to changes by change ID.
- **Bookmarks** are jj's branches. They do not move automatically when you create new changes on top.
- **Rewriting a change auto-rebases its descendants.** This is normal and safe.
- **Conflicts are stored in commits** and do not block operations. A change can be "conflicted" and
  you can keep working. It must be resolved before pushing.
- Revsets: `@` working copy, `@-` its parent, `trunk()` main, `trunk()..@` your unmerged work,
  `conflicts()` conflicted changes, `mine()` changes you authored.

## Command map

| Intent | jj |
|---|---|
| Status | `jj st` |
| History | `jj log`, `jj log -r 'trunk()..@'` |
| Diff of working change | `jj diff`, `jj diff --stat`, `jj diff --git` |
| Diff of a specific change | `jj diff -r <change>`, `jj show <change>` |
| Start new work on main | `jj new 'trunk()' -m "<message>"` |
| Set/replace message | `jj describe -m "<message>"` (or `-r <change>`) |
| Finish change, start next on top | `jj commit -m "<message>"` |
| Go back and edit an earlier change | `jj edit <change>` |
| Fold working change into parent | `jj squash -m "<message>"` |
| Fold into a specific change | `jj squash --from <src> --into <dest> -m "<message>"` |
| Throw away a change | `jj abandon <change>` |
| Rebase onto latest main | `jj rebase -b @ -d 'trunk()'` (destination flag name varies by version; check `jj rebase --help`) |
| Fetch | `jj git fetch` |
| Push new change as a PR branch | `jj git push -c <change>` (creates `push-<changeid>` bookmark) |
| Push an existing bookmark | `jj git push -b <bookmark>` |
| Preview a push | add `--dry-run` |
| Move a bookmark | `jj bookmark set <name> -r <change>` |
| What happened / audit trail | `jj op log --limit 20` |
| How a change evolved | `jj evolog -r <change>` |
| Undo last operation | `jj undo` |
| Restore repo to earlier operation | `jj op restore <op-id>` |

**Avoid** (interactive): `jj split` without path arguments, `jj squash -i`, `jj diffedit`,
`jj resolve`, `jj describe` without `-m`. Note that `jj squash` opens an editor when both sides have
descriptions unless you pass `-m`.

## Task workflow

1. **Start**
   - `jj git fetch`
   - `jj op log --limit 1` and **record the operation ID**. This is your rollback point, and you
     report it at the end.
   - `jj new 'trunk()' -m "<intent of the change>"`. Describe *before* editing so the op log and
     evolog read clearly.
2. **Work**
   - One logical change per jj change. When a logical step is done, `jj commit -m "..."` and continue.
   - Keep descriptions accurate as scope changes (`jj describe -m`).
3. **Before pushing**
   - `jj log -r 'trunk()..@'`: confirm the stack is what you intend and has no stray empty changes.
     Abandon empty ones.
   - `jj log -r 'conflicts()'` must be empty for anything you push.
   - Rebase onto current trunk if it moved, then rerun tests.
   - Run the project's tests and linters: `<TEST COMMAND>`, `<LINT COMMAND>`.
4. **Push and open a PR**
   - `jj git push -c <change>`
   - `gh pr create --head push-<changeid> --base main --title "..." --body "..."`
5. **Report** (always, at the end of a task). Include:
   - change IDs and PR URLs created
   - the start and end operation IDs (so the human can `jj op restore` to the start point)
   - a short summary of how the work evolved, using `jj evolog` for anything rewritten more than
     once (false starts, reverted approaches)
   - anything you were unsure about or skipped

## Stacked PRs

For multi-step work, make a chain of changes, one PR per change:

- Push each with `jj git push -c <change>`.
- Open each PR with `--base` set to the bookmark of the change below it (the bottom one targets `main`).
- Editing a lower change auto-rebases the ones above. Push all affected bookmarks afterwards
  (`jj git push -b <b1> -b <b2> ...`).
- When the bottom PR merges: `jj git fetch`, rebase the remainder onto `trunk()`, push, and retarget
  the next PR's base to `main` (`gh pr edit <n> --base main`).

## Responding to review

Default: **append, don't amend**, while a PR is under review, so reviewers can see what changed.

- `jj new <bookmark>` → make the fix → `jj describe -m "Address review: <what>"`
- `jj bookmark set <bookmark> -r @` → `jj git push -b <bookmark>`

Only amend in place (`jj edit` / `jj squash`) if told to, or before the first review.

## Conflicts

- With git-style markers configured, resolve by editing the files directly. The snapshot records the
  resolution; there is no "mark resolved" step.
- Confirm with `jj st` and `jj log -r 'conflicts()'`.
- If a conflict involves code you don't understand the intent of, stop and ask rather than pick a side.

## After merge

- `jj git fetch`
- If the PR was merge-committed, jj recognises the changes as landed.
- If it was squash- or rebase-merged, your local changes remain distinct. Verify the content is on
  trunk, then `jj abandon` them.

## Parallel work

If running alongside other agents, use a separate workspace: `jj workspace add <path>`. If told the
workspace is stale, run `jj workspace update-stale`. Never operate on another agent's workspace.

## Project conventions

- Commit message style: `<CONVENTION>`
- PR description template: `<TEMPLATE OR LINK>`
- Trailers: add `Co-authored-by: <HUMAN NAME> <EMAIL>` when a human directed the work.
