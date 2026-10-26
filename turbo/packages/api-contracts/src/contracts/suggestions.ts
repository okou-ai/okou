import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { composerDraftSchema } from "./chat-threads";
import { apiErrorSchema } from "./errors";

const SUGGESTION_LIMIT = 10;
// UUID aliases must share one terminal identity in the JSONB collection.
const suggestionIdSchema = z.uuid().toLowerCase();
const suggestionOptionIdSchema = z.string().trim().min(1).max(64);
const suggestionStatusSchema = z.enum(["active", "consumed", "removed"]);
const suggestionDraftSchema = composerDraftSchema
  .refine(
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
  )
  .refine(
    (draft) => {
      return JSON.stringify(draft).length <= 65536;
    },
    {
      message: "Suggestion draft exceeds 65536 characters",
    },
  );
export const suggestionOptionSchema = z.object({
  id: suggestionOptionIdSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(160),
  threadId: z.uuid().toLowerCase().nullable(),
  draft: suggestionDraftSchema,
});
export type SuggestionOption = z.infer<typeof suggestionOptionSchema>;
const suggestionOptionsSchema = z
  .array(suggestionOptionSchema)
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
const suggestionContentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().max(200),
  priority: z.number().int().min(-2147483648).max(2147483647),
  options: suggestionOptionsSchema,
});
export const suggestionSchema = suggestionContentSchema.extend({
  id: suggestionIdSchema,
  status: suggestionStatusSchema,
  selectedOptionId: suggestionOptionIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const suggestionReceiptSchema = suggestionSchema
  .pick({
    id: true,
    status: true,
    selectedOptionId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ status: z.enum(["consumed", "removed"]) });
export type SuggestionReceipt = z.infer<typeof suggestionReceiptSchema>;
export const suggestionCreateSchema = suggestionContentSchema.extend({
  id: suggestionIdSchema,
  priority: suggestionContentSchema.shape.priority.default(0),
});
export const suggestionUpdateSchema = suggestionContentSchema.partial().refine(
  (body) => {
    return Object.keys(body).length > 0;
  },
  {
    message: "Provide at least one suggestion field to update",
  },
);
export type Suggestion = z.infer<typeof suggestionSchema>;
export type SuggestionCreate = z.infer<typeof suggestionCreateSchema>;
export type SuggestionUpdate = z.infer<typeof suggestionUpdateSchema>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const params = z.object({ id: suggestionIdSchema });
export const suggestionsContract = c.router({
  list: {
    method: "GET",
    path: "/api/suggestions",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        suggestions: z.array(suggestionSchema).max(SUGGESTION_LIMIT),
        receipts: z.array(suggestionReceiptSchema).optional(),
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
    body: z.object({ optionId: suggestionOptionIdSchema.nullable() }),
    responses: { 200: suggestionSchema, ...errors },
    summary: "Choose a suggestion option, or dismiss it with a null option ID",
  },
});
