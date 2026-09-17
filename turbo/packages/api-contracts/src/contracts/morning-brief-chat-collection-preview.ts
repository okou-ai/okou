import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** Why one unread candidate contributed no content. */
const morningBriefChatSkipReasonSchema = z.enum([
  /** The member's canonical Morning Brief destination thread. */
  "destination_thread",
  /** The thread has hosted official Morning Brief content. */
  "morning_brief_thread",
  /** Created before the thread origin was recorded, or by a path that does not classify itself. */
  "unknown_thread_provenance",
  /** A classification this API version does not understand. */
  "unsupported_thread_provenance",
  /** Deleted, or its Agent ownership changed, between selection and the read. */
  "thread_unavailable",
  /** Membership, Agent visibility, or erasure state no longer permits the read. */
  "owner_context_unavailable",
  /** A Run started on the thread, so its latest output is not settled. */
  "active_run",
  /** The terminal marker or read watermark moved after selection. */
  "read_state_advanced",
  /** The bounded read did not complete; nothing from this thread is reported. */
  "thread_read_failed",
  /** Nothing visible survived the content filters, for example after retention. */
  "no_visible_excerpts",
]);

export type MorningBriefChatSkipReason = z.infer<
  typeof morningBriefChatSkipReasonSchema
>;

/** Why a reported payload is smaller than the underlying data. */
const morningBriefChatTruncationSchema = z.enum([
  /** More unread candidates exist than one collection may inspect. */
  "candidate_overflow",
  /** The collection time budget ran out before every candidate was inspected. */
  "deadline_exceeded",
  /** The thread has more eligible excerpts than the per-thread limit. */
  "excerpt_limit",
  /** One excerpt was cut to the per-excerpt byte limit. */
  "excerpt_bytes",
  /** The whole-collection text budget ran out. */
  "output_budget",
  /** A stored event exceeded the readable payload limit and was not decoded. */
  "oversized_event_payload",
]);

export type MorningBriefChatTruncation = z.infer<
  typeof morningBriefChatTruncationSchema
>;

const morningBriefChatExcerptSchema = z.object({
  eventId: z.string().uuid(),
  seqId: z.number().int(),
  role: z.enum(["user", "assistant"]),
  at: z.string().datetime(),
  text: z.string(),
});

const morningBriefChatItemSchema = z.object({
  threadId: z.string().uuid(),
  agentId: z.string().uuid(),
  provenance: z.literal("ordinary"),
  terminal: z.object({
    eventId: z.string().uuid(),
    runId: z.string().uuid(),
    seqId: z.number().int(),
    at: z.string().datetime(),
  }),
  excerpts: z.array(morningBriefChatExcerptSchema),
  truncations: z.array(morningBriefChatTruncationSchema),
});

export type MorningBriefChatItem = z.infer<typeof morningBriefChatItemSchema>;

const morningBriefChatCollectionSchema = z.object({
  source: z.literal("chat"),
  /** The scheduled instant this collection was frozen at. */
  anchor: z.string().datetime(),
  collectedAt: z.string().datetime(),
  /**
   * `empty` means the member has no unread Chat at all. `no-eligible-content`
   * means unread threads existed but none released content, which is a
   * different fact from an empty inbox.
   */
  result: z.enum(["empty", "collected", "no-eligible-content"]),
  /** `partial` whenever any candidate was unknown, failed, or truncated. */
  coverage: z.enum(["complete", "partial"]),
  scope: z.object({
    unreadCandidates: z.number().int(),
    inspectedThreads: z.number().int(),
  }),
  items: z.array(morningBriefChatItemSchema),
  skipped: z.array(
    z.object({
      threadId: z.string().uuid(),
      reason: morningBriefChatSkipReasonSchema,
    }),
  ),
  truncations: z.array(morningBriefChatTruncationSchema),
});

export type MorningBriefChatCollection = z.infer<
  typeof morningBriefChatCollectionSchema
>;

export const morningBriefChatCollectionPreviewContract = c.router({
  collect: {
    method: "POST",
    path: "/api/morning-brief/preview/chat-collection",
    headers: authHeadersSchema,
    body: z.object({
      /** The scheduled occurrence instant. The only accepted input. */
      scheduledFor: z.string().datetime(),
    }),
    responses: {
      200: morningBriefChatCollectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      /** Production, where this developer-only endpoint does not exist. */
      404: z.string(),
      500: apiErrorSchema,
    },
    summary: "Collect eligible unread Chat for a Morning Brief occurrence",
  },
});
