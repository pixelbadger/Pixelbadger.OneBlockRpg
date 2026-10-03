/**
 * The UI port (§3.1, Q11). The session emits view models and accepts player intents; it never formats for a
 * particular display. Any host (the web page, the native window) is an adapter on this port.
 */
import type { CombatIntent } from "../core/combat.js";
import type { RoomDescription } from "../core/describe.js";
import type { Output } from "../core/world.js";
import type { ActionRequest, Look, SkillId, Special, Terrain } from "../payload/schema.js";

export type Tile = [number, number];

/** Something standing in the scene (§4.10). */
export interface SceneThing {
  id: string;
  name: string;
  kind: "character" | "fixed" | "item";
  pos: Tile;
  /** Every tile it covers (fixed objects can cover several). */
  tiles: Tile[];
  look?: Look;
  player?: boolean;
  status?: "ok" | "down" | "dead" | "asleep";
  hostile?: boolean;
  apparition?: boolean;
  /** In the current fight: "a" is the player's side. */
  side?: "a" | "b";
  open?: boolean;
  container?: boolean;
  lockable?: boolean;
  locked?: boolean;
  merchant?: boolean;
  /** What you can see in it (open containers and surfaces) or on them (characters' held things). */
  contents?: { id: string; name: string }[];
}

/** Spatial things that happened this turn, for frontends that animate them. */
export type Fx =
  | { kind: "walk"; id: string; room: string; path: Tile[] }
  | {
      kind: "hit" | "miss";
      actor: string;
      target: string;
      from?: Tile;
      to?: Tile;
      ranged: boolean;
      crit?: boolean;
      damage?: number;
    }
  | { kind: "down" | "killed"; id: string; at?: Tile };

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
  | {
      type: "inventory";
      items: string[];
      equipped: string[];
      money: number;
      /** The same items with their ids, for frontends that act on them. */
      entries?: {
        id: string;
        name: string;
        equipped: boolean;
        weapon?: boolean;
        armour?: boolean;
        consumable?: boolean;
      }[];
    }
  | {
      /** The player's room as drawn (§4.10): terrain, exits and everything standing in it. */
      type: "scene";
      room: string;
      name: string;
      w: number;
      h: number;
      /** terrain[y][x] */
      terrain: Terrain[][];
      /** Authored terrain looks, keyed "x,y". */
      looks: Record<string, Look>;
      exits: {
        pos: Tile;
        label: string;
        direction?: string;
        to?: string;
        /** The destination's name, once visited. */
        toName?: string;
        blocked: boolean;
        door?: string;
        open?: boolean;
        locked?: boolean;
      }[];
      things: SceneThing[];
      tags: string[];
      /** Minutes into the day, for lighting. */
      minute: number;
    }
  | { type: "fx"; fx: Fx[] }
  | {
      /** What the player knows of the block's layout: visited rooms, their visible exits and where those lead. */
      type: "map";
      here: string;
      rooms: { id: string; name: string; visited: boolean }[];
      exits: { from: string; to?: string; direction: string; label: string; blocked: boolean }[];
    }
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
  /** The payload's introduction (§7.2): pages of light markdown (see src/engine/session/markdown.ts), shown one at a time. */
  | { type: "introduction"; title?: string; pages: string[] }
  | { type: "ended"; ending: string; title?: string; text: string };

/** The view model of one type, e.g. `ViewOf<"map">`. */
export type ViewOf<T extends ViewModel["type"]> = Extract<ViewModel, { type: T }>;

export type MetaCommand = "look" | "inventory" | "status" | "journal" | "menu" | "help" | "improve" | "intro";

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
