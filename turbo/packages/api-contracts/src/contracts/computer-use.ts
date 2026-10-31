import { desktopUpgradeRequiredSchema } from "./desktop-updates";
import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  intersection,
  literal,
  looseObject,
  number,
  object,
  record,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import {
  desktopShellPayloadSchema,
  desktopShellResultSchema,
} from "./desktop-shell-schemas";
import { fileDownloadUrlSchema } from "./file-download";
import { authHeadersSchema, initContract } from "./base";
import { ApiError, apiErrorSchema } from "./errors";
import {
  computerUseCommandNotificationsSchema,
  realtimeSubscriptionSchema,
} from "./realtime";
import { computerUseHostStatusSchema } from "../validators/computer-use";

export { computerUseHostStatusSchema } from "../validators/computer-use";

const c = initContract();

export const computerUseReadCommandKindSchema = zEnum([
  "apps.list",
  "app.state",
]);

export const computerUseWriteCommandKindSchema = zEnum([
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
]);

export const desktopShellKindSchema = zEnum([
  "shell.cmd",
  "shell.list",
  "shell.status",
  "shell.close",
]);

export const computerUseCommandKindSchema = zEnum([
  ...computerUseReadCommandKindSchema.options,
  ...computerUseWriteCommandKindSchema.options,
  ...desktopShellKindSchema.options,
]);

export const computerUseCommandStatusSchema = zEnum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const computerUseCommandErrorCodeSchema = zEnum([
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
  "invalid_arguments",
  "result_too_large",
  "shell_unavailable",
  "shell_busy",
]);

const hostNameSchema = string().trim().min(1).max(253);
const hostInstallationIdSchema = string().trim().uuid();
const hostVersionSchema = string().trim().min(1).max(64);
const hostOsVersionSchema = string().trim().min(1).max(128);
const authorizationRequestTokenPathParamsSchema = object({
  requestToken: string().min(1),
});
const commandIdPathParamsSchema = object({
  commandId: string().min(1),
});
const supportedCapabilitiesSchema = array(string().trim().min(1).max(128)).max(
  50,
);
const appNameSchema = string().trim().min(1).max(256);
const snapshotIdSchema = string().trim().min(1).max(256);
const elementIdSchema = string().trim().min(1).max(256);
const elementIndexSchema = number().int().min(0);

const computerUsePermissionsSchema = object({
  accessibility: boolean(),
  screenRecording: boolean(),
  automation: object({
    chrome: object({
      status: zEnum([
        "unknown",
        "granted",
        "denied",
        "not_installed",
        "not_running",
      ]),
      updatedAt: string().nullable().default(null),
      reason: string().nullable().default(null),
    }).default({ status: "unknown", updatedAt: null, reason: null }),
    safari: object({
      status: zEnum([
        "unknown",
        "granted",
        "denied",
        "not_installed",
        "not_running",
      ]),
      updatedAt: string().nullable().default(null),
      reason: string().nullable().default(null),
    }).default({ status: "unknown", updatedAt: null, reason: null }),
  }).default({
    chrome: { status: "unknown", updatedAt: null, reason: null },
    safari: { status: "unknown", updatedAt: null, reason: null },
  }),
});

const computerUseRuntimeBodySchema = object({
  installationId: hostInstallationIdSchema.optional(),
  hostName: hostNameSchema,
  appVersion: hostVersionSchema,
  osVersion: hostOsVersionSchema,
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
  permissions: computerUsePermissionsSchema,
});

const computerUseHostStartBodySchema = computerUseRuntimeBodySchema.extend({
  installationId: hostInstallationIdSchema,
});

const computerUseCommandTargetShape = {
  timeoutMs: number().int().min(1_000).max(120_000).default(60_000),
  realtime: boolean().optional(),
} as const;

const computerUseCommandPayloadShape = {
  app: appNameSchema.optional(),
  snapshotId: snapshotIdSchema.optional(),
  elementId: elementIdSchema.optional(),
  elementIndex: elementIndexSchema.optional(),
  x: number().int().min(0).optional(),
  y: number().int().min(0).optional(),
  button: zEnum(["left", "right", "middle"]).optional(),
  clickCount: number().int().min(1).max(3).optional(),
  direction: zEnum(["up", "down", "left", "right"]).optional(),
  pages: number().positive().max(25).optional(),
  value: string().min(1).max(64_000).optional(),
  text: string().min(1).max(64_000).optional(),
  key: string().trim().min(1).max(256).optional(),
  action: string().trim().min(1).max(256).optional(),
} as const;

const computerUseCommandCreateBodySchema = object({
  kind: computerUseReadCommandKindSchema,
  ...computerUseCommandTargetShape,
  ...computerUseCommandPayloadShape,
}).superRefine((body, ctx) => {
  if (body.kind === "app.state" && !body.app) {
    ctx.addIssue({
      code: "custom",
      path: ["app"],
      message: "app.state requires app",
    });
  }
});

const computerUseWriteCommandCreateBaseSchema = object({
  kind: computerUseWriteCommandKindSchema,
  ...computerUseCommandTargetShape,
  ...computerUseCommandPayloadShape,
});

type ComputerUseWriteCommandCreateBody = zInfer<
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

const computerUseCommandErrorSchema = object({
  code: computerUseCommandErrorCodeSchema,
  message: string(),
});

// GUI/helper fields remain open. Declare the shared Shell fields without adding
// required queue fields or changing the JSON sent by installed 0.54.x builds.
const computerUseCommandPayloadSchema = looseObject({
  ...desktopShellPayloadSchema.shape,
  // GUI keyboard.press_key uses the same name with a different key vocabulary.
  key: string().optional(),
}).meta({ "x-desktop-stable-fields": true });
const computerUseCommandResultSchema = looseObject(
  desktopShellResultSchema.shape,
).meta({ "x-desktop-stable-fields": true });

/**
 * Screenshot pointer shapes for `computer_use_commands.result.screenshot`.
 *
 * Valid image data URLs are offloaded on completion; stored screenshots keep
 * only a private object pointer. Unrecognized strings can still be persisted
 * but are not downloadable as screenshots. The stored pointer carries
 * `bucket`/`key`; the client-facing pointer omits
 * them so internal storage layout never leaves the API. Retention deletes
 * commands together with their objects. Existing `{ type: "expired" }`
 * pointers from screenshot-only retention remain readable until command cleanup.
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

export const computerUseHostSchema = object({
  id: string(),
  hostName: string().optional(),
  displayName: string(),
  appVersion: string(),
  osVersion: string(),
  supportedCapabilities: array(string()),
  permissions: computerUsePermissionsSchema,
  status: computerUseHostStatusSchema,
  lastSeenAt: string(),
  createdAt: string(),
});

export const computerUseHeartbeatResponseSchema = object({
  ok: literal(true),
  hostId: string(),
});

export const computerUseHostStopResponseSchema = object({
  ok: literal(true),
  hostId: string(),
});

export const computerUseHostListResponseSchema = object({
  hosts: array(computerUseHostSchema),
});

export const computerUseAuthorizationSourceSchema = zEnum([
  "chat",
  "slack",
  "teams",
]);

const computerUseAuthorizationRequestCreateBodySchema = object({});

export const computerUseAuthorizationRequestCreateResponseSchema = object({
  authorizationUrl: string().url(),
  source: computerUseAuthorizationSourceSchema,
  expiresAt: string(),
});

export const computerUseAuthorizationRequestResponseSchema = object({
  source: computerUseAuthorizationSourceSchema,
  expiresAt: string(),
  completedAt: string().nullable(),
  computerUseHostId: string().uuid().nullable(),
  hosts: array(computerUseHostSchema),
});

const computerUseAuthorizationRequestApplyBodySchema = object({
  computerUseHostId: string().uuid(),
});

export const computerUseAuthorizationRequestApplyResponseSchema = object({
  ok: literal(true),
  source: computerUseAuthorizationSourceSchema,
  computerUseHostId: string().uuid(),
});

export const computerUseCommandCreateResponseSchema = object({
  commandId: string(),
  status: literal("queued"),
  realtime: realtimeSubscriptionSchema.optional(),
});

export const computerUseCommandResponseSchema = object({
  id: string(),
  kind: computerUseCommandKindSchema,
  status: computerUseCommandStatusSchema,
  hostId: string().nullable(),
  hostName: string().nullable(),
  payload: computerUseCommandPayloadSchema,
  result: computerUseCommandResultSchema.optional(),
  error: computerUseCommandErrorSchema.optional(),
  timeoutMs: number().int().nullable(),
  createdAt: string(),
  claimedAt: string().nullable(),
  completedAt: string().nullable(),
});

export const computerUseHostCommandNextBodySchema = object({
  supportedCapabilities: supportedCapabilitiesSchema.default([]),
});

export const computerUseHostCommandNextResponseSchema = discriminatedUnion(
  "status",
  [
    object({ status: literal("idle") }),
    object({
      status: literal("command"),
      command: computerUseCommandResponseSchema,
    }),
  ],
);

export const computerUseHostCommandCompleteBodySchema = discriminatedUnion(
  "status",
  [
    object({
      status: literal("succeeded"),
      result: computerUseCommandResultSchema,
    }),
    object({
      status: literal("failed"),
      error: computerUseCommandErrorSchema,
    }),
  ],
);

export const computerUseCommandCompleteResponseSchema = object({
  ok: literal(true),
});

export const computerUseAuditEventSchema = object({
  id: string(),
  commandId: string(),
  runId: string().nullable(),
  hostId: string().nullable(),
  kind: computerUseCommandKindSchema,
  app: string().nullable(),
  event: literal("completed"),
  redactedResult: record(string(), zUnknown()).nullable(),
  error: record(string(), zUnknown()).nullable(),
  createdAt: string(),
});

export const computerUseAuditEventListResponseSchema = object({
  auditEvents: array(computerUseAuditEventSchema),
});

export const computerUseHostsContract = c.router({
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
  screenshotUrl: {
    method: "GET",
    path: "/api/computer-use/commands/:commandId/screenshot/url",
    headers: authHeadersSchema,
    pathParams: commandIdPathParamsSchema,
    responses: {
      200: fileDownloadUrlSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Resolve a temporary direct URL for a desktop command screenshot",
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

export const computerUseAuditEventsContract = c.router({
  list: {
    method: "GET",
    path: "/api/computer-use/audit-events",
    headers: authHeadersSchema,
    query: object({
      limit: coerce.number().int().positive().max(200).default(50),
      commandId: string().optional(),
      hostId: string().optional(),
      runId: string().optional(),
    }),
    responses: {
      200: computerUseAuditEventListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List desktop computer-use write command audit events",
  },
});

export type ComputerUseAuditEvent = zInfer<typeof computerUseAuditEventSchema>;
export type ComputerUseAuditEventListResponse = zInfer<
  typeof computerUseAuditEventListResponseSchema
>;
export type ComputerUseCommandCreateResponse = zInfer<
  typeof computerUseCommandCreateResponseSchema
>;
export type ComputerUseCommandError = zInfer<
  typeof computerUseCommandErrorSchema
>;
export type ComputerUseCommandKind = zInfer<
  typeof computerUseCommandKindSchema
>;
export type ComputerUseCommandResponse = zInfer<
  typeof computerUseCommandResponseSchema
>;
export type ComputerUseCommandResult = zInfer<
  typeof computerUseCommandResultSchema
>;
export type ComputerUseCommandStatus = zInfer<
  typeof computerUseCommandStatusSchema
>;
export type ComputerUseHost = zInfer<typeof computerUseHostSchema>;
export type ComputerUseHostListResponse = zInfer<
  typeof computerUseHostListResponseSchema
>;
export type ComputerUseAuthorizationRequestCreateResponse = zInfer<
  typeof computerUseAuthorizationRequestCreateResponseSchema
>;
export type ComputerUseAuthorizationRequestResponse = zInfer<
  typeof computerUseAuthorizationRequestResponseSchema
>;
export type ComputerUseAuthorizationRequestApplyResponse = zInfer<
  typeof computerUseAuthorizationRequestApplyResponseSchema
>;
export type ComputerUseAuthorizationSource = zInfer<
  typeof computerUseAuthorizationSourceSchema
>;
export type ComputerUseReadCommandKind = zInfer<
  typeof computerUseReadCommandKindSchema
>;
export type ComputerUseWriteCommandKind = zInfer<
  typeof computerUseWriteCommandKindSchema
>;
export type ComputerUseAuditEventsContract =
  typeof computerUseAuditEventsContract;
export type ComputerUseCommandContract = typeof computerUseCommandContract;
export type ComputerUseAuthorizationRequestsContract =
  typeof computerUseAuthorizationRequestsContract;
export type ComputerUseHostsContract = typeof computerUseHostsContract;
export type ComputerUseWriteCommandContract =
  typeof computerUseWriteCommandContract;

// Native Desktop hosts authenticate with their Clerk session and connection generation.
const sessionHostPathParamsSchema = object({ hostId: string().uuid() });
const sessionHostGenerationSchema = object({
  connectionGeneration: number().int().positive(),
});
const sessionHostResponses = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  409: apiErrorSchema,
  429: apiErrorSchema,
  503: apiErrorSchema,
};
// Desktop treats a completion 409 with CONFLICT as already recorded, so its
// codes are declared for the Desktop contract gate.
const sessionHostCompleteConflictSchema = object({
  error: object({
    message: string(),
    code: zEnum([
      ApiError.CONFLICT.code,
      ApiError.HOST_CONNECTION_INVALID.code,
    ]),
  }),
});
export const computerUseSessionHostsContract = c.router({
  register: {
    method: "POST",
    path: "/api/computer-use/hosts/register",
    headers: authHeadersSchema,
    body: computerUseHostStartBodySchema,
    responses: {
      200: sessionHostGenerationSchema.extend({
        hostId: string().uuid(),
        commandNotifications: computerUseCommandNotificationsSchema,
      }),
      426: desktopUpgradeRequiredSchema,
      ...sessionHostResponses,
    },
    summary: "Register a computer-use host bound to the current Clerk session",
  },
  heartbeat: {
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/heartbeat",
    headers: authHeadersSchema,
    pathParams: sessionHostPathParamsSchema,
    body: computerUseRuntimeBodySchema.extend(
      sessionHostGenerationSchema.shape,
    ),
    responses: {
      200: computerUseHeartbeatResponseSchema.extend({
        hasPendingCommands: boolean(),
      }),
      ...sessionHostResponses,
    },
    summary: "Refresh the current session's computer-use host",
  },
  stop: {
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/stop",
    headers: authHeadersSchema,
    pathParams: sessionHostPathParamsSchema,
    body: sessionHostGenerationSchema,
    responses: {
      200: computerUseHostStopResponseSchema,
      ...sessionHostResponses,
    },
    summary: "Stop the current session's computer-use host connection",
  },
  next: {
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/commands/next",
    headers: authHeadersSchema,
    pathParams: sessionHostPathParamsSchema,
    body: computerUseHostCommandNextBodySchema.extend(
      sessionHostGenerationSchema.shape,
    ),
    responses: {
      200: computerUseHostCommandNextResponseSchema,
      426: desktopUpgradeRequiredSchema,
      ...sessionHostResponses,
    },
    summary: "Claim a command using the current Clerk session",
  },
  complete: {
    method: "POST",
    path: "/api/computer-use/hosts/:hostId/commands/:commandId/complete",
    headers: authHeadersSchema,
    pathParams: sessionHostPathParamsSchema.extend(
      commandIdPathParamsSchema.shape,
    ),
    body: intersection(
      computerUseHostCommandCompleteBodySchema,
      sessionHostGenerationSchema,
    ),
    responses: {
      200: computerUseCommandCompleteResponseSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      ...sessionHostResponses,
      409: sessionHostCompleteConflictSchema,
    },
    summary: "Report a claimed command using the current Clerk session",
  },
});
