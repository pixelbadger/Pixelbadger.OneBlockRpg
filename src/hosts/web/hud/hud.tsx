/**
 * The play screen: the scene with whatever floats over it and the log in the left column, the title, status and
 * the fight or the pack in the right. It re-renders whenever the client's model changes; keys go to the client.
 */
import { useEffect, useLayoutEffect, useReducer, useRef } from "preact/hooks";
import type { GameClient } from "../../../client/game-client.js";
import type { SpriteSheet } from "../../../client/sprites.js";
import { gaugeStyle } from "../../../client/text.js";
import { Floating } from "./float.js";
import { SceneCanvas, type WebImage } from "./scene.js";
import { Paras } from "./text.js";

type Props = { client: GameClient };

export function Hud({ client, sprites }: Props & { sprites?: SpriteSheet<WebImage> }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.onChange(() => redraw(undefined)), [client]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const handled = client.key({ key: e.key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
      if (handled) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [client]);
  const m = client.model;
  return (
    <div class="game">
      <div class="main">
        <div class={`scene panel${m.mode === "combat" ? " fight" : ""}`}>
          <SceneCanvas client={client} {...(sprites ? { sprites } : {})} />
          <Floating client={client} />
        </div>
        <Log client={client} />
      </div>
      <Side client={client} />
    </div>
  );
}

/**
 * The message log, newest at the foot. Its position follows the model's scroll (pages back from the newest); the
 * wheel, a drag or a touch scrolls it natively and is reported back as a scroll input, so the keys carry on from
 * there. A scroll past the top is clamped the same way.
 */
function Log({ client }: Props) {
  const m = client.model;
  const lines = useRef<HTMLDivElement>(null);
  const report = () => {
    const el = lines.current;
    if (!el?.clientHeight) return;
    const back = (el.scrollHeight - el.clientHeight - el.scrollTop) / el.clientHeight;
    if (Math.abs(back - client.model.scroll) > 0.01)
      client.pointer({ kind: "scroll", delta: back - client.model.scroll });
  };
  useLayoutEffect(() => {
    const el = lines.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight - m.scroll * el.clientHeight;
    report();
  });
  return (
    <div class="log panel">
      <div class="lines" ref={lines} onScroll={report} role="log" aria-live="polite">
        <Paras lines={m.log} />
      </div>
      <div class="prompt style-muted">{m.busy ? "…" : (m.prompt ?? "")}</div>
    </div>
  );
}

function Gauge({ label, value, max, fill }: { label: string; value: number; max: number; fill?: string }) {
  const style = gaugeStyle(value, max);
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div class="gauge">
      <span class="style-plain">{label}</span>
      <div class="bar" aria-hidden="true">
        <div style={{ width: `${pct}%`, background: `var(--ob-bar-${fill ?? style})` }} />
      </div>
      <span class={`value style-${style}`}>
        {value}/{max}
      </span>
    </div>
  );
}

function Side({ client }: Props) {
  const m = client.model;
  const s = m.status;
  const c = m.combat;
  const apMax = Number(m.sheet?.derived.AP ?? c?.ap ?? 0);
  return (
    <aside class="side panel">
      <h1 class="style-title">{m.title}</h1>
      {s && (
        <section aria-label="Status">
          <p class="style-strong">{s.clock}</p>
          <Gauge label="HP" value={s.hp} max={s.maxHp} />
          {c && <Gauge label="AP" value={c.ap} max={Math.max(apMax, c.ap)} fill="ap" />}
          <p>
            <span class="style-objective">£{s.money}</span>
          </p>
          <p>
            <span class="style-strong">Level {s.level}</span>
            <span class="style-muted"> · {s.xp} XP</span>
            {s.unspentSkillPoints > 0 && <span class="style-warning"> · +{s.unspentSkillPoints} (Z)</span>}
          </p>
          {s.sneaking && <p class="style-warning">Sneaking</p>}
        </section>
      )}
      {c ? (
        <section aria-label="Fight">
          <h2 class="style-danger">Round {c.round}</h2>
          <ul class="roster">
            {c.combatants.map((x) => (
              <li key={x.id}>
                <span class={x.side === "a" ? "style-good" : "style-danger"}>{x.side === "a" ? "▲" : "▼"}</span>
                <span class={x.status === "in" ? "style-plain" : "style-muted"}>
                  {x.name}
                  {x.status !== "in" && ` (${x.status})`}
                </span>
                <span class={`style-${gaugeStyle(x.hp, x.maxHp)}`}>
                  {x.hp}/{x.maxHp}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        m.inventory && (
          <section aria-label="Pack">
            <h2 class="style-heading">Pack</h2>
            {m.inventory.entries?.length ? (
              <ul>
                {m.inventory.entries.map((it) => (
                  <li key={it.id}>
                    <span class={it.equipped ? "style-strong" : "style-plain"}>{it.name}</span>
                    {it.equipped && <span class="style-good"> (ready)</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p class="style-muted">Nothing.</p>
            )}
          </section>
        )
      )}
    </aside>
  );
}
