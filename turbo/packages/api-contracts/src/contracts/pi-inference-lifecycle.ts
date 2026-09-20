import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);

const piApiHandoffTokenQuantitySchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

/**
 * API-first usage known at the ownership-transfer boundary. Absence means the
 * producer did not have a handoff-time snapshot; consumers must not infer zero.
 * Objects intentionally ignore unknown additive fields so handoff metadata can
 * evolve without breaking an older reader.
 */
export const piApiHandoffUsageSchema = z
  .discriminatedUnion("state", [
    z.object({
      schemaVersion: z.literal(1),
      state: z.literal("no-inference"),
      sampledAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      schemaVersion: z.literal(1),
      state: z.literal("observed"),
      sampledAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      coverage: z.enum(["complete", "partial", "unavailable"]),
      tokens: z.object({
        input: piApiHandoffTokenQuantitySchema,
        cacheRead: piApiHandoffTokenQuantitySchema,
        cacheCreation: piApiHandoffTokenQuantitySchema,
        output: piApiHandoffTokenQuantitySchema,
      }),
    }),
  ])
  .superRefine((usage, context) => {
    if (usage.state === "no-inference") return;
    const tokens = Object.values(usage.tokens);
    const hasKnownToken = tokens.some((token) => {
      return token !== null;
    });
    const allTokensKnown = tokens.every((token) => {
      return token !== null;
    });
    const validCoverage =
      (usage.coverage === "complete" && allTokensKnown) ||
      (usage.coverage === "partial" && hasKnownToken) ||
      (usage.coverage === "unavailable" && !hasKnownToken);
    if (!validCoverage) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Coverage does not match the established token quantities",
      });
    }
  });

/** References are immutable, tenant-scoped objects, never signed URLs or secrets. */
export const piInferenceInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputEventId: z.uuid().nullable(),
  inputGeneration: z.number().int().nonnegative(),
  configurationHash: digest,
  contextHash: digest,
  h0: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("empty") }),
    z.strictObject({
      kind: z.literal("history"),
      conversationId: z.uuid(),
      historyHash: digest,
    }),
  ]),
  deferredSecrets: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("encrypted"),
      objectHash: digest,
      expiresAt: z.iso.datetime(),
    }),
  ]),
});

export const piInferencePublicationSchema = z.strictObject({
  h1Hash: digest,
  manifestGeneration: z.number().int().positive(),
  lastEventSequence: z.number().int().nonnegative(),
});
export type PiInferencePublication = z.infer<
  typeof piInferencePublicationSchema
>;

export const piSandboxContinuationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pending-tools"),
    h1Hash: digest,
    manifestGeneration: z.number().int().positive(),
    pendingToolIds: z.array(z.string().min(1)).min(1),
    lastEventSequence: z.number().int().nonnegative(),
    apiUsage: piApiHandoffUsageSchema.optional(),
  }),
  z.object({
    mode: z.literal("settled-session"),
    h1Hash: digest,
    manifestGeneration: z.number().int().positive(),
    lastEventSequence: z.number().int().nonnegative(),
    apiUsage: piApiHandoffUsageSchema.optional(),
  }),
  z.object({
    mode: z.literal("untouched-h0"),
    apiUsage: piApiHandoffUsageSchema.optional(),
  }),
]);

export const piInferencePhaseSchema = z.enum([
  "admitted",
  "ready",
  "provider",
  "publishing",
  "sandbox_waiting",
  "sandbox_preparing",
  "sandbox_ready",
  "sandbox_running",
  "terminal",
]);
export type PiInferencePhase = z.infer<typeof piInferencePhaseSchema>;
export type PiInferenceInput = z.infer<typeof piInferenceInputSchema>;
export type PiSandboxContinuation = z.infer<typeof piSandboxContinuationSchema>;
export type PiApiHandoffUsage = z.infer<typeof piApiHandoffUsageSchema>;
