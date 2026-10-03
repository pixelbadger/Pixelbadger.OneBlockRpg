/**
 * The presentation model: everything a host draws, in one plain object. The session's view models (port.ts) are
 * absorbed into it after every turn; the controller changes it as keys and clicks arrive. Hosts render it and never
 * write to it.
 */

import { SKILL_NAMES } from "../engine/mechanics/special.js";
import type { Special } from "../engine/payload/schema.js";
import type { Mode, SceneThing, Tile, ViewModel, ViewOf } from "../engine/session/port.js";
import type { Session } from "../engine/session/session.js";
import { markdownParagraphs, type Paragraph, toParagraphs } from "./text.js";
import { Timeline } from "./timeline.js";

export interface MenuItem {
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
}

export interface Menu {
  title: string;
  items: MenuItem[];
  /** The highlighted row. */
  index: number;
  /** Conversation and creation menus can't be dismissed; you have to choose. */
  sticky?: boolean;
  /** Escape goes back to this menu. */
  back?: Menu;
}

export type Verb =
  | "attack"
  | "talk"
  | "look"
  | "get"
  | "open"
  | "lock"
  | "push"
  | "use-on"
  | "throw"
  | "give"
  | "steal"
  | "barter";

/** A target in the scene: a thing, or an exit tile. */
export type Target = { kind: "thing"; thing: SceneThing } | { kind: "exit"; exit: ViewOf<"scene">["exits"][number] };

/** Aiming a verb: the scene shows `cursor`; Enter (or a click) does the verb to what is under it. */
export interface Targeting {
  verb: Verb;
  title: string;
  cursor: Tile;
  /** Nearest first. */
  candidates: Target[];
  /** The held item being used, thrown or given. */
  item?: { id: string; name: string };
  /** Choosing your own tile does this (e.g. use an item on nothing). */
  self?: () => void | Promise<void>;
}

/** A box over the scene: a sheet, the journal, help or the paged introduction. */
export interface Overlay {
  title: string;
  lines: Paragraph[];
  /** Skills that can be raised from here (the stats sheet with points to spend), and the highlighted one. */
  skills?: { id: string; label: string }[];
  index?: number;
  /** A paged overlay (the introduction): `lines` is pages[page]; next on the last page closes it. */
  pages?: Paragraph[][];
  page?: number;
  /** Lines scrolled down within the current page (hosts clamp it). */
  offset?: number;
}

export interface Model {
  title: string;
  mode: Mode;
  scene?: ViewOf<"scene">;
  status?: ViewOf<"status">;
  sheet?: ViewOf<"sheet">;
  inventory?: ViewOf<"inventory">;
  combat?: ViewOf<"combat">;
  conversation?: ViewOf<"conversation">;
  create?: ViewOf<"create">;
  ended?: ViewOf<"ended">;
  /** The message log, oldest first (capped at LOG_LIMIT paragraphs). */
  log: Paragraph[];
  /** Pages scrolled back from the newest message; 0 follows the log. Hosts clamp it. */
  scroll: number;
  menu?: Menu;
  targeting?: Targeting;
  overlay?: Overlay;
  /** Custom character creation: SPECIAL being allocated, and the highlighted attribute. */
  allot?: { special: Special; index: number };
  /** A turn is being played (the model may be thinking). Input other than scrolling waits. */
  busy: boolean;
  /** A one-line hint for the foot of the log: what the keys do now. */
  prompt?: string;
}

export const LOG_LIMIT = 3000;

export function emptyModel(title: string, mode: Mode): Model {
  return { title, mode, log: [], scroll: 0, busy: false };
}

/** Adds paragraphs to the log and follows it. */
export function pushLog(m: Model, paras: Paragraph[]): void {
  m.log.push(...paras);
  if (m.log.length > LOG_LIMIT) m.log.splice(0, m.log.length - LOG_LIMIT);
  m.scroll = 0;
}

/**
 * Turns session output into the model: the log, the panels and any sheet to show. Returns the turn's animation when
 * things moved or fought in the room the player is still in.
 */
export function absorb(m: Model, session: Session, views: readonly ViewModel[]): Timeline | undefined {
  const before = new Map<string, Tile>((m.scene?.things ?? []).map((t) => [t.id, t.pos]));
  const beforeRoom = m.scene?.room;
  pushLog(m, toParagraphs(views, { compact: true }));
  for (const v of views) {
    if (v.type === "sheet") {
      const skills = Object.entries(v.skills).map(([id, value]) => ({
        id,
        label: `${SKILL_NAMES[id as keyof typeof SKILL_NAMES]}${v.tags.includes(id as never) ? "*" : ""}  ${value}%`,
      }));
      m.overlay = {
        title: v.name,
        lines: toParagraphs([v]),
        ...(m.status?.unspentSkillPoints || Number(v.derived["Skill points"] ?? 0) > 0 ? { skills, index: 0 } : {}),
      };
    } else if (v.type === "journal") m.overlay = { title: "Journal", lines: toParagraphs([v]) };
    else if (v.type === "help") m.overlay = { title: "Help", lines: toParagraphs([v]) };
    else if (v.type === "introduction") {
      const pages = v.pages.map(markdownParagraphs);
      m.overlay = { title: v.title ?? m.title, lines: pages[0]!, pages, page: 0, offset: 0 };
    } else if (v.type === "combat") m.combat = v;
    else if (v.type === "conversation") {
      m.conversation = v;
      m.menu = undefined;
    } else if (v.type === "create") m.create = v;
    else if (v.type === "ended") m.ended = v;
  }
  m.mode = session.mode;
  if (m.mode !== "combat") m.combat = undefined;
  if (m.mode !== "conversation") m.conversation = undefined;
  if (m.mode !== "create") {
    m.status = session.statusView();
    m.sheet = session.sheetView();
    m.inventory = session.inventoryView();
    m.scene = session.sceneView();
  }
  const fx = views.find((v) => v.type === "fx");
  if (fx?.type === "fx" && m.scene && beforeRoom === m.scene.room) return new Timeline(fx.fx, before);
  return undefined;
}
