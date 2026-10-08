import { z } from "zod";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const combinedCoverage = z.enum(["complete", "partial"]);
const totalTokens = z
  .object({
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
const coverageReason = z.enum([
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
const sandboxProxy = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("unavailable"),
        reason: z.enum([
          "not-observed",
          "launch-unavailable",
          "busy",
          "timed-out",
          "invalid-response",
          "transport",
        ]),
      })
      .strict(),
    z
      .object({
        state: z.literal("observed"),
        sampledAtMs: safeInteger.positive(),
        revision: safeInteger,
        coverage: combinedCoverage,
        reasons: z.array(coverageReason).max(10),
        observedResponses: safeInteger.max(4096),
        outstandingResponses: safeInteger.max(4096),
        tokens: totalTokens,
      })
      .strict(),
  ])
  .superRefine((source, context) => {
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

const combined = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("observed"),
      coverage: combinedCoverage,
      observedTokens: totalTokens,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("no-observation"),
    })
    .strict(),
  z
    .object({
      state: z.literal("overflow"),
      coverage: combinedCoverage,
    })
    .strict(),
]);

const runUsageResultBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    combined,
    sources: z
      .object({
        sandboxProxy,
      })
      .strict(),
  })
  .strict();

type RunUsageResultInput = z.infer<typeof runUsageResultBaseSchema>;

function sourceCategorySums(
  sources: RunUsageResultInput["sources"],
): readonly [number, number, number, number] {
  if (sources.sandboxProxy.state !== "observed") return [0, 0, 0, 0];
  const { tokens } = sources.sandboxProxy;
  return [tokens.input, tokens.cacheRead, tokens.cacheCreation, tokens.output];
}

function validateCombined(
  result: RunUsageResultInput,
  context: z.RefinementCtx,
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

export const runUsageErrorKindSchema = z.enum([
  "unsupported-runner",
  "assignment-unavailable",
  "busy",
  "timed-out",
  "cancelled",
  "invalid-response",
  "transport",
]);
export const runUsageCliOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("ok"),
      usage: runUsageResultSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("error"),
      error: z
        .object({
          kind: runUsageErrorKindSchema,
          delivery: z.enum(["not-dispatched", "unknown"]),
        })
        .strict(),
    })
    .strict(),
]);

export type RunUsageResult = z.infer<typeof runUsageResultSchema>;
export type RunUsageCliOutcome = z.infer<typeof runUsageCliOutcomeSchema>;
export type RunUsageErrorKind = z.infer<typeof runUsageErrorKindSchema>;
