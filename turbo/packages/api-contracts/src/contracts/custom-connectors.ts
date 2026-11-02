import {
  array,
  literal,
  number,
  object,
  record,
  string,
  union,
  uuid,
  enum as zEnum,
  never as zNever,
  null as zNull,
  type RefinementCtx,
  type infer as zInfer,
} from "zod";

import {
  customConnectorFieldKindSchema,
  customConnectorFieldSchema,
  customConnectorHeaderInjectionSchema,
  customConnectorListResponseSchema,
  customConnectorMcpTransportSchema,
  customConnectorOAuthConfigSchema,
  customConnectorPermissionBundleRefSchema,
  customConnectorQueryInjectionSchema,
  customConnectorResponseSchema,
  customConnectorSkillMarkdownSchema,
  setCustomConnectorValuesResponseSchema,
  startCustomConnectorOAuth2ResponseSchema,
  type CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  type customConnectorHttpResponseSchema,
  type customConnectorMcpResponseSchema,
  type customConnectorSlugSchema,
  type CustomConnectorResponse,
} from "../validators/custom-connectors";
import { initContract, authHeadersSchema } from "./base";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import { connectorAccountMutationIntentSchema } from "./connector-accounts";
import { apiErrorSchema } from "./errors";

export {
  CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS,
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  customConnectorSlugSchema,
  customConnectorFieldKindSchema,
  customConnectorFieldSchema,
  customConnectorHeaderInjectionSchema,
  customConnectorQueryInjectionSchema,
  customConnectorOAuthProviderAdapterSchema,
  INTEGRATION_MANAGED_CUSTOM_CONNECTOR_PROVIDER_ADAPTERS,
  isIntegrationManagedCustomConnectorProviderAdapter,
  customConnectorOAuthTokenEndpointAuthMethodSchema,
  customConnectorOAuthPkceMethodSchema,
  customConnectorOAuthConfigSchema,
  customConnectorPermissionBundleRefSchema,
  customConnectorSkillMarkdownSchema,
  customConnectorMcpTransportSchema,
  customConnectorManagedStatusSchema,
  customConnectorHttpAuthResponseSchema,
  customConnectorHttpResponseCoreSchema,
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseCoreSchema,
  customConnectorMcpAuthResponseSchema,
  customConnectorMcpResponseSchema,
  customConnectorResponseSchema,
  isIntegrationManagedCustomConnector,
  customConnectorListResponseSchema,
  startCustomConnectorOAuth2ResponseSchema,
  setCustomConnectorValuesResponseSchema,
  type CustomConnectorOAuthProviderAdapter,
  type CustomConnectorOAuthConfig,
  type CustomConnectorResponse,
  type IntegrationManagedCustomConnectorResponse,
} from "../validators/custom-connectors";

const c = initContract();

export type CustomConnectorAutomaticOAuthErrorCode =
  (typeof CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES)[keyof typeof CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES];

export type CustomConnectorSlug = zInfer<typeof customConnectorSlugSchema>;

export type CustomConnectorFieldKind = zInfer<
  typeof customConnectorFieldKindSchema
>;

export type CustomConnectorField = zInfer<typeof customConnectorFieldSchema>;

export type CustomConnectorHeaderInjection = zInfer<
  typeof customConnectorHeaderInjectionSchema
>;

export type CustomConnectorQueryInjection = zInfer<
  typeof customConnectorQueryInjectionSchema
>;

export const customConnectorAuthModeSchema = zEnum([
  "none",
  "manual",
  "oauth",
  "automatic",
]);
export type CustomConnectorAuthMode = zInfer<
  typeof customConnectorAuthModeSchema
>;

export const customConnectorOAuthConfigInputSchema =
  customConnectorOAuthConfigSchema.extend({
    clientSecret: string().min(1).max(4096).optional(),
  });
export type CustomConnectorOAuthConfigInput = zInfer<
  typeof customConnectorOAuthConfigInputSchema
>;

export type CustomConnectorPermissionBundleRef = zInfer<
  typeof customConnectorPermissionBundleRefSchema
>;

const customConnectorPermissionSchema = object({
  name: string().min(1).max(128),
  description: string().optional(),
});

export const customConnectorPermissionBundleSchema = object({
  ref: customConnectorPermissionBundleRefSchema,
  permissions: array(customConnectorPermissionSchema),
  defaultPolicies: record(string(), zEnum(["allow", "deny", "ask"])),
});
export type CustomConnectorPermissionBundleResponse = zInfer<
  typeof customConnectorPermissionBundleSchema
>;

export type CustomConnectorMcpTransport = zInfer<
  typeof customConnectorMcpTransportSchema
>;

export type CustomConnectorHttpResponse = zInfer<
  typeof customConnectorHttpResponseSchema
>;

export type CustomConnectorMcpResponse = zInfer<
  typeof customConnectorMcpResponseSchema
>;

export function isHttpCustomConnectorResponse(
  connector: CustomConnectorResponse,
): connector is CustomConnectorHttpResponse {
  return connector.kind === "http";
}

const customConnectorDefinitionWriteBaseSchema = object({
  displayName: string().min(1).max(128),
  fields: array(customConnectorFieldSchema),
  headerInjections: array(customConnectorHeaderInjectionSchema),
  queryInjections: array(customConnectorQueryInjectionSchema),
  authMode: customConnectorAuthModeSchema.optional(),
  oauthConfig: customConnectorOAuthConfigInputSchema.optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: number().int().positive().optional(),
});

interface CustomConnectorAuthWrite {
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode?: CustomConnectorAuthMode;
  readonly oauthConfig?: CustomConnectorOAuthConfigInput;
}

function validateAutomaticAuthWrite(
  value: CustomConnectorAuthWrite,
  context: RefinementCtx,
  connectorKind: "http" | "mcp",
): void {
  if (connectorKind !== "mcp") {
    context.addIssue({
      code: "custom",
      message: "Automatic authentication requires an MCP connector",
      path: ["authMode"],
    });
  }
  if (value.oauthConfig !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Automatic authentication cannot include OAuth configuration",
      path: ["authMode"],
    });
  }
  if (
    value.fields.length > 0 ||
    value.headerInjections.length > 0 ||
    value.queryInjections.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Automatic authentication cannot include credential fields or injections",
      path: ["authMode"],
    });
  }
}

function validateNoAuthWrite(
  value: CustomConnectorAuthWrite,
  context: RefinementCtx,
  connectorKind: "http" | "mcp",
): void {
  if (value.oauthConfig !== undefined) {
    context.addIssue({
      code: "custom",
      message: "No authentication cannot include OAuth configuration",
      path: ["authMode"],
    });
  }
  if (value.headerInjections.length > 0 || value.queryInjections.length > 0) {
    context.addIssue({
      code: "custom",
      message: "No authentication cannot include authentication injections",
      path: ["authMode"],
    });
  }
  if (
    value.fields.some((field) => {
      return field.kind === "secret";
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "No authentication cannot include secret fields",
      path: ["fields"],
    });
  }
  if (connectorKind === "mcp" && value.fields.length > 0) {
    context.addIssue({
      code: "custom",
      message: "No-auth MCP connectors cannot include fields",
      path: ["fields"],
    });
  }
}

function validateCustomConnectorAuthWrite(
  value: CustomConnectorAuthWrite,
  context: RefinementCtx,
  connectorKind: "http" | "mcp",
): void {
  const authMode = value.authMode ?? "manual";
  if (authMode === "automatic") {
    validateAutomaticAuthWrite(value, context, connectorKind);
    return;
  }
  if (authMode === "none") {
    validateNoAuthWrite(value, context, connectorKind);
    return;
  }
  if (
    value.headerInjections.length === 0 &&
    value.queryInjections.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Authentication requires at least one header or query injection",
      path: ["authMode"],
    });
  }
  if (authMode === "manual") {
    if (value.oauthConfig !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Manual authentication cannot include OAuth configuration",
        path: ["authMode"],
      });
    }
    return;
  }
  if (value.oauthConfig === undefined) {
    context.addIssue({
      code: "custom",
      message: "Custom OAuth requires static OAuth configuration",
      path: ["oauthConfig"],
    });
  }
}

const customConnectorHttpDefinitionWriteCoreSchema =
  customConnectorDefinitionWriteBaseSchema.extend({
    kind: literal("http").optional(),
    prefixTemplates: array(string().min(1)).min(1),
    permissionBundleRef: customConnectorPermissionBundleRefSchema
      .nullable()
      .optional(),
    endpoint: zNever().optional(),
    transport: zNever().optional(),
  });

const customConnectorHttpDefinitionWriteSchema =
  customConnectorHttpDefinitionWriteCoreSchema.superRefine((value, context) => {
    validateCustomConnectorAuthWrite(value, context, "http");
  });

export const customConnectorHttpCreateBodySchema =
  customConnectorHttpDefinitionWriteCoreSchema
    .extend({
      slug: string().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "http");
    });

export const customConnectorMcpCreateBodySchema =
  customConnectorDefinitionWriteBaseSchema
    .extend({
      kind: literal("mcp"),
      endpoint: string().min(1).max(2048),
      transport: customConnectorMcpTransportSchema,
      permissionBundleRef: zNull().optional(),
      slug: string().optional(),
      prefixTemplates: zNever().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "mcp");
    });

export const createCustomConnectorBodySchema = union([
  customConnectorMcpCreateBodySchema,
  customConnectorHttpCreateBodySchema,
]);
export type CreateCustomConnectorBody = zInfer<
  typeof createCustomConnectorBodySchema
>;

export const customConnectorHttpUpdateBodySchema =
  customConnectorHttpDefinitionWriteSchema;

export const customConnectorMcpUpdateBodySchema =
  customConnectorDefinitionWriteBaseSchema
    .extend({
      kind: literal("mcp"),
      endpoint: string().min(1).max(2048),
      transport: customConnectorMcpTransportSchema,
      permissionBundleRef: zNull().optional(),
      prefixTemplates: zNever().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "mcp");
    });

export const updateCustomConnectorBodySchema = union([
  customConnectorMcpUpdateBodySchema,
  customConnectorHttpUpdateBodySchema,
]);
/*
 * `kind` is intentionally optional only on the HTTP branches. Installed
 * writers predate the protocol discriminator, while every MCP writer must be
 * explicit so an HTTP-only backend cannot silently create a different shape.
 */
export type UpdateCustomConnectorBody = zInfer<
  typeof updateCustomConnectorBodySchema
>;

export const startCustomConnectorOAuth2BodySchema = object({
  agentId: uuid().optional(),
  account: connectorAccountMutationIntentSchema,
}).strict();

export const customConnectorValueInputSchema = object({
  key: string().min(1).max(64),
  kind: customConnectorFieldKindSchema,
  value: string().min(1),
});
export type CustomConnectorValueInput = zInfer<
  typeof customConnectorValueInputSchema
>;

export const setCustomConnectorValuesBodySchema = object({
  values: array(customConnectorValueInputSchema),
  account: connectorAccountMutationIntentSchema,
});
export type SetCustomConnectorValuesBody = zInfer<
  typeof setCustomConnectorValuesBodySchema
>;

export const customConnectorProposalSchema = object({
  operation: zEnum(["create", "update"]),
  connectorId: uuid().optional(),
  displayName: string().min(1).max(128),
  prefixTemplates: array(string().min(1)).min(1),
  fields: array(customConnectorFieldSchema),
  headerInjections: array(customConnectorHeaderInjectionSchema),
  queryInjections: array(customConnectorQueryInjectionSchema),
  notes: string().max(2048).optional(),
});
export type CustomConnectorProposal = zInfer<
  typeof customConnectorProposalSchema
>;

export const saveCustomConnectorProposalBodySchema = object({
  proposal: customConnectorProposalSchema,
  values: array(customConnectorValueInputSchema),
  agentId: uuid().optional(),
});
export type SaveCustomConnectorProposalBody = zInfer<
  typeof saveCustomConnectorProposalBodySchema
>;

export const saveCustomConnectorProposalResponseSchema = object({
  connector: customConnectorResponseSchema,
  connectionId: uuid().optional(),
  authorizedAgentId: uuid().optional(),
});
export type SaveCustomConnectorProposalResponse = zInfer<
  typeof saveCustomConnectorProposalResponseSchema
>;

/**
 * Custom connectors contract for /api/custom-connectors
 * GET: list all org custom connectors with per-user connection state
 * POST: create a new custom connector (admin only)
 */
export const customConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/custom-connectors",
    headers: authHeadersSchema,
    responses: {
      200: customConnectorListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org custom connectors",
  },
  create: {
    method: "POST",
    path: "/api/custom-connectors",
    headers: authHeadersSchema,
    body: createCustomConnectorBodySchema,
    responses: {
      201: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an org custom connector",
  },
});
export type CustomConnectorsContract = typeof customConnectorsContract;

/**
 * Custom connector by id contract for /api/custom-connectors/[id]
 * DELETE: delete a custom connector (admin only — cascades secrets)
 * PUT: update a custom connector definition (admin only)
 */
export const customConnectorByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      200: customConnectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an org custom connector",
  },
  delete: {
    method: "DELETE",
    path: "/api/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org custom connector",
  },
  update: {
    method: "PUT",
    path: "/api/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: updateCustomConnectorBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update an org custom connector",
  },
  permissions: {
    method: "GET",
    path: "/api/custom-connectors/:id/permissions",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      200: customConnectorPermissionBundleSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an org custom connector permission bundle",
  },
});
export type CustomConnectorByIdContract = typeof customConnectorByIdContract;

export const customConnectorValuesContract = c.router({
  set: {
    method: "PUT",
    path: "/api/custom-connectors/:id/values",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: setCustomConnectorValuesBodySchema,
    responses: {
      200: setCustomConnectorValuesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the calling user's values for a custom connector",
  },
});
export type CustomConnectorValuesContract =
  typeof customConnectorValuesContract;

export const customConnectorOAuth2Contract = c.router({
  start: {
    method: "POST",
    path: "/api/custom-connectors/:id/oauth2/start",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: startCustomConnectorOAuth2BodySchema,
    responses: {
      200: startCustomConnectorOAuth2ResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Start OAuth 2.0 for a custom connector",
  },
  callback: {
    method: "GET",
    path: "/api/custom-connectors/oauth2/callback",
    query: object({
      code: string().optional(),
      state: string().optional(),
      error: string().optional(),
      error_description: string().optional(),
      iss: string().optional(),
      responseMode: literal("json").optional(),
    }).catchall(string()),
    responses: {
      200: connectorOauthCallbackResultSchema,
      307: c.noBody(),
    },
    summary: "Complete OAuth 2.0 for a custom connector",
  },
});
export type CustomConnectorOAuth2Contract =
  typeof customConnectorOAuth2Contract;

export const customConnectorProposalContract = c.router({
  save: {
    method: "POST",
    path: "/api/custom-connectors/proposals/save",
    headers: authHeadersSchema,
    body: saveCustomConnectorProposalBodySchema,
    responses: {
      200: saveCustomConnectorProposalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Save a custom connector proposal",
  },
});
export type CustomConnectorProposalContract =
  typeof customConnectorProposalContract;
