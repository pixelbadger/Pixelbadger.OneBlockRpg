/**
 * Light markdown for authored long-form text (the introduction, §7.2): parsed here into display-neutral blocks of
 * styled runs, so every frontend draws it its own way. The subset: `#`–`###` headings, paragraphs (lines joined until
 * a blank line), `>` quotes, `-`/`*` and `1.` list items, `---` rules, and inline `**bold**`, `*italic*` or
 * `_italic_`. A backslash escapes a marker (`\*`). Anything else is plain text.
 */

export interface MdRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3; runs: MdRun[] }
  | { kind: "paragraph"; runs: MdRun[] }
  | { kind: "quote"; runs: MdRun[] }
  | { kind: "item"; marker: string; runs: MdRun[] }
  | { kind: "rule" };

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", runs: parseInline(para.join(" ")) });
    if (quote.length) blocks.push({ kind: "quote", runs: parseInline(quote.join(" ")) });
    para = [];
    quote = [];
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const quoted = line.match(/^>\s?(.*)$/);
    const item = line.match(/^([-*]|\d+[.)])\s+(.*)$/);
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, runs: parseInline(heading[2]!) });
    } else if (quoted) {
      if (para.length) flush();
      quote.push(quoted[1]!);
    } else if (item) {
      flush();
      const marker = /\d/.test(item[1]!) ? item[1]!.replace(")", ".") : "•";
      blocks.push({ kind: "item", marker, runs: parseInline(item[2]!) });
    } else {
      if (quote.length) flush();
      // A line right after a list item continues it.
      const last = blocks[blocks.length - 1];
      if (!para.length && last?.kind === "item" && /^\s/.test(raw)) {
        last.runs.push({ text: " " }, ...parseInline(line));
      } else para.push(line);
    }
  }
  flush();
  return blocks;
}

/** Inline emphasis: `**bold**`, `*italic*`, `_italic_` (nestable), with `\` escaping a marker. */
export function parseInline(text: string): MdRun[] {
  const runs: MdRun[] = [];
  let bold = false;
  let italic: "*" | "_" | null = null;
  let buf = "";
  const emit = () => {
    if (!buf) return;
    const prev = runs[runs.length - 1];
    if (prev && !!prev.bold === bold && !!prev.italic === !!italic) prev.text += buf;
    else runs.push({ text: buf, ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}) });
    buf = "";
  };
  // A marker opens only before a non-space and with a closer later on (unescaped, after a non-space), so "2 * 3"
  // and a lone asterisk stay literal.
  const closes = (from: number, marker: string) => {
    for (let at = text.indexOf(marker, from); at >= 0; at = text.indexOf(marker, at + 1)) {
      if (at > from && !/[\s\\]/.test(text[at - 1]!)) return true;
    }
    return false;
  };
  const opens = (at: number, marker: string) =>
    /\S/.test(text[at + marker.length] ?? "") && closes(at + marker.length, marker);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && /[*_\\]/.test(text[i + 1] ?? "")) {
      buf += text[++i];
      continue;
    }
    if (ch === "*" && text[i + 1] === "*" && (bold || opens(i, "**"))) {
      emit();
      bold = !bold;
      i++;
      continue;
    }
    if ((ch === "*" || ch === "_") && (italic === ch || (!italic && opens(i, ch)))) {
      // `_` inside a word (snake_case) is not emphasis.
      const inWord = ch === "_" && /\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "");
      if (!inWord) {
        emit();
        italic = italic ? null : ch;
        continue;
      }
    }
    buf += ch;
  }
  emit();
  return runs;
}
