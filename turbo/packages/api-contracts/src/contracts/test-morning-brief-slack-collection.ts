import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The explicitly invoked Slack collection preview for `simple-morning-brief`.
 *
 * It is a development / protected-preview entrypoint: the environment gate
 * denies production, and the caller is an ordinary authenticated member acting
 * only on their own organization and user. No owner, workspace, channel or
 * credential can be supplied. The single input is a scheduled anchor, which is
 * validated and frozen into the occurrence's collection window.
 */

/** Why an invocation never reached a claim, and so never called Slack. */
export const morningBriefCollectionSkipReasonSchema = z.enum([
  "feature-disabled",
  "brief-absent",
  "brief-pending",
  "brief-inconsistent",
  "brief-paused",
  "missing-timezone",
  "missing-agent",
  "membership-revoked",
  "slack-not-installed",
  "slack-not-connected",
]);

export const morningBriefCollectionOutcomeSchema = z.enum([
  "complete",
  "partial",
  "no_shared_channels",
  "rate_limited",
  "permission_denied",
  "provider_failed",
]);

/** Which documented budget, if any, bounded the read. */
const morningBriefCollectionLimitSchema = z.enum([
  "channel-pages",
  "channels",
  "threads",
  "requests",
  "messages",
  "text-bytes",
  "deadline",
  "history-pages",
  "reply-pages",
  "cursor-anomaly",
]);

const morningBriefCollectionOccurrenceSchema = z.object({
  scheduledFor: z.string().datetime(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  timezone: z.string(),
  collectionKind: z.literal("slack"),
  collectionVersion: z.number().int().positive(),
  attempt: z.number().int().positive(),
  status: z.enum(["completed", "failed"]),
  outcome: morningBriefCollectionOutcomeSchema,
});

/**
 * One normalized Slack message inside the in-memory bundle.
 *
 * `ts` and `threadTs` keep Slack's exact fractional timestamps as strings, so
 * the window boundary is never rounded away. Only the projected text travels;
 * blocks, attachments, files and raw provider JSON do not.
 */
const morningBriefSlackEntrySchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  channelUrl: z.string().url(),
  ts: z.string(),
  threadTs: z.string().nullable(),
  authorId: z.string().nullable(),
  text: z.string(),
  /** True when this message came from an expanded thread rather than history. */
  fromThread: z.boolean(),
});

/**
 * The ephemeral source envelope S5 will consume in-process.
 *
 * It is returned to the authenticated preview caller only after a successful
 * authority and lease finalization, and it is never persisted. A later
 * duplicate invocation of a completed occurrence reports `bundle: null`.
 */
export const morningBriefSlackBundleSchema = z.object({
  source: z.literal("slack"),
  version: z.number().int().positive(),
  workspaceId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  timezone: z.string(),
  /**
   * `complete` covers the declared scope — bounded channels and the threads
   * discovered inside the window — not the whole Slack workspace or day.
   */
  coverage: z.enum(["complete", "partial", "empty"]),
  limits: z.array(morningBriefCollectionLimitSchema),
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string().url(),
      isPrivate: z.boolean(),
      /** True when this channel's own history was bounded before the window end. */
      truncated: z.boolean(),
    }),
  ),
  entries: z.array(morningBriefSlackEntrySchema),
  counts: z.object({
    channels: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    textBytes: z.number().int().nonnegative(),
  }),
});

const collectResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("not-executed"),
    reason: morningBriefCollectionSkipReasonSchema,
  }),
  z.object({
    result: z.literal("collected"),
    occurrence: morningBriefCollectionOccurrenceSchema,
    bundle: morningBriefSlackBundleSchema,
  }),
  z.object({
    result: z.literal("already-completed"),
    occurrence: morningBriefCollectionOccurrenceSchema,
    /** Terminal metadata cannot recover a bundle that only ever existed in memory. */
    bundle: z.null(),
  }),
  z.object({
    result: z.literal("failed"),
    occurrence: morningBriefCollectionOccurrenceSchema,
    failure: z.object({
      outcome: morningBriefCollectionOutcomeSchema,
      retryAfterSeconds: z.number().int().nonnegative().optional(),
    }),
  }),
]);

export const testMorningBriefSlackCollectionContract = c.router({
  collect: {
    method: "POST",
    path: "/api/test/morning-brief/slack-collection",
    headers: authHeadersSchema,
    body: z.object({
      /** The scheduled anchor; the window is `[anchor - 24 hours, anchor)`. */
      scheduledFor: z.string().datetime(),
    }),
    responses: {
      200: collectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
      409: apiErrorSchema,
    },
    summary:
      "Collect one bounded Slack source bundle for a Morning Brief occurrence",
  },
});

export type MorningBriefCollectionSkipReason = z.infer<
  typeof morningBriefCollectionSkipReasonSchema
>;
export type MorningBriefCollectionOutcome = z.infer<
  typeof morningBriefCollectionOutcomeSchema
>;
export type MorningBriefCollectionLimit = z.infer<
  typeof morningBriefCollectionLimitSchema
>;
export type MorningBriefSlackBundle = z.infer<
  typeof morningBriefSlackBundleSchema
>;
export type MorningBriefSlackEntry = z.infer<
  typeof morningBriefSlackEntrySchema
>;
export type MorningBriefCollectionOccurrenceView = z.infer<
  typeof morningBriefCollectionOccurrenceSchema
>;
