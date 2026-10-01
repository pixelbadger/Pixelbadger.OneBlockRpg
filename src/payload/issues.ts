import type { z } from "zod";

/** A validation finding (§7.7): file, path and a suggested fix, so a coding agent can iterate on its own. */
export interface PayloadIssue {
  severity: "error" | "warning";
  file: string;
  /** Dotted path inside the file, e.g. `exits[0].to`. */
  path: string;
  message: string;
  fix?: string;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

export function formatIssue(i: PayloadIssue): string {
  const where = i.path ? `${i.file}: ${i.path}` : i.file;
  return `${i.severity === "error" ? "error" : "warn "} ${where}: ${i.message}${i.fix ? `\n      fix: ${i.fix}` : ""}`;
}

type RawIssue = z.core.$ZodIssue;

interface Flat {
  path: PropertyKey[];
  message: string;
  fix?: string;
}

/**
 * Flattens zod issues into readable ones. Conditions and effects are unions of single-key objects, and zod reports
 * a failed union as every branch's errors. We pick the branch whose key is actually present, or say which keys exist.
 */
export function flattenZodIssues(issues: readonly RawIssue[], base: PropertyKey[] = []): Flat[] {
  const out: Flat[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const branches = issue.errors;
      const matching = branches.filter(
        (b) =>
          !b.some((e) => e.code === "unrecognized_keys" && e.path.length === 0) &&
          !b.some((e) => e.code === "invalid_type" && e.path.length === 1 && e.message.includes("received undefined")),
      );
      if (matching.length > 0) {
        const best = matching.reduce((a, b) => (b.length < a.length ? b : a));
        out.push(...flattenZodIssues(best, path));
        continue;
      }
      const keys = new Set<string>();
      for (const b of branches) {
        // Each single-key branch fails first on its own key being absent.
        const first = b.find(
          (e) =>
            e.path.length === 1 &&
            (e.code === "invalid_union" ||
              e.code === "invalid_value" ||
              (e.code === "invalid_type" && e.message.includes("received undefined"))),
        );
        if (first) keys.add(String(first.path[0]));
      }
      if (keys.size > 0) {
        const list = [...keys];
        out.push({
          path,
          message: `expected an object with exactly one of these keys: ${list.join(", ")}`,
          fix: "check the key name for typos against spec §7.5 (conditions and effects)",
        });
      } else {
        const expected = branches
          .flatMap((b) => b.filter((e) => e.code === "invalid_type").map((e) => (e as { expected: string }).expected))
          .filter((v, i, a) => a.indexOf(v) === i);
        out.push({ path, message: `invalid value; expected ${expected.join(" or ") || "a different shape"}` });
      }
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      out.push({
        path,
        message: `unknown key(s): ${issue.keys.join(", ")}`,
        fix: "remove the key or fix its spelling; payload objects are strict",
      });
      continue;
    }
    out.push({ path, message: issue.message });
  }
  // De-duplicate identical messages at identical paths.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${formatPath(f.path)}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
