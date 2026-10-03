/**
 * What floats over the scene, centred: the open menu (conversation options among them), an overlay (sheet, journal,
 * help, the paged introduction), the custom-character screen and the ending. A click sends the PointerInput the
 * matching key would.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import type { GameClient } from "../../../client/game-client.js";
import type { Menu, Model, Overlay } from "../../../client/model.js";
import { ATTRIBUTE_NAMES } from "../../../engine/mechanics/special.js";
import { ATTRIBUTES } from "../../../engine/payload/schema.js";
import { Paras } from "./text.js";

type Props = { client: GameClient };

/** Whatever floats over the scene now, with the scrim under it where the scene is set aside. */
export function Floating({ client }: Props) {
  const m = client.model;
  const box = m.ended ? (
    <Ended client={client} />
  ) : m.overlay ? (
    <OverlayBox client={client} o={m.overlay} />
  ) : m.allot ? (
    <Allot client={client} />
  ) : m.menu ? (
    <MenuBox client={client} menu={m.menu} />
  ) : null;
  if (!box) return null;
  return (
    <>
      {scrimmed(m) && <div class="scrim" />}
      {box}
    </>
  );
}

/** The scene is dimmed under overlays, while creating a character and at the end; menus leave it in view. */
const scrimmed = (m: Model) => !!m.overlay || m.mode === "create" || m.mode === "ended";

function MenuBox({ client, menu }: Props & { menu: Menu }) {
  const m = client.model;
  const talk = m.mode === "conversation" && menu.sticky ? m.conversation : undefined;
  const choose = (i: number) =>
    client.pointer(talk ? { kind: "option", index: talk.options[i]!.index } : { kind: "menu", index: i });
  return (
    <div class="float" role="dialog" aria-label={menu.title}>
      <h2 class="style-title">{menu.title}</h2>
      <ul class="rows">
        {menu.items.map((it, i) => (
          <li key={i}>
            <button
              type="button"
              class={i === menu.index ? "row selected" : "row"}
              aria-current={i === menu.index}
              onClick={() => choose(i)}
            >
              <span>
                <span class="style-choice">{i + 1}</span>
                <span class="style-muted">. </span>
                <span class="style-plain">{it.label}</span>
              </span>
              {it.detail && <span class="detail style-muted">{it.detail}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OverlayBox({ client, o }: Props & { o: Overlay }) {
  const body = useRef<HTMLDivElement>(null);
  const paged = o.pages && o.pages.length > 1;
  const page = o.page ?? 0;
  const last = !o.pages || page >= o.pages.length - 1;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.scrollTop = (o.offset ?? 0) * Number.parseFloat(getComputedStyle(el).lineHeight || "0");
  });
  const act = (action: "next" | "prev" | "close") => client.pointer({ kind: "overlay", action });
  return (
    <div class="float" role="dialog" aria-label={o.title}>
      <h2 class="style-title">{o.title}</h2>
      <div class="body" ref={body}>
        <Paras lines={o.lines} />
      </div>
      {o.skills && (
        <ul class="rows" aria-label="Raise a skill">
          {o.skills.map((sk, i) => (
            <li key={sk.id}>
              <button
                type="button"
                class={i === o.index ? "row selected" : "row"}
                aria-current={i === o.index}
                onClick={() => client.pointer({ kind: "skill", index: i })}
              >
                <span class="style-plain">{sk.label}</span>
                <span class="detail style-muted">raise</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="foot">
        {paged && (
          <>
            <span class="style-muted">
              {page + 1} / {o.pages!.length}
            </span>
            <span class="spacer" />
            <button type="button" class="button" disabled={page === 0} onClick={() => act("prev")}>
              ‹ Back
            </button>
          </>
        )}
        <button type="button" class="button primary" onClick={() => act(paged && !last ? "next" : "close")}>
          {paged && !last ? "Next ›" : "Close"}
        </button>
      </div>
    </div>
  );
}

function Allot({ client }: Props) {
  const m = client.model;
  const a = m.allot!;
  const c = m.create;
  const total = ATTRIBUTES.length * 5 + (c?.points ?? 0);
  const left = total - ATTRIBUTES.reduce((s, x) => s + a.special[x], 0);
  const allot = (action: "select" | "raise" | "lower" | "done" | "cancel", index?: number) =>
    client.pointer({ kind: "allot", action, ...(index === undefined ? {} : { index }) });
  return (
    <div class="float" role="dialog" aria-label="Make your own">
      <h2 class="style-title">Make your own</h2>
      <div class="body">
        <p class="style-muted">
          Each attribute stays within {c?.min ?? 1}–{c?.max ?? 10}. Arrows or the buttons.
        </p>
      </div>
      <ul class="rows allot">
        {ATTRIBUTES.map((x, i) => (
          <li key={x} class={i === a.index ? "selected" : undefined}>
            <button type="button" class="row" aria-current={i === a.index} onClick={() => allot("select", i)}>
              <span class="style-plain">{ATTRIBUTE_NAMES[x]}</span>
            </button>
            <button
              type="button"
              class="button"
              aria-label={`Lower ${ATTRIBUTE_NAMES[x]}`}
              onClick={() => allot("lower", i)}
            >
              −
            </button>
            <span class="value style-strong">{a.special[x]}</span>
            <button
              type="button"
              class="button"
              aria-label={`Raise ${ATTRIBUTE_NAMES[x]}`}
              onClick={() => allot("raise", i)}
            >
              +
            </button>
          </li>
        ))}
      </ul>
      <div class="foot">
        <span class={left ? "style-warning" : "style-good"}>{left} points left</span>
        <span class="spacer" />
        <button type="button" class="button" onClick={() => allot("cancel")}>
          Cancel
        </button>
        <button type="button" class="button primary" disabled={left !== 0} onClick={() => allot("done")}>
          Done
        </button>
      </div>
    </div>
  );
}

function Ended({ client }: Props) {
  const e = client.model.ended!;
  return (
    <div class="float" role="dialog" aria-label={e.title ?? "The End"}>
      <h2 class="style-title">— {e.title ?? "The End"} —</h2>
      <div class="body">
        <p class="style-strong">{e.text}</p>
      </div>
      <div class="foot">
        <button type="button" class="button primary" onClick={() => client.key({ key: "Enter" })}>
          Back to the title
        </button>
      </div>
    </div>
  );
}
