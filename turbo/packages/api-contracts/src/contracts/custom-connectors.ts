import {
  array,
  boolean,
  discriminatedUnion,
  intersection,
  literal,
  number,
  object,
  record,
  string,
  tuple,
  union,
  uuid,
  enum as zEnum,
  never as zNever,
  null as zNull,
  type RefinementCtx,
  type infer as zInfer,
} from "zod";

import { initContract, authHeadersSchema } from "./base";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import { connectorCompletedOperationResponseSchema } from "./connector-schemas";
import { connectorAccountMutationIntentSchema } from "./connector-accounts";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS = 2_048;

export const CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES = {
  AUTHENTICATION_RESPONSE_INVALID: "MCP_OAUTH_AUTHENTICATION_RESPONSE_INVALID",
  DISCOVERY_INVALID: "MCP_OAUTH_DISCOVERY_INVALID",
  AUTHORIZATION_UNSUPPORTED: "MCP_OAUTH_AUTHORIZATION_UNSUPPORTED",
  CLIENT_REGISTRATION_UNAVAILABLE: "MCP_OAUTH_CLIENT_REGISTRATION_UNAVAILABLE",
  CLIENT_REGISTRATION_REJECTED: "MCP_OAUTH_CLIENT_REGISTRATION_REJECTED",
  CLIENT_REGISTRATION_INVALID: "MCP_OAUTH_CLIENT_REGISTRATION_INVALID",
  CLIENT_REGISTRATION_CONFLICT: "MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT",
  UNSAFE_URL: "MCP_OAUTH_UNSAFE_URL",
  PROVIDER_UNAVAILABLE: "MCP_OAUTH_PROVIDER_UNAVAILABLE",
  BINDING_CHANGED: "MCP_OAUTH_BINDING_CHANGED",
} as const;

export type CustomConnectorAutomaticOAuthErrorCode =
  (typeof CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES)[keyof typeof CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES];

export const customConnectorSlugSchema = string().regex(
  /^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/u,
);
export type CustomConnectorSlug = zInfer<typeof customConnectorSlugSchema>;

export const customConnectorFieldKindSchema = zEnum(["secret", "variable"]);
export type CustomConnectorFieldKind = zInfer<
  typeof customConnectorFieldKindSchema
>;

export const customConnectorFieldSchema = object({
  key: string().min(1).max(64),
  label: string().min(1).max(128),
  kind: customConnectorFieldKindSchema,
  required: boolean(),
  description: string().max(512).optional(),
});
export type CustomConnectorField = zInfer<typeof customConnectorFieldSchema>;

export const customConnectorHeaderInjectionSchema = object({
  name: string().min(1).max(128),
  valueTemplate: string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});
export type CustomConnectorHeaderInjection = zInfer<
  typeof customConnectorHeaderInjectionSchema
>;

export const customConnectorQueryInjectionSchema = object({
  name: string().min(1).max(128),
  valueTemplate: string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});
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

export const customConnectorOAuthProviderAdapterSchema = zEnum([
  "standard",
  "feishu",
]);
export type CustomConnectorOAuthProviderAdapter = zInfer<
  typeof customConnectorOAuthProviderAdapterSchema
>;

export const INTEGRATION_MANAGED_CUSTOM_CONNECTOR_PROVIDER_ADAPTERS = [
  "feishu",
] as const satisfies readonly CustomConnectorOAuthProviderAdapter[];

export function isIntegrationManagedCustomConnectorProviderAdapter(
  providerAdapter: CustomConnectorOAuthProviderAdapter | null | undefined,
): boolean {
  return INTEGRATION_MANAGED_CUSTOM_CONNECTOR_PROVIDER_ADAPTERS.some(
    (managedProviderAdapter) => {
      return managedProviderAdapter === providerAdapter;
    },
  );
}
export const customConnectorOAuthTokenEndpointAuthMethodSchema = zEnum([
  "client_secret_basic",
  "client_secret_post",
]);
export const customConnectorOAuthPkceMethodSchema = zEnum(["none", "S256"]);

export const customConnectorOAuthConfigSchema = object({
  providerAdapter: customConnectorOAuthProviderAdapterSchema,
  clientId: string().min(1).max(255),
  authorizationUrl: string().url().max(2048),
  tokenUrl: string().url().max(2048),
  tokenEndpointAuthMethod: customConnectorOAuthTokenEndpointAuthMethodSchema,
  pkceMethod: customConnectorOAuthPkceMethodSchema,
  scopes: array(string().min(1).max(256)).max(100),
  authorizationParams: record(string(), string()),
});
export type CustomConnectorOAuthConfig = zInfer<
  typeof customConnectorOAuthConfigSchema
>;

export const customConnectorOAuthConfigInputSchema =
  customConnectorOAuthConfigSchema.extend({
    clientSecret: string().min(1).max(4096).optional(),
  });
export type CustomConnectorOAuthConfigInput = zInfer<
  typeof customConnectorOAuthConfigInputSchema
>;

export const customConnectorPermissionBundleRefSchema = string()
  .max(128)
  .regex(/^builtin:[a-z0-9][a-z0-9-]*@1$/u);
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

export const customConnectorSkillMarkdownSchema = string().refine(
  (value) => {
    return new TextEncoder().encode(value).byteLength <= 65_536;
  },
  { message: "Custom connector skill markdown must not exceed 64 KiB" },
);

export const customConnectorMcpTransportSchema = literal("streamable-http");
export type CustomConnectorMcpTransport = zInfer<
  typeof customConnectorMcpTransportSchema
>;

/**
 * Custom connector response — safe to return to any org member.
 * Never includes any secret material.
 */
const customConnectorResponseBaseSchema = object({
  id: string().uuid(),
  slug: string(),
  displayName: string(),
  fields: array(customConnectorFieldSchema),
  headerInjections: array(customConnectorHeaderInjectionSchema),
  queryInjections: array(customConnectorQueryInjectionSchema),
  permissionBundleRef: customConnectorPermissionBundleRefSchema
    .nullable()
    .optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: number().int().positive(),
  createdAt: string(),
  updatedAt: string(),
});

/** Integration-owned status for managed Feishu/Lark, never ordinary account defaults. */
export const customConnectorManagedStatusSchema = object({
  connected: boolean(),
  connectedAccountId: uuid().optional(),
  connectedAccountUpdatedAt: string().optional(),
  missingRequiredFields: array(string()),
  configuredFieldKeys: array(string()),
});

type CustomConnectorNonOAuthAuthResponse<
  TMode extends "manual" | "none" | "automatic",
> = {
  readonly authMode: TMode;
  readonly oauthConfig?: never;
};

const customConnectorManualAuthResponseSchema = object({
  authMode: literal("manual"),
  oauthConfig: zNever().optional(),
}).transform((value): CustomConnectorNonOAuthAuthResponse<"manual"> => {
  return { authMode: value.authMode };
});

const customConnectorNoAuthResponseSchema = object({
  authMode: literal("none"),
  oauthConfig: zNever().optional(),
}).transform((value): CustomConnectorNonOAuthAuthResponse<"none"> => {
  return { authMode: value.authMode };
});

const customConnectorCustomOAuthResponseSchema = object({
  authMode: literal("oauth"),
  oauthConfig: customConnectorOAuthConfigSchema.extend({
    providerAdapter: literal("standard"),
  }),
}).transform((value) => {
  return {
    authMode: value.authMode,
    oauthConfig: value.oauthConfig,
  };
});

const customConnectorManagedOAuthResponseSchema = object({
  authMode: literal("oauth"),
  oauthConfig: customConnectorOAuthConfigSchema.extend({
    providerAdapter: literal("feishu"),
  }),
  ...customConnectorManagedStatusSchema.shape,
});

const customConnectorAutomaticResponseSchema = object({
  authMode: literal("automatic"),
  oauthConfig: zNever().optional(),
}).transform((value): CustomConnectorNonOAuthAuthResponse<"automatic"> => {
  return { authMode: value.authMode };
});

export const customConnectorHttpAuthResponseSchema = union([
  customConnectorNoAuthResponseSchema,
  customConnectorManualAuthResponseSchema,
  customConnectorCustomOAuthResponseSchema,
  customConnectorManagedOAuthResponseSchema,
]);

export const customConnectorHttpResponseCoreSchema =
  customConnectorResponseBaseSchema.extend({
    kind: literal("http"),
    prefixTemplates: array(string()),
  });
export const customConnectorHttpResponseSchema = intersection(
  customConnectorHttpResponseCoreSchema,
  customConnectorHttpAuthResponseSchema,
);
export type CustomConnectorHttpResponse = zInfer<
  typeof customConnectorHttpResponseSchema
>;

export const customConnectorMcpResponseCoreSchema =
  customConnectorResponseBaseSchema.extend({
    kind: literal("mcp"),
    endpoint: string().min(1),
    transport: customConnectorMcpTransportSchema,
    prefixTemplates: tuple([]),
    permissionBundleRef: zNull().optional(),
  });
export const customConnectorMcpAuthResponseSchema = union([
  customConnectorNoAuthResponseSchema,
  customConnectorManualAuthResponseSchema,
  customConnectorCustomOAuthResponseSchema,
  customConnectorManagedOAuthResponseSchema,
  customConnectorAutomaticResponseSchema,
]);
export const customConnectorMcpResponseSchema = intersection(
  customConnectorMcpResponseCoreSchema,
  customConnectorMcpAuthResponseSchema,
);
export type CustomConnectorMcpResponse = zInfer<
  typeof customConnectorMcpResponseSchema
>;

export const customConnectorResponseSchema = union([
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
]);
export type CustomConnectorResponse = zInfer<
  typeof customConnectorResponseSchema
>;

export type IntegrationManagedCustomConnectorResponse =
  CustomConnectorResponse &
    zInfer<typeof customConnectorManagedStatusSchema> & {
      readonly oauthConfig: CustomConnectorOAuthConfig & {
        readonly providerAdapter: "feishu";
      };
    };

export function isIntegrationManagedCustomConnector(
  connector: CustomConnectorResponse,
): connector is IntegrationManagedCustomConnectorResponse;
export function isIntegrationManagedCustomConnector(connector: {
  readonly oauthConfig?: {
    readonly providerAdapter: CustomConnectorOAuthProviderAdapter;
  } | null;
}): boolean;
export function isIntegrationManagedCustomConnector(connector: {
  readonly oauthConfig?: {
    readonly providerAdapter: CustomConnectorOAuthProviderAdapter;
  } | null;
}): boolean {
  return isIntegrationManagedCustomConnectorProviderAdapter(
    connector.oauthConfig?.providerAdapter,
  );
}

export function isHttpCustomConnectorResponse(
  connector: CustomConnectorResponse,
): connector is CustomConnectorHttpResponse {
  return connector.kind === "http";
}

export const customConnectorListResponseSchema = object({
  connectors: array(customConnectorResponseSchema),
});

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
  agentId: string().uuid().optional(),
  account: connectorAccountMutationIntentSchema,
}).strict();

const startCustomConnectorOAuth2AuthorizationResponseSchema = object({
  result: literal("authorization"),
  authorizationUrl: string().url(),
  connectionId: uuid().optional(),
  oauthAttemptId: uuid(),
});

const startCustomConnectorOAuth2ConnectedResponseSchema = object({
  result: literal("connected"),
  connector: customConnectorResponseSchema,
  connectionId: uuid(),
});

export const startCustomConnectorOAuth2ResponseSchema = discriminatedUnion(
  "result",
  [
    startCustomConnectorOAuth2AuthorizationResponseSchema,
    startCustomConnectorOAuth2ConnectedResponseSchema,
  ],
);

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

export const setCustomConnectorValuesResponseSchema =
  customConnectorResponseSchema.and(connectorCompletedOperationResponseSchema);

export const customConnectorProposalSchema = object({
  operation: zEnum(["create", "update"]),
  connectorId: string().uuid().optional(),
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
  agentId: string().uuid().optional(),
});
export type SaveCustomConnectorProposalBody = zInfer<
  typeof saveCustomConnectorProposalBodySchema
>;

export const saveCustomConnectorProposalResponseSchema = object({
  connector: customConnectorResponseSchema,
  connectionId: uuid().optional(),
  authorizedAgentId: string().uuid().optional(),
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
    pathParams: object({ id: string().uuid() }),
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
    pathParams: object({ id: string().uuid() }),
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
    pathParams: object({ id: string().uuid() }),
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
    pathParams: object({ id: string().uuid() }),
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
    pathParams: object({ id: string().uuid() }),
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
    pathParams: object({ id: string().uuid() }),
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
