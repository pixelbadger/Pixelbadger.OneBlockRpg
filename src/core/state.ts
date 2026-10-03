/**
 * World state (§3.7, §4). The payload is immutable; this holds everything that can change. It is only ever changed by
 * applying events (ops.ts), so the current state is a fold over the event log.
 */

import type { RngState } from "../mechanics/rng.js";
import type { Modifier } from "../mechanics/special.js";
import type { ActionRequest, CombatProfile, Scalar, SkillId, Special, Tier } from "../payload/schema.js";

export interface ObjState {
  /** Room, container or character id; null when off-stage (not yet spawned, or removed). */
  location: string | null;
  /** The tile this stands on, when directly in a room (§4.10); null otherwise. */
  pos?: [number, number] | null;
  props: Record<string, Scalar>;
}

export interface Belief {
  /** A story belief id (§7.3), or `thought-…` for a belief held in the character's own words (`text`). */
  id: string;
  /** The character's own wording (§4.13, reading): set on thoughts, which conditions cannot test. */
  text?: string;
  confidence: number;
  source: string;
  day: number;
}

export interface Rel {
  trust: number;
  affinity: number;
  notes: string;
}

export type CharStatus = "ok" | "down" | "dead";

export interface CharState {
  /** Base SPECIAL (before modifiers and fatigue). */
  special: Special;
  tags: SkillId[];
  skillPoints: Partial<Record<SkillId, number>>;
  unspentSkillPoints: number;
  hp: number;
  level: number;
  xp: number;
  money: number;
  awakeMinutes: number;
  asleepUntil: number | null;
  /** Fatigue recovery multiplier for the current sleep: 1 in a bed, 0.5 on the floor. */
  sleepQuality: number;
  status: CharStatus;
  downUntil: number | null;
  hostile: boolean;
  combatProfile: CombatProfile;
  intent: string | null;
  equipment: { weapon?: string; armour?: string };
  relationships: Record<string, Rel>;
  beliefs: Belief[];
  modifiers: Modifier[];
  /** Active behaviour ids. */
  behaviours: string[];
  /** Minutes accumulated towards the next healing tick (doubled while asleep). */
  healAccum: number;
  /** Day on which First Aid was last applied to this character. */
  firstAidDay: number | null;
  /**
   * The sneaking stance (§5.4): null when not sneaking. `aware` holds the characters who have noticed the sneaker in
   * their current room; everyone else does not perceive them or their actions.
   */
  sneaking?: { aware: string[] } | null;
}

export type LogKind =
  | "conversation"
  | "overheard"
  | "witnessed"
  | "heard"
  | "action"
  | "hook"
  | "set-piece"
  | "note"
  | "digest";

export interface LogEntry {
  at: number;
  kind: LogKind;
  text: string;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
}

/** A player option on offer (§6.3): authored, LLM-suggested, or the always-available leave. */
export type ConvOption =
  | { kind: "authored"; text: string; index: number }
  | { kind: "llm"; text: string; action?: ActionRequest; check?: { skill: SkillId; tier: Tier } }
  | { kind: "leave"; text: string };

export interface ConversationState {
  id: string;
  character: string;
  turn: number;
  startedAt: number;
  transcript: TranscriptLine[];
  /** Results of the last actions, hooks and checks, fed to the next character turn (§6.3). */
  results: string[];
  /** Minutes spent on actions during the conversation. */
  actionMinutes: number;
  suspended: boolean;
  ending: boolean;
  /** Options currently offered to the player. */
  options: ConvOption[];
}

export interface SetPieceState {
  id: string;
  beat: number;
  beatsDone: string[];
  startedAt: number;
  turns: number;
  narration: string[];
}

/** `left` is a combatant left behind when the fight moved rooms with a pursuit. */
export type CombatantStatus = "in" | "fled" | "surrendered" | "down" | "dead" | "left";

export interface Combatant {
  id: string;
  side: "a" | "b";
  status: CombatantStatus;
  target?: string;
}

export interface CombatState {
  room: string;
  combatants: Combatant[];
  order: string[];
  round: number;
  turn: number;
  ap: number;
  seconds: number;
  origin: "explore" | "conversation" | "set-piece";
  log: string[];
  /**
   * Escapes still open to pursuit (§5.6): a combatant who left the room can be followed by each opponent on their
   * next turn, until the turn order comes back round to the fleer (`expires`).
   */
  trails?: Trail[];
}

export interface Trail {
  id: string;
  from: string;
  to: string;
  direction: string;
  expires: { round: number; turn: number };
}

export interface Ended {
  ending: string;
  title?: string;
  text: string;
}

export interface WorldState {
  payloadId: string;
  payloadVersion: string;
  seed: string;
  /** Absolute game minutes. Time of day is clock mod 1440. */
  clock: number;
  /** Chapter number: starts at 1 and advances when the player sleeps (§3.6). */
  day: number;
  /** Start of the time window for `time` conditions in the current evaluation pass. */
  windowFrom: number;
  rng: RngState;
  flags: Record<string, Scalar>;
  objects: Record<string, ObjState>;
  chars: Record<string, CharState>;
  visited: string[];
  /** Seconds walked towards the next whole minute (§4.10: a step is 10 seconds). */
  seconds?: number;
  triggersFired: string[];
  /** Last value of edge-triggered conditions, keyed by trigger or rule. */
  edges: Record<string, boolean>;
  /** Behaviour rule bookkeeping: last firing time and count, keyed `${owner}/${behaviour}/${index}`. */
  rules: Record<string, { last: number; count: number }>;
  hooksUsed: string[];
  optionsUsed: string[];
  dayLogs: Record<string, LogEntry[]>;
  summaries: Record<string, { day: number; text: string }[]>;
  callouts: Record<string, string>;
  conversation: ConversationState | null;
  setPiece: SetPieceState | null;
  setPiecesDone: string[];
  combat: CombatState | null;
  ended: Ended | null;
  playerCreated: boolean;
}
