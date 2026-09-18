import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { connectorAccountMutationIntentSchema } from "./connector-accounts";
import {
  connectorOauthDeviceAuthSessionPollRequestSchema,
  connectorOauthDeviceAuthSessionPollResponseSchema,
  connectorOauthDeviceAuthSessionStartResponseSchema,
  connectorExternalCodeSessionCompleteRequestSchema,
  connectorExternalCodeSessionCompleteResponseSchema,
  connectorExternalCodeSessionStartResponseSchema,
  connectorOauthStartResponseSchema,
  connectorListResponseSchema,
  connectorResponseSchema,
  scopeDiffResponseSchema,
} from "./connector-schemas";

const c = initContract();

/**
 * Contract for GET /api/connectors
 */
export const connectorsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors",
    headers: authHeadersSchema,
    responses: {
      200: connectorListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List the current user's connector connections",
  },
});

/**
 * Contract for GET /api/connectors/:connectorSlug
 */
export const connectorsBySlugContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/:connectorSlug",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector by slug",
  },
});

/**
 * Contract for GET /api/connectors/:connectorSlug/scope-diff
 * App-layer endpoint (direct service call, no proxy)
 */
export const connectorScopeDiffContract = c.router({
  getScopeDiff: {
    method: "GET",
    path: "/api/connectors/:connectorSlug/scope-diff",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    responses: {
      200: scopeDiffResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get scope diff for a connector",
  },
});

export const connectorOauthStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/oauth/start",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      callbackTarget: z.literal("app").optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: connectorOauthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OAuth authorization URL",
  },
});

export const connectorOpenIdStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/openid/start",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: connectorOauthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OpenID handoff and authorization URL",
  },
});

export const connectorManualGrantContract = c.router({
  connect: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/manual-grant",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
      values: z.record(z.string(), z.string()),
    }),
    responses: {
      200: connectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Connect a connector with a manual grant",
  },
});

export const connectorNoAuthGrantContract = c.router({
  connect: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/no-auth",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: connectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Enable a connector with a no-auth grant",
  },
});

export const connectorOauthDeviceAuthSessionContract = c.router({
  create: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/oauth/device/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
      options: z.record(z.string(), z.string()).optional(),
    }),
    responses: {
      200: connectorOauthDeviceAuthSessionStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OAuth device authorization session",
  },
  poll: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll",
    headers: authHeadersSchema,
    pathParams: z.object({
      connectorSlug: connectorSlugSchema,
      sessionId: z.uuid(),
    }),
    body: connectorOauthDeviceAuthSessionPollRequestSchema,
    responses: {
      200: connectorOauthDeviceAuthSessionPollResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll connector OAuth device authorization session",
  },
});

export const connectorExternalCodeSessionContract = c.router({
  create: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/external-code/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: connectorExternalCodeSessionStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector external-code authorization session",
  },
  complete: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete",
    headers: authHeadersSchema,
    pathParams: z.object({
      connectorSlug: connectorSlugSchema,
      sessionId: z.uuid(),
    }),
    body: connectorExternalCodeSessionCompleteRequestSchema,
    responses: {
      200: connectorExternalCodeSessionCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete connector external-code authorization session",
  },
});

const connectorSearchItemSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
  description: z.string(),
  authMethods: z.array(connectorAuthMethodIdSchema),
});

const connectorSearchResponseSchema = z.object({
  connectors: z.array(connectorSearchItemSchema),
});

export type ConnectorSearchItem = z.infer<typeof connectorSearchItemSchema>;
export type ConnectorSearchResponse = z.infer<
  typeof connectorSearchResponseSchema
>;

/**
 * Contract for GET /api/connectors/search
 * Returns up to 100 featured connectors or slug/label search results.
 */
export const connectorsSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/connectors/search",
    headers: authHeadersSchema,
    query: z.object({ keyword: z.string().optional() }),
    responses: {
      200: connectorSearchResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Search available connectors by slug or label",
  },
});

export type ConnectorsMainContract = typeof connectorsMainContract;
export type ConnectorsBySlugContract = typeof connectorsBySlugContract;
export type ConnectorScopeDiffContract = typeof connectorScopeDiffContract;
export type ConnectorManualGrantContract = typeof connectorManualGrantContract;
export type ConnectorNoAuthGrantContract = typeof connectorNoAuthGrantContract;
export type ConnectorOauthDeviceAuthSessionContract =
  typeof connectorOauthDeviceAuthSessionContract;
export type ConnectorExternalCodeSessionContract =
  typeof connectorExternalCodeSessionContract;
export type ConnectorsSearchContract = typeof connectorsSearchContract;
