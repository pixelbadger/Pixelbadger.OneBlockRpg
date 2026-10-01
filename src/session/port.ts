/**
 * The UI port (§3.1, Q11). The session emits view models and accepts player intents; it never formats for a
 * particular display. Any frontend (the readline CLI, a TUI, a web page) is an adapter on this port.
 */
import type { CombatIntent } from "../core/combat.js";
import type { RoomDescription } from "../core/describe.js";
import type { Output } from "../core/world.js";
import type { ActionRequest, SkillId, Special } from "../payload/schema.js";

export type Mode = "create" | "explore" | "conversation" | "combat" | "ended";

export interface MenuItem {
  label: string;
  intent: Intent;
}

export type ViewModel =
  | { type: "narration"; kind: Output["kind"]; text: string; speaker?: string }
  | { type: "room"; room: RoomDescription; objective?: string }
  | {
      type: "status";
      clock: string;
      day: number;
      hp: number;
      maxHp: number;
      awakeHours: number;
      wakingHours: number;
      money: number;
      level: number;
      xp: number;
      unspentSkillPoints: number;
      sneaking: boolean;
    }
  | {
      type: "sheet";
      name: string;
      special: Special;
      base: Special;
      derived: Record<string, number>;
      skills: Record<SkillId, number>;
      tags: SkillId[];
    }
  | { type: "inventory"; items: string[]; equipped: string[]; money: number }
  | { type: "journal"; entries: { day: number; text: string }[] }
  | { type: "conversation"; with: string; options: { index: number; text: string }[] }
  | {
      type: "combat";
      round: number;
      ap: number;
      yourTurn: boolean;
      combatants: { id: string; name: string; hp: number; maxHp: number; side: "a" | "b"; status: string }[];
      options: MenuItem[];
    }
  | { type: "menu"; items: MenuItem[] }
  | { type: "create"; presets: { name: string; special: Special }[]; points: number; min: number; max: number }
  | { type: "help"; text: string }
  | { type: "ended"; ending: string; title?: string; text: string };

export type MetaCommand = "look" | "inventory" | "status" | "journal" | "menu" | "help" | "improve";

export type Intent =
  | { type: "command"; text: string }
  | { type: "action"; action: ActionRequest }
  | { type: "option"; index: number }
  | { type: "combat"; intent: CombatIntent }
  | { type: "create"; preset?: string; special?: Special }
  | { type: "meta"; command: MetaCommand; arg?: string };

export interface TurnOutput {
  views: ViewModel[];
  mode: Mode;
}
