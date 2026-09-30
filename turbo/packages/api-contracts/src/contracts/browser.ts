import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Okou always asks Browser Use for its longest provider lifetime and manages
// reclamation itself through the idle lease below, so a hard provider timeout
// can never cut a browser short while somebody is still using it.
export const BROWSER_PROVIDER_TIMEOUT_MINUTES = 240;
export const BROWSER_IDLE_LEASE_MINUTES = 10;
export const BROWSER_SCREEN_WIDTH = 1440;
export const BROWSER_INITIAL_SCREEN_HEIGHT = 900;
export const BROWSER_MIN_SCREEN_HEIGHT = 320;
export const BROWSER_MAX_SCREEN_HEIGHT = 3456;

export const browserStatusSchema = z.enum([
  "creating",
  "active",
  "resuming",
  "stopping",
  "suspended",
  "error",
]);

export const browserSuspensionReasonSchema = z.enum([
  // Historical reason kept for rows written before the idle lease existed.
  "run_end",
  "idle",
  "timeout",
  "provider",
  "reconcile",
  "user",
]);

const browserScreenSchema = z.object({
  width: z.literal(BROWSER_SCREEN_WIDTH),
  height: z
    .number()
    .int()
    .min(BROWSER_MIN_SCREEN_HEIGHT)
    .max(BROWSER_MAX_SCREEN_HEIGHT),
  resizable: z.boolean(),
});

export const browserSessionSchema = z
  .object({
    threadId: z.uuid(),
    name: z.string().min(1).max(64),
    status: browserStatusSchema,
    viewerUrl: z.url(),
    liveUrl: z.url().nullable(),
    screenshotUrl: z.url().nullable(),
    proxyCountryCode: z.string().length(2).nullable(),
    timeoutMinutes: z.number().int().positive(),
    // Only live provider instances have persisted window dimensions.
    screen: browserScreenSchema.optional(),
    // When Okou reclaims the live provider instance unless somebody leases it
    // again. Null once no provider instance is running.
    idleExpiresAt: z.iso.datetime().nullable(),
    suspendedAt: z.iso.datetime().nullable(),
    suspensionReason: browserSuspensionReasonSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type BrowserSuspensionReason = z.infer<
  typeof browserSuspensionReasonSchema
>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;

export const browserCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64).default("browser"),
    proxyCountryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => {
        return value.toLowerCase();
      })
      .nullable()
      .default(null),
  })
  .strict();

export type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

const browserThreadParamsSchema = z.object({
  threadId: z.uuid(),
});

const browserResponseSchema = z.object({
  browser: browserSessionSchema,
});

const browserResizeRequestSchema = z.object({
  aspectRatio: z.number().positive().finite(),
});

const browserAuthorizationRequestTokenPathParamsSchema = z.object({
  requestToken: z.string().min(1),
});

const browserAuthorizationRequestCreateResponseSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

const browserAuthorizationRequestResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  cloudBrowserEnabled: z.boolean(),
});

const browserAuthorizationRequestApplyResponseSchema = z.object({
  ok: z.literal(true),
  cloudBrowserEnabled: z.literal(true),
});

const browserConnectionResponseSchema = browserResponseSchema.extend({
  cdpUrl: z.url(),
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
    body: z.object({}),
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
    body: z.object({}),
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
    body: z.object({}),
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
    body: z.object({}),
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
    body: z.object({}),
    responses: {
      200: z.object({}),
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
});

export const browserAuthorizationRequestsContract = c.router({
  create: {
    method: "POST",
    path: "/api/browser/authorization-requests",
    headers: authHeadersSchema,
    body: z.object({}),
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
    body: z.object({}),
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
export type BrowserAuthorizationRequestCreateResponse = z.infer<
  typeof browserAuthorizationRequestCreateResponseSchema
>;
export type BrowserAuthorizationRequestResponse = z.infer<
  typeof browserAuthorizationRequestResponseSchema
>;
export type BrowserAuthorizationRequestApplyResponse = z.infer<
  typeof browserAuthorizationRequestApplyResponseSchema
>;
