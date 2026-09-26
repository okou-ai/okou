import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const BROWSER_USER_ACTION_MAX_FIELDS = 8;
export const BROWSER_USER_ACTION_MAX_KEY_LENGTH = 64;
export const BROWSER_USER_ACTION_MAX_LABEL_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_VALUE_LENGTH = 4096;
export const BROWSER_USER_ACTION_MAX_OPTIONS = 32;
export const BROWSER_USER_ACTION_MAX_RADIO_MEMBERS = 16;
export const BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH = 256;
export const BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH = 200;
export const BROWSER_USER_ACTION_MAX_FILE_BYTES = 1024 * 1024;
export const BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES = 1024 * 1024 * 1024;
export const BROWSER_USER_ACTION_MAX_FILES = 3;
export const BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES = 1_500_000;

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
  "number",
  "date_time",
  "select",
  "checkbox",
  "radio",
  "file",
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
    backendNodeId: z.number().int().positive().safe(),
  })
  .strict();

const inputCreateSchema = z
  .object({
    kind: z.literal("input"),
    callbackPrompt: boundedNonblank(
      BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
    ),
    pageTargetId: boundedNonblank(BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH),
    fields: z
      .array(browserUserActionInputFieldCreateSchema)
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_FIELDS),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    const backendNodeIds = new Set<number>();
    for (const [index, field] of value.fields.entries()) {
      if (keys.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: "Input field keys must be unique",
          path: ["fields", index, "key"],
        });
      }
      keys.add(field.key);
      if (backendNodeIds.has(field.backendNodeId)) {
        context.addIssue({
          code: "custom",
          message: "Input field backend node IDs must be unique",
          path: ["fields", index, "backendNodeId"],
        });
      }
      backendNodeIds.add(field.backendNodeId);
    }
  });

export const browserUserActionCreateRequestSchema = inputCreateSchema;

const browserUserActionScalarValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    value: z.string().max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH),
  })
  .strict();
const selectOptionIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(BROWSER_USER_ACTION_MAX_OPTIONS - 1);
const browserUserActionSelectValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    optionIndexes: z
      .array(selectOptionIndexSchema)
      .max(BROWSER_USER_ACTION_MAX_OPTIONS),
    optionSetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.optionIndexes).size !== value.optionIndexes.length) {
      context.addIssue({
        code: "custom",
        message: "Selected option indices must be unique",
      });
    }
  });
const browserUserActionCheckboxValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    checked: z.boolean(),
    observedChecked: z.boolean(),
  })
  .strict();
const browserUserActionRadioValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    memberIndex: z
      .number()
      .int()
      .min(-1)
      .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
    observedSelectedIndex: z
      .number()
      .int()
      .min(-1)
      .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
    groupFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
const browserUserActionFileValueSchema = z
  .object({
    key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
    observedFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    operation: z.enum(["keep", "replace", "clear"]),
    files: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH),
            type: z.string().max(BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH),
            size: z
              .number()
              .int()
              .min(0)
              .max(BROWSER_USER_ACTION_MAX_FILE_BYTES),
            contentBase64: z
              .string()
              .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
              .max(4 * Math.ceil(BROWSER_USER_ACTION_MAX_FILE_BYTES / 3)),
          })
          .strict(),
      )
      .max(BROWSER_USER_ACTION_MAX_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === "replace") !== value.files.length > 0) {
      context.addIssue({ code: "custom", message: "Invalid file selection" });
    }
    if (
      value.files.reduce((sum, file) => {
        return sum + file.size;
      }, 0) > BROWSER_USER_ACTION_MAX_FILE_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "File selection exceeds limit",
      });
    }
  });
export const browserUserActionSubmittedValueSchema = z.union([
  browserUserActionScalarValueSchema,
  browserUserActionSelectValueSchema,
  browserUserActionCheckboxValueSchema,
  browserUserActionRadioValueSchema,
  browserUserActionFileValueSchema,
]);

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
    control: z
      .object({
        tagName: z.enum(["INPUT", "TEXTAREA", "SELECT"]),
        inputType: z.enum([
          "textarea",
          "text",
          "search",
          "email",
          "tel",
          "url",
          "password",
          "number",
          "date",
          "time",
          "datetime-local",
          "month",
          "week",
          "select-one",
          "select-multiple",
          "checkbox",
          "radio",
          "file",
        ]),
        siteRequired: z.boolean().optional(),
        accept: z
          .string()
          .max(BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH)
          .optional(),
        fileSetFingerprint: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        files: z
          .array(
            z
              .object({
                name: z
                  .string()
                  .min(1)
                  .max(BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH),
                type: z.string().max(BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH),
                size: z
                  .number()
                  .int()
                  .min(0)
                  .max(BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES),
              })
              .strict(),
          )
          .max(BROWSER_USER_ACTION_MAX_FILES)
          .optional(),
        checked: z.boolean().optional(),
        radioGroupFingerprint: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        radioOptions: z
          .array(
            z
              .object({
                index: z
                  .number()
                  .int()
                  .min(0)
                  .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
                label: z
                  .string()
                  .min(1)
                  .max(BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH),
                disabled: z.boolean(),
                selected: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS)
          .optional(),
        multiple: z.boolean().optional(),
        optionSetFingerprint: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        options: z
          .array(
            z
              .object({
                index: selectOptionIndexSchema,
                label: z
                  .string()
                  .max(BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH),
                disabled: z.boolean(),
                selected: z.boolean(),
                empty: z.boolean(),
              })
              .strict(),
          )
          .max(BROWSER_USER_ACTION_MAX_OPTIONS)
          .optional(),
        minLength: z
          .number()
          .int()
          .min(0)
          .max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH)
          .optional(),
        maxLength: z
          .number()
          .int()
          .min(0)
          .max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH)
          .optional(),
        pattern: z.string().max(512).optional(),
        min: z
          .string()
          .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
          .optional(),
        max: z
          .string()
          .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
          .optional(),
        step: z
          .string()
          .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
          .optional(),
      })
      .strict(),
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
  completedAt: z.iso.datetime().nullable(),
  agentId: z.uuid(),
  threadId: z.uuid(),
  callbackIds: callbackIdsSchema,
  callbackDelivered: z.boolean().optional(),
});

export const browserUserActionResponseSchema = responseBaseSchema
  .extend({
    kind: z.literal("input"),
    siteOrigin: z.url(),
    fields: z
      .array(browserUserActionDisplayFieldSchema)
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_FIELDS),
  })
  .strict();

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
    summary: "Create an exact Browser input request",
  },
  get: {
    method: "GET",
    path: "/api/browser/user-actions/:requestToken",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Read a Browser user-action request",
  },
  preflight: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/preflight",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: emptyBodySchema,
    responses: { 200: browserUserActionResponseSchema, ...commonErrors },
    summary: "Check an exact Browser input target before form entry",
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
});

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
