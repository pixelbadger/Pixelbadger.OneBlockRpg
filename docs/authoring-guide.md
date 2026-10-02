# Payload authoring guide

How to turn a user's **story brief** into a **game payload** for the one block engine (spec §7.9). It is written for a
coding agent, and it is also what the [`make-game`](../.claude/skills/make-game/SKILL.md) Claude Code skill follows.
The worked example throughout is **The Pier** ([brief](../examples/the-pier/brief.md),
[payload](../examples/the-pier/)).

Read these spec chapters first. This guide assumes them:

- [§4 World model](spec/04-world-model.html): rooms, objects, actions, behaviours, flags and beliefs
- [§5 Mechanics](spec/05-mechanics.html): SPECIAL, skills, checks, combat, fatigue
- [§6 LLM layer](spec/06-llm-layer.html): conversations, hooks, the director, callouts, day summaries
- [§7 Game payload](spec/07-game-payload.html): layout, text variants, the condition/effect language, validation

The schema is the source of truth: [`schema/payload.schema.json`](../schema/payload.schema.json), generated from
[`src/payload/schema.ts`](../src/payload/schema.ts). When this guide and the schema disagree, the schema wins.

## 1. The loop

1. **Read the brief** and list what it decides and what it leaves to you ("left to the authoring agent").
   Never contradict a decision. Fill the gaps in the brief's tone.
2. **Plan on paper first** (section 3): rooms, cast, the plot's flags, the discovery chain, set pieces and endings.
   The plan is cheap to change and the YAML isn't.
3. **Write the payload** in `examples/<game-id>/` (or wherever the user asks), file by file (section 2).
4. **Validate** with `pnpm oneblock validate <dir>` until it reports `ok` with **zero warnings**. Every issue gives a
   file, a path and usually a fix.
5. **Play it** offline: `pnpm oneblock play <dir> --provider offline --new`. Walk the critical path by hand, and
   look for dead ends, text that reads wrong and things that fire at the wrong time.
6. **Write a playthrough test** (`tests/<game-id>.test.ts`, section 9) that reaches every ending, then run `pnpm test`.
7. Iterate until all three pass. Then report what you decided where the brief was silent.

## 2. Layout and naming

```
<game-id>/
  game.yaml            # id, title, schema_version, start, player, clock, intro, style_guide, downed, xp
  story.yaml           # synopsis, tone, tensions, belief catalogue, triggers, endings
  rooms/<area>.yaml    # one file per area of the block (seafront, site, town…)
  objects/<kind>.yaml  # e.g. clues.yaml for the plot's evidence, things.yaml for everything else
  characters/<group>.yaml
  conversations/<group>.yaml
  hooks.yaml
  behaviours/routines.yaml
  set_pieces/<id>.yaml # one per file
  callouts.yaml        # only if you use callouts
  combat_text.yaml
```

The split is a convention: the loader merges everything and ids are global.

| Thing | Convention | Examples |
|---|---|---|
| Ids (rooms, objects, characters, hooks, behaviours…) | lower-case kebab | `pier-tollhouse`, `room-seven-key`, `edith-lends-archive-key` |
| Flags | lower-case snake | `unease`, `glass_house_burning`, `sent_home` |
| Belief ids | kebab, and a proposition | `stillborn-secret`, `edmund-set-the-fire` |
| Hook ids | `<who>-<verb>-<what>` for one character's hooks, a bare verb phrase for shared ones | `shaun-gives-rattle`, `adjust-trust` |
| Behaviour ids | `<who>-routine`, `<who>-reactions` | `gary-routine` |
| Set-piece beats | short kebab nouns | `the-tea`, `the-lace`, `the-look` |

Put a comment at the top of each file saying what it holds and which brief section it serves. Comments help the next
agent and the human.

## 3. From brief to plan

Each brief section (§7.2) maps onto the payload like this. The Pier's choices are in brackets.

### Premise & tone → `game.yaml`, `story.synopsis`, `story.tone`

- **`style_guide`** (≤ 2500 characters) is in every LLM prompt. Give it register, era, dialect, how strange it gets,
  and what characters must never do. (The Pier: "The Victorian couple never speak and are never explained. Nobody else
  sees them…")
- **`synopsis`** (≤ 2500 characters) is in every prompt too. It says what is *really* going on, including the hidden
  truth, and what happens if the player does nothing. The LLM needs the truth to keep characters consistent. The
  engine keeps the player from simply being told it, because only hooks and authored text change world state.
- **`intro`** is the first thing the player reads: 60–100 words, second person, and it should place them in the block.

### The block → `rooms/`

- **8–16 rooms** is the right size for an "inch wide, mile deep" block. Start from a hub (a street, a parade, a
  lobby) and hang areas off it. (The Pier has 16 rooms: the parade as the hub, then the pier, the hotel site, the pub
  and the guest house.)
- **The edge is impassable** (Q6). Give the hub one or two `blocked` exits whose text says why the player stays:
  `{ direction: town, label: town, blocked: "…You haven't been into town in weeks." }`.
- **Doors are objects** referenced by `via:`. Use them when locking, opening or describing the door matters. Otherwise
  use a plain exit.
- **Time-gated exits** use `when` and `closed_text`. A secret or conditional route is an extra exit with
  `hidden: true` and a `when`, which is listed only while the condition holds. (The pier gate: the turnstile is open
  09:00–21:00, and once `unease` is set there's a hidden "over the gate" exit at night.)
- Every room needs a way back. NPCs route only through exits whose `when` holds for them, so check that routines can
  still get people home at night.

### Drawing the rooms → each room's `map` (§4.10, §7.10)

Every room is a tile map, like a town in *Ultima V*. The engine walks people across it, fights on it and checks line
of sight with it, so draw it as the floor plan the description implies.

```yaml
- id: flat-2b
  name: Flat 2B
  # …description, exits…
  map:
    rows:
      - "####=####"
      - "#bb..dd.#"
      - "#.....k.#"
      - "#...@..nD"
      - "#########"
    legend:
      ".": { terrain: boards }            # redefine . for the room's floor
      "=": { terrain: window }
      b: { object: bed-2b }               # repeat a letter to make big furniture
      d: { object: desk-2b }
      k: { object: kettle }
      "@": { character: player }          # the player's start (start room only)
      n: { object: eviction-notice }      # where an off-stage thing appears when spawned
      D: { exit: east }                   # the exit's tile, by direction or label
```

- **Small and readable.** Most rooms are 6–12 tiles across and 4–7 deep; a street or a pier can be 20 long. Keep a
  border of `#` (or `~` water, `=` windows) and put exits on the edge they lead off: north at the top, `down` on a
  stair tile (`on: stairs` is automatic for up and down).
- **Everything that starts in the room stands on it**: every object and character with `location:` this room. Doors
  (`via:` objects) don't: they are drawn on their exit's tile. Things inside containers or held by people don't either.
- **Home tiles.** Put a character on the map of every room their routine takes them to; that's where they stand when
  they're there, and they walk back to it as the clock runs. Without one they hang about by the door they came in.
- **Every exit gets a tile**, blocked and hidden ones too. A blocked exit is the edge of the block: a road running on,
  the sea.
- **Leave room to move.** Fixed objects (anything not `takeable`) block walking, so keep a path to every exit and
  beside every object. Behind a shop counter, leave a gap so the shopkeeper can be reached.
- **Decoration** that isn't an object is terrain with a look: `P: { terrain: wall, look: { emoji: "📫" } }` for post
  boxes, `t: { terrain: fence, look: { emoji: "🚏" } }` for a bus stop. Walls block sight; fences, railings, windows
  and water don't. Use emoji with a standard emoji presentation (no variation selectors) so they are two columns
  wide everywhere.
- **Looks are optional.** The TUI dresses objects by keyword (a kettle gets 🫖) and characters with a person emoji;
  add `look: { emoji, glyph, color }` to an object or character only when the default is wrong.

### Characters → `characters/`

- **SPECIAL**: a typical person is 5 in everything. Spend contrasts deliberately: the old keeper with IN 8 and ST 2,
  the labourer with ST 8. Keep a fixed player near 35 points. For point-buy (`player.mode: point-buy`), every preset
  must spend exactly 40.
- **Persona** (≤ 1500 characters, in every prompt for that character): `identity` is one line, `background` holds
  what they know and hide, `personality` is 3–5 adjectives, and `voice` is concrete (cadence, dialect, verbal tics).
- **Goals**: 2–3 short imperative sentences. They drive the LLM, so make them pull against each other and against the
  player.
- **Relationships**: trust and affinity from −100 to 100 toward the player and the cast, with a one-line `notes`.
  Hook guards read these numbers. Set starting values so a friendly route opens in 1–3 good conversations.
- **`tag_skills`** (≤ 3), **`combat_profile`**, **`essential: true`** for anyone the plot needs alive,
  **`merchant: true`** for anyone who sells. A merchant sells everything they hold, so keep plot items off merchants.
- **Routines** (behaviours, §4.5): a few `time` rules per character that move them and set an `intent` ("sweeping the
  lobby"). Everyone must sleep: either `{ act: sleep }` in their routine, or something `sleepable` within reach
  (the mechanics lint checks this). NPC sleep lasts 8 hours.
- **Apparitions** (Q31): `perceived_by: player`, no `location`, and no conversations. Give them a `refuse_text` for
  `talk`. Stage them with `spawn`, `move` and `remove`. They are intangible (they can't be attacked or handed things)
  and have no bodies (they never tire). Objects can be apparitions too (The Pier's bassinet and tea table).

### Systemic flesh: things, not triggers (§4.11–4.13)

The test of a block: delete most of its triggers, and do interesting things still happen for an hour because the
people, objects, schedules, ownership, work, locks and spaces keep colliding? Build for that. Before writing a
trigger, ask whether the world could do it instead:

- **Put every story piece physically somewhere**, behind or under something that has to be dealt with: a
  `fastened` board, `locked` door or cupboard, a hidden cavity revealed by a property
  (`hidden_unless: { property: { object: reception-panelling, key: fastened, value: false } }`).
- **Give it `force` methods by tool tag, not use rules by tool id.** `tools: [pry]` works with any bar; `[screwdriver]`
  is slow and quiet; each method has its own time, check, noise and text. Then put several tools in the world, owned
  by different people, and let routines carry them about (Tommo picks up the bar at 07:45 and drops it at 17:30).
- **Make it belong to someone** (`owner`, `permitted`). Taking it in front of them is a transgression; they notice
  when it's gone. Tie `permitted` to a relationship and the player's standing changes what they may touch.
- **Let it make a noise.** `step_noise` on something `underfoot`, a `noise` on use rules and force methods, a
  `noise` effect in an object's behaviour (Room 7's board creaks in the evenings). Whoever is near hears it, and a
  behaviour turns hearing into belief (`event: { kind: heard, actor: self, target: floorboard }`).
- **Let documents teach** (`teaches: [ashdowns-stayed]`). Whoever reads it learns it, so knowledge can travel: Gary
  reads the register Tommo found and tells the pub.
- **Give people a mundane life with stakes**: a job checked by behaviours (`adjust_property` on a ledger object,
  `remember` notes for their conversations), reactions to `noticed-missing`, `noticed-damage` and `transgression`.

### Plot → beliefs, flags, triggers, endings (`story.yaml`)

Beliefs are what the player knows; flags are the plot's stage. Before writing YAML, list them:

| Kind | The Pier |
|---|---|
| Discovery beliefs, one per piece of the truth (`teaches` on the document, or told by someone who knows) | `ashdowns-stayed`, `stillborn-secret`, `edmund-set-the-fire`, `child-had-a-name` |
| Stage flags, for an arc that escalates | `unease` → `obsession` → `breakdown` |
| Staging flags, so a spawn/remove pair runs once per window | `clara_at_rail`, `lullaby_staged` |
| Outcome flags read by endings | `glass_house_burned` |

- **Discoveries**: make the clue an object with full text in its `description` and `teaches`, and drive the arc from
  `believes`, so it doesn't matter how the player learned it. A trigger on reading it may mark the moment
  (narration, XP 25–50): `when: { event: { kind: examined, actor: player, target: guest-register } }`, `once: true`.
- **Escalation without counters**: the language has no arithmetic, so "any two of three" is three `all` pairs inside
  an `any` (see `stage-obsession`). Pace stages by day if the brief wants them to take time
  (`{ day: { gte: 2 } }`). A modifier with a fixed `id` *replaces* the previous one, so stages can set absolute
  values: `{ modify: { who: player, id: madness-pe, attribute: PE, amount: 2 } }`.
- **SPECIAL as story**: Perception-gated text (`when: { special: { PE: { gte: 7 } } }`) and `hidden_unless` let a
  stat change reveal the world. The Pier raises PE as Liam goes mad, so the Victorian pier shows through.
  Fatigue costs PE too, so never make the critical path depend on a gate that tiredness can close. Give every gate
  a non-stat alternative, ideally a belief someone can give you
  (`hidden_unless: { any: [ { special: … }, { believes: { who: player, belief: loose-board } } ] }`); hearing a
  hidden thing from close by also finds it.
- **Deadlines**: a `once` trigger on `{ day: { gte: N } }` plus a `time` crossing. Use `wakes: true` if it may fire
  while the player sleeps. `day` is the chapter count, and it advances when the player sleeps, not at midnight.
- **Endings**: at least one must be reachable. Order text variants from most specific to least, and make the last one
  unconditional. One ending with variants is a good way to say "inevitable, but your understanding matters".

### Conversations → `conversations/`

- **At least one per speaking character.** For people whose attitude changes with the plot, add stage-gated specs
  at a higher `priority` with a `when` (The Pier: `gary-work` → `gary-concerned` at `obsession` → `gary-distance` at
  `breakdown`). It's the simplest way to make the cast notice things.
- **Goals**: 2–3 lines, and specific to this conversation. Say what the character will and won't reveal and on what
  terms ("If he already knows the Ashdowns' names, be frightened, and lend him the archive key").
- **Hooks per conversation: 1–4.** Always include the generic `adjust-trust`, plus one or two plot hooks the
  character could plausibly grant. More than four dilutes the model's choices.
- **Authored options**: 1–4 per conversation. Use `once` for questions, `when` for options that need an item or
  belief, `check` for skill attempts (`[Speech] …` in the text), `action` for "[Give the letters]"-style moves,
  and `effects` for engine-applied consequences.
- **`actions`** is the allow-list for what the *character* may do mid-conversation. It defaults to go, give, take
  and use. Grant `attack` only where violence is part of the scene (the validator flags it for review).
- `ends_when` always includes a turn cap: `{ turns: { gte: 8 } }`.

### Never depend on the LLM for the critical path

Hooks only fire when a model chooses them, and offline play (`--provider offline`) has no model. **Every piece of
the critical path needs an authored route**: an option with `effects`, an object use rule, an action (steal it,
pick the lock) or a trigger. Keep the hook as well, since it's the livelier route. (The Pier: the archive key comes
through Edith's hook *or* the authored option "Mr and Mrs Ashdown. Room 7.", and the rattle through Shaun's hook,
a Speech option, or stealing it.)

### Hooks → `hooks.yaml`

- The `description` is what the LLM reads. Phrase it as an action in the character's voice: "Lend Liam the key to the
  archive cupboard, so he can read the 1893 papers himself."
- Guard every plot hook: relationship thresholds, beliefs or stage flags. A guard is evaluated with `self` as the
  speaking character.
- `once: true` is **once per save, for everyone**, not once per character. Shared hooks like `adjust-trust` and
  `notice-he-is-changing` must not be `once`.
- Params and `$arg` give bounded numeric choices: `trust: { $arg: amount }` with `min`/`max`.

### Set pieces → `set_pieces/`

Use one when several characters must act together, or when the brief names a big scene. Ordinary encounters don't
need one.

- `starts_when` should usually include where the player is. A set piece that starts while they're across the block
  plays to nobody.
- `stage` lists the rooms, and `cast` the characters the director may use. The `director_brief` (≤ 1500 characters)
  says what the scene is *for*, what the cast want, and what must never happen.
- 3–5 `beats`, each with a one-line description.
- `moves`: grant the director as little as works. `effects: [narrate]` with no actions is often enough. Move
  apparitions yourself with staging triggers (`in_set_piece: <id>`), so the scene still works offline. The Pier keeps
  the couple one room ahead of Liam with three `promenade-ahead-N` triggers.
- **`ends_when` must include a timeout** (a `time_between` window), so the scene ends without the player.
- `ends_when` is evaluated without the event window, so `event` conditions never match there. Have a trigger set a
  flag on the event and end on the flag (`saw-the-cradle` → `saw_cradle`).
- `outcomes` run in order when it ends. An outcome without `when` always runs.

### Combat text → `combat_text.yaml`

Each weapon `type` needs `hit`, `miss`, `crit` and `down` (and optionally `kill`), and `unarmed` and `thrown` are
always worth having. Placeholders: `{{Attacker}}`, `{{target}}`, `{{Target}}`, `{{weapon}}`, `{{Weapon}}`,
`{{damage}}`.

## 4. Writing the text

- **Second person, present tense**, in the style guide's voice. The engine supplies "You take the crowbar." Your text
  is the description, the reveal and the consequence.
- **Room descriptions: 1–3 sentences, up to about 60 words.** Lead with what's distinctive, end with what leads
  somewhere (exits, people, the thing to look at). Name exits in prose only if it helps orientation.
- **Object descriptions: 1–2 sentences.** Clues are the exception: give the whole document, because reading it *is*
  the gameplay.
- **`room_text`** replaces "You see X here." for objects that deserve a sentence ("A red jerrycan stands by the
  generator.").
- **Text variants**: put the most specific first and end with an unconditional fallback (the validator insists).
  Typical gates are plot flags, then time of day, then SPECIAL.
- **Never mention mechanics** (numbers, checks, flags) in flavour text. Show stats through what the character notices.
- **If the text names it, it exists.** Every thing a room description mentions (the boots by the door, the rules on
  the wall, the gulls) must be an object the player can examine, usually `scenery: true` with `aliases`. Players
  will try `read rules` and `take boots`, and "You don't see any rules here" breaks the illusion at once. Give the
  best ones a use rule, such as a kettle that makes tea or a fruit machine that takes a quid. Keep it all in
  `objects/scenery.yaml`, grouped by room (see The Pier's). If an object can move, make the room text that mentions
  it a variant that depends on where it is.
- **Ending text: 80–150 words.** It is the last thing the player reads, so make it count.

## 5. Gotchas

| Condition or effect | Behaviour |
|---|---|
| `time: "12:30"` | true only on the tick that *crosses* 12:30. For state, use `time_between` |
| `time_after` / `time_before` | time of day, no wrap-round. For a night window, use `time_between: { from: "21:00", to: "04:00" }` |
| triggers | fire each time their condition *becomes* true (edge), or once with `once: true` |
| behaviour rules | edge-triggered like triggers, unless they have a `cooldown` |
| `spawn` | moves the object if it already exists somewhere, so spawning a held item takes it |
| `move` the player | allowed (The Pier's deadline does it). It doesn't trigger `go` side effects |
| `act` from a trigger | needs `actor:` (the validator says so) |
| merchants | sell everything they hold, at value-based prices (§5.7) |
| `hidden_unless` | applies to the player only. NPCs always see hidden things |
| `self` | the behaviour owner, the hook's speaker, or the consuming character |
| `once` hooks | once per save, across every character |
| reach | acting on something walks the actor next to it first, which takes time (10 s a tile) |
| `spawn` / `move` into a room | lands on the thing's tile on that room's map if it has one, else the nearest free tile |
| map legend `.` / `#` / space | floor / wall / void unless the legend redefines them |

## 6. Budgets

The validator warns above these, because each item is in every relevant prompt.

| Field | Budget |
|---|---|
| `story.synopsis` | 2500 characters |
| `game.style_guide` | 2500 characters |
| character `persona` (all fields) | 1500 characters |
| character `goals` (joined) | 800 characters |
| set piece `director_brief` | 1500 characters |

## 7. Validation

`pnpm oneblock validate <dir>` runs the schema, reference checks, the playability lint (reachability, flags read but
never set, ending reachability, text-variant fallbacks, set-piece references, combat text), the mechanics lint
(SPECIAL ranges, weapon ST, sleep) and the budget lint. Treat warnings as errors in shipped examples. The Pier
validates with zero.

## 8. Worked example: The Pier

| Brief says | Payload does | Where |
|---|---|---|
| Present day; the past only as apparitions, PE-gated text and set pieces | PE ≥ 7/8/9 variants on the parade, pier, beach and glass house; no second time layer | `rooms/seafront.yaml` |
| Ghosts silent and seen only; appear through spawn/move/remove | `perceived_by: player`, no conversations, `refuse_text`; staging triggers per appearance | `characters/ghosts.yaml`, `story.yaml` |
| Three pieces of the couple's story | guest register (behind fastened panelling, in a hidden cavity), Clara's letter (under a screwed-down, creaking board in Gary's locked Room 7), the 1893 newspaper (Edith's locked archive); plus Edith's legend and Shaun's rattle; each `teaches` its belief | `objects/clues.yaml` |
| Madness as stage flags plus SPECIAL modifiers | `unease`/`obsession`/`breakdown` from beliefs, however learned (from day 2 and day 3); PE up, CH and IN down via fixed-id modifiers | `story.yaml` |
| Mundane labouring life | Gary looks for Liam at 10:30 and 15:00 (strikes on the timesheet, sacked at three; Marek covers if he likes him), checks the panelling and the plasterboard, refuels the generator from the petrol can and notices when it's gone; tools circulate with routines | `behaviours/`, `objects/things.yaml` |
| The crew and friends notice him changing | stage-gated conversations; the `worried-friend` behaviour (seeing him obsessed); `goes-looking` on the last night; the `notice-he-is-changing` hook | `conversations/`, `behaviours/reactions.yaml` |
| Discovery-paced, with a deadline | the stages need the beliefs; `the-last-night` on day 5 at 23:00 forces it | `story.yaml` |
| Final burning: the couple taking tea as it burns | `the-burning` set piece; `use petrol can/matches on deckchairs`; outcomes that narrate who came looking, whether he still has a job, and the missing petrol | `set_pieces/the-burning.yaml`, `objects/things.yaml` |
| Earlier apparition set pieces left to the agent | `the-promenade` (follow them along the pier) and `the-lullaby` (Room 7 at night) | `set_pieces/` |
| One inevitable ending | one ending with three variants, by how much he understood | `story.yaml` |

A discovery, end to end, with no trigger in it. The board in Room 7
([`objects/clues.yaml`](../examples/the-pier/objects/clues.yaml)) is loose, screwed down, owned by nobody, and creaks:

```yaml
- id: floorboard
  location: room-seven
  hidden_unless:
    any: [ { special: { PE: { gte: 7 } } }, { believes: { who: player, belief: loose-board } } ]
  affordances: [underfoot, container, openable]
  behaviours: [board-creaks]          # a `noise` every 45 minutes through the evening
  properties: { open: false, fastened: true }
  step_noise: { loudness: 5, sound: "a floorboard creak, hollow, like a drum with something under it" }
  force:
    - { tools: [screwdriver], minutes: 15, check: { skill: repair, tier: easy }, noise: { loudness: 2, sound: "…" } }
    - { tools: [pry, claw], minutes: 5, noise: { loudness: 7, sound: "a floorboard being torn up" } }
```

Marek works late at the far end of the corridor, so he may hear it through the door; his behaviour
([`behaviours/reactions.yaml`](../examples/the-pier/behaviours/reactions.yaml)) turns that into a belief and a
memory, which is what his conversation option and his hook are guarded by. Liam can hear it there too, or tread on it
(hearing it in the same room finds it). Marek's screwdriver is in his toolbox, `permitted` to anyone he trusts;
Tommo usually has the bar. The key to Room 7 is on Gary's board, lent if he trusts Liam, a transgression if taken in
front of him, and missed when he next looks; or the door can be forced, loudly, and Gary finds it on his rounds. The
letter `teaches: [stillborn-secret]`, and the madness reads the belief.

## 9. The playthrough test

Copy the shape of [`tests/pier.test.ts`](../tests/pier.test.ts):

- **validates with no issues**: `expect(validatePayloadAt(dir).issues).toEqual([])`.
- **one test per ending**: drive a `Session` with typed commands and pick options by text. Use a `ScriptedProvider`
  that invokes the plot hooks it's offered, so the hook routes are exercised. Use `offlineProvider()` to prove the
  authored routes work without a model.
- **a test for anything the brief marks as decided**, e.g. that apparitions never reach NPC day logs.
- Assert on flags, beliefs, `w.state.ended` and key lines of text, not on whole transcripts.

## 10. Before you hand it back

- [ ] `pnpm oneblock validate <dir>`: ok, zero warnings
- [ ] Every ending is reached by a test, and the critical path also works offline
- [ ] Every brief decision is honoured. Everything you decided is listed in your report
- [ ] Every thing a room description names is an examinable object
- [ ] Every story piece is physically somewhere, and reachable in at least two ways nobody scripted (a tool, a
      person, a noise, an owner's trust), each covered by a test
- [ ] Every room has a map; every character has a home tile in each room their routine visits
- [ ] Every character sleeps, has a routine and at least one conversation (apparitions excepted)
- [ ] Every timed set piece and window has a timeout, and every spawn has a matching remove
- [ ] `pnpm test` and `pnpm lint` pass
