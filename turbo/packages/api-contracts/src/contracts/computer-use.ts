import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUseAnyPluginCallBodySchema,
} from "./computer-use-plugins";

const c = initContract();

export const computerUseHostStatusSchema = z.enum(["online", "offline"]);

export const computerUseReadCommandKindSchema = z.enum([
  "apps.list",
  "app.state",
]);

export const computerUseWriteCommandKindSchema = z.enum([
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
]);

export const computerUsePluginCommandKindSchema = z.literal(
  COMPUTER_USE_PLUGIN_CALL_KIND,
);

export const computerUseCommandKindSchema = z.enum([
  ...computerUseReadCommandKindSchema.options,
  ...computerUseWriteCommandKindSchema.options,
  COMPUTER_USE_PLUGIN_CALL_KIND,
]);

export const computerUseCommandStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const computerUseCommandErrorCodeSchema = z.enum([
  "no_host",
  "permission_denied",
  "accessibility_unavailable",
  "automation_permission_denied",
  "window_unavailable",
  "screen_recording_unavailable",
  "app_not_found",
  "app_open_failed",
  "element_action_unsupported",
  "element_not_editable",
  "unsupported_command",
  "timeout",
  "command_timeout",
  "feature_disabled",
  "plugin_disabled",
  "plugin_unavailable",
  "plugin_restarting",
  "unknown_plugin",
  "unknown_tool",
  "invalid_arguments",
  "path_denied",
  "result_too_large",
  "input_too_large",
  "mcp_error",
]);

const hostNameSchema = z.string().trim().min(1).max(253);
const hostInstallationIdSchema = z.string().trim().uuid();
const hostVersionSchema = z.string().trim().min(1).max(64);
const hostOsVersionSchema = z.string().trim().min(1).max(128);
const authorizationRequestTokenPathParamsSchema = z.object({
  requestToken: z.string().min(1),
});
const commandIdPathParamsSchema = z.object({
  commandId: z.string().min(1),
});
const supportedCapabilitiesSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(50);
const appNameSchema = z.string().trim().min(1).max(256);
const snapshotIdSchema = z.string().trim().min(1).max(256);
const elementIdSchema = z.string().trim().min(1).max(256);
const elementIndexSchema = z.number().int().min(0);

const computerUsePermissionsSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
  automation: z
    .object({
      chrome: z
        .object({
          status: z.enum([
            "unknown",
            "granted",
            "denied",
            "not_installed",
            "not_running",
          ]),
          updatedAt: z.string().nullable().default(null),
          reason: z.string().nullable().default(null),
        })
        .default({ status: "unknown", updatedAt: null, reason: null }),
      safari: z
        .object({
          status: z.enum([
            "unknown",
            "granted",
            "denied",
            "not_installed",
            "not_running",
          ]),
          updatedAt: z.string().nullable().default(null),
          reason: z.string().nullable().default(null),
        })
        .default({ status: "unknown", updatedAt: null, reason: null }),
    })
    .default({
      chrome: { status: "unknown", updatedAt: null, reason: null },
      safari: { status: "unknown", updatedAt: null, reason: null },
    }),
});

const computerUseRuntimeBodySchema = z.object({
  installationId: hostInstallationIdSchema.optional(),
  hostName: hostNameSchema,
  appVersion: hostVersionSchema,
  osVersion: hostOsVersionSchema,
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
  permissions: computerUsePermissionsSchema,
});

const computerUseCommandTargetShape = {
  timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
} as const;

const computerUseCommandPayloadShape = {
  app: appNameSchema.optional(),
  snapshotId: snapshotIdSchema.optional(),
  elementId: elementIdSchema.optional(),
  elementIndex: elementIndexSchema.optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pages: z.number().positive().max(25).optional(),
  value: z.string().min(1).max(64_000).optional(),
  text: z.string().min(1).max(64_000).optional(),
  key: z.string().trim().min(1).max(256).optional(),
  action: z.string().trim().min(1).max(256).optional(),
} as const;

const computerUseCommandCreateBodySchema = z
  .object({
    kind: computerUseReadCommandKindSchema,
    ...computerUseCommandTargetShape,
    ...computerUseCommandPayloadShape,
  })
  .superRefine((body, ctx) => {
    if (body.kind === "app.state" && !body.app) {
      ctx.addIssue({
        code: "custom",
        path: ["app"],
        message: "app.state requires app",
      });
    }
  });

const computerUseWriteCommandCreateBaseSchema = z.object({
  kind: computerUseWriteCommandKindSchema,
  ...computerUseCommandTargetShape,
  ...computerUseCommandPayloadShape,
});

type ComputerUseWriteCommandCreateBody = z.infer<
  typeof computerUseWriteCommandCreateBaseSchema
>;

interface ComputerUseCommandValidationContext {
  addIssue(issue: {
    code: "custom";
    path: PropertyKey[];
    message: string;
  }): void;
}

function requireComputerUseField(
  ctx: ComputerUseCommandValidationContext,
  field: string,
  message: string,
): void {
  ctx.addIssue({ code: "custom", path: [field], message });
}

function validateElementClickCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  const hasPoint = body.x !== undefined && body.y !== undefined;
  if (!body.elementId && body.elementIndex === undefined && !hasPoint) {
    requireComputerUseField(
      ctx,
      "elementIndex",
      "element.click requires elementId, elementIndex, or x/y",
    );
  }
  if ((body.x === undefined) !== (body.y === undefined)) {
    requireComputerUseField(
      ctx,
      "x",
      "element.click coordinates require both x and y",
    );
  }
}

function validateElementScrollCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId && body.elementIndex === undefined) {
    requireComputerUseField(
      ctx,
      "elementIndex",
      "element.scroll requires elementId or elementIndex",
    );
  }
  if (!body.direction) {
    requireComputerUseField(
      ctx,
      "direction",
      "element.scroll requires direction",
    );
  }
}

function validateElementSetValueCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId && body.elementIndex === undefined) {
    requireComputerUseField(
      ctx,
      "elementIndex",
      "element.set_value requires elementId or elementIndex",
    );
  }
  if (!body.value) {
    requireComputerUseField(ctx, "value", "element.set_value requires value");
  }
}

function validateElementActionCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.elementId && body.elementIndex === undefined) {
    requireComputerUseField(
      ctx,
      "elementIndex",
      "element.perform_action requires elementId or elementIndex",
    );
  }
  if (!body.action) {
    requireComputerUseField(
      ctx,
      "action",
      "element.perform_action requires action",
    );
  }
}

function validateComputerUseWriteCommand(
  body: ComputerUseWriteCommandCreateBody,
  ctx: ComputerUseCommandValidationContext,
): void {
  if (!body.app) {
    requireComputerUseField(ctx, "app", `${body.kind} requires app`);
    return;
  }

  switch (body.kind) {
    case "app.open":
      return;
    case "element.click":
      validateElementClickCommand(body, ctx);
      return;
    case "element.scroll":
      validateElementScrollCommand(body, ctx);
      return;
    case "element.set_value":
      validateElementSetValueCommand(body, ctx);
      return;
    case "element.perform_action":
      validateElementActionCommand(body, ctx);
      return;
    case "keyboard.type_text":
      if (!body.text) {
        requireComputerUseField(
          ctx,
          "text",
          "keyboard.type_text requires text",
        );
      }
      return;
    case "keyboard.press_key":
      if (!body.key) {
        requireComputerUseField(ctx, "key", "keyboard.press_key requires key");
      }
  }
}

const computerUseWriteCommandCreateBodySchema =
  computerUseWriteCommandCreateBaseSchema.superRefine(
    validateComputerUseWriteCommand,
  );

const computerUseCommandErrorSchema = z.object({
  code: computerUseCommandErrorCodeSchema,
  message: z.string(),
});

const computerUseCommandResultSchema = z.record(z.string(), z.unknown());

/**
 * Screenshot pointer shapes for `computer_use_commands.result.screenshot`.
 *
 * Old rows store the screenshot as a `data:image/...;base64,...` string. New
 * rows store the bytes in private object storage and keep only a pointer here.
 * The stored pointer carries `bucket`/`key`; the client-facing pointer omits
 * them so internal storage layout never leaves the API. After retention
 * deletes the object the pointer is rewritten to `{ type: "expired" }`.
 */
export interface StoredScreenshotPointer {
  readonly type: "s3";
  readonly bucket: string;
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ClientScreenshotPointer {
  readonly type: "s3" | "expired";
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface StoredPluginContentPointer {
  readonly type: "s3";
  readonly bucket: string;
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

export interface ClientPluginContentPointer {
  readonly type: "s3" | "expired";
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly fileName?: string;
}

export function isStoredScreenshotPointer(
  value: unknown,
): value is StoredScreenshotPointer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "s3" &&
    typeof (value as { readonly key?: unknown }).key === "string"
  );
}

export function isExpiredScreenshotPointer(
  value: unknown,
): value is { readonly type: "expired" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "expired"
  );
}

export function isStoredPluginContentPointer(
  value: unknown,
): value is StoredPluginContentPointer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "s3" &&
    typeof (value as { readonly bucket?: unknown }).bucket === "string" &&
    typeof (value as { readonly key?: unknown }).key === "string" &&
    typeof (value as { readonly mimeType?: unknown }).mimeType === "string" &&
    typeof (value as { readonly fileName?: unknown }).fileName === "string"
  );
}

export function isExpiredPluginContentPointer(
  value: unknown,
): value is { readonly type: "expired" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly type?: unknown }).type === "expired"
  );
}

export const computerUseHostSchema = z.object({
  id: z.string(),
  hostName: z.string().optional(),
  displayName: z.string(),
  appVersion: z.string(),
  osVersion: z.string(),
  supportedCapabilities: z.array(z.string()),
  permissions: computerUsePermissionsSchema,
  status: computerUseHostStatusSchema,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const computerUseHostStartResponseSchema = z.object({
  hostId: z.string(),
  hostToken: z.string(),
});

export const computerUseHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const computerUseHostStopBodySchema = z.object({});

export const computerUseHostStopResponseSchema = z.object({
  ok: z.literal(true),
  hostId: z.string(),
});

export const computerUseHostListResponseSchema = z.object({
  hosts: z.array(computerUseHostSchema),
});

export const computerUseAuthorizationSourceSchema = z.enum([
  "chat",
  "slack",
  "teams",
]);

const computerUseAuthorizationRequestCreateBodySchema = z.object({});

export const computerUseAuthorizationRequestCreateResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  source: computerUseAuthorizationSourceSchema,
  expiresAt: z.string(),
});

export const computerUseAuthorizationRequestResponseSchema = z.object({
  source: computerUseAuthorizationSourceSchema,
  expiresAt: z.string(),
  completedAt: z.string().nullable(),
  computerUseHostId: z.string().uuid().nullable(),
  hosts: z.array(computerUseHostSchema),
});

const computerUseAuthorizationRequestApplyBodySchema = z.object({
  computerUseHostId: z.string().uuid(),
});

export const computerUseAuthorizationRequestApplyResponseSchema = z.object({
  ok: z.literal(true),
  source: computerUseAuthorizationSourceSchema,
  computerUseHostId: z.string().uuid(),
});

export const computerUseCommandCreateResponseSchema = z.object({
  commandId: z.string(),
  status: z.literal("queued"),
});

export const computerUseCommandResponseSchema = z.object({
  id: z.string(),
  kind: computerUseCommandKindSchema,
  status: computerUseCommandStatusSchema,
  hostId: z.string().nullable(),
  hostName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  result: computerUseCommandResultSchema.optional(),
  error: computerUseCommandErrorSchema.optional(),
  timeoutMs: z.number().int().nullable(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const computerUseHostCommandNextBodySchema = z.object({
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
});

export const computerUseHostCommandNextResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("command"),
      command: computerUseCommandResponseSchema,
    }),
  ],
);

export const computerUseHostCommandCompleteBodySchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("succeeded"),
      result: computerUseCommandResultSchema,
    }),
    z.object({
      status: z.literal("failed"),
      error: computerUseCommandErrorSchema,
    }),
  ],
);

export const computerUseCommandCompleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const computerUseAuditEventSchema = z.object({
  id: z.string(),
  commandId: z.string(),
  runId: z.string().nullable(),
  hostId: z.string().nullable(),
  kind: computerUseCommandKindSchema,
  app: z.string().nullable(),
  event: z.literal("completed"),
  redactedResult: z.record(z.string(), z.unknown()).nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export const computerUseAuditEventListResponseSchema = z.object({
  auditEvents: z.array(computerUseAuditEventSchema),
});

export const computerUseHostsContract = c.router({
  start: {
    method: "POST",
    path: "/api/computer-use/hosts/start",
    headers: authHeadersSchema,
    body: computerUseRuntimeBodySchema,
    responses: {
      200: computerUseHostStartResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Start or reactivate a desktop computer-use host",
  },
  list: {
    method: "GET",
    path: "/api/computer-use/hosts",
    headers: authHeadersSchema,
    responses: {
      200: computerUseHostListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List linked desktop computer-use hosts",
  },
});

export const computerUseHeartbeatContract = c.router({
  heartbeat: {
    method: "POST",
    path: "/api/computer-use/heartbeat",
    headers: authHeadersSchema,
    body: computerUseRuntimeBodySchema,
    responses: {
      200: computerUseHeartbeatResponseSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Refresh a desktop computer-use host heartbeat",
  },
  stop: {
    method: "POST",
    path: "/api/computer-use/host/stop",
    headers: authHeadersSchema,
    body: computerUseHostStopBodySchema,
    responses: {
      200: computerUseHostStopResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Stop a desktop computer-use host",
  },
});

export const computerUseAuthorizationRequestsContract = c.router({
  create: {
    method: "POST",
    path: "/api/computer-use/authorization-requests",
    headers: authHeadersSchema,
    body: computerUseAuthorizationRequestCreateBodySchema,
    responses: {
      200: computerUseAuthorizationRequestCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Create a short-lived Computer Use authorization request for the current run",
  },
  get: {
    method: "GET",
    path: "/api/computer-use/authorization-requests/:requestToken",
    headers: authHeadersSchema,
    pathParams: authorizationRequestTokenPathParamsSchema,
    responses: {
      200: computerUseAuthorizationRequestResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Read a Computer Use authorization request",
  },
  apply: {
    method: "POST",
    path: "/api/computer-use/authorization-requests/:requestToken/apply",
    headers: authHeadersSchema,
    pathParams: authorizationRequestTokenPathParamsSchema,
    body: computerUseAuthorizationRequestApplyBodySchema,
    responses: {
      200: computerUseAuthorizationRequestApplyResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Bind a Computer Use host for a delegated authorization request",
  },
});

export const computerUseCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/computer-use/commands",
    headers: authHeadersSchema,
    body: computerUseCommandCreateBodySchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a read-only desktop computer-use command",
  },
  get: {
    method: "GET",
    path: "/api/computer-use/commands/:commandId",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    responses: {
      200: computerUseCommandResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a desktop computer-use command result",
  },
  getScreenshot: {
    method: "GET",
    path: "/api/computer-use/commands/:commandId/screenshot",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    responses: {
      200: c.type<Blob>(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Download a desktop computer-use command screenshot",
  },
  getPluginContent: {
    method: "GET",
    path: "/api/computer-use/commands/:commandId/plugin-content",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    responses: {
      200: c.type<Blob>(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Download offloaded desktop computer-use plugin content",
  },
});

export const computerUseWriteCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/computer-use/write-commands",
    headers: authHeadersSchema,
    body: computerUseWriteCommandCreateBodySchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a desktop computer-use write command",
  },
});

export const computerUsePluginCommandContract = c.router({
  create: {
    method: "POST",
    path: "/api/computer-use/plugin-commands",
    headers: authHeadersSchema,
    body: computerUseAnyPluginCallBodySchema,
    responses: {
      200: computerUseCommandCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a desktop computer-use plugin command",
  },
});

export const computerUseHostCommandsContract = c.router({
  next: {
    method: "POST",
    path: "/api/computer-use/host/commands/next",
    headers: authHeadersSchema,
    body: computerUseHostCommandNextBodySchema,
    responses: {
      200: computerUseHostCommandNextResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Claim the next approved desktop computer-use command",
  },
  complete: {
    method: "POST",
    path: "/api/computer-use/host/commands/:commandId/complete",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    body: computerUseHostCommandCompleteBodySchema,
    responses: {
      200: computerUseCommandCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Complete a desktop computer-use command",
  },
});

export const computerUseAuditEventsContract = c.router({
  list: {
    method: "GET",
    path: "/api/computer-use/audit-events",
    headers: authHeadersSchema,
    query: z.object({
      limit: z.coerce.number().int().positive().max(200).default(50),
      commandId: z.string().optional(),
      hostId: z.string().optional(),
      runId: z.string().optional(),
    }),
    responses: {
      200: computerUseAuditEventListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List desktop computer-use write command audit events",
  },
});

export type ComputerUseAuditEvent = z.infer<typeof computerUseAuditEventSchema>;
export type ComputerUseAuditEventListResponse = z.infer<
  typeof computerUseAuditEventListResponseSchema
>;
export type ComputerUseCommandCreateResponse = z.infer<
  typeof computerUseCommandCreateResponseSchema
>;
export type ComputerUseCommandError = z.infer<
  typeof computerUseCommandErrorSchema
>;
export type ComputerUseCommandKind = z.infer<
  typeof computerUseCommandKindSchema
>;
export type ComputerUseCommandResponse = z.infer<
  typeof computerUseCommandResponseSchema
>;
export type ComputerUseCommandResult = z.infer<
  typeof computerUseCommandResultSchema
>;
export type ComputerUseCommandStatus = z.infer<
  typeof computerUseCommandStatusSchema
>;
export type ComputerUseHost = z.infer<typeof computerUseHostSchema>;
export type ComputerUseHostListResponse = z.infer<
  typeof computerUseHostListResponseSchema
>;
export type ComputerUseAuthorizationRequestCreateResponse = z.infer<
  typeof computerUseAuthorizationRequestCreateResponseSchema
>;
export type ComputerUseAuthorizationRequestResponse = z.infer<
  typeof computerUseAuthorizationRequestResponseSchema
>;
export type ComputerUseAuthorizationRequestApplyResponse = z.infer<
  typeof computerUseAuthorizationRequestApplyResponseSchema
>;
export type ComputerUseAuthorizationSource = z.infer<
  typeof computerUseAuthorizationSourceSchema
>;
export type ComputerUseReadCommandKind = z.infer<
  typeof computerUseReadCommandKindSchema
>;
export type ComputerUseWriteCommandKind = z.infer<
  typeof computerUseWriteCommandKindSchema
>;
export type ComputerUsePluginCommandKind = z.infer<
  typeof computerUsePluginCommandKindSchema
>;
export type ComputerUseAuditEventsContract =
  typeof computerUseAuditEventsContract;
export type ComputerUseCommandContract = typeof computerUseCommandContract;
export type ComputerUseHeartbeatContract = typeof computerUseHeartbeatContract;
export type ComputerUseAuthorizationRequestsContract =
  typeof computerUseAuthorizationRequestsContract;
export type ComputerUseHostCommandsContract =
  typeof computerUseHostCommandsContract;
export type ComputerUseHostsContract = typeof computerUseHostsContract;
export type ComputerUseWriteCommandContract =
  typeof computerUseWriteCommandContract;
export type ComputerUsePluginCommandContract =
  typeof computerUsePluginCommandContract;
