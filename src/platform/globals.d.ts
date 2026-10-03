/**
 * The globals every JavaScript host has (browsers, Node), for the layers that may not assume either: engine, platform
 * and client compile against ES2023 plus these alone (tsconfig.pure.json), so a stray `document` or `node:fs`
 * fails to build.
 */
declare var console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T): T;
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare var performance: { now(): number };
