/** Plain-text rendering of view models for the readline CLI. The only place that formats for a display (§3.1). */

import { ATTRIBUTE_NAMES, SKILL_NAMES } from "../mechanics/special.js";
import { ATTRIBUTES } from "../payload/schema.js";
import type { ViewModel } from "../session/port.js";

const WIDTH = 100;

export function wrap(text: string, width = WIDTH, indent = ""): string {
  return text
    .split("\n")
    .map((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let line = indent;
      for (const word of words) {
        if (line.trim() && line.length + word.length + 1 > width) {
          lines.push(line);
          line = indent;
        }
        line += (line.trim() ? " " : "") + word;
      }
      if (line.trim()) lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

export function render(views: readonly ViewModel[], color = true): string {
  const k = color ? c : { bold: id, dim: id, italic: id, cyan: id, yellow: id, red: id, magenta: id };
  const out: string[] = [];
  for (const v of views) {
    switch (v.type) {
      case "narration":
        if (v.kind === "speech") out.push(wrap(`${k.bold(v.speaker ?? "")}: “${v.text}”`));
        else if (v.kind === "system" || v.kind === "check") out.push(k.dim(wrap(v.text)));
        else if (v.kind === "ambient") out.push(k.italic(wrap(v.text)));
        else if (v.kind === "combat") out.push(k.red(wrap(v.text)));
        else if (v.kind === "callout") out.push(k.magenta(wrap(v.text, WIDTH, "  ")));
        else if (v.kind === "journal") out.push(`${k.yellow("Journal")}\n${wrap(v.text, WIDTH, "  ")}`);
        else if (v.kind === "ending") out.push(`\n${k.bold(wrap(v.text))}`);
        else out.push(wrap(v.text));
        break;
      case "room": {
        const r = v.room;
        const lines = [`\n${k.bold(k.cyan(r.name))}`, wrap(r.description)];
        if (v.objective) lines.push(k.yellow(`Objective: ${v.objective}`));
        for (const o of r.objects) lines.push(wrap(o));
        for (const p of r.people) lines.push(wrap(p));
        if (r.exits.length) lines.push(k.dim(`Exits: ${r.exits.map((x) => x.label).join(", ")}`));
        out.push(lines.join("\n"));
        break;
      }
      case "status":
        out.push(
          k.dim(
            `[${v.clock} · HP ${v.hp}/${v.maxHp} · awake ${v.awakeHours}/${v.wakingHours}h · £${v.money} · L${v.level} ${v.xp} XP${v.unspentSkillPoints ? ` · ${v.unspentSkillPoints} skill points` : ""}]`,
          ),
        );
        break;
      case "sheet": {
        const attrs = ATTRIBUTES.map(
          (a) => `${ATTRIBUTE_NAMES[a]} ${v.special[a]}${v.special[a] !== v.base[a] ? ` (${v.base[a]})` : ""}`,
        );
        const derived = Object.entries(v.derived).map(([n, x]) => `${n} ${x}`);
        const skills = Object.entries(v.skills).map(
          ([s, x]) => `${SKILL_NAMES[s as keyof typeof SKILL_NAMES]}${v.tags.includes(s as never) ? "*" : ""} ${x}%`,
        );
        out.push(`${k.bold(v.name)}\n${attrs.join(" · ")}\n${derived.join(" · ")}\n${wrap(skills.join(" · "))}`);
        break;
      }
      case "inventory":
        out.push(
          v.items.length
            ? `You are carrying: ${v.items.join(", ")}.${v.equipped.length ? ` Ready: ${v.equipped.join(", ")}.` : ""} Money: £${v.money}.`
            : `You are carrying nothing. Money: £${v.money}.`,
        );
        break;
      case "journal":
        out.push(
          v.entries.length
            ? v.entries.map((e) => `${k.yellow(`Day ${e.day}`)}\n${wrap(e.text, WIDTH, "  ")}`).join("\n")
            : "Your journal is empty. Days are written up when you sleep.",
        );
        break;
      case "conversation":
        out.push(v.options.map((o) => `  ${k.cyan(String(o.index + 1))}. ${o.text}`).join("\n"));
        break;
      case "combat": {
        const rows = v.combatants.map(
          (x) =>
            `  ${x.side === "a" ? "▲" : "▼"} ${x.name}: ${x.hp}/${x.maxHp} HP${x.status !== "in" ? ` (${x.status})` : ""}`,
        );
        out.push(`${k.red(`Round ${v.round}`)}${v.yourTurn ? ` · ${v.ap} AP left` : ""}\n${rows.join("\n")}`);
        if (v.yourTurn) out.push(v.options.map((o, i) => `  ${k.cyan(String(i + 1))}. ${o.label}`).join("\n"));
        break;
      }
      case "menu":
        out.push(v.items.map((o, i) => `  ${k.cyan(String(i + 1))}. ${o.label}`).join("\n"));
        break;
      case "create":
        out.push(
          `${k.bold("Create your character.")} Every attribute starts at 5; you have ${v.points} more points; each stays within ${v.min}–${v.max}.\n` +
            `Enter seven numbers for ST PE EN CH IN AG LK (totalling 40), or a preset:\n` +
            v.presets.map((p) => `  ${p.name}: ${ATTRIBUTES.map((a) => `${a} ${p.special[a]}`).join(" ")}`).join("\n"),
        );
        break;
      case "help":
        out.push(v.text);
        break;
      case "ended":
        out.push(`\n${k.bold(`— ${v.title ?? "The End"} —`)}`);
        break;
    }
  }
  return out.join("\n");
}

function id(s: string) {
  return s;
}
