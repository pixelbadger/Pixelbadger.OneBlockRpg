/**
 * The scene: one canvas, redrawn every animation frame at the device's pixel ratio with the shared renderer. Clicks
 * and hovers are resolved to map tiles with the layout the last frame was drawn with.
 */
import { useEffect, useRef } from "preact/hooks";
import { css } from "../../../client/art.js";
import type { Scratch } from "../../../client/canvas.js";
import type { GameClient } from "../../../client/game-client.js";
import { drawScene } from "../../../client/scene.js";
import type { SpriteSheet } from "../../../client/sprites.js";
import { theme } from "../../../client/theme.js";
import { type SceneLayout, tileAt } from "../../../client/timeline.js";

/** What sprites decode to in the browser, and what recoloured ones are drawn on. */
export type WebImage = ImageBitmap | OffscreenCanvas;

export const decodePng = (bytes: Uint8Array): Promise<WebImage> =>
  createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));

const scratch: Scratch<WebImage> = (w, h) => {
  const image = new OffscreenCanvas(w, h);
  return { ctx: image.getContext("2d")!, image };
};

/** The biggest whole-number scale for the art, in CSS pixels' worth. */
const MAX_SCALE = 4;

export function SceneCanvas({ client, sprites }: { client: GameClient; sprites?: SpriteSheet<WebImage> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layout = useRef<SceneLayout | undefined>(undefined);
  const hovered = useRef("");

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const m = client.model;
      if (!m.scene || m.mode === "create") {
        ctx.fillStyle = css(theme.colours.background);
        ctx.fillRect(0, 0, w, h);
        layout.current = undefined;
        return;
      }
      const frame = client.frame(now);
      layout.current = drawScene<WebImage>(ctx, { x: 0, y: 0, w, h }, m.scene, {
        t: now,
        scratch,
        maxScale: Math.max(1, Math.round(MAX_SCALE * dpr)),
        ...(sprites ? { sprites } : {}),
        ...(frame ? { frame } : {}),
        ...(m.targeting ? { cursor: m.targeting.cursor } : {}),
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [client, sprites]);

  const tile = (e: MouseEvent) => {
    const l = layout.current;
    if (!l) return undefined;
    const r = ref.current!.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    return tileAt(l, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  };

  return (
    <canvas
      ref={ref}
      onClick={(e) => {
        const at = tile(e);
        if (at) client.pointer({ kind: "tile", tile: at, button: "primary" });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const at = tile(e);
        if (at) client.pointer({ kind: "tile", tile: at, button: "secondary" });
      }}
      onMouseMove={(e) => {
        const at = tile(e);
        if (!at || `${at}` === hovered.current || !client.model.targeting) return;
        hovered.current = `${at}`;
        client.pointer({ kind: "hover", tile: at });
      }}
    />
  );
}
