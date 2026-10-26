import {
  array,
  discriminatedUnion,
  literal,
  number,
  object,
  uuid,
  enum as zEnum,
  type RefinementCtx,
  type infer as zInfer,
} from "zod";

const safeInteger = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const combinedCoverage = zEnum(["complete", "partial"]);
const totalTokens = object({
  input: safeInteger,
  cacheRead: safeInteger,
  cacheCreation: safeInteger,
  output: safeInteger,
  total: safeInteger,
})
  .strict()
  .superRefine((tokens, context) => {
    if (
      tokens.input + tokens.cacheRead + tokens.cacheCreation + tokens.output !==
      tokens.total
    ) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "Token total does not match its categories",
      });
    }
  });
const coverageReason = zEnum([
  "history_lost",
  "retention_lost",
  "missing_usage",
  "missing_categories",
  "parse_error",
  "ambiguous_response",
  "unsupported_protocol",
  "interrupted",
  "overflow",
  "in_flight",
]);
const sandboxProxy = discriminatedUnion("state", [
  object({
    state: literal("unavailable"),
    reason: zEnum([
      "not-observed",
      "launch-unavailable",
      "busy",
      "timed-out",
      "invalid-response",
      "transport",
    ]),
  }).strict(),
  object({
    state: literal("observed"),
    sampledAtMs: safeInteger.positive(),
    revision: safeInteger,
    coverage: combinedCoverage,
    reasons: array(coverageReason).max(10),
    observedResponses: safeInteger.max(4096),
    outstandingResponses: safeInteger.max(4096),
    tokens: totalTokens,
  }).strict(),
]).superRefine((source, context) => {
  if (source.state !== "observed") return;
  const reasons = new Set(source.reasons);
  if (reasons.size !== source.reasons.length) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "MITM reasons must be unique",
    });
  }
  if ((source.coverage === "complete") !== (source.reasons.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "MITM coverage does not match its reasons",
    });
  }
  if (reasons.has("in_flight") !== source.outstandingResponses > 0) {
    context.addIssue({
      code: "custom",
      path: ["outstandingResponses"],
      message: "MITM in-flight state is incoherent",
    });
  }
  if (source.observedResponses === 0 && source.tokens.total !== 0) {
    context.addIssue({
      code: "custom",
      path: ["observedResponses"],
      message: "MITM totals require an observed response",
    });
  }
});

const combined = discriminatedUnion("state", [
  object({
    state: literal("observed"),
    coverage: combinedCoverage,
    observedTokens: totalTokens,
  }).strict(),
  object({
    state: literal("unavailable"),
    reason: literal("no-observation"),
  }).strict(),
  object({
    state: literal("overflow"),
    coverage: combinedCoverage,
  }).strict(),
]);

const runUsageResultBaseSchema = object({
  schemaVersion: literal(1),
  runId: uuid(),
  combined,
  sources: object({
    sandboxProxy,
  }).strict(),
}).strict();

type RunUsageResultInput = zInfer<typeof runUsageResultBaseSchema>;

function sourceCategorySums(
  sources: RunUsageResultInput["sources"],
): readonly [number, number, number, number] {
  if (sources.sandboxProxy.state !== "observed") return [0, 0, 0, 0];
  const { tokens } = sources.sandboxProxy;
  return [tokens.input, tokens.cacheRead, tokens.cacheCreation, tokens.output];
}

function validateCombined(
  result: RunUsageResultInput,
  context: RefinementCtx,
): void {
  const proxy = result.sources.sandboxProxy;
  if (result.combined.state === "unavailable") {
    if (proxy.state === "observed") {
      context.addIssue({
        code: "custom",
        path: ["combined"],
        message: "Unavailable combined state contains an observation",
      });
    }
    return;
  }
  if (proxy.state !== "observed") {
    context.addIssue({
      code: "custom",
      path: ["combined"],
      message: "Combined observation has no observed source",
    });
    return;
  }
  if (result.combined.coverage !== proxy.coverage) {
    context.addIssue({
      code: "custom",
      path: ["combined", "coverage"],
      message: "Combined coverage does not match source coverage",
    });
  }
  const sums = sourceCategorySums(result.sources);
  const sumTotal = sums.reduce((total, value) => {
    return total + value;
  }, 0);
  const overflows =
    sums.some((value) => {
      return value > Number.MAX_SAFE_INTEGER;
    }) || sumTotal > Number.MAX_SAFE_INTEGER;
  if (result.combined.state === "overflow") {
    if (!overflows) {
      context.addIssue({
        code: "custom",
        path: ["combined"],
        message: "Combined overflow has safe source sums",
      });
    }
    return;
  }
  if (overflows) {
    context.addIssue({
      code: "custom",
      path: ["combined"],
      message: "Observed combined state contains unsafe source sums",
    });
    return;
  }
  const expected = [...sums, sumTotal];
  const actual = [
    result.combined.observedTokens.input,
    result.combined.observedTokens.cacheRead,
    result.combined.observedTokens.cacheCreation,
    result.combined.observedTokens.output,
    result.combined.observedTokens.total,
  ];
  if (
    expected.some((value, index) => {
      return value !== actual[index];
    })
  ) {
    context.addIssue({
      code: "custom",
      path: ["combined", "observedTokens"],
      message: "Combined tokens do not match source observations",
    });
  }
}

export const runUsageResultSchema =
  runUsageResultBaseSchema.superRefine(validateCombined);

export const runUsageErrorKindSchema = zEnum([
  "unsupported-runner",
  "assignment-unavailable",
  "busy",
  "timed-out",
  "cancelled",
  "invalid-response",
  "transport",
]);
export const runUsageCliOutcomeSchema = discriminatedUnion("status", [
  object({
    schemaVersion: literal(1),
    status: literal("ok"),
    usage: runUsageResultSchema,
  }).strict(),
  object({
    schemaVersion: literal(1),
    status: literal("error"),
    error: object({
      kind: runUsageErrorKindSchema,
      delivery: zEnum(["not-dispatched", "unknown"]),
    }).strict(),
  }).strict(),
]);

export type RunUsageResult = zInfer<typeof runUsageResultSchema>;
export type RunUsageCliOutcome = zInfer<typeof runUsageCliOutcomeSchema>;
export type RunUsageErrorKind = zInfer<typeof runUsageErrorKindSchema>;
