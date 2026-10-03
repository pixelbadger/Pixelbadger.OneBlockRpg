/**
 * Days are chapters (§6.8, §3.6). When the player sleeps, each character with activity gets one summary call in their
 * own perspective (independent, so they run in parallel). Summaries go at the front of later calls; raw logs stay in
 * the event log but never re-enter prompts after their day. An oversized day log is summarised early (safety valve).
 */
import { formatClock } from "../core/clock.js";
import { set } from "../core/ops.js";
import type { LogEntry } from "../core/state.js";
import type { World } from "../core/world.js";
import { complete } from "../llm/provider.js";
import { characterPart, ENGINE_RULES, storyPart, summariesPart } from "./context.js";
import type { NarrativeDeps } from "./conversation.js";
import { DaySummary } from "./schemas.js";

/** Characters' day logs larger than this (in characters) are partly summarised early. */
export const DAY_LOG_BUDGET = 16000;
const SUMMARY_WORDS = 250;

function logText(entries: readonly LogEntry[]): string {
  return entries.map((e) => `[${formatClock(e.at)}] (${e.kind}) ${e.text}`).join("\n");
}

/** Mechanical fallback when the provider fails: the first lines of the log, trimmed to the word budget. */
export function digest(entries: readonly LogEntry[], words = SUMMARY_WORDS): string {
  const all = entries.map((e) => e.text.split("\n")[0]!).join(" ");
  const ws = all.split(/\s+/).filter(Boolean);
  return ws.length > words ? `${ws.slice(0, words).join(" ")}…` : ws.join(" ");
}

async function summarise(
  d: NarrativeDeps,
  who: string,
  entries: readonly LogEntry[],
  partial: boolean,
): Promise<string> {
  const w = d.w;
  const isPlayer = who === w.playerId;
  const instruction = partial
    ? `Condense the earlier part of today below into a short note (≤ 120 words) in ${isPlayer ? "second person (you…)" : "first person, as yourself"}. Keep promises, suspicions and who did what.`
    : isPlayer
      ? `Write the player's journal entry for day ${w.state.day} in second person ("you…"), ≤ ${SUMMARY_WORDS} words: what happened, what you learned, who promised what, what you suspect.`
      : `Summarise your day ${w.state.day} in first person, as yourself, ≤ ${SUMMARY_WORDS} words: what you now think of people, what was promised, what you suspect. Only what you experienced.`;
  const r = await complete(
    d.provider,
    {
      purpose: "day-summary",
      system: [{ label: "engine", text: ENGINE_RULES }, storyPart(w), characterPart(w, who), summariesPart(w, who)],
      messages: [
        {
          role: "user",
          content: `## Your day ${w.state.day} log\n${logText(entries)}\n\n${instruction}\nReply as JSON: {"summary": "..."}`,
        },
      ],
      schema: DaySummary,
      maxOutputTokens: 1500,
    },
    d.onUsage,
  );
  return r.ok ? r.value.summary.trim() : digest(entries, partial ? 120 : SUMMARY_WORDS);
}

/** Closes the day: summaries for everyone with activity, then the day counter advances and logs are cleared. */
export async function endDay(d: NarrativeDeps): Promise<void> {
  const w = d.w;
  const day = w.state.day;
  const who = Object.entries(w.state.dayLogs)
    .filter(([id, log]) => log.length > 0 && w.isChar(id))
    .map(([id]) => id)
    .sort((a, b) => (a === w.playerId ? -1 : b === w.playerId ? 1 : a.localeCompare(b)));
  const texts = await Promise.all(who.map((id) => summarise(d, id, w.state.dayLogs[id]!, false)));
  // Applied in a fixed order, so replays are identical regardless of which call returned first.
  who.forEach((id, i) => {
    w.emit("day-summary", {
      targets: [id],
      payload: { day, text: texts[i] },
      ops: [{ op: "push", path: ["summaries", id], value: { day, text: texts[i] } }],
    });
  });
  w.emit("day-ended", { payload: { day }, ops: [set(["dayLogs"], {}), set(["day"], day + 1)] });
}

/** Safety valve (§6.8): summarise the older half of any day log that outgrows its budget. */
export async function compactDayLogs(d: NarrativeDeps): Promise<void> {
  const w = d.w;
  for (const [who, log] of Object.entries(w.state.dayLogs)) {
    if (logText(log).length <= DAY_LOG_BUDGET || log.length < 4) continue;
    const half = Math.floor(log.length / 2);
    const older = log.slice(0, half);
    const note = await summarise(d, who, older, true);
    const entry: LogEntry = { at: older[0]!.at, kind: "digest", text: `Earlier today: ${note}` };
    w.emit("day-log", {
      targets: [who],
      payload: { compacted: half },
      ops: [set(["dayLogs", who], [entry, ...log.slice(half)])],
    });
  }
}

/** The text for {{summaries.<who>.today}} and {{summaries.<who>.latest}} in callout prompts (§6.5). */
export function summaryVar(w: World, who: string, which: string): string {
  const sums = w.state.summaries[who] ?? [];
  if (which === "today") {
    const today = sums.find((s) => s.day === w.state.day);
    if (today) return today.text;
    const log = w.state.dayLogs[who] ?? [];
    if (log.length) return digest(log);
    return sums[sums.length - 1]?.text ?? "";
  }
  if (which === "latest") return sums[sums.length - 1]?.text ?? "";
  if (which === "all") return sums.map((s) => `Day ${s.day}: ${s.text}`).join("\n");
  return "";
}
