import {
  array,
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
import { composerDraftSchema } from "./chat-threads";
import { apiErrorSchema } from "./errors";
import { SUGGESTION_RETENTION_MS } from "../validators/suggestions";

export {
  SUGGESTION_RETENTION_MS,
  getSuggestionExpiresAt,
} from "../validators/suggestions";

const SUGGESTION_LIMIT = 10;
export const SUGGESTION_FEEDBACK_RETENTION_MS = 30 * SUGGESTION_RETENTION_MS;
export const suggestionFeedbackScopeSchema = object({
  key: string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_.:-]+$/u),
  label: string().trim().min(1).max(80),
});
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
  learnedAt: iso.datetime().nullable(),
  targetId: uuid().toLowerCase().nullable(),
  note: string().max(512),
  context: object({
    title: string().max(120),
    rationale: string().max(200),
    scope: suggestionFeedbackScopeSchema,
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
  priority: number().int().min(-2147483648).max(2147483647),
  feedbackScope: suggestionFeedbackScopeSchema,
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
export const suggestionSchema = suggestionContentSchema.extend({
  id: suggestionIdSchema,
  status: suggestionStatusSchema,
  selectedOptionId: suggestionOptionIdSchema.nullable(),
  feedbacks: array(suggestionFeedbackSchema).max(100).default([]),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
  expiresAt: iso.datetime().optional(),
  consumeToken: string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export const suggestionReceiptSchema = suggestionSchema
  .pick({
    id: true,
    status: true,
    selectedOptionId: true,
    createdAt: true,
    updatedAt: true,
    feedbacks: true,
  })
  .extend({ status: zEnum(["consumed", "removed"]) });
export type SuggestionReceipt = zInfer<typeof suggestionReceiptSchema>;
export const suggestionCreateSchema = suggestionContentSchema.extend({
  id: suggestionIdSchema,
  priority: suggestionContentSchema.shape.priority.default(0),
  expiresAt: iso.datetime().optional(),
});
export const suggestionUpdateSchema = suggestionContentSchema
  .extend({ expiresAt: iso.datetime().optional() })
  .partial()
  .refine(
    (body) => {
      return Object.keys(body).length > 0;
    },
    {
      message: "Provide at least one suggestion field to update",
    },
  );
export type Suggestion = zInfer<typeof suggestionSchema>;
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
export const suggestionsContract = c.router({
  manage: {
    method: "GET",
    path: "/api/suggestions/active",
    headers: authHeadersSchema,
    query: object({ after: suggestionIdSchema.optional() }),
    responses: {
      200: object({
        suggestions: array(suggestionSchema).max(100),
        receipts: array(suggestionReceiptSchema),
        nextAfter: suggestionIdSchema.nullable(),
      }),
      ...errors,
    },
    summary: "Read a page of all active suggestions for Agent curation",
  },
  list: {
    method: "GET",
    path: "/api/suggestions",
    headers: authHeadersSchema,
    responses: {
      200: object({
        suggestions: array(suggestionSchema).max(SUGGESTION_LIMIT),
        receipts: array(suggestionReceiptSchema).optional(),
      }),
      ...errors,
    },
    summary: "Read your actionable suggestions",
  },
  create: {
    method: "POST",
    path: "/api/suggestions",
    headers: authHeadersSchema,
    body: suggestionCreateSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Publish a suggestion from Okou",
  },
  update: {
    method: "PATCH",
    path: "/api/suggestions/:id",
    headers: authHeadersSchema,
    pathParams: params,
    body: suggestionUpdateSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Update an active suggestion from Okou",
  },
  remove: {
    method: "DELETE",
    path: "/api/suggestions/:id",
    headers: authHeadersSchema,
    pathParams: params,
    responses: { 204: c.noBody(), ...errors },
    summary: "Withdraw a suggestion from Okou",
  },
  consume: {
    method: "POST",
    path: "/api/suggestions/:id/consume",
    headers: authHeadersSchema,
    pathParams: params,
    body: suggestionConsumeSchema,
    responses: { 200: suggestionSchema, ...errors },
    summary: "Choose a suggestion option, or dismiss it with a null option ID",
  },
  feedback: {
    method: "POST",
    path: "/api/suggestions/:id/feedback",
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
