/**
 * Text for the panels: session view models and light markdown as paragraphs of spans in semantic styles. Hosts map
 * each style to a look from theme.ts (a CSS class on the web, a paint natively) and wrap the text themselves.
 */

import { ATTRIBUTE_NAMES, SKILL_NAMES } from "../engine/mechanics/special.js";
import { ATTRIBUTES } from "../engine/payload/schema.js";
import { type MdRun, parseMarkdown } from "../engine/session/markdown.js";
import type { ViewModel } from "../engine/session/port.js";

/** Every way text is styled. theme.ts gives each a colour and weight. */
export const TEXT_STYLES = [
  /** Prose. */
  "plain",
  /** System messages, checks, hints, separators and secondary figures. */
  "muted",
  /** Bold prose: an ending, a name, markdown `**bold**`. */
  "strong",
  /** Italic prose: markdown `*italic*`. */
  "emphasis",
  /** A room's name, a page or an ending's title. */
  "title",
  /** Markdown `#`, and journal days. */
  "heading",
  /** Markdown `##` and `###`. */
  "subheading",
  /** A markdown `>` quote. */
  "quote",
  /** Who is speaking, before their line. */
  "speaker",
  /** A spoken line. */
  "speech",
  /** Background goings-on. */
  "ambient",
  /** People present. */
  "person",
  /** The current objective. */
  "objective",
  /** A payload callout (§6): a beat the story wants noticed. */
  "callout",
  /** An option's number. */
  "choice",
  /** Combat, errors, enemies, a worsened attribute, a low gauge. */
  "danger",
  /** Allies, an improved attribute, a full gauge. */
  "good",
  /** Something to attend to: unspent points, a gauge half gone. */
  "warning",
] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

export interface Span {
  text: string;
  style: TextStyle;
}

/** One logical block of text; hosts wrap it to their width. */
export interface Paragraph {
  spans: Span[];
  /** Indent in character widths (the font is monospace). */
  indent?: number;
}

const span = (text: string, style: TextStyle = "plain"): Span => ({ text, style });

/** View model types the HUD shows in their own panels, so a compact log leaves them out. */
const ELSEWHERE = new Set<ViewModel["type"]>([
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

/** Turns session output into paragraphs. `compact` keeps the prose for the log and leaves the panels' views out. */
export function toParagraphs(views: readonly ViewModel[], opts: { compact?: boolean } = {}): Paragraph[] {
  const out: Paragraph[] = [];
  const p = (spans: Span[], indent?: number) => out.push(indent ? { spans, indent } : { spans });
  const blank = () => {
    if (out.length && out[out.length - 1]!.spans.length) p([]);
  };
  for (const v of views) {
    if (opts.compact && ELSEWHERE.has(v.type)) continue;
    switch (v.type) {
      case "narration":
        switch (v.kind) {
          case "speech":
            p([span(`${v.speaker ?? ""}: `, "speaker"), span(`“${v.text}”`, "speech")]);
            break;
          case "system":
          case "check":
            p([span(v.text, "muted")]);
            break;
          case "ambient":
            p([span(v.text, "ambient")]);
            break;
          case "combat":
            p([span(v.text, "danger")]);
            break;
          case "callout":
            p([span(v.text, "callout")], 2);
            break;
          case "journal":
            p([span("Journal", "heading")]);
            p([span(v.text)], 2);
            break;
          case "ending":
            blank();
            p([span(v.text, "strong")]);
            break;
          default:
            p([span(v.text)]);
        }
        break;
      case "room": {
        const r = v.room;
        blank();
        p([span(r.name, "title")]);
        p([span(r.description)]);
        if (v.objective) p([span("Objective: ", "objective"), span(v.objective, "objective")]);
        for (const o of r.objects) p([span(o)]);
        for (const x of r.people) p([span(x, "person")]);
        if (r.exits.length && !opts.compact) {
          const spans: Span[] = [span("Exits: ", "muted")];
          r.exits.forEach((x, i) => {
            if (i) spans.push(span(", ", "muted"));
            spans.push(span(x.label, x.blocked ? "muted" : "strong"));
          });
          p(spans);
        }
        blank();
        break;
      }
      case "sheet":
        p([span(v.name, "strong")]);
        p(
          ATTRIBUTES.flatMap((a, i) => [
            ...(i ? [span(" · ", "muted")] : []),
            span(`${ATTRIBUTE_NAMES[a]} `),
            span(String(v.special[a]), attrStyle(v.special[a], v.base[a])),
          ]),
        );
        p([
          span(
            Object.entries(v.derived)
              .map(([n, x]) => `${n} ${x}`)
              .join(" · "),
            "muted",
          ),
        ]);
        p([
          span(
            Object.entries(v.skills)
              .map(
                ([s, x]) =>
                  `${SKILL_NAMES[s as keyof typeof SKILL_NAMES]}${v.tags.includes(s as never) ? "*" : ""} ${x}%`,
              )
              .join(" · "),
          ),
        ]);
        break;
      case "inventory":
        p([
          span(
            v.items.length
              ? `You are carrying: ${v.items.join(", ")}.${v.equipped.length ? ` Ready: ${v.equipped.join(", ")}.` : ""} Money: £${v.money}.`
              : `You are carrying nothing. Money: £${v.money}.`,
          ),
        ]);
        break;
      case "journal":
        if (!v.entries.length) p([span("Your journal is empty. Days are written up when you sleep.", "muted")]);
        for (const e of v.entries) {
          p([span(`Day ${e.day}`, "heading")]);
          p([span(e.text)], 2);
        }
        break;
      case "conversation":
        blank();
        for (const o of v.options) p(option(o.index + 1, o.text), 2);
        break;
      case "combat":
        blank();
        p([span(`Round ${v.round}`, "danger"), ...(v.yourTurn ? [span(` · ${v.ap} AP left`, "muted")] : [])]);
        for (const x of v.combatants) {
          p(
            [
              span(x.side === "a" ? "▲ " : "▼ ", x.side === "a" ? "good" : "danger"),
              span(`${x.name} `),
              span(`${x.hp}/${x.maxHp}`, gaugeStyle(x.hp, x.maxHp)),
              ...(x.status !== "in" ? [span(` (${x.status})`, "muted")] : []),
            ],
            2,
          );
        }
        if (v.yourTurn) for (const [i, o] of v.options.entries()) p(option(i + 1, o.label), 2);
        break;
      case "menu":
        for (const [i, o] of v.items.entries()) p(option(i + 1, o.label), 2);
        break;
      case "create":
        p([
          span("Create your character. ", "strong"),
          span(
            `Every attribute starts at 5; you have ${v.points} more points; each stays within ${v.min}–${v.max}. Enter seven numbers for ST PE EN CH IN AG LK (totalling 40), or a preset:`,
          ),
        ]);
        for (const pr of v.presets) {
          p([span(`${pr.name}: `, "speaker"), span(ATTRIBUTES.map((a) => `${a} ${pr.special[a]}`).join(" "))], 2);
        }
        break;
      case "help":
        p([span(v.text, "muted")]);
        break;
      case "introduction":
        if (v.title) p([span(v.title, "title")]);
        v.pages.forEach((page, i) => {
          if (i) p([span("───", "muted")]);
          out.push(...markdownParagraphs(page));
        });
        break;
      case "ended":
        blank();
        p([span(`— ${v.title ?? "The End"} —`, "title")]);
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

/** Light markdown (src/engine/session/markdown.ts) as paragraphs, with a blank one between blocks. */
export function markdownParagraphs(src: string): Paragraph[] {
  const out: Paragraph[] = [];
  // Emphasis inside a heading stays the heading; elsewhere bold beats italic.
  const runs = (rs: MdRun[], base: TextStyle = "plain", keep = false) =>
    rs.map((r) => span(r.text, keep ? base : r.bold ? "strong" : r.italic ? "emphasis" : base));
  for (const b of parseMarkdown(src)) {
    if (out.length) out.push({ spans: [] });
    switch (b.kind) {
      case "heading":
        out.push({ spans: runs(b.runs, b.level === 1 ? "heading" : "subheading", true) });
        break;
      case "paragraph":
        out.push({ spans: runs(b.runs) });
        break;
      case "quote":
        out.push({ spans: runs(b.runs, "quote"), indent: 4 });
        break;
      case "item":
        out.push({ spans: [span(`${b.marker} `, "muted"), ...runs(b.runs)], indent: 2 });
        break;
      case "rule":
        out.push({ spans: [span("───", "muted")] });
        break;
    }
  }
  return out;
}

function option(n: number, text: string): Span[] {
  return [span(`${n}`, "choice"), span(". ", "muted"), span(text)];
}

/** An attribute against its base: raised, lowered (by a condition or an injury) or as born. */
export function attrStyle(now: number, base: number): TextStyle {
  return now > base ? "good" : now < base ? "danger" : "strong";
}

/** A gauge's colour by how full it is (`invert` for gauges where full is bad, like hours awake). */
export function gaugeStyle(value: number, max: number, invert = false): "good" | "warning" | "danger" {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const health = invert ? 1 - frac : frac;
  return health > 0.6 ? "good" : health > 0.3 ? "warning" : "danger";
}

/** The plain text of some spans. */
export const plain = (spans: readonly Span[]): string => spans.map((s) => s.text).join("");

/**
 * Wraps spans to `width` (in the units `measure` returns: pixels for a canvas), breaking at spaces and on "\n", and
 * hard-splitting a word longer than a line. Styles carry across breaks. For hosts that lay out text themselves;
 * the DOM wraps on its own.
 */
export function wrapSpans(spans: readonly Span[], width: number, measure: (s: string) => number): Span[][] {
  const lines: Span[][] = [];
  const space = measure(" ");
  let line: Span[] = [];
  let used = 0;
  let pending: Span | null = null;
  const newline = () => {
    lines.push(line);
    line = [];
    used = 0;
    pending = null;
  };
  const push = (text: string, style: TextStyle) => {
    const last = line[line.length - 1];
    if (last && last.style === style) last.text += text;
    else line.push({ text, style });
  };
  for (const s of spans) {
    for (const part of s.text.split(/(\n|[ \t]+)/)) {
      if (!part) continue;
      if (part === "\n") {
        newline();
        continue;
      }
      if (/^[ \t]+$/.test(part)) {
        if (used > 0) pending = span(" ", s.style);
        continue;
      }
      let word = part;
      let w = measure(word);
      const gap = pending as Span | null;
      if (used > 0 && used + (gap ? space : 0) + w > width) newline();
      else if (gap && used > 0) {
        push(" ", gap.style);
        used += space;
      }
      pending = null;
      while (used + w > width) {
        // A word longer than a whole line: hard-split it (at least one character a line).
        const chars = [...word];
        let take = 1;
        while (take < chars.length && used + measure(chars.slice(0, take + 1).join("")) <= width) take++;
        push(chars.slice(0, take).join(""), s.style);
        word = chars.slice(take).join("");
        newline();
        if (!word) break;
        w = measure(word);
      }
      if (word) {
        push(word, s.style);
        used += w;
      }
    }
  }
  if (line.length || lines.length === 0) newline();
  return lines;
}
