import {
  array,
  literal,
  object,
  record,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import { builtinConnectorAutomaticResponseSchema } from "../validators/connectors";
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
  connectorCompletedOperationResponseSchema,
  builtinConnectorListResponseSchema,
} from "./connector-schemas";

export { builtinConnectorAutomaticResponseSchema } from "../validators/connectors";

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

export const builtinConnectorOauthStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/connectors/:connectorSlug/oauth/start",
    headers: authHeadersSchema,
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
      callbackTarget: literal("app").optional(),
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: builtinConnectorAutomaticResponseSchema,
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
    query: object({
      state: string().optional(),
      code: string().optional(),
      error: string().optional(),
      error_description: string().optional(),
      iss: string().optional(),
      responseMode: literal("json").optional(),
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
      values: record(string(), string()),
    }),
    responses: {
      200: connectorCompletedOperationResponseSchema,
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
    }),
    responses: {
      200: connectorCompletedOperationResponseSchema,
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
      account: connectorAccountMutationIntentSchema,
      options: record(string(), string()).optional(),
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
    pathParams: object({
      connectorSlug: connectorSlugSchema,
      sessionId: uuid(),
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
    pathParams: object({ connectorSlug: connectorSlugSchema }),
    body: object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: uuid().optional(),
      authorizeAgent: literal(true).optional(),
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
    pathParams: object({
      connectorSlug: connectorSlugSchema,
      sessionId: uuid(),
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

const builtinConnectorSearchItemSchema = object({
  slug: connectorSlugSchema,
  label: string(),
  description: string(),
  authMethods: array(connectorAuthMethodIdSchema),
});

const builtinConnectorSearchResponseSchema = object({
  connectors: array(builtinConnectorSearchItemSchema),
});

export type BuiltinConnectorSearchItem = zInfer<
  typeof builtinConnectorSearchItemSchema
>;
export type BuiltinConnectorSearchResponse = zInfer<
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
    query: object({ keyword: string().optional() }),
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
