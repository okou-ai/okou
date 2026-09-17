import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);

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
  z.strictObject({
    mode: z.literal("pending-tools"),
    h1Hash: digest,
    manifestGeneration: z.number().int().positive(),
    pendingToolIds: z.array(z.string().min(1)).min(1),
    lastEventSequence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    mode: z.literal("settled-session"),
    h1Hash: digest,
    manifestGeneration: z.number().int().positive(),
    lastEventSequence: z.number().int().nonnegative(),
  }),
  z.strictObject({ mode: z.literal("untouched-h0") }),
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
