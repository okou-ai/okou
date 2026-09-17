import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The developer preview of Simple Morning Brief Gmail collection.
 *
 * The request carries an anchor and nothing else: the owner, Agent, connector
 * account and provider paths are derived from the authenticated member's
 * canonical Morning Brief state, never from the caller.
 */

/** Why a source produced no usable content. Never a healthy empty day. */
export const morningBriefSourceFailureSchema = z.enum([
  "not-connected",
  "not-authorized",
  "reconnect-required",
  "source-revoked",
  "rate-limited",
  "deadline-exceeded",
  "provider-failed",
]);

export type MorningBriefSourceFailure = z.infer<
  typeof morningBriefSourceFailureSchema
>;

/** Every cap that silently shortened a read, reported explicitly. */
export const morningBriefTruncationSchema = z.enum([
  "list-pages",
  "candidates",
  "detail-requests",
  "total-requests",
  "deadline",
  "response-bytes",
  "total-response-bytes",
  /** A retained header value hit its own per-field ceiling. */
  "header-characters",
  "excerpt-characters",
  "text-characters",
  "mime-nodes",
]);

export type MorningBriefTruncation = z.infer<
  typeof morningBriefTruncationSchema
>;

export const morningBriefBranchOutcomeSchema = z.enum([
  "complete",
  "truncated",
  "denied",
  "failed",
]);

export type MorningBriefBranchOutcome = z.infer<
  typeof morningBriefBranchOutcomeSchema
>;

export const morningBriefGmailBranchSchema = z.enum(["recent", "unread"]);

export type MorningBriefGmailBranch = z.infer<
  typeof morningBriefGmailBranchSchema
>;

export const morningBriefGmailItemSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  /** Every branch that selected this message; duplicates merge by ID. */
  branches: z.array(morningBriefGmailBranchSchema).min(1),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  date: z.string().nullable(),
  internalDate: z.string().datetime(),
  unread: z.boolean(),
  excerpt: z.string(),
  /**
   * `none`, `html-only` and `mime-truncated` are declared coverage gaps, not
   * empty content. `html-only` means the message really carried no usable
   * inline text; `mime-truncated` means a MIME cap stopped the walk before the
   * whole structure was seen, so nothing here proves what the message contains.
   */
  excerptSource: z.enum([
    "text-plain",
    "html-normalized",
    "none",
    "html-only",
    "mime-truncated",
  ]),
  sourceUrl: z.string(),
});

export type MorningBriefGmailItem = z.infer<typeof morningBriefGmailItemSchema>;

export const morningBriefGmailCollectionSchema = z.object({
  source: z.literal("gmail"),
  /**
   * `ok` and `empty` are complete reads. `partial` kept usable content while
   * losing coverage, and `unavailable` produced none.
   */
  status: z.enum(["ok", "empty", "partial", "unavailable"]),
  anchor: z.string().datetime(),
  collectedAt: z.string().datetime(),
  timezone: z.string(),
  recentWindow: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  /** The unread backlog is a read-time snapshot, not anchor-time state. */
  unreadObservedAt: z.string().datetime(),
  items: z.array(morningBriefGmailItemSchema),
  coverage: z.object({
    recent: morningBriefBranchOutcomeSchema,
    unread: morningBriefBranchOutcomeSchema,
    truncations: z.array(morningBriefTruncationSchema),
    requests: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
  }),
  failure: morningBriefSourceFailureSchema.nullable(),
});

export type MorningBriefGmailCollection = z.infer<
  typeof morningBriefGmailCollectionSchema
>;

export const morningBriefGmailCollectionPreviewRequestSchema = z.object({
  anchor: z.string().datetime(),
});

export const morningBriefGmailCollectionPreviewContract = c.router({
  collect: {
    method: "POST",
    path: "/api/morning-brief/preview/gmail-collection",
    headers: authHeadersSchema,
    body: morningBriefGmailCollectionPreviewRequestSchema,
    responses: {
      200: morningBriefGmailCollectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.string(),
      500: apiErrorSchema,
    },
    summary: "Collect Gmail for Simple Morning Brief in a developer preview",
  },
});

export type MorningBriefGmailCollectionPreviewContract =
  typeof morningBriefGmailCollectionPreviewContract;
