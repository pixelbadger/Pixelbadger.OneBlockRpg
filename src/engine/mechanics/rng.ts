/**
 * Seeded PRNG (§3.8). All randomness in the engine flows through an Rng whose state lives in the world state,
 * so a save replays identically. sfc32: small, fast and well distributed.
 */
export type RngState = [number, number, number, number];

/** Hashes a seed string into a 128-bit initial state (cyrb128). */
export function seedState(seed: string): RngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const s: RngState = [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  const rng = new Rng(s);
  for (let i = 0; i < 15; i++) rng.next();
  return rng.state;
}

export class Rng {
  private s: RngState;

  constructor(state: RngState) {
    this.s = [...state];
  }

  get state(): RngState {
    return [...this.s];
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let [a, b, c, d] = this.s;
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.s = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Roll one die with `sides` faces: 1..sides. */
  die(sides: number): number {
    return this.int(1, sides);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)]!;
  }
}
