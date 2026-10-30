import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH,
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
} from "../validators/browser-user-actions";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export {
  BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH,
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
} from "../validators/browser-user-actions";

const c = initContract();

export const BROWSER_USER_ACTION_MAX_FIELDS = 8;
export const BROWSER_USER_ACTION_MAX_TITLE_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_REASON_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_KEY_LENGTH = 64;
export const BROWSER_USER_ACTION_MAX_LABEL_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_OPTIONS = 32;
export const BROWSER_USER_ACTION_MAX_RADIO_MEMBERS = 16;
export const BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH = 256;
export const BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH = 128;
export const BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES = 1024 * 1024 * 1024;
export const BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH = 512;
export const BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES = 1_500_000;

export const browserUserActionStateSchema = zEnum([
  "pending",
  "applying",
  "succeeded",
  "cancelled",
  "stale",
  "uncertain",
]);
export const browserUserActionFieldKindSchema = zEnum([
  "text",
  "username",
  "password",
  "one_time_code",
  "number",
  "range",
  "color",
  "date_time",
  "select",
  "checkbox",
  "radio",
  "file",
]);

const boundedNonblank = (maximum: number) => {
  return string().trim().min(1).max(maximum);
};

export const browserUserActionInputFieldCreateSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  label: boundedNonblank(BROWSER_USER_ACTION_MAX_LABEL_LENGTH),
  description: string()
    .trim()
    .max(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
    .optional(),
  fieldKind: browserUserActionFieldKindSchema,
  required: boolean(),
  backendNodeId: number().int().positive().safe(),
}).strict();

const inputCreateSchema = object({
  kind: literal("input"),
  title: boundedNonblank(BROWSER_USER_ACTION_MAX_TITLE_LENGTH),
  reason: boundedNonblank(BROWSER_USER_ACTION_MAX_REASON_LENGTH),
  callbackPrompt: boundedNonblank(
    BROWSER_USER_ACTION_MAX_CALLBACK_PROMPT_LENGTH,
  ),
  pageTargetId: boundedNonblank(BROWSER_USER_ACTION_MAX_TARGET_ID_LENGTH),
  fields: array(browserUserActionInputFieldCreateSchema)
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

const browserUserActionScalarValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  value: string().max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH),
}).strict();
const selectOptionIndexSchema = number()
  .int()
  .min(0)
  .max(BROWSER_USER_ACTION_MAX_OPTIONS - 1);
const browserUserActionSelectValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  optionIndexes: array(selectOptionIndexSchema).max(
    BROWSER_USER_ACTION_MAX_OPTIONS,
  ),
  optionSetFingerprint: string().regex(/^[0-9a-f]{64}$/u),
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
const browserUserActionRangeValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  observedValue: string()
    .min(1)
    .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH),
  observedMin: string()
    .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
    .optional(),
  observedMax: string()
    .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
    .optional(),
  observedStep: string()
    .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
    .optional(),
  value: string().min(1).max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH),
}).strict();
const browserUserActionColorValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  observedColor: string().regex(/^#[0-9a-f]{6}$/u),
  value: string().regex(/^#[0-9a-f]{6}$/u),
}).strict();
const browserUserActionCheckboxValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  checked: boolean(),
  observedChecked: boolean(),
}).strict();
const browserUserActionRadioValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  memberIndex: number()
    .int()
    .min(-1)
    .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
  observedSelectedIndex: number()
    .int()
    .min(-1)
    .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
  groupFingerprint: string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const browserUserActionFileValueSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  observedFingerprint: string().regex(/^[0-9a-f]{64}$/u),
  operation: zEnum(["keep", "replace", "clear"]),
  files: array(
    object({
      name: string().min(1).max(BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH),
      type: string().max(BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH),
      size: number().int().min(0).max(BROWSER_USER_ACTION_MAX_FILE_BYTES),
    }).strict(),
  ).max(BROWSER_USER_ACTION_MAX_FILES),
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
export const browserUserActionSubmittedValueSchema = union([
  browserUserActionScalarValueSchema,
  browserUserActionRangeValueSchema,
  browserUserActionColorValueSchema,
  browserUserActionSelectValueSchema,
  browserUserActionCheckboxValueSchema,
  browserUserActionRadioValueSchema,
  browserUserActionFileValueSchema,
]);

export const browserUserActionApplyRequestSchema = object({
  values: array(browserUserActionSubmittedValueSchema).max(
    BROWSER_USER_ACTION_MAX_FIELDS,
  ),
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

export const browserUserActionDisplayFieldSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  label: boundedNonblank(BROWSER_USER_ACTION_MAX_LABEL_LENGTH),
  description: string()
    .max(BROWSER_USER_ACTION_MAX_DESCRIPTION_LENGTH)
    .optional(),
  fieldKind: browserUserActionFieldKindSchema,
  required: boolean(),
  control: object({
    tagName: zEnum(["INPUT", "TEXTAREA", "SELECT"]),
    inputType: zEnum([
      "textarea",
      "text",
      "search",
      "email",
      "tel",
      "url",
      "password",
      "number",
      "range",
      "color",
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
    siteRequired: boolean().optional(),
    accept: string().max(BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH).optional(),
    fileSetFingerprint: string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    files: array(
      object({
        name: string().min(1).max(BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH),
        type: string().max(BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH),
        size: number()
          .int()
          .min(0)
          .max(BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES),
      }).strict(),
    )
      .max(BROWSER_USER_ACTION_MAX_FILES)
      .optional(),
    checked: boolean().optional(),
    radioGroupFingerprint: string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    radioOptions: array(
      object({
        index: number()
          .int()
          .min(0)
          .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS - 1),
        label: string().min(1).max(BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH),
        disabled: boolean(),
        selected: boolean(),
      }).strict(),
    )
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_RADIO_MEMBERS)
      .optional(),
    multiple: boolean().optional(),
    optionSetFingerprint: string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    options: array(
      object({
        index: selectOptionIndexSchema,
        label: string().max(BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH),
        disabled: boolean(),
        selected: boolean(),
        empty: boolean(),
      }).strict(),
    )
      .max(BROWSER_USER_ACTION_MAX_OPTIONS)
      .optional(),
    minLength: number()
      .int()
      .min(0)
      .max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH)
      .optional(),
    maxLength: number()
      .int()
      .min(0)
      .max(BROWSER_USER_ACTION_MAX_VALUE_LENGTH)
      .optional(),
    pattern: string().max(512).optional(),
    rangeValue: string()
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
      .optional(),
    colorValue: string()
      .regex(/^#[0-9a-f]{6}$/u)
      .optional(),
    colorMode: literal("opaque-srgb").optional(),
    min: string()
      .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
      .optional(),
    max: string()
      .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
      .optional(),
    step: string()
      .max(BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
      .optional(),
  }).strict(),
}).strict();

const callbackIdsSchema = object({
  success: object({
    clientEventId: uuid(),
    chatThreadSortEventId: uuid(),
  }).strict(),
  cancellation: object({
    clientEventId: uuid(),
    chatThreadSortEventId: uuid(),
  }).strict(),
}).strict();

const responseBaseSchema = object({
  requestToken: string().min(1),
  state: browserUserActionStateSchema,
  completedAt: iso.datetime().nullable(),
  agentId: uuid(),
  threadId: uuid(),
  callbackIds: callbackIdsSchema,
  callbackDelivered: boolean().optional(),
});

export const browserUserActionResponseSchema = responseBaseSchema
  .extend({
    kind: literal("input"),
    // Historical requests remain readable without a task explanation.
    title: boundedNonblank(BROWSER_USER_ACTION_MAX_TITLE_LENGTH).optional(),
    reason: boundedNonblank(BROWSER_USER_ACTION_MAX_REASON_LENGTH).optional(),
    siteOrigin: url(),
    fields: array(browserUserActionDisplayFieldSchema)
      .min(1)
      .max(BROWSER_USER_ACTION_MAX_FIELDS),
  })
  .strict();

export const browserUserActionCreateResponseSchema = object({
  actionUrl: url(),
  action: browserUserActionResponseSchema,
}).strict();

const requestTokenParamsSchema = object({
  requestToken: string().min(1).max(512),
}).strict();
const browserFileUploadPrepareSchema = object({
  key: boundedNonblank(BROWSER_USER_ACTION_MAX_KEY_LENGTH),
  index: number()
    .int()
    .min(0)
    .max(BROWSER_USER_ACTION_MAX_FILES - 1),
  size: number().int().min(0).max(BROWSER_USER_ACTION_MAX_FILE_BYTES),
}).strict();
const emptyBodySchema = object({}).strict();
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
  prepareFileUpload: {
    method: "POST",
    path: "/api/browser/user-actions/:requestToken/files/prepare",
    headers: authHeadersSchema,
    pathParams: requestTokenParamsSchema,
    body: browserFileUploadPrepareSchema,
    responses: {
      200: object({
        uploadUrl: url(),
      }).strict(),
      ...commonErrors,
    },
    summary: "Prepare a temporary direct upload for a Browser file input",
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

export type BrowserUserActionState = zInfer<
  typeof browserUserActionStateSchema
>;
export type BrowserUserActionFieldKind = zInfer<
  typeof browserUserActionFieldKindSchema
>;
export type BrowserUserActionCreateRequest = zInfer<
  typeof browserUserActionCreateRequestSchema
>;
export type BrowserUserActionApplyRequest = zInfer<
  typeof browserUserActionApplyRequestSchema
>;
export type BrowserUserActionPrepareFileUploadRequest = zInfer<
  typeof browserFileUploadPrepareSchema
>;
export type BrowserUserActionResponse = zInfer<
  typeof browserUserActionResponseSchema
>;
export type BrowserUserActionsContract = typeof browserUserActionsContract;
