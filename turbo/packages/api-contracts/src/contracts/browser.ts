import {
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export { BROWSER_IDLE_LEASE_MINUTES } from "../validators/browser";

const c = initContract();

// Okou always asks Browser Use for its longest provider lifetime and manages
// reclamation itself through the idle lease below, so a hard provider timeout
// can never cut a browser short while somebody is still using it.
export const BROWSER_PROVIDER_TIMEOUT_MINUTES = 240;
export const BROWSER_SCREEN_WIDTH = 1440;
export const BROWSER_INITIAL_SCREEN_HEIGHT = 900;
export const BROWSER_MIN_SCREEN_HEIGHT = 320;
export const BROWSER_MAX_SCREEN_HEIGHT = 3456;
// Transient viewer measurements; the API and viewer apply the same raster budget.
const browserInitialDisplaySchema = object({
  width: number().positive().max(65_536),
  height: number().positive().max(65_536),
  dpr: number().positive().max(32),
});
export const browserStatusSchema = zEnum([
  "creating",
  "active",
  "resuming",
  "stopping",
  "suspended",
  "error",
]);

export const browserSuspensionReasonSchema = zEnum([
  // Historical reason kept for rows written before the idle lease existed.
  "run_end",
  "idle",
  "timeout",
  "provider",
  "reconcile",
  "user",
]);

const browserScreenSchema = object({
  width: literal(BROWSER_SCREEN_WIDTH),
  height: number()
    .int()
    .min(BROWSER_MIN_SCREEN_HEIGHT)
    .max(BROWSER_MAX_SCREEN_HEIGHT),
  resizable: boolean(),
});

export const browserWindowContextSchema = object({
  instanceId: uuid(),
  primaryWindowId: number().int().nonnegative().safe(),
}).strict();

export type BrowserWindowContext = zInfer<typeof browserWindowContextSchema>;

export const browserSessionSchema = object({
  threadId: uuid(),
  name: string().min(1).max(64),
  status: browserStatusSchema,
  viewerUrl: url(),
  liveUrl: url().nullable(),
  screenshotUrl: url().nullable(),
  proxyCountryCode: string().length(2).nullable(),
  timeoutMinutes: number().int().positive(),
  // Only live provider instances have persisted window dimensions.
  screen: browserScreenSchema.optional(),
  // Published by the shared-owner writer after its CLI readers are deployed.
  // Per-thread Browsers have no shared native-window context.
  window: browserWindowContextSchema.optional(),
  // When Okou reclaims the live provider instance unless somebody leases it
  // again. Null once no provider instance is running.
  idleExpiresAt: iso.datetime().nullable(),
  suspendedAt: iso.datetime().nullable(),
  suspensionReason: browserSuspensionReasonSchema.nullable(),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
}).strict();

export type BrowserStatus = zInfer<typeof browserStatusSchema>;
export type BrowserSuspensionReason = zInfer<
  typeof browserSuspensionReasonSchema
>;
export type BrowserSession = zInfer<typeof browserSessionSchema>;

export const browserCreateRequestSchema = object({
  name: string().trim().min(1).max(64).default("browser"),
  proxyCountryCode: string()
    .trim()
    .length(2)
    .transform((value) => {
      return value.toLowerCase();
    })
    .nullable()
    .default(null),
}).strict();

export type BrowserCreateRequest = zInfer<typeof browserCreateRequestSchema>;

const browserThreadParamsSchema = object({
  threadId: uuid(),
});

const browserResponseSchema = object({
  browser: browserSessionSchema,
});

const browserResizeRequestSchema = object({
  aspectRatio: number().positive().finite(),
});

const browserAuthorizationRequestTokenPathParamsSchema = object({
  requestToken: string().min(1),
});

const browserAuthorizationRequestCreateResponseSchema = object({
  authorizationUrl: url(),
  expiresAt: iso.datetime(),
});

const browserAuthorizationRequestResponseSchema = object({
  id: uuid(),
  chatThreadId: uuid(),
  expiresAt: iso.datetime(),
  completedAt: iso.datetime().nullable(),
  cloudBrowserEnabled: boolean(),
});

const browserAuthorizationRequestApplyResponseSchema = object({
  ok: literal(true),
  cloudBrowserEnabled: literal(true),
});

export const browserExtensionSchema = object({
  id: uuid(),
  runtimeId: string().regex(/^[a-p]{32}$/u),
  version: string().min(1),
});

export type BrowserExtension = zInfer<typeof browserExtensionSchema>;

const browserViewerConnectionSchema = object({
  cdpUrl: url({ protocol: /^wss$/u }),
  extension: browserExtensionSchema,
});

export type BrowserViewerConnection = zInfer<
  typeof browserViewerConnectionSchema
>;

const browserConnectionResponseSchema = browserResponseSchema.extend({
  cdpUrl: url(),
});

const commonErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const browserContract = c.router({
  create: {
    method: "POST",
    path: "/api/browsers",
    headers: authHeadersSchema,
    body: browserCreateRequestSchema,
    responses: {
      201: browserConnectionResponseSchema,
      ...commonErrorResponses,
    },
    summary:
      "Create a new managed browser for the current chat thread using its isolated profile",
  },
  use: {
    method: "POST",
    path: "/api/browsers/use",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: browserConnectionResponseSchema,
      ...commonErrorResponses,
    },
    summary:
      "Create, reuse, or resume the current chat thread's managed browser and extend its idle lease",
  },
  lease: {
    method: "POST",
    path: "/api/browsers/lease",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Extend the idle lease of the current chat thread's live browser",
  },
  leaseByThread: {
    method: "POST",
    path: "/api/chat-threads/:threadId/browser/lease",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    body: object({}),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Extend the idle lease of a live browser from its viewer",
  },
  open: {
    method: "POST",
    path: "/api/chat-threads/:threadId/browser/open",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    body: object({ initialDisplay: browserInitialDisplaySchema.optional() }),
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Open a chat thread's managed browser",
  },
  close: {
    method: "POST",
    path: "/api/chat-threads/:threadId/browser/close",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    body: object({}),
    responses: {
      200: object({}),
      ...commonErrorResponses,
    },
    summary: "Record that the managed browser sidebar was closed",
  },
  resizeByThread: {
    method: "POST",
    path: "/api/chat-threads/:threadId/browser/resize",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    body: browserResizeRequestSchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Resize a live browser to match a viewer aspect ratio",
  },
  current: {
    method: "GET",
    path: "/api/browsers/current",
    headers: authHeadersSchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    },
    summary: "Get the current chat thread's managed browser",
  },
  get: {
    method: "GET",
    path: "/api/chat-threads/:threadId/browser",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    responses: {
      200: browserResponseSchema,
      ...commonErrorResponses,
    } as const,
    summary: "Get a chat thread's managed browser",
  },
  viewerConnection: {
    method: "GET",
    path: "/api/chat-threads/:threadId/browser/viewer-connection",
    headers: authHeadersSchema,
    pathParams: browserThreadParamsSchema,
    responses: {
      200: browserViewerConnectionSchema,
      ...commonErrorResponses,
    },
    summary: "Get a live browser's WebSocket endpoint for its signed-in owner",
  },
});

export const browserAuthorizationRequestsContract = c.router({
  create: {
    method: "POST",
    path: "/api/browser/authorization-requests",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: browserAuthorizationRequestCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Create a short-lived cloud browser authorization request for the current run",
  },
  get: {
    method: "GET",
    path: "/api/browser/authorization-requests/:requestToken",
    headers: authHeadersSchema,
    pathParams: browserAuthorizationRequestTokenPathParamsSchema,
    responses: {
      200: browserAuthorizationRequestResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Read a cloud browser authorization request",
  },
  apply: {
    method: "POST",
    path: "/api/browser/authorization-requests/:requestToken/apply",
    headers: authHeadersSchema,
    pathParams: browserAuthorizationRequestTokenPathParamsSchema,
    body: object({}),
    responses: {
      200: browserAuthorizationRequestApplyResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "Enable the cloud browser for a delegated authorization request",
  },
});

export type BrowserContract = typeof browserContract;
export type BrowserAuthorizationRequestsContract =
  typeof browserAuthorizationRequestsContract;
export type BrowserAuthorizationRequestCreateResponse = zInfer<
  typeof browserAuthorizationRequestCreateResponseSchema
>;
export type BrowserAuthorizationRequestResponse = zInfer<
  typeof browserAuthorizationRequestResponseSchema
>;
export type BrowserAuthorizationRequestApplyResponse = zInfer<
  typeof browserAuthorizationRequestApplyResponseSchema
>;
