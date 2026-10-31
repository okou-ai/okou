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
  type infer as zInfer,
} from "zod";

import { connectorCompletedOperationResponseSchema } from "../contracts/connector-schemas";

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

export const customConnectorSlugSchema = string().regex(
  /^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/u,
);

export const customConnectorFieldKindSchema = zEnum(["secret", "variable"]);

export const customConnectorFieldSchema = object({
  key: string().min(1).max(64),
  label: string().min(1).max(128),
  kind: customConnectorFieldKindSchema,
  required: boolean(),
  description: string().max(512).optional(),
});

export const customConnectorHeaderInjectionSchema = object({
  name: string().min(1).max(128),
  valueTemplate: string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});

export const customConnectorQueryInjectionSchema = object({
  name: string().min(1).max(128),
  valueTemplate: string()
    .min(1)
    .max(CUSTOM_CONNECTOR_INJECTION_TEMPLATE_MAX_CHARS),
});

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

export const customConnectorPermissionBundleRefSchema = string()
  .max(128)
  .regex(/^builtin:[a-z0-9][a-z0-9-]*@1$/u);

export const customConnectorSkillMarkdownSchema = string().refine(
  (value) => {
    return new TextEncoder().encode(value).byteLength <= 65_536;
  },
  { message: "Custom connector skill markdown must not exceed 64 KiB" },
);

export const customConnectorMcpTransportSchema = literal("streamable-http");

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

export const customConnectorListResponseSchema = object({
  connectors: array(customConnectorResponseSchema),
});

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

export const setCustomConnectorValuesResponseSchema =
  customConnectorResponseSchema.and(connectorCompletedOperationResponseSchema);
