/**
 * The drawing surface the shared client paints on: the subset of Canvas 2D it uses. The browser's
 * CanvasRenderingContext2D and @napi-rs/canvas's SKRSContext2D both satisfy it as they are, so one scene renderer
 * serves the web and native hosts.
 */

/** A host-decoded picture (an ImageBitmap, a Skia Image or a canvas); opaque to the client but for its size. */
export interface CanvasImage {
  readonly width: number;
  readonly height: number;
}

/** A Canvas 2D context drawing images of type `I` (whatever the host decodes sprites to). */
export interface Canvas2D<I extends CanvasImage = CanvasImage> {
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  imageSmoothingEnabled: boolean;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(
    image: I,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * An offscreen canvas of `w`×`h`, for recolouring sprites (night, ghosts, the dead) once and caching the result.
 * Web: an OffscreenCanvas and its context; native: `createCanvas(w, h)` and its context.
 */
export type Scratch<I extends CanvasImage> = (w: number, h: number) => { ctx: Canvas2D<I>; image: I };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
