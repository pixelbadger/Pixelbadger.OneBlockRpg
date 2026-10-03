/** The message log: session view models as styled paragraphs, re-wrapped to the pane on every frame. */

import { ATTRIBUTE_NAMES, SKILL_NAMES } from "../../mechanics/special.js";
import { ATTRIBUTES } from "../../payload/schema.js";
import { type MdRun, parseMarkdown } from "../../session/markdown.js";
import type { ViewModel } from "../../session/port.js";
import { S, type Span } from "./canvas.js";

/** One logical block of the scrollback, re-wrapped to the pane width on every frame. */
export interface Paragraph {
  spans: Span[];
  indent?: number;
}

// ─── View models → scrollback ─────────────────────────────────────────────────

/** Turns session output into scrollback paragraphs. Status views feed the sidebar instead. */
export function toParagraphs(views: readonly ViewModel[], opts: { compact?: boolean } = {}): Paragraph[] {
  const out: Paragraph[] = [];
  const p = (spans: Span[], indent?: number) => out.push(indent ? { spans, indent } : { spans });
  const blank = () => {
    if (out.length && out[out.length - 1]!.spans.length) p([]);
  };
  // The tiled frontend shows choices, sheets and exits elsewhere; the log keeps the prose.
  const elsewhere = new Set([
    "conversation",
    "menu",
    "create",
    "combat",
    "inventory",
    "sheet",
    "journal",
    "help",
    "introduction",
  ]);
  for (const v of views) {
    if (opts.compact && elsewhere.has(v.type)) continue;
    switch (v.type) {
      case "narration":
        switch (v.kind) {
          case "speech":
            p([{ text: `${v.speaker ?? ""}: `, sgr: S.boldCyan }, { text: `“${v.text}”` }]);
            break;
          case "system":
          case "check":
            p([{ text: v.text, sgr: S.grey }]);
            break;
          case "ambient":
            p([{ text: v.text, sgr: S.italic }]);
            break;
          case "combat":
            p([{ text: v.text, sgr: S.red }]);
            break;
          case "callout":
            p([{ text: v.text, sgr: S.magenta }], 2);
            break;
          case "journal":
            p([{ text: "Journal", sgr: S.yellow }]);
            p([{ text: v.text }], 2);
            break;
          case "ending":
            blank();
            p([{ text: v.text, sgr: S.bold }]);
            break;
          default:
            p([{ text: v.text }]);
        }
        break;
      case "room": {
        const r = v.room;
        blank();
        p([{ text: `━━ ${r.name} `, sgr: S.boldCyan }]);
        p([{ text: r.description }]);
        if (v.objective)
          p([
            { text: "Objective: ", sgr: S.boldYellow },
            { text: v.objective, sgr: S.yellow },
          ]);
        for (const o of r.objects) p([{ text: o }]);
        for (const x of r.people) p([{ text: x, sgr: S.cyan }]);
        if (r.exits.length && !opts.compact) {
          const spans: Span[] = [{ text: "Exits: ", sgr: S.grey }];
          r.exits.forEach((x, i) => {
            if (i) spans.push({ text: ", ", sgr: S.grey });
            spans.push({ text: x.label, sgr: x.blocked ? S.grey : S.bold });
          });
          p(spans);
        }
        blank();
        break;
      }
      case "sheet": {
        p([{ text: v.name, sgr: S.bold }]);
        p(
          ATTRIBUTES.flatMap((a, i) => [
            ...(i ? [{ text: " · ", sgr: S.grey }] : []),
            { text: `${ATTRIBUTE_NAMES[a]} ` },
            { text: String(v.special[a]), sgr: attrSgr(v.special[a], v.base[a]) },
          ]),
        );
        p([
          {
            text: Object.entries(v.derived)
              .map(([n, x]) => `${n} ${x}`)
              .join(" · "),
            sgr: S.grey,
          },
        ]);
        p([
          {
            text: Object.entries(v.skills)
              .map(
                ([s, x]) =>
                  `${SKILL_NAMES[s as keyof typeof SKILL_NAMES]}${v.tags.includes(s as never) ? "*" : ""} ${x}%`,
              )
              .join(" · "),
          },
        ]);
        break;
      }
      case "inventory":
        p([
          {
            text: v.items.length
              ? `You are carrying: ${v.items.join(", ")}.${v.equipped.length ? ` Ready: ${v.equipped.join(", ")}.` : ""} Money: £${v.money}.`
              : `You are carrying nothing. Money: £${v.money}.`,
          },
        ]);
        break;
      case "journal":
        if (!v.entries.length) p([{ text: "Your journal is empty. Days are written up when you sleep.", sgr: S.grey }]);
        for (const e of v.entries) {
          p([{ text: `Day ${e.day}`, sgr: S.yellow }]);
          p([{ text: e.text }], 2);
        }
        break;
      case "conversation":
        blank();
        for (const o of v.options) p(option(o.index + 1, o.text), 2);
        break;
      case "combat": {
        blank();
        p([
          { text: `Round ${v.round}`, sgr: S.red },
          ...(v.yourTurn ? [{ text: ` · ${v.ap} AP left`, sgr: S.grey }] : []),
        ]);
        for (const x of v.combatants) {
          p(
            [
              { text: x.side === "a" ? "▲ " : "▼ ", sgr: x.side === "a" ? S.green : S.red },
              { text: `${x.name} ` },
              ...bar(x.hp, x.maxHp, 10),
              { text: ` ${x.hp}/${x.maxHp}${x.status !== "in" ? ` (${x.status})` : ""}`, sgr: S.grey },
            ],
            2,
          );
        }
        if (v.yourTurn) for (const [i, o] of v.options.entries()) p(option(i + 1, o.label), 2);
        break;
      }
      case "menu":
        for (const [i, o] of v.items.entries()) p(option(i + 1, o.label), 2);
        break;
      case "create":
        p([
          { text: "Create your character. ", sgr: S.bold },
          {
            text: `Every attribute starts at 5; you have ${v.points} more points; each stays within ${v.min}–${v.max}. Enter seven numbers for ST PE EN CH IN AG LK (totalling 40), or a preset:`,
          },
        ]);
        for (const pr of v.presets)
          p(
            [
              { text: `${pr.name}: `, sgr: S.boldCyan },
              { text: ATTRIBUTES.map((a) => `${a} ${pr.special[a]}`).join(" ") },
            ],
            2,
          );
        break;
      case "help":
        p([{ text: v.text, sgr: S.grey }]);
        break;
      case "introduction":
        if (v.title) p([{ text: v.title, sgr: S.boldYellow }]);
        v.pages.forEach((page, i) => {
          if (i) p([{ text: "───", sgr: S.grey }]);
          out.push(...markdownParagraphs(page));
        });
        break;
      case "ended":
        blank();
        p([{ text: `— ${v.title ?? "The End"} —`, sgr: S.boldYellow }]);
        break;
      case "status":
      case "map":
      case "scene":
      case "fx":
        break;
    }
  }
  return out;
}

/** Light markdown (src/session/markdown.ts) as paragraphs, with a blank line between blocks. */
export function markdownParagraphs(src: string): Paragraph[] {
  const out: Paragraph[] = [];
  const runs = (rs: MdRun[], base = "") =>
    rs.map((r) => ({
      text: r.text,
      sgr: [base, r.bold ? S.bold : "", r.italic ? S.italic : ""].filter(Boolean).join(";"),
    }));
  for (const b of parseMarkdown(src)) {
    if (out.length) out.push({ spans: [] });
    switch (b.kind) {
      case "heading":
        out.push({ spans: runs(b.runs, b.level === 1 ? S.boldYellow : S.boldCyan) });
        break;
      case "paragraph":
        out.push({ spans: runs(b.runs) });
        break;
      case "quote":
        out.push({ spans: runs(b.runs, S.italic), indent: 4 });
        break;
      case "item":
        out.push({ spans: [{ text: `${b.marker} `, sgr: S.grey }, ...runs(b.runs)], indent: 2 });
        break;
      case "rule":
        out.push({ spans: [{ text: "───", sgr: S.grey }] });
        break;
    }
  }
  return out;
}

function option(n: number, text: string): Span[] {
  return [{ text: `${n}`, sgr: S.boldCyan }, { text: ". ", sgr: S.grey }, { text }];
}

export function attrSgr(now: number, base: number): string {
  return now > base ? S.green : now < base ? S.red : S.bold;
}

/** A horizontal gauge: filled cells coloured by how full it is. */
export function bar(value: number, max: number, width: number, invert = false): Span[] {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(frac * width);
  const health = invert ? 1 - frac : frac;
  const sgr = health > 0.6 ? S.green : health > 0.3 ? S.yellow : S.red;
  return [
    { text: "█".repeat(filled), sgr },
    { text: "░".repeat(width - filled), sgr: S.grey },
  ];
}
