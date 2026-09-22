/**
 * A run model's product line: the line a vendor ships it under, independent of
 * the vendor prefix and the version. `claude-fable-5-1` and a later
 * `claude-fable-5-2` are both `fable`; `claude-opus-5` is `opus`.
 *
 * This is deliberately not `modelFamily` in
 * `apps/api/src/signals/services/session-compatibility.ts`. That helper answers
 * whether two runs may share a native session and truncates at the first
 * separator, so every Claude model collapses to `claude`. It cannot tell a
 * frontier line from a workhorse one, and its meaning must not move. The
 * product line is a separate axis, derived here.
 *
 * The set is closed: a model whose line is missing here classifies as `null`,
 * and `pi-admission-policy.test.ts` fails until the line is recorded. Adding
 * one is the moment to decide whether it is a frontier line.
 */
export const MODEL_PRODUCT_LINES = [
  "okou",
  "fable",
  "opus",
  "sonnet",
  "astra",
  "sol",
  "terra",
  "luna",
  "flash",
  "pro",
] as const;

export type ModelProductLine = (typeof MODEL_PRODUCT_LINES)[number];

const MODEL_PRODUCT_LINE_SET: ReadonlySet<string> = new Set(
  MODEL_PRODUCT_LINES,
);

/**
 * Lines that run on their vendor's own harness instead of the Pi loop. This is
 * the epic's rule as data: frontier lines stay with the vendor, everything else
 * is Pi-eligible. `pi-admission-policy.test.ts` holds `PI_MODEL_POLICY` to it,
 * so a future model on one of these lines cannot reach Pi without failing.
 */
export const FRONTIER_MODEL_PRODUCT_LINES = [
  "fable",
  "astra",
] as const satisfies readonly ModelProductLine[];

const FRONTIER_MODEL_PRODUCT_LINE_SET: ReadonlySet<string> = new Set(
  FRONTIER_MODEL_PRODUCT_LINES,
);

/**
 * The product line of a model ID, or `null` when the ID carries no known line.
 *
 * Vendors place the line on either side of the version (`claude-fable-5-1`,
 * `gpt-6-astra`, `deepseek-v4.1-flash`) and gateways prefix their own vendor
 * (`anthropic/claude-fable-5.1`), so position carries no meaning and the ID is
 * matched segment-wise against the known lines instead. That also keeps the
 * failure direction right for a guard whose job is exclusion: a segment that
 * merely reads like a line over-matches into a vendor-harness decision rather
 * than silently admitting a frontier model to Pi.
 */
export function modelProductLine(
  model: string | null | undefined,
): ModelProductLine | null {
  if (typeof model !== "string") {
    return null;
  }
  const line = model
    .trim()
    .toLowerCase()
    .split(/[-_./]/u)
    .find((segment) => {
      return MODEL_PRODUCT_LINE_SET.has(segment);
    });
  return line === undefined ? null : (line as ModelProductLine);
}

/** The model belongs to a line that runs on its vendor's own harness. */
export function isFrontierModelProductLine(
  model: string | null | undefined,
): boolean {
  const line = modelProductLine(model);
  return line !== null && FRONTIER_MODEL_PRODUCT_LINE_SET.has(line);
}
