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
 * neither all run the same engine. The inputs are an anchor and, optionally, the
 * caller's own deadline; owner, Agent, installation, accounts and every provider
 * path come from canonical state.
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
  /**
   * Applicable, and the attempt's own budget ran out before it was admitted.
   *
   * Distinct from every read outcome: nothing was observed about this source,
   * which is why it can never contribute to a healthy empty answer.
   */
  "not-started",
]);

/**
 * Whole-item losses, named by the reduction that caused each one.
 *
 * Three independent stages can drop evidence and they act on disjoint records,
 * so the known counts add up. `unknownRemaining` is not a count: a cap that
 * ended a provider read never enumerated what was behind it, and reporting a
 * number there would state a total nothing observed.
 */
const compositionOmissionSchema = z.object({
  bySource: z.object({
    known: z.number().int().nonnegative(),
    unknownRemaining: z.boolean(),
  }),
  byNormalizedCap: z.number().int().nonnegative(),
  byRequest: z.number().int().nonnegative(),
  knownTotal: z.number().int().nonnegative(),
  unknownRemaining: z.boolean(),
});

/** One provider branch's own window or outstanding-work snapshot. */
const compositionBranchSchema = z.object({
  name: z.string(),
  status: z.string(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  observedAt: z.string().nullable(),
});

/**
 * The window and snapshot context one source's evidence is only true within.
 *
 * `startDate` and `endDateExclusive` are the frozen local dates an all-day
 * record was selected against, and `timezone` is what makes them a day rather
 * than a range of instants.
 */
const compositionProvenanceSchema = z.object({
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  startDate: z.string().nullable(),
  endDateExclusive: z.string().nullable(),
  timezone: z.string().nullable(),
  observedAt: z.string().nullable(),
  collectedAt: z.string().nullable(),
  branches: z.array(compositionBranchSchema),
  limitations: z.array(z.string()),
});

/** One entry per applicable source, in the fixed admission order. */
const compositionSourcesSchema = z.array(
  z.object({
    source: morningBriefCompositionSourceSchema,
    coverage: compositionCoverageSchema,
    /** Normalized items that survived the combined normalized ceiling. */
    items: z.number().int().nonnegative(),
    /** Of those, the ones the assembled request could actually carry. */
    includedInRequest: z.number().int().nonnegative(),
    /** Null when a started source rejected before returning its accounting. */
    requests: z.number().int().nonnegative().nullable(),
    /** Why each item is in the window, counted by claim. */
    timeSemantics: z.object({
      instant: z.number().int().nonnegative(),
      overlap: z.number().int().nonnegative(),
      dateOnly: z.number().int().nonnegative(),
      outstanding: z.number().int().nonnegative(),
    }),
    omitted: compositionOmissionSchema,
    provenance: compositionProvenanceSchema,
    /**
     * A fingerprint of exactly the evidence this source put in the request.
     *
     * It is content-free and one-way. Two provider states that a reader would
     * act on differently must not produce the same value: that equality is how
     * a normalization silently dropping branch, state or check facts becomes
     * observable from outside.
     */
    evidenceDigest: z.string(),
  }),
);

const compositionResultSchema = z.object({
  sources: compositionSourcesSchema,
  /** The one absolute deadline this attempt ran under. */
  deadline: z.object({
    startedAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    source: z.enum(["phase", "caller"]),
  }),
  /** The admission order, capped at the concurrency ceiling. */
  waves: z.array(z.array(morningBriefCompositionSourceSchema)),
  /** Measured bytes of the one aggregate normalized document, metadata included. */
  normalizedBytes: z.number().int().nonnegative(),
  normalizedMaxBytes: z.number().int().positive(),
  omittedByNormalizedCap: z.number().int().nonnegative(),
  /**
   * Measured bytes of the request document one model call would receive.
   *
   * `null` when no request was assembled, which is what a healthy empty
   * collection produces. This measures the composed document itself; the
   * transport body that carries it is the integration consumer's own ceiling.
   */
  request: z
    .object({
      envelopeBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      maxBytes: z.number().int().positive(),
      items: z.number().int().nonnegative(),
      omittedItems: z.number().int().nonnegative(),
      omittedBytes: z.number().int().nonnegative(),
      digest: z.string(),
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
  /** Exact UTF-8 bytes of the serialized descriptor array below. */
  descriptorBytes: z.number().int().nonnegative(),
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
  /**
   * Every applicable source answered affirmatively and none of them had
   * anything. A source that failed or never started is not an answer, so it
   * can never produce this result.
   */
  z.object({
    result: z.literal("empty"),
    composition: compositionResultSchema,
  }),
  /**
   * No request could be made, and this was not a quiet morning.
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
      /** The one absolute deadline was reached before the attempt finished. */
      "deadline-exceeded",
      /** Every source that could have answered failed. */
      "all-sources-failed",
      /** Nothing contributed and some applicable source never answered. */
      "incomplete-coverage",
    ]),
    detail: z.string(),
    /**
     * What each applicable source did, as far as the attempt got.
     *
     * Empty only when the attempt ended before the source plan existed. This
     * is where the facts matter most: an attempt that never started Chat is a
     * different problem from one whose Chat was quiet.
     */
    sources: compositionSourcesSchema,
  }),
  /** The owner's authority moved while the attempt was reading. */
  z.object({ result: z.literal("authority-changed") }),
]);

export const morningBriefCompositionPreviewContract = c.router({
  compose: {
    method: "POST",
    path: "/api/morning-brief/collection-preview/compose",
    headers: authHeadersSchema,
    body: z.object({
      anchor: z.string().datetime(),
      /**
       * The caller's own budget for this attempt.
       *
       * Optional, and only ever tighter: the composition takes the earlier of
       * this instant and its own 45-second phase, so a caller cannot extend the
       * phase by asking for more.
       */
      deadlineAt: z.string().datetime().optional(),
    }),
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
