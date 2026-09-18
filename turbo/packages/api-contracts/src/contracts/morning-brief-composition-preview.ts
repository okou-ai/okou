import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The developer preview that makes the source-independent composition a real,
 * reachable consumer of the Morning Brief engine.
 *
 * It is registered in the ordinary application composition, so the production
 * gate, authentication and ownership checks are the deployed ones. Production
 * answers 404 before authentication regardless of `simpleMorningBrief`.
 *
 * No connector is required to reach it: an owner with only Gmail, only Slack or
 * neither all run the same engine. The single input is an anchor; owner, Agent,
 * installation, accounts and every provider path come from canonical state.
 *
 * The response is a report about one composition, never its evidence. No
 * message body, subject, prompt, instruction text or credential is returned.
 */

export const morningBriefCompositionSourceSchema = z.enum([
  "gmail",
  "calendar",
  "github",
  "slack",
  "chat",
]);

const compositionCoverageSchema = z.enum([
  "unconfigured",
  "empty",
  "complete",
  "partial",
  "failed",
]);

const compositionResultSchema = z.object({
  sources: z.array(
    z.object({
      source: morningBriefCompositionSourceSchema,
      coverage: compositionCoverageSchema,
      items: z.number().int().nonnegative(),
      requests: z.number().int().nonnegative(),
    }),
  ),
  /** The admission order, capped at the concurrency ceiling. */
  waves: z.array(z.array(morningBriefCompositionSourceSchema)),
  normalizedBytes: z.number().int().nonnegative(),
  omittedByNormalizedCap: z.number().int().nonnegative(),
  /**
   * Measured bytes of the request one model call would receive.
   *
   * `null` when no request was assembled, which is what a healthy empty
   * collection produces.
   */
  request: z
    .object({
      envelopeBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      maxBytes: z.number().int().positive(),
      items: z.number().int().nonnegative(),
      omittedItems: z.number().int().nonnegative(),
      omittedBytes: z.number().int().nonnegative(),
    })
    .nullable(),
  language: z
    .object({
      authority: z.enum(["agent-instructions", "member-locale", "default"]),
      fallbackLanguage: z.string(),
      /**
       * What the attempt proved about the Agent's instructions.
       *
       * Absence is reported as the state it was read in and the configuration
       * it was read from, never as a missing field: "no volume was ever
       * published", "that version carries no instructions file" and "that
       * version's file is empty" are three different facts, and each is
       * revalidated against live configuration before the request is frozen.
       * The instruction text itself never appears here.
       */
      instructions: z.discriminatedUnion("state", [
        z.object({
          state: z.literal("available"),
          versionId: z.string(),
          digest: z.string(),
        }),
        z.object({ state: z.literal("no-storage"), versionId: z.null() }),
        z.object({ state: z.literal("no-target"), versionId: z.string() }),
        z.object({ state: z.literal("empty-file"), versionId: z.string() }),
      ]),
    })
    .nullable(),
  /** Credential-free retained authority; never a token or a payload. */
  descriptors: z.array(
    z.object({
      source: morningBriefCompositionSourceSchema,
      connectionId: z.string().nullable(),
      accountRef: z.string().nullable(),
      /** Digested from the permissions the read was actually admitted under. */
      scopeDigest: z.string(),
      /** One endpoint per exercised permission, so a later check can re-ask. */
      endpoints: z.array(z.string()),
      membershipId: z.string(),
      agentId: z.string(),
      capturedAt: z.string().datetime(),
      containers: z.array(z.string()),
      contributed: z.boolean(),
    }),
  ),
});

const composeResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("composed"),
    composition: compositionResultSchema,
  }),
  /** Every configured source answered, and none of them had anything. */
  z.object({
    result: z.literal("empty"),
    composition: compositionResultSchema,
  }),
  /**
   * Usable evidence existed and no request could be made.
   *
   * Distinct from `empty` on purpose: one is a quiet morning, the other is a
   * problem that has to be recovered rather than delivered as silence.
   */
  z.object({
    result: z.literal("incomplete"),
    reason: z.enum([
      "language-context-unavailable",
      /**
       * The retained proof could not be represented inside its declared bounds,
       * or a supplied source could not prove the authority it was read under.
       */
      "retained-authority-unbounded",
      "no-item-fits",
    ]),
    detail: z.string(),
  }),
  /** The owner's authority moved while the attempt was reading. */
  z.object({ result: z.literal("authority-changed") }),
]);

export const morningBriefCompositionPreviewContract = c.router({
  compose: {
    method: "POST",
    path: "/api/morning-brief/collection-preview/compose",
    headers: authHeadersSchema,
    body: z.object({ anchor: z.string().datetime() }),
    responses: {
      200: composeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
    },
    summary: "Compose every configured Morning Brief source into one request",
  },
});

export type MorningBriefCompositionPreviewContract =
  typeof morningBriefCompositionPreviewContract;
