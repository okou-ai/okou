import * as z from "zod";
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

export const customConnectorSlugSchema = z
  .string()
  .regex(/^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/u);
export type CustomConnectorSlug = z.infer<typeof customConnectorSlugSchema>;

export const customConnectorFieldKindSchema = z.enum(["secret", "variable"]);
export type CustomConnectorFieldKind = z.infer<
  typeof customConnectorFieldKindSchema
>;

export const customConnectorFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  kind: customConnectorFieldKindSchema,
  required: z.boolean(),
  description: z.string().max(512).optional(),
});
export type CustomConnectorField = z.infer<typeof customConnectorFieldSchema>;

export const customConnectorHeaderInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z
    .string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});
export type CustomConnectorHeaderInjection = z.infer<
  typeof customConnectorHeaderInjectionSchema
>;

export const customConnectorQueryInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z
    .string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});
export type CustomConnectorQueryInjection = z.infer<
  typeof customConnectorQueryInjectionSchema
>;

export const customConnectorAuthModeSchema = z.enum([
  "none",
  "manual",
  "oauth",
  "automatic",
]);
export type CustomConnectorAuthMode = z.infer<
  typeof customConnectorAuthModeSchema
>;

export const customConnectorOAuthProviderAdapterSchema = z.enum([
  "standard",
  "feishu",
]);
export type CustomConnectorOAuthProviderAdapter = z.infer<
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
export const customConnectorOAuthTokenEndpointAuthMethodSchema = z.enum([
  "client_secret_basic",
  "client_secret_post",
]);
export const customConnectorOAuthPkceMethodSchema = z.enum(["none", "S256"]);

export const customConnectorOAuthConfigSchema = z.object({
  providerAdapter: customConnectorOAuthProviderAdapterSchema,
  clientId: z.string().min(1).max(255),
  authorizationUrl: z.string().url().max(2048),
  tokenUrl: z.string().url().max(2048),
  tokenEndpointAuthMethod: customConnectorOAuthTokenEndpointAuthMethodSchema,
  pkceMethod: customConnectorOAuthPkceMethodSchema,
  scopes: z.array(z.string().min(1).max(256)).max(100),
  authorizationParams: z.record(z.string(), z.string()),
});
export type CustomConnectorOAuthConfig = z.infer<
  typeof customConnectorOAuthConfigSchema
>;

export const customConnectorOAuthConfigInputSchema =
  customConnectorOAuthConfigSchema.extend({
    clientSecret: z.string().min(1).max(4096).optional(),
  });
export type CustomConnectorOAuthConfigInput = z.infer<
  typeof customConnectorOAuthConfigInputSchema
>;

export const customConnectorPermissionBundleRefSchema = z
  .string()
  .max(128)
  .regex(/^builtin:[a-z0-9][a-z0-9-]*@1$/u);
export type CustomConnectorPermissionBundleRef = z.infer<
  typeof customConnectorPermissionBundleRefSchema
>;

const customConnectorPermissionSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
});

export const customConnectorPermissionBundleSchema = z.object({
  ref: customConnectorPermissionBundleRefSchema,
  permissions: z.array(customConnectorPermissionSchema),
  defaultPolicies: z.record(z.string(), z.enum(["allow", "deny", "ask"])),
});
export type CustomConnectorPermissionBundleResponse = z.infer<
  typeof customConnectorPermissionBundleSchema
>;

export const customConnectorSkillMarkdownSchema = z.string().refine(
  (value) => {
    return new TextEncoder().encode(value).byteLength <= 65_536;
  },
  { message: "Custom connector skill markdown must not exceed 64 KiB" },
);

export const customConnectorMcpTransportSchema = z.literal("streamable-http");
export type CustomConnectorMcpTransport = z.infer<
  typeof customConnectorMcpTransportSchema
>;

/**
 * Custom connector response — safe to return to any org member.
 * Never includes any secret material.
 */
const customConnectorResponseBaseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  permissionBundleRef: customConnectorPermissionBundleRefSchema
    .nullable()
    .optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Integration-owned status for managed Feishu/Lark, never ordinary account defaults. */
export const customConnectorManagedStatusSchema = z.object({
  connected: z.boolean(),
  connectedAccountId: z.uuid().optional(),
  connectedAccountUpdatedAt: z.string().optional(),
  missingRequiredFields: z.array(z.string()),
  configuredFieldKeys: z.array(z.string()),
});

type CustomConnectorNonOAuthAuthResponse<
  TMode extends "manual" | "none" | "automatic",
> = {
  readonly authMode: TMode;
  readonly oauthConfig?: never;
};

const customConnectorManualAuthResponseSchema = z
  .object({
    authMode: z.literal("manual"),
    oauthConfig: z.never().optional(),
  })
  .transform((value): CustomConnectorNonOAuthAuthResponse<"manual"> => {
    return { authMode: value.authMode };
  });

const customConnectorNoAuthResponseSchema = z
  .object({
    authMode: z.literal("none"),
    oauthConfig: z.never().optional(),
  })
  .transform((value): CustomConnectorNonOAuthAuthResponse<"none"> => {
    return { authMode: value.authMode };
  });

const customConnectorCustomOAuthResponseSchema = z
  .object({
    authMode: z.literal("oauth"),
    oauthConfig: customConnectorOAuthConfigSchema.extend({
      providerAdapter: z.literal("standard"),
    }),
  })
  .transform((value) => {
    return {
      authMode: value.authMode,
      oauthConfig: value.oauthConfig,
    };
  });

const customConnectorManagedOAuthResponseSchema = z.object({
  authMode: z.literal("oauth"),
  oauthConfig: customConnectorOAuthConfigSchema.extend({
    providerAdapter: z.literal("feishu"),
  }),
  ...customConnectorManagedStatusSchema.shape,
});

const customConnectorAutomaticResponseSchema = z
  .object({
    authMode: z.literal("automatic"),
    oauthConfig: z.never().optional(),
  })
  .transform((value): CustomConnectorNonOAuthAuthResponse<"automatic"> => {
    return { authMode: value.authMode };
  });

export const customConnectorHttpAuthResponseSchema = z.union([
  customConnectorNoAuthResponseSchema,
  customConnectorManualAuthResponseSchema,
  customConnectorCustomOAuthResponseSchema,
  customConnectorManagedOAuthResponseSchema,
]);

export const customConnectorHttpResponseCoreSchema =
  customConnectorResponseBaseSchema.extend({
    kind: z.literal("http"),
    prefixTemplates: z.array(z.string()),
  });
export const customConnectorHttpResponseSchema = z.intersection(
  customConnectorHttpResponseCoreSchema,
  customConnectorHttpAuthResponseSchema,
);
export type CustomConnectorHttpResponse = z.infer<
  typeof customConnectorHttpResponseSchema
>;

export const customConnectorMcpResponseCoreSchema =
  customConnectorResponseBaseSchema.extend({
    kind: z.literal("mcp"),
    endpoint: z.string().min(1),
    transport: customConnectorMcpTransportSchema,
    prefixTemplates: z.tuple([]),
    permissionBundleRef: z.null().optional(),
  });
export const customConnectorMcpAuthResponseSchema = z.union([
  customConnectorNoAuthResponseSchema,
  customConnectorManualAuthResponseSchema,
  customConnectorCustomOAuthResponseSchema,
  customConnectorManagedOAuthResponseSchema,
  customConnectorAutomaticResponseSchema,
]);
export const customConnectorMcpResponseSchema = z.intersection(
  customConnectorMcpResponseCoreSchema,
  customConnectorMcpAuthResponseSchema,
);
export type CustomConnectorMcpResponse = z.infer<
  typeof customConnectorMcpResponseSchema
>;

export const customConnectorResponseSchema = z.union([
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
]);
export type CustomConnectorResponse = z.infer<
  typeof customConnectorResponseSchema
>;

export type IntegrationManagedCustomConnectorResponse =
  CustomConnectorResponse &
    z.infer<typeof customConnectorManagedStatusSchema> & {
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

export const customConnectorListResponseSchema = z.object({
  connectors: z.array(customConnectorResponseSchema),
});

const customConnectorDefinitionWriteBaseSchema = z.object({
  displayName: z.string().min(1).max(128),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  authMode: customConnectorAuthModeSchema.optional(),
  oauthConfig: customConnectorOAuthConfigInputSchema.optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: z.number().int().positive().optional(),
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
  context: z.RefinementCtx,
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
  context: z.RefinementCtx,
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
  context: z.RefinementCtx,
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
    kind: z.literal("http").optional(),
    prefixTemplates: z.array(z.string().min(1)).min(1),
    permissionBundleRef: customConnectorPermissionBundleRefSchema
      .nullable()
      .optional(),
    endpoint: z.never().optional(),
    transport: z.never().optional(),
  });

const customConnectorHttpDefinitionWriteSchema =
  customConnectorHttpDefinitionWriteCoreSchema.superRefine((value, context) => {
    validateCustomConnectorAuthWrite(value, context, "http");
  });

export const customConnectorHttpCreateBodySchema =
  customConnectorHttpDefinitionWriteCoreSchema
    .extend({
      slug: z.string().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "http");
    });

export const customConnectorMcpCreateBodySchema =
  customConnectorDefinitionWriteBaseSchema
    .extend({
      kind: z.literal("mcp"),
      endpoint: z.string().min(1).max(2048),
      transport: customConnectorMcpTransportSchema,
      permissionBundleRef: z.null().optional(),
      slug: z.string().optional(),
      prefixTemplates: z.never().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "mcp");
    });

export const createCustomConnectorBodySchema = z.union([
  customConnectorMcpCreateBodySchema,
  customConnectorHttpCreateBodySchema,
]);
export type CreateCustomConnectorBody = z.infer<
  typeof createCustomConnectorBodySchema
>;

export const customConnectorHttpUpdateBodySchema =
  customConnectorHttpDefinitionWriteSchema;

export const customConnectorMcpUpdateBodySchema =
  customConnectorDefinitionWriteBaseSchema
    .extend({
      kind: z.literal("mcp"),
      endpoint: z.string().min(1).max(2048),
      transport: customConnectorMcpTransportSchema,
      permissionBundleRef: z.null().optional(),
      prefixTemplates: z.never().optional(),
    })
    .superRefine((value, context) => {
      validateCustomConnectorAuthWrite(value, context, "mcp");
    });

export const updateCustomConnectorBodySchema = z.union([
  customConnectorMcpUpdateBodySchema,
  customConnectorHttpUpdateBodySchema,
]);
/*
 * `kind` is intentionally optional only on the HTTP branches. Installed
 * writers predate the protocol discriminator, while every MCP writer must be
 * explicit so an HTTP-only backend cannot silently create a different shape.
 */
export type UpdateCustomConnectorBody = z.infer<
  typeof updateCustomConnectorBodySchema
>;

export const startCustomConnectorOAuth2BodySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    account: connectorAccountMutationIntentSchema,
  })
  .strict();

const startCustomConnectorOAuth2AuthorizationResponseSchema = z.object({
  result: z.literal("authorization"),
  authorizationUrl: z.string().url(),
  connectionId: z.uuid().optional(),
  oauthAttemptId: z.uuid(),
});

const startCustomConnectorOAuth2ConnectedResponseSchema = z.object({
  result: z.literal("connected"),
  connector: customConnectorResponseSchema,
  connectionId: z.uuid(),
});

export const startCustomConnectorOAuth2ResponseSchema = z.discriminatedUnion(
  "result",
  [
    startCustomConnectorOAuth2AuthorizationResponseSchema,
    startCustomConnectorOAuth2ConnectedResponseSchema,
  ],
);

export const customConnectorValueInputSchema = z.object({
  key: z.string().min(1).max(64),
  kind: customConnectorFieldKindSchema,
  value: z.string().min(1),
});
export type CustomConnectorValueInput = z.infer<
  typeof customConnectorValueInputSchema
>;

export const setCustomConnectorValuesBodySchema = z.object({
  values: z.array(customConnectorValueInputSchema),
  account: connectorAccountMutationIntentSchema,
});
export type SetCustomConnectorValuesBody = z.infer<
  typeof setCustomConnectorValuesBodySchema
>;

export const setCustomConnectorValuesResponseSchema =
  customConnectorResponseSchema.and(connectorCompletedOperationResponseSchema);

export const customConnectorProposalSchema = z.object({
  operation: z.enum(["create", "update"]),
  connectorId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(128),
  prefixTemplates: z.array(z.string().min(1)).min(1),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  notes: z.string().max(2048).optional(),
});
export type CustomConnectorProposal = z.infer<
  typeof customConnectorProposalSchema
>;

export const saveCustomConnectorProposalBodySchema = z.object({
  proposal: customConnectorProposalSchema,
  values: z.array(customConnectorValueInputSchema),
  agentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalBody = z.infer<
  typeof saveCustomConnectorProposalBodySchema
>;

export const saveCustomConnectorProposalResponseSchema = z.object({
  connector: customConnectorResponseSchema,
  connectionId: z.uuid().optional(),
  authorizedAgentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalResponse = z.infer<
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    pathParams: z.object({ id: z.string().uuid() }),
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
    query: z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        iss: z.string().optional(),
        responseMode: z.literal("json").optional(),
      })
      .catchall(z.string()),
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
