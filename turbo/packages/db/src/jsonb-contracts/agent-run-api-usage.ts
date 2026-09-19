import { z } from "zod";

const quantitySchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const tokensSchema = z
  .object({
    input: quantitySchema.nullable(),
    cacheRead: quantitySchema.nullable(),
    cacheCreation: quantitySchema.nullable(),
    output: quantitySchema.nullable(),
  })
  .strict();

export const agentRunApiUsageAttemptSchema = z
  .object({
    id: z.uuid(),
    registeredAtMs: quantitySchema.positive(),
    observedAtMs: quantitySchema.positive().nullable(),
    terminal: z.boolean(),
    coverage: z.enum(["complete", "partial", "unavailable"]),
    tokens: tokensSchema,
    evidenceLost: z.boolean(),
    ambiguous: z
      .array(z.enum(["input", "cacheRead", "cacheCreation", "output"]))
      .max(4),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.terminal !== (attempt.observedAtMs !== null)) {
      context.addIssue({
        code: "custom",
        message: "Terminal attempts require an observed timestamp",
      });
    }
    if (new Set(attempt.ambiguous).size !== attempt.ambiguous.length) {
      context.addIssue({
        code: "custom",
        message: "Ambiguous categories must be unique",
      });
    }
    for (const field of attempt.ambiguous) {
      if (attempt.tokens[field] !== null) {
        context.addIssue({
          code: "custom",
          message: "Ambiguous categories cannot retain a quantity",
        });
      }
    }
    if (
      !attempt.terminal &&
      (attempt.coverage !== "unavailable" ||
        attempt.evidenceLost ||
        attempt.ambiguous.length > 0 ||
        Object.values(attempt.tokens).some((value) => {
          return value !== null;
        }))
    ) {
      context.addIssue({
        code: "custom",
        message: "Outstanding attempts cannot retain terminal evidence",
      });
    }
  });

export const agentRunApiUsageProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["no-inference", "pending", "attempted"]),
    attempts: z.array(agentRunApiUsageAttemptSchema).max(8),
    overflow: z.boolean(),
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.phase !== "attempted" && projection.attempts.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Only attempted projections may retain attempts",
      });
    }
    if (projection.phase === "attempted" && projection.attempts.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Attempted projections require a retained attempt",
      });
    }
    if (
      new Set(
        projection.attempts.map((attempt) => {
          return attempt.id;
        }),
      ).size !== projection.attempts.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Attempt identities must be unique",
      });
    }
    if (projection.phase !== "attempted" && projection.overflow) {
      context.addIssue({
        code: "custom",
        message: "Pre-provider projections cannot overflow",
      });
    }
  });

export type AgentRunApiUsageProjection = z.infer<
  typeof agentRunApiUsageProjectionSchema
>;
export type AgentRunApiUsageAttempt = z.infer<
  typeof agentRunApiUsageAttemptSchema
>;

export function initialAgentRunApiUsageProjection(
  phase: "no-inference" | "pending",
): AgentRunApiUsageProjection {
  return { schemaVersion: 1, phase, attempts: [], overflow: false };
}
