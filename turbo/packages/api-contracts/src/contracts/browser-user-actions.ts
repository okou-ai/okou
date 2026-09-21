import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const BROWSER_USER_ACTION_MAX_FIELDS = 8;
export const BROWSER_USER_ACTION_MAX_KEY_LENGTH = 64;
export const BROWSER_USER_ACTION_MAX_LABEL_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_SELECTOR_LENGTH = 2048;
export const BROWSER_USER_ACTION_MAX_VALUE_LENGTH = 4096;
export const BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH = 200;

export const browserUserActionKindSchema = z.enum([
  "input",
  "direct_interaction",
]);
export const browserUserActionStateSchema = z.enum([
  "pending",
  "applying",
  "succeeded",
  "cancelled",
  "stale",
  "uncertain",
]);
export const browserUserActionFieldKindSchema = z.enum([
  "text",
  "username",
  "password",
  "one_time_code",
]);

const boundedNonblank = (maximum: number) => {
  return z.string().trim().min(1).max(maximum);
};

export const browserUserActionInputFieldCreateSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    label: boundedNonblank(BROWSER_USER_ACTION_MAX_LABEL_LENGTH),
    description: z
      .string()
      .trim()
      .max(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
      .optional(),
    fieldKind: browserUserActionFieldKindSchema,
    required: z.boolean(),
    selector: boundedNonblank(BROWSER_USER_ACTION_MAX_SELECTOR_LENGTH),
  })
  .strict();

const inputCreateSchema = z
  .object({
    kind: z.literal("input"),
    callbackPrompt: boundedNonblank(
      BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
    ),
    fields: z
      .array(browserUserActionInputFieldCreateSchema)
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_FIELDS),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, field] of value.fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: "Input field keys must be unique",
          path: ["fields", index, "key"],
        });
      }
      keys.add(field.key);
    }
  });

const directInteractionCreateSchema = z
  .object({
    kind: z.literal("direct_interaction"),
    callbackPrompt: boundedNonblank(
      BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
    ),
    reason: boundedNonblank(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH),
  })
  .strict();

export const browserUserActionCreateRequestSchema = z.discriminatedUnion(
  "kind",
  [inputCreateSchema, directInteractionCreateSchema],
);

export const browserUserActionSubmittedValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    value: z.string().max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH),
  })
  .strict();

export const browserUserActionApplyRequestSchema = z
  .object({
    values: z
      .array(browserUserActionSubmittedValueSchema)
      .max(BROWSER_USER_ACTION_MAX_FIELDS),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of value.values.entries()) {
      if (keys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          message: "Submitted value keys must be unique",
          path: ["values", index, "key"],
        });
      }
      keys.add(entry.key);
    }
  });

export const browserUserActionDisplayFieldSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    label: boundedNonblank(BROWSER_USER_ACTION_MAX_LABEL_LENGTH),
    description: z
      .string()
      .max(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
      .optional(),
    fieldKind: browserUserActionFieldKindSchema,
    required: z.boolean(),
  })
  .strict();

const callbackIdsSchema = z
  .object({
    success: z
      .object({
        clientEventId: z.uuid(),
        chatThreadSortEventId: z.uuid(),
      })
      .strict(),
    cancellation: z
      .object({
        clientEventId: z.uuid(),
        chatThreadSortEventId: z.uuid(),
      })
      .strict(),
  })
  .strict();

const responseBaseSchema = z.object({
  requestToken: z.string().min(1),
  state: browserUserActionStateSchema,
  siteOrigin: z.url(),
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  agentId: z.uuid(),
  threadId: z.uuid(),
  callbackIds: callbackIdsSchema,
});

export const browserUserActionResponseSchema = z.discriminatedUnion("kind", [
  responseBaseSchema
    .extend({
      kind: z.literal("input"),
      fields: z.array(browserUserActionDisplayFieldSchema).min(1).max(8),
    })
    .strict(),
  responseBaseSchema
    .extend({
      kind: z.literal("direct_interaction"),
      reason: boundedNonblank(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH),
    })
    .strict(),
]);

export const browserUserActionCreateResponseSchema = z
  .object({
    actionUrl: z.url(),
    action: browserUserActionResponseSchema,
  })
  .strict();

const requestTokenParamsSchema = z
  .object({ requestToken: z.string().min(1).max(512) })
  .strict();
const emptyBodySchema = z.object({}).strict();
const commonErrors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  410: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const browserUserActionsContract = c.router({
  create: {
    method: "POST",
    path: "/api/browser/user-actions",
    headers: authHeadersSchema,
    body: browserUserActionCreateRequestSchema,
    responses: { 201: browserUserActionCreateResponseSchema, ...commonErrors },
    summary: "Create an exact Browser input or direct-interaction request",
  },
  get: {
    method: "GET",
    path: "/api/browser/user-actions/:requestToken",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Read a Browser user-action request",
  },
  apply: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/apply",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: browserUserActionApplyRequestSchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Apply user-provided values to exact Browser controls",
  },
  cancel: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/cancel",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: emptyBodySchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Cancel a pending Browser user-action request",
  },
  open: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/open",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: emptyBodySchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Open the exact Browser target for direct interaction",
  },
  complete: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/complete",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: emptyBodySchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Record user completion of direct Browser interaction",
  },
});

export type BrowserUserActionKind = z.infer<typeof browserUserActionKindSchema>;
export type BrowserUserActionState = z.infer<
  typeof browserUserActionStateSchema
>;
export type BrowserUserActionFieldKind = z.infer<
  typeof browserUserActionFieldKindSchema
>;
export type BrowserUserActionCreateRequest = z.infer<
  typeof browserUserActionCreateRequestSchema
>;
export type BrowserUserActionApplyRequest = z.infer<
  typeof browserUserActionApplyRequestSchema
>;
export type BrowserUserActionResponse = z.infer<
  typeof browserUserActionResponseSchema
>;
export type BrowserUserActionsContract = typeof browserUserActionsContract;
