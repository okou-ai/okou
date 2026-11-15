import {
  array,
  boolean,
  enum as zEnum,
  literal,
  number,
  object,
  record,
  string,
  unknown as zUnknown,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { ablyTokenRequestSchema } from "./realtime";

export const phoneActionSchema = object({
  kind: zEnum([
    "session.start",
    "observe",
    "app.open",
    "tap",
    "swipe",
    "type",
    "session.stop",
  ]),
  app: string().min(1).max(255).optional(),
  snapshotId: uuid().optional(),
  elementId: string()
    .regex(/^(0|[1-9]\d{0,2})$/u)
    .optional(),
  text: string()
    .max(4000)
    .regex(/^[^\x00-\x1f\x7f]*$/u)
    .optional(),
  direction: zEnum(["up", "down", "left", "right"]).optional(),
  goal: string().min(1).max(1000).optional(),
})
  .strict()
  .superRefine((value, context) => {
    const invalid = (message: string) => {
      return context.addIssue({ code: "custom", message });
    };
    if (value.kind === "session.start" && !value.goal)
      invalid("A concrete task goal is required");
    if (value.kind === "app.open" && !value.app) invalid("app is required");
    if (
      ["tap", "swipe", "type"].includes(value.kind) &&
      (!value.snapshotId || !value.app)
    )
      invalid("A current snapshot and expected app are required");
    if (value.kind === "tap" && !value.elementId)
      invalid("elementId is required");
    if (value.kind === "type" && !value.text) invalid("text is required");
    if (value.kind === "swipe" && !value.direction)
      invalid("direction is required");
  });
export type PhoneAction = zInfer<typeof phoneActionSchema>;
export const phoneResultSchema = object({
  status: zEnum(["succeeded", "failed", "unknown", "approval_required"]),
  data: record(string(), zUnknown())
    .refine((value) => {
      return JSON.stringify(value).length <= 1_000_000;
    }, "Observation metadata exceeds the size limit")
    .default({}),
  error: string().max(2000).optional(),
  screenshotBase64: string().max(8_000_000).optional(),
});
export const phoneOperationSchema = object({
  id: uuid(),
  deviceId: uuid(),
  runId: uuid(),
  grantId: uuid(),
  action: phoneActionSchema,
  status: zEnum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "approval_required",
  ]),
  result: record(string(), zUnknown()).nullable(),
  error: string().nullable(),
  createdAt: string(),
  expiresAt: string(),
});
export const phoneDeviceSchema = object({
  id: uuid(),
  displayName: string(),
  osVersion: string(),
  appVersion: string(),
  generation: number().int(),
  ready: boolean(),
  lastSeenAt: string(),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};
const base = { headers: authHeadersSchema, responses: errors };
const devicePath = object({ deviceId: uuid() });
const authority = object({ generation: number().int().positive() });
const c = initContract();
export const phoneUseContract = c.router({
  devices: {
    ...base,
    method: "GET",
    path: "/api/phone-use/devices",
    responses: {
      ...errors,
      200: object({ devices: array(phoneDeviceSchema) }),
    },
  },
  register: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices",
    body: object({
      installationId: uuid(),
      displayName: string().min(1).max(100),
      osVersion: string()
        .regex(/^\d+(?:\.\d+){0,2}$/u)
        .refine((version) => {
          return Number(version.split(".")[0]) >= 27;
        }, "iOS 27 or later is required"),
      appVersion: literal("1"),
      protocolVersion: literal(1),
    }),
    responses: { ...errors, 200: phoneDeviceSchema },
  },
  heartbeat: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/heartbeat",
    pathParams: devicePath,
    body: authority.extend({ ready: boolean() }),
    responses: { ...errors, 200: object({ ok: literal(true) }) },
  },
  disconnect: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/disconnect",
    pathParams: devicePath,
    body: authority,
    responses: { ...errors, 200: object({ ok: literal(true) }) },
  },
  realtime: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/realtime",
    pathParams: devicePath,
    body: authority,
    responses: {
      ...errors,
      200: object({ channel: string(), tokenRequest: ablyTokenRequestSchema }),
    },
  },
  chats: {
    ...base,
    method: "GET",
    path: "/api/phone-use/chats",
    responses: {
      ...errors,
      200: object({
        chats: array(object({ id: uuid(), title: string().nullable() })),
      }),
    },
  },
  grant: {
    ...base,
    method: "POST",
    path: "/api/phone-use/grants",
    body: object({
      deviceId: uuid(),
      threadId: uuid(),
      generation: number().int().positive(),
      allow: boolean(),
    }),
    responses: { ...errors, 200: object({ ok: literal(true) }) },
  },
  create: {
    ...base,
    method: "POST",
    path: "/api/phone-use/operations",
    body: object({ id: uuid(), action: phoneActionSchema }),
    responses: { ...errors, 200: phoneOperationSchema },
  },
  get: {
    ...base,
    method: "GET",
    path: "/api/phone-use/operations/:operationId",
    pathParams: object({ operationId: uuid() }),
    responses: { ...errors, 200: phoneOperationSchema },
  },
  screenshot: {
    ...base,
    method: "GET",
    path: "/api/phone-use/operations/:operationId/screenshot",
    pathParams: object({ operationId: uuid() }),
    responses: { ...errors, 200: object({ url: string() }) },
  },
  next: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/next",
    pathParams: devicePath,
    body: authority.extend({
      activeRunId: uuid().optional(),
      activeGrantId: uuid().optional(),
    }),
    responses: {
      ...errors,
      200: object({
        operation: phoneOperationSchema.nullable(),
        sessionEnded: boolean().optional(),
      }),
    },
  },
  validate: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/validate",
    pathParams: devicePath,
    body: authority.extend({ operationId: uuid() }),
    responses: { ...errors, 200: object({ ok: literal(true) }) },
  },
  complete: {
    ...base,
    method: "POST",
    path: "/api/phone-use/devices/:deviceId/complete",
    pathParams: devicePath,
    body: authority.extend({ operationId: uuid(), result: phoneResultSchema }),
    responses: { ...errors, 200: object({ ok: literal(true) }) },
  },
});
export function phoneUseChannel(
  orgId: string,
  userId: string,
  deviceId: string,
  generation: number,
) {
  return `phone-use:${orgId}:${userId}:${deviceId}:${generation}`;
}
