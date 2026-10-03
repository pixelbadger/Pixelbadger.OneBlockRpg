/** Styled text: the client's paragraphs as HTML, a span per run with the theme's class for its style. */
import type { Paragraph, Span } from "../../../client/text.js";

export function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} class={`style-${s.style}`}>
          {s.text}
        </span>
      ))}
    </>
  );
}

export function Para({ p }: { p: Paragraph }) {
  if (!p.spans.length) return <p class="blank" />;
  return (
    <p style={p.indent ? { paddingLeft: `${p.indent}ch` } : undefined}>
      <Spans spans={p.spans} />
    </p>
  );
}

export function Paras({ lines }: { lines: readonly Paragraph[] }) {
  return (
    <>
      {lines.map((p, i) => (
        <Para key={i} p={p} />
      ))}
    </>
  );
}
