/**
 * Every event kind the engine emits (§4.9). Behaviours and triggers react to these with the `event` condition.
 * For events about an object, `targets` holds the object first, then any secondary target.
 */
export const EVENT_KINDS = [
  // actions (§4.3)
  "moved", // actor moved from one room to another (targets: [from, to])
  "walked", // actor walked across tiles within a room (payload.path) (§4.10)
  "took",
  "dropped",
  "put",
  "opened",
  "closed",
  "locked",
  "unlocked",
  "used",
  "thrown", // targets: [item, target?]
  "pushed",
  "impact", // a thrown or pushed object hit something
  "broken",
  "gave",
  "showed",
  "stole",
  "caught-stealing",
  "bought",
  "sold",
  "equipped",
  "unequipped",
  "examined",
  "read", // a character took in what a document says (targets: [document]; payload: accepted, rejected) (§4.13)
  "waited",
  "slept",
  "woke",
  "collapsed",
  "sneak-started", // actor entered the sneaking stance
  "sneak-ended", // actor left it (payload.revealed when an attack or talk gave them away)
  "noticed", // actor noticed a sneaking character (targets: [sneaker])
  "forced", // actor forced an object open or loose (targets: [object, tool]) (§4.12)
  // sound and ownership (§4.11, §4.13)
  "noise", // something made a sound (targets: [source]; payload: room, loudness, sound)
  "heard", // actor heard a noise (targets: [source]; payload: sound, room, level, near)
  "transgression", // actor took, forced or broke something not theirs, and was seen (targets: [object, owner])
  "noticed-missing", // an owner noticed something of theirs gone from its place (targets: [object])
  "noticed-damage", // an owner noticed something of theirs forced or broken (targets: [object])
  // combat (§5.6)
  "attacked",
  "combat-started",
  "hit",
  "missed",
  "downed",
  "killed",
  "fled",
  "pursued", // actor followed a fleeing combatant (targets: [quarry, from, to]); combat moves with them
  "surrendered",
  "combat-ended",
  // conversation (§6)
  "conversation-started",
  "said",
  "conversation-ended",
  // state changes
  "flag-set",
  "flag-cleared",
  "property-set",
  "spawned",
  "removed",
  "relocated",
  "intent-set",
  "behaviour-started",
  "behaviour-stopped",
  "behaviour-fired",
  "relationship-adjusted",
  "belief-added",
  "belief-removed",
  "checked",
  "xp-awarded",
  "level-up",
  "healed",
  "damaged",
  "money-changed",
  "modifier-added",
  "modifier-expired",
  "hostile-set",
  "combat-profile-set",
  "hook-fired",
  "hook-refused",
  "trigger-fired",
  "set-piece-started",
  "beat-advanced",
  "set-piece-ended",
  "callout",
  "narrated",
  "clock-advanced",
  "seconds-carried", // walking time short of a whole minute (§4.10)
  "day-ended",
  "day-summary",
  "day-log",
  "fatigue",
  "game-ended",
  "mode",
  "rng",
  "player-created",
  "skill-improved",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
