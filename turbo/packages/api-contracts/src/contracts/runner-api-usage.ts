import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";

const c = initContract();
const quantitySchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const runnerApiUsageCoverageReasonSchema = z.enum([
  "missing_usage",
  "missing_categories",
  "overflow",
  "in_flight",
  "ambiguous_attempt",
  "pending_inference",
]);

export const runnerApiUsageTotalsSchema = z
  .object({
    input: quantitySchema,
    cacheRead: quantitySchema,
    cacheCreation: quantitySchema,
    output: quantitySchema,
    total: quantitySchema,
  })
  .strict()
  .refine(
    (value) => {
      const sum =
        value.input + value.cacheRead + value.cacheCreation + value.output;
      return Number.isSafeInteger(sum) && sum === value.total;
    },
    { message: "Token total must equal the sum of its disjoint categories" },
  );

const runnerIdentitySchema = z
  .object({
    runnerId: z.uuid(),
    heartbeatGeneration: runnerHeartbeatGenerationSchema,
  })
  .strict();

const unavailableSchema = z
  .object({ state: z.literal("unavailable"), runId: z.uuid() })
  .strict();

const availableSchema = z
  .object({
    state: z.literal("available"),
    runId: z.uuid(),
    revision: quantitySchema.positive(),
    sampledAtMs: quantitySchema.positive(),
    updatedAtMs: quantitySchema.positive(),
    inferenceState: z.enum(["no_inference", "pending", "attempted"]),
    observedAttempts: quantitySchema.max(8),
    outstandingAttempts: quantitySchema.max(8),
    complete: z.boolean(),
    reasons: z.array(runnerApiUsageCoverageReasonSchema).max(6),
    totals: runnerApiUsageTotalsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.reasons).size !== value.reasons.length) {
      context.addIssue({
        code: "custom",
        message: "Coverage reasons must be unique",
      });
    }
    if (value.complete !== (value.reasons.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Complete must match coverage reasons",
      });
    }
    if (value.reasons.includes("in_flight") !== value.outstandingAttempts > 0) {
      context.addIssue({
        code: "custom",
        message: "In-flight reason must match outstanding attempts",
      });
    }
    if (value.observedAttempts + value.outstandingAttempts > 8) {
      context.addIssue({
        code: "custom",
        message: "Retained attempt counts must fit the source bound",
      });
    }
    const reasonOrder = [
      "pending_inference",
      "in_flight",
      "missing_usage",
      "missing_categories",
      "ambiguous_attempt",
      "overflow",
    ] as const;
    if (
      value.reasons.some((reason, index) => {
        return (
          index > 0 &&
          reasonOrder.indexOf(reason) <=
            reasonOrder.indexOf(value.reasons[index - 1]!)
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Coverage reasons must be sorted",
      });
    }
    if (
      value.inferenceState === "no_inference" &&
      (!value.complete ||
        value.observedAttempts !== 0 ||
        value.outstandingAttempts !== 0 ||
        value.totals.total !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "No-inference snapshots must be complete zero",
      });
    }
    if (value.inferenceState === "pending") {
      if (
        value.observedAttempts !== 0 ||
        value.outstandingAttempts !== 0 ||
        value.totals.total !== 0 ||
        value.reasons.length !== 1 ||
        value.reasons[0] !== "pending_inference"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Pending snapshots require zero usage and only pending inference coverage",
        });
      }
    } else if (value.reasons.includes("pending_inference")) {
      context.addIssue({
        code: "custom",
        message: "Only pending snapshots may report pending inference coverage",
      });
    }
    if (
      value.inferenceState === "attempted" &&
      value.observedAttempts + value.outstandingAttempts === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Attempted snapshots require a retained attempt",
      });
    }
  });

export const runnerApiUsageResponseSchema = z.discriminatedUnion("state", [
  unavailableSchema,
  availableSchema,
]);

export const runnerApiUsageContract = c.router({
  read: {
    method: "POST",
    path: "/api/runners/runs/:runId/api-usage",
    pathParams: z.object({ runId: z.uuid() }).strict(),
    headers: authHeadersSchema,
    body: z.object({ runnerIdentity: runnerIdentitySchema }).strict(),
    responses: {
      200: runnerApiUsageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read cumulative API-owned usage for the winning official Runner",
  },
});

export type RunnerApiUsageRequest = z.infer<
  typeof runnerApiUsageContract.read.body
>;
export type RunnerApiUsageResponse = z.infer<
  typeof runnerApiUsageResponseSchema
>;
export type RunnerApiUsageCoverageReason = z.infer<
  typeof runnerApiUsageCoverageReasonSchema
>;
