import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { composerDraftSchema } from "../validators/chat-threads";
import { apiErrorSchema } from "./errors";
import { SUGGESTION_RETENTION_MS } from "../validators/suggestions";

export {
  SUGGESTION_RETENTION_MS,
  getSuggestionExpiresAt,
} from "../validators/suggestions";

const SUGGESTION_LIMIT = 10;
export const SUGGESTION_FEEDBACK_RETENTION_MS = 30 * SUGGESTION_RETENTION_MS;
export const suggestionFeedbackSchema = object({
  id: uuid().toLowerCase(),
  kind: zEnum([
    "already_done",
    "not_planned",
    "less_like_this",
    "dismissed",
    "option_selected",
    "custom_sent",
    "undo",
    "reason",
  ]),
  createdAt: iso.datetime(),
  // Legacy persisted receipt; feedback context never consumes or acknowledges events.
  learnedAt: iso.datetime().nullable(),
  targetId: uuid().toLowerCase().nullable(),
  note: string().max(512),
  choice: string().optional(),
  context: object({
    title: string().max(120),
    rationale: string().max(200),
    optionLabel: string().max(80).nullable(),
  }),
});
export type SuggestionFeedback = zInfer<typeof suggestionFeedbackSchema>;
export const suggestionFeedbackRequestSchema = object({
  id: uuid().toLowerCase(),
  kind: zEnum([
    "already_done",
    "not_planned",
    "less_like_this",
    "dismissed",
    "undo",
    "reason",
  ]),
  targetId: uuid().toLowerCase().nullable().default(null),
  note: string().trim().max(512).default(""),
});
export type SuggestionFeedbackRequest = zInfer<
  typeof suggestionFeedbackRequestSchema
>;
// UUID aliases must share one terminal identity in the JSONB collection.
const suggestionIdSchema = uuid().toLowerCase();
const suggestionOptionIdSchema = string().trim().min(1).max(64);
const suggestionStatusSchema = zEnum(["active", "consumed", "removed"]);
const suggestionDraftSchema = composerDraftSchema.refine(
  (draft) => {
    return (
      draft.draftUserMessage?.parts.some((part) => {
        return part.type !== "text" || part.text.trim().length > 0;
      }) ?? false
    );
  },
  {
    message: "A suggestion requires a composer message",
    path: ["draftUserMessage"],
  },
);
export const suggestionOptionSchema = object({
  id: suggestionOptionIdSchema.refine((id) => {
    return id !== "custom";
  }, "custom is reserved"),
  label: string().trim().min(1).max(80),
  description: string().trim().max(160),
  threadId: uuid().toLowerCase().nullable(),
  draft: suggestionDraftSchema,
});
export type SuggestionOption = zInfer<typeof suggestionOptionSchema>;
const suggestionOptionsSchema = array(suggestionOptionSchema)
  .min(1)
  .max(3)
  .refine(
    (options) => {
      return (
        new Set(
          options.map((option) => {
            return option.id;
          }),
        ).size === options.length
      );
    },
    { message: "Suggestion option IDs must be unique" },
  )
  .refine(
    (options) => {
      return JSON.stringify(options).length <= 65536;
    },
    { message: "Suggestion options exceed 65536 characters" },
  );
const suggestionContentSchema = object({
  title: string().trim().min(1).max(120),
  rationale: string().trim().max(200),
  options: suggestionOptionsSchema,
  customOption: object({
    id: literal("custom"),
    threadId: literal(null),
    draft: suggestionDraftSchema
      .refine((draft) => {
        return JSON.stringify(draft).length <= 65536;
      }, "Custom direction draft exceeds 65536 characters")
      .refine((draft) => {
        const parts = draft.draftUserMessage?.parts ?? [];
        const feedback = parts.filter((part) => {
          return part.type === "feedback";
        });
        const [quote] = feedback;
        return (
          feedback.length === 1 &&
          quote !== undefined &&
          quote.quote.trim().length > 0 &&
          quote.note.length === 0 &&
          quote.source === undefined &&
          quote.eventId === undefined &&
          parts.every((part) => {
            return (
              part.type === "feedback" ||
              (part.type === "file" &&
                (draft.draftAttachments ?? []).some((file) => {
                  return file.id === part.fileId;
                }))
            );
          })
        );
      }, "Custom direction requires one complete neutral quote with an empty note and optional files"),
  }),
});
export type SuggestionContent = zInfer<typeof suggestionContentSchema>;
export const suggestionStateSchema = object({
  status: suggestionStatusSchema,
  selectedOptionId: suggestionOptionIdSchema.nullable(),
  feedbacks: array(suggestionFeedbackSchema).max(100),
}).strict();
export type SuggestionState = zInfer<typeof suggestionStateSchema>;
export const feedItemTypeSchema = zEnum(["suggestion", "event"]);
const feedItemBaseSchema = object({
  id: suggestionIdSchema,
  type: feedItemTypeSchema,
  sourceType: literal("agent").optional(),
  priority: number().int().min(-2147483648).max(2147483647),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
  expiresAt: iso.datetime().nullable(),
});
export const suggestionSchema = feedItemBaseSchema.extend({
  type: literal("suggestion"),
  content: suggestionContentSchema,
  state: suggestionStateSchema,
  expiresAt: iso.datetime(),
  consumeToken: string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export const suggestionReceiptSchema = feedItemBaseSchema.extend({
  type: literal("suggestion"),
  content: literal(null),
  state: suggestionStateSchema.extend({
    status: zEnum(["consumed", "removed"]),
  }),
  expiresAt: iso.datetime(),
});
export type SuggestionReceipt = zInfer<typeof suggestionReceiptSchema>;
export type Suggestion = zInfer<typeof suggestionSchema>;
export const platformEventSchema = feedItemBaseSchema.extend({
  type: literal("event"),
  sourceType: literal("platform-event"),
  content: object({
    eventType: literal("automation-disabled"),
    automationId: uuid(),
    workflowId: uuid(),
    workspaceId: string().min(1),
    automationName: string().min(1).max(200),
    automationDescription: string().min(1).max(1024).optional(),
    disabledAt: iso.datetime(),
    consecutiveFailures: number().int().positive(),
    recoveryScheduled: boolean(),
  }),
  state: object({ status: zEnum(["active", "dismissed"]) }).strict(),
});
export type PlatformEvent = zInfer<typeof platformEventSchema>;
export type FeedItem = Suggestion | SuggestionReceipt | PlatformEvent;
export const feedSourcesSchema = object({
  suggestions: boolean(),
  whatsNew: boolean(),
  offers: boolean(),
  systemUpdates: boolean(),
});
export type FeedSources = zInfer<typeof feedSourcesSchema>;
export const suggestionCreateSchema = object({
  id: suggestionIdSchema,
  type: literal("suggestion"),
  priority: feedItemBaseSchema.shape.priority.default(0),
  content: suggestionContentSchema,
  expiresAt: iso.datetime().optional(),
}).strict();
export const suggestionUpdateSchema = object({
  priority: feedItemBaseSchema.shape.priority.optional(),
  content: suggestionContentSchema.partial().strict().optional(),
  expiresAt: iso.datetime().optional(),
})
  .strict()
  .refine(
    (body) => {
      return (
        body.priority !== undefined ||
        body.expiresAt !== undefined ||
        (body.content !== undefined && Object.keys(body.content).length > 0)
      );
    },
    {
      message: "Provide at least one feed item field to update",
    },
  );
export type SuggestionCreate = zInfer<typeof suggestionCreateSchema>;
export type SuggestionUpdate = zInfer<typeof suggestionUpdateSchema>;
const suggestionConsumeSchema = object({
  optionId: suggestionOptionIdSchema.nullable(),
  snapshot: suggestionSchema.optional(),
});
export type SuggestionConsume = zInfer<typeof suggestionConsumeSchema>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const params = object({ id: suggestionIdSchema });
export const feedContract = c.router({
  sources: {
    method: "GET",
    path: "/api/feed/sources",
    headers: authHeadersSchema,
    responses: { 200: feedSourcesSchema, ...errors },
    summary: "Read your For you source preferences",
  },
  updateSources: {
    method: "PATCH",
    path: "/api/feed/sources",
    headers: authHeadersSchema,
    body: feedSourcesSchema
      .partial()
      .strict()
      .refine((body) => {
        return Object.keys(body).length > 0;
      }, "Provide at least one source preference"),
    responses: { 200: feedSourcesSchema, ...errors },
    summary: "Choose future For you deliveries; keep already delivered cards",
  },
  summary: {
    method: "GET",
    path: "/api/feed/summary",
    headers: authHeadersSchema,
    responses: { 200: object({ hasUnread: boolean() }), ...errors },
    summary: "Read whether an enabled For you source has unread cards",
  },
  markRead: {
    method: "POST",
    path: "/api/feed/items/:id/read",
    headers: authHeadersSchema,
    pathParams: params,
    responses: { 200: object({ readAt: iso.datetime() }), ...errors },
    summary: "Mark a displayed card as read without consuming it",
  },
  manage: {
    method: "GET",
    path: "/api/feed/items/active",
    headers: authHeadersSchema,
    query: object({
      after: suggestionIdSchema.optional(),
      type: literal("suggestion").optional(),
    }),
    responses: {
      200: object({
        items: array(suggestionSchema).max(100),
        receipts: array(suggestionReceiptSchema),
        nextAfter: suggestionIdSchema.nullable(),
      }),
      ...errors,
    },
    summary: "Read a page of all active suggestions for Agent curation",
  },
  list: {
    method: "GET",
    path: "/api/feed/items",
    headers: authHeadersSchema,
    query: object({ type: feedItemTypeSchema.optional() }),
    responses: {
      200: object({
        items: array(suggestionSchema.or(platformEventSchema)).max(
          SUGGESTION_LIMIT,
        ),
        receipts: array(suggestionReceiptSchema).optional(),
      }),
      ...errors,
    },
    summary: "Read your actionable feed items",
  },
  dismiss: {
    method: "POST",
    path: "/api/feed/items/:id/dismiss",
    headers: authHeadersSchema,
    pathParams: params,
    responses: { 204: c.noBody(), ...errors },
    summary: "Dismiss a platform event",
  },
  create: {
    method: "POST",
    path: "/api/feed/items",
    headers: authHeadersSchema,
    body: suggestionCreateSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Publish a suggestion from Okou",
  },
  update: {
    method: "PATCH",
    path: "/api/feed/items/:id",
    headers: authHeadersSchema,
    pathParams: params,
    body: suggestionUpdateSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Update an active suggestion from Okou",
  },
  remove: {
    method: "DELETE",
    path: "/api/feed/items/:id",
    headers: authHeadersSchema,
    pathParams: params,
    responses: { 204: c.noBody(), ...errors },
    summary: "Withdraw a suggestion from Okou",
  },
  consume: {
    method: "POST",
    path: "/api/feed/items/:id/suggestion/consume",
    headers: authHeadersSchema,
    pathParams: params,
    body: suggestionConsumeSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Choose a suggestion option, or dismiss it with a null option ID",
  },
  feedback: {
    method: "POST",
    path: "/api/feed/items/:id/suggestion/feedback",
    headers: authHeadersSchema,
    pathParams: params,
    body: suggestionFeedbackRequestSchema.extend({
      snapshot: suggestionSchema.optional(),
    }),
    responses: {
      200: object({ restored: literal(true).or(literal(false)) }),
      ...errors,
    },
    summary: "Give feedback on a suggestion, undo feedback, or add a reason",
  },
});
