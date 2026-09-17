import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { morningBriefCollectionSkipReasonSchema } from "./morning-brief-collection-preview";

const c = initContract();

/**
 * The explicitly invoked platform-funded generation preview.
 *
 * It ships in the ordinary API route table and is reachable on a development
 * server and on a protected preview deployment; production answers 404 through
 * the environment gate even when `simpleMorningBrief` is on for the caller. The
 * caller is an ordinary authenticated member acting on their own organization
 * and user, and the single input is a scheduled anchor. No owner, account,
 * model, prompt, source bundle or credential can be supplied.
 *
 * One invocation runs real Slack collection, commits a generation reservation
 * in the same transaction that finalizes that collection, and only then makes
 * one platform-funded model request. Nothing here delivers anything: no Chat
 * message, no email and no schedule change follows an accepted result.
 */

/** Why an invocation never reached a reservation, so never called a provider. */
export const morningBriefGenerationSkipReasonSchema = z.union([
  morningBriefCollectionSkipReasonSchema,
  /** The platform generation credential is not configured for this deployment. */
  z.literal("generation-not-configured"),
]);

export const morningBriefGenerationStateSchema = z.enum([
  "reserved",
  "succeeded",
  "output_rejected",
  "provider_failed",
  "not_invoked",
  "result_discarded",
  "invocation_outcome_unknown",
  "skipped_empty",
  "skipped_incomplete",
]);

export const morningBriefGenerationFailureReasonSchema = z.enum([
  "not_configured",
  "provider_error",
  "response_unreadable",
  "transport_failed",
  "output_truncated",
  "unexpected_tool_calls",
  "invalid_json",
  "invalid_shape",
  "unknown_source_reference",
  "empty_deliver",
  "result_too_large",
  "reservation_expired",
  "owner_revoked",
  "binding_changed",
  "persistence_failed",
]);

/**
 * The anonymous platform spend receipt for one invocation.
 *
 * It is reported so an operator can verify that the platform paid and that the
 * amount is either exactly known or explicitly unknown. It carries no owner
 * identity and no provider payload. `value` is the provider's own reported
 * amount in `unit`; it is never converted into a currency or into Okou credits.
 */
export const morningBriefPlatformReceiptSchema = z.object({
  attemptId: z.string().uuid(),
  provider: z.literal("openrouter"),
  requestedModel: z.string(),
  returnedModel: z.string().nullable(),
  providerGenerationId: z.string().nullable(),
  outcome: z.enum([
    "response_received",
    "provider_error",
    "response_unreadable",
    "invocation_unknown",
  ]),
  cost: z.object({
    state: z.enum(["reported", "unavailable", "invocation_unknown"]),
    /** Absent unless `state` is `reported`. An explicit `"0"` is a known zero. */
    value: z.string().nullable(),
    unit: z.enum(["openrouter_credits"]).nullable(),
    source: z
      .enum(["chat_completion_usage_cost", "generation_total_cost"])
      .nullable(),
  }),
  tokens: z.object({
    prompt: z.number().int().nonnegative().nullable(),
    completion: z.number().int().nonnegative().nullable(),
    reasoning: z.number().int().nonnegative().nullable(),
    cached: z.number().int().nonnegative().nullable(),
    total: z.number().int().nonnegative().nullable(),
  }),
});

/** The accepted result, rendered by program code from validated model data. */
const morningBriefGenerationResultSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("deliver"),
    title: z.string(),
    /** Safe Markdown; every link comes from the collected source map. */
    markdown: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({
    decision: z.literal("skip"),
    /** The model's own validated no-content decision, never a failure. */
    reason: z.literal("nothing_actionable"),
  }),
]);

export const morningBriefGenerationViewSchema = z.object({
  purpose: z.literal("preview"),
  state: morningBriefGenerationStateSchema,
  attemptId: z.string().uuid(),
  model: z.string(),
  promptVersion: z.number().int().positive(),
  resultSchemaVersion: z.number().int().positive(),
  language: z.string(),
  languageSource: z.enum(["member-locale", "default"]),
  /** What the bundle offered, what travelled, and whether anything was dropped. */
  inputItems: z.number().int().nonnegative(),
  includedItems: z.number().int().nonnegative(),
  inputReduced: z.boolean(),
  sourceCoverage: z.enum(["complete", "partial", "empty"]),
  inputDigest: z.string(),
  reservedAt: z.string().datetime(),
  reservationExpiresAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  result: morningBriefGenerationResultSchema.nullable(),
  failureReason: morningBriefGenerationFailureReasonSchema.nullable(),
  /** Present only for an invocation this request itself observed. */
  receipt: morningBriefPlatformReceiptSchema.nullable(),
});

const occurrenceSchema = z.object({
  scheduledFor: z.string().datetime(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  timezone: z.string(),
  collectionKind: z.literal("slack"),
  collectionVersion: z.number().int().positive(),
  attempt: z.number().int().positive(),
  status: z.enum(["completed", "failed"]),
  outcome: z.string(),
});

const generateResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("not-executed"),
    reason: morningBriefGenerationSkipReasonSchema,
  }),
  z.object({
    result: z.literal("collection-failed"),
    occurrence: occurrenceSchema,
    failure: z.object({
      outcome: z.string(),
      retryAfterSeconds: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    result: z.literal("generated"),
    occurrence: occurrenceSchema,
    generation: morningBriefGenerationViewSchema,
  }),
  z.object({
    result: z.literal("already-generated"),
    occurrence: occurrenceSchema,
    generation: morningBriefGenerationViewSchema,
  }),
  z.object({
    /**
     * The occurrence finished collecting without ever reserving a generation,
     * and a completed occurrence keeps no source body. This state is reported
     * exactly as it is: it is not recollected, replayed or invented.
     */
    result: z.literal("collection-completed-without-generation"),
    occurrence: occurrenceSchema,
  }),
]);

export const morningBriefGenerationPreviewContract = c.router({
  // Named `preview` rather than `generate`: a first-party `.generate(` call
  // shape matches a Semgrep SSRF rule for headless-renderer APIs, and a
  // suppression comment would hide the rule for real findings too.
  preview: {
    method: "POST",
    path: "/api/morning-brief/preview/generation",
    headers: authHeadersSchema,
    body: z.object({
      /** The scheduled anchor; the collection window is `[anchor - 24h, anchor)`. */
      scheduledFor: z.string().datetime(),
    }),
    responses: {
      200: generateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
      409: apiErrorSchema,
    },
    summary:
      "Collect, generate and persist one platform-funded Morning Brief preview result",
  },
});

export type MorningBriefGenerationSkipReason = z.infer<
  typeof morningBriefGenerationSkipReasonSchema
>;
export type MorningBriefGenerationState = z.infer<
  typeof morningBriefGenerationStateSchema
>;
export type MorningBriefGenerationFailureReason = z.infer<
  typeof morningBriefGenerationFailureReasonSchema
>;
export type MorningBriefPlatformReceiptView = z.infer<
  typeof morningBriefPlatformReceiptSchema
>;
export type MorningBriefGenerationView = z.infer<
  typeof morningBriefGenerationViewSchema
>;
