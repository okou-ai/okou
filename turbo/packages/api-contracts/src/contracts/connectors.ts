import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { connectorAccountMutationIntentSchema } from "./connector-accounts";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import {
  builtinConnectorOauthDeviceAuthSessionPollRequestSchema,
  builtinConnectorOauthDeviceAuthSessionPollResponseSchema,
  builtinConnectorOauthDeviceAuthSessionStartResponseSchema,
  builtinConnectorExternalCodeSessionCompleteRequestSchema,
  builtinConnectorExternalCodeSessionCompleteResponseSchema,
  builtinConnectorExternalCodeSessionStartResponseSchema,
  builtinConnectorOauthStartResponseSchema,
  builtinConnectorListResponseSchema,
  builtinConnectorResponseSchema,
  scopeDiffResponseSchema,
} from "./connector-schemas";

const c = initContract();

/**
 * Contract for GET /api/connectors
 */
export const builtinConnectorsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors",
    headers: authHeadersSchema,
    responses: {
      200: builtinConnectorListResponseSchema,
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
export const builtinConnectorsBySlugContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/:connectorSlug",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    responses: {
      200: builtinConnectorResponseSchema,
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
export const builtinConnectorScopeDiffContract = c.router({
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

export const builtinConnectorOauthStartContract = c.router({
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
      200: builtinConnectorOauthStartResponseSchema,
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

export const builtinConnectorAutomaticContract = c.router({
  start: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/automatic/start",
    headers: authHeadersSchema,
    pathParams: z.object({ connectorSlug: connectorSlugSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: z.discriminatedUnion("result", [
        z.object({
          result: z.literal("connected"),
          connectedAccountId: z.uuid(),
        }),
        z.object({
          result: z.literal("authorization"),
          authorizationUrl: z.url(),
          oauthAttemptId: z.uuid(),
        }),
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Discover and connect builtin MCP authentication",
  },
  callback: {
    method: "GET",
    path: "/api/connectors/automatic/callback",
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
      iss: z.string().optional(),
      responseMode: z.literal("json").optional(),
    }),
    responses: {
      200: connectorOauthCallbackResultSchema,
      307: c.noBody(),
    },
    summary: "Complete builtin MCP automatic authorization",
  },
});

export const builtinConnectorOpenIdStartContract = c.router({
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
      200: builtinConnectorOauthStartResponseSchema,
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

export const builtinConnectorManualGrantContract = c.router({
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
      200: builtinConnectorResponseSchema,
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

export const builtinConnectorNoAuthGrantContract = c.router({
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
      200: builtinConnectorResponseSchema,
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

export const builtinConnectorOauthDeviceAuthSessionContract = c.router({
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
      200: builtinConnectorOauthDeviceAuthSessionStartResponseSchema,
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
    body: builtinConnectorOauthDeviceAuthSessionPollRequestSchema,
    responses: {
      200: builtinConnectorOauthDeviceAuthSessionPollResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll connector OAuth device authorization session",
  },
});

export const builtinConnectorExternalCodeSessionContract = c.router({
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
      200: builtinConnectorExternalCodeSessionStartResponseSchema,
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
    body: builtinConnectorExternalCodeSessionCompleteRequestSchema,
    responses: {
      200: builtinConnectorExternalCodeSessionCompleteResponseSchema,
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

const builtinConnectorSearchItemSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
  description: z.string(),
  authMethods: z.array(connectorAuthMethodIdSchema),
});

const builtinConnectorSearchResponseSchema = z.object({
  connectors: z.array(builtinConnectorSearchItemSchema),
});

export type BuiltinConnectorSearchItem = z.infer<
  typeof builtinConnectorSearchItemSchema
>;
export type BuiltinConnectorSearchResponse = z.infer<
  typeof builtinConnectorSearchResponseSchema
>;

/**
 * Contract for GET /api/connectors/search
 * Returns up to 100 featured connectors or slug/label search results.
 */
export const builtinConnectorsSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/connectors/search",
    headers: authHeadersSchema,
    query: z.object({ keyword: z.string().optional() }),
    responses: {
      200: builtinConnectorSearchResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Search available connectors by slug or label",
  },
});

export type BuiltinConnectorsMainContract =
  typeof builtinConnectorsMainContract;
export type BuiltinConnectorsBySlugContract =
  typeof builtinConnectorsBySlugContract;
export type BuiltinConnectorScopeDiffContract =
  typeof builtinConnectorScopeDiffContract;
export type BuiltinConnectorManualGrantContract =
  typeof builtinConnectorManualGrantContract;
export type BuiltinConnectorNoAuthGrantContract =
  typeof builtinConnectorNoAuthGrantContract;
export type BuiltinConnectorOauthDeviceAuthSessionContract =
  typeof builtinConnectorOauthDeviceAuthSessionContract;
export type BuiltinConnectorExternalCodeSessionContract =
  typeof builtinConnectorExternalCodeSessionContract;
export type BuiltinConnectorsSearchContract =
  typeof builtinConnectorsSearchContract;
