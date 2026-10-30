/**
 * Shared grammar for a single host/path segment used across firewall
 * base URL validation, permission rule path validation, and runtime URL
 * matching.
 *
 * Grammar mirrors crates/runner/mitm-addon/src/firewall_matching/patterns.py::parse_segment —
 * keep both implementations in lockstep. Any change to accepted or rejected
 * forms must land in both languages and the shared contract fixture at once:
 * turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json.
 *
 * Accepted forms:
 *   - Plain literal (no braces).
 *   - `{name}`                  pure parameter.
 *   - `{name}suffix`            parameter + literal suffix.
 *   - `prefix{name}`            literal prefix + parameter.
 *   - `prefix{name}suffix`      literal prefix + parameter + literal suffix.
 *   - `{name:digits}`           whole rule-path segment of ASCII digits.
 *     Constraints are not supported in base URLs or mixed/greedy segments.
 *     A colon reserves the constraint suffix; unknown constraints are errors.
 *   - Unconstrained parameter names are opaque non-empty text without colons and may carry a
 *     trailing `+` or `*` for greedy matching;
 *     greedy is only valid in positions the caller allows (leftmost host
 *     segment, or last rule-path segment). Greedy names must NOT appear in
 *     mixed segments — that combination is reserved.
 *
 * Rejected forms (error kind with a specific reason):
 *   - `{}` / `prefix{}suffix`   empty parameter name.
 *   - `{a}{b}`                  adjacent parameters in one segment.
 *   - `{a}.{b}`                 literal-separated parameters in one segment.
 *   - `{name` / `name}`         unbalanced brace.
 *
 * Match-time semantics for mixed segments (carried by `param` result):
 *   - The runtime segment must startsWith(prefix) AND endsWith(suffix)
 *     AND length > prefix.length + suffix.length (middle must be non-empty).
 *   - Captured value is the middle slice.
 */

const ERROR_HINT =
  'use "{name}", "prefix{name}", "{name}suffix", or "prefix{name}suffix"';

type SegmentParseResult =
  | { kind: "literal"; value: string }
  | {
      kind: "param";
      prefix: string;
      name: string;
      suffix: string;
      greedy: "" | "+" | "*";
      constraint?: "digits";
    }
  | { kind: "error"; reason: string };

export function parseSegment(seg: string): SegmentParseResult {
  const openCount = countChar(seg, "{");
  const closeCount = countChar(seg, "}");

  if (openCount === 0 && closeCount === 0) {
    return { kind: "literal", value: seg };
  }
  if (openCount !== closeCount) {
    return {
      kind: "error",
      reason: `unbalanced brace in segment "${seg}" — ${ERROR_HINT}`,
    };
  }

  const open1 = seg.indexOf("{");
  const close1 = seg.indexOf("}");
  if (close1 < open1) {
    return {
      kind: "error",
      reason: `unbalanced brace in segment "${seg}" — ${ERROR_HINT}`,
    };
  }

  if (openCount >= 2) {
    const open2 = seg.indexOf("{", close1 + 1);
    if (close1 + 1 === open2) {
      return {
        kind: "error",
        reason: `adjacent parameters in segment "${seg}" — only one parameter per segment is allowed; ${ERROR_HINT}`,
      };
    }
    return {
      kind: "error",
      reason: `literal-separated parameters in segment "${seg}" — only one parameter per segment is allowed; ${ERROR_HINT}`,
    };
  }

  const prefix = seg.slice(0, open1);
  const content = seg.slice(open1 + 1, close1);
  const suffix = seg.slice(close1 + 1);

  if (
    prefix.includes("{") ||
    prefix.includes("}") ||
    suffix.includes("{") ||
    suffix.includes("}")
  ) {
    return {
      kind: "error",
      reason: `unbalanced brace in segment "${seg}" — ${ERROR_HINT}`,
    };
  }

  // Strip optional trailing greedy marker BEFORE emptiness check so that
  // `{+}` / `{*}` report "empty parameter name", matching legacy behavior.
  let greedy: "" | "+" | "*" = "";
  let name = content;
  if (content.length > 0) {
    const last = content[content.length - 1]!;
    if (last === "+" || last === "*") {
      greedy = last;
      name = content.slice(0, -1);
    }
  }

  if (name.length === 0) {
    return {
      kind: "error",
      reason: `empty parameter name in segment "${seg}" — ${ERROR_HINT}`,
    };
  }

  const parsed = { kind: "param", prefix, name, suffix, greedy } as const;
  return name.includes(":") ? parseConstrainedSegment(parsed, seg) : parsed;
}

function parseConstrainedSegment(
  parsed: Extract<SegmentParseResult, { kind: "param" }>,
  seg: string,
): SegmentParseResult {
  const { name, prefix, suffix, greedy } = parsed;
  const parts = name.split(":");
  if (parts.length !== 2 || parts[0] === "" || parts[1] !== "digits") {
    return {
      kind: "error",
      reason: `invalid parameter constraint in segment "${seg}"`,
    };
  }
  if (
    prefix !== "" ||
    suffix !== "" ||
    greedy !== "" ||
    /[+*]$/.test(parts[0]!)
  ) {
    return {
      kind: "error",
      reason: `constrained parameter must occupy one non-greedy segment "${seg}"`,
    };
  }
  return {
    kind: "param",
    prefix,
    name: parts[0]!,
    suffix,
    greedy,
    constraint: "digits",
  };
}

export function splitPathSegments(path: string): string[] {
  if (path === "" || path === "/") return [];
  const pathWithoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
  if (pathWithoutLeadingSlash === "") return [];
  return pathWithoutLeadingSlash.split("/");
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n++;
  }
  return n;
}
