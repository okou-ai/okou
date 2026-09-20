import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorCatalogDiagnosticsSchema } from "./connector-catalog-diagnostics";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import { connectorReconnectReasonSchema } from "./connector-schemas";
import { apiErrorSchema } from "./errors";

export { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";

const c = initContract();

const publicConnectorCatalogAuthMethodSummarySchema = z.object({
  id: connectorAuthMethodIdSchema,
  label: z.string(),
  description: z.string().nullable(),
  grantKind: z.enum([
    "none",
    "automatic",
    "manual",
    "auth-code",
    "openid-auth",
    "external-code",
    "device-auth",
    "managed",
  ]),
});

const publicConnectorCatalogPermissionSummarySchema = z.object({
  hasPermissions: z.boolean(),
  permissionCount: z.number().int().nonnegative(),
  hasCategories: z.boolean(),
  hasDefaultPolicyOverrides: z.boolean(),
});

export const publicConnectorCatalogIconSchema = z.object({
  url: z.url({ protocol: /^https$/u }).max(2048),
  invertInDarkMode: z.boolean(),
  scale: z.number().min(1).max(3).optional(),
});

const publicConnectorCatalogCategoryGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  menuLabel: z.string(),
});

const publicConnectorCatalogCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  menuLabel: z.string(),
  groupId: z.string().nullable(),
});

const publicConnectorCatalogCategoryMetadataSchema = z.object({
  categories: z.array(publicConnectorCatalogCategorySchema),
  groups: z.array(publicConnectorCatalogCategoryGroupSchema),
});

const publicConnectorCatalogItemSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
  description: z.string(),
  icon: publicConnectorCatalogIconSchema,
  category: z.string(),
  /**
   * Discovery ordering, lower first. Absent for connectors outside the ranked
   * head, which sort after every ranked one.
   */
  popularityRank: z.number().int().nonnegative().optional(),
  generation: z.array(z.string()),
  tags: z.array(z.string()),
  mcp: z
    .object({
      transport: z.literal("streamable-http"),
      endpoint: z.url({ protocol: /^https$/u }),
    })
    .optional(),
  replaces: z.object({ connectorSlug: connectorSlugSchema }).optional(),
  authMethods: z.array(publicConnectorCatalogAuthMethodSummarySchema),
  permissionSummary: publicConnectorCatalogPermissionSummarySchema,
});

const publicConnectorCatalogManualFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  placeholder: z.string().nullable(),
  inputType: z.enum(["password", "text"]),
});

const publicConnectorCatalogStartOptionChoiceSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const publicConnectorCatalogStartOptionSchema = z.object({
  id: z.string(),
  kind: z.literal("select"),
  label: z.string(),
  required: z.boolean(),
  defaultValue: z.string().nullable(),
  options: z.array(publicConnectorCatalogStartOptionChoiceSchema),
});

const publicConnectorCatalogAuthMethodDetailSchema =
  publicConnectorCatalogAuthMethodSummarySchema.extend({
    manualFields: z.array(publicConnectorCatalogManualFieldSchema),
    startOptions: z.array(publicConnectorCatalogStartOptionSchema),
  });

const publicConnectorCatalogDetailSchema =
  publicConnectorCatalogItemSchema.extend({
    authMethods: z.array(publicConnectorCatalogAuthMethodDetailSchema),
  });

const publicConnectorCatalogListResponseSchema = z.object({
  connectors: z.array(publicConnectorCatalogItemSchema),
  categoryMetadata: publicConnectorCatalogCategoryMetadataSchema.optional(),
});

const publicConnectorCatalogConnectionStatusSchema = z.enum([
  "not-connected",
  "connected",
  "scope-mismatch",
  "reconnect-required",
]);

const publicConnectorCatalogConnectionSchema = z.object({
  id: z.uuid().optional(),
  authMethod: connectorAuthMethodIdSchema,
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  reconnectReason: connectorReconnectReasonSchema.nullable(),
});

const publicConnectorCatalogStatusItemSchema =
  publicConnectorCatalogDetailSchema.extend({
    connection: publicConnectorCatalogConnectionSchema.nullable(),
    connected: z.boolean(),
    connectionStatus: publicConnectorCatalogConnectionStatusSchema,
    scopeMismatch: z.boolean(),
    authMethodSupportsRefresh: z.boolean(),
    tokenExpiresAt: z.string().nullable(),
    singleAuthCodeAuthMethodId: connectorAuthMethodIdSchema.nullable(),
    connectNotice: z.enum(["google-security-warning"]).nullable(),
  });

const publicConnectorCatalogDetailResponseSchema = z.object({
  connector: publicConnectorCatalogStatusItemSchema,
});

const publicConnectorCatalogStatusResponseSchema = z.object({
  connectors: z.array(publicConnectorCatalogStatusItemSchema),
  categoryMetadata: publicConnectorCatalogCategoryMetadataSchema.optional(),
});

const publicConnectorCatalogDiscoveryResponseSchema =
  publicConnectorCatalogStatusResponseSchema.extend({
    totalConnectorCount: z.number().int().nonnegative(),
    /**
     * How many connectors each category holds in total. Discovery returns a
     * slice per category, so the client needs this to offer "show all" without
     * a second request.
     */
    categoryConnectorCounts: z
      .record(z.string(), z.number().int().nonnegative())
      .optional(),
  });

const publicFirewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);

const publicConnectorCatalogPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const publicConnectorCatalogPermissionCategoriesSchema = z.object({
  categories: z.record(z.string(), z.string()),
  displayOrder: z.array(z.string()),
});

const publicConnectorCatalogDefaultPolicySchema = z.object({
  permissionDefault: publicFirewallPolicyValueSchema,
  permissionOverrides: z.record(z.string(), z.array(z.string())).optional(),
  unknownPolicy: publicFirewallPolicyValueSchema,
});

const publicConnectorCatalogPermissionDetailSchema = z.object({
  connectorSlug: connectorSlugSchema,
  label: z.string(),
  icon: publicConnectorCatalogIconSchema,
  permissionCount: z.number().int().nonnegative(),
  permissions: z.array(publicConnectorCatalogPermissionSchema),
  categories: publicConnectorCatalogPermissionCategoriesSchema.nullable(),
  defaultPolicy: publicConnectorCatalogDefaultPolicySchema,
});

const publicConnectorCatalogPermissionDetailResponseSchema = z.object({
  permissions: publicConnectorCatalogPermissionDetailSchema,
});

const connectorCatalogPathParamsSchema = z.object({
  connectorSlug: connectorSlugSchema,
});

/**
 * The grant kinds that complete in the browser: the user presses one button,
 * authorizes at the provider, and comes back connected. Everything else needs a
 * key pasted in from somewhere outside Okou.
 *
 * This is also the rule the Get started connector reward pays on, so the two
 * cannot drift: a connector the catalog offers as one-click is a connector that
 * earns the reward.
 */
export const ONE_CLICK_CONNECTOR_GRANT_KINDS = Object.freeze([
  "auth-code",
  "external-code",
  "device-auth",
] as const);

export function isOneClickConnectorGrantKind(grantKind: string): boolean {
  return ONE_CLICK_CONNECTOR_GRANT_KINDS.some((kind) => {
    return kind === grantKind;
  });
}

export type PublicConnectorCatalogAuthMethodSummary = z.infer<
  typeof publicConnectorCatalogAuthMethodSummarySchema
>;
export type PublicConnectorCatalogPermissionSummary = z.infer<
  typeof publicConnectorCatalogPermissionSummarySchema
>;
export type PublicConnectorCatalogIcon = z.infer<
  typeof publicConnectorCatalogIconSchema
>;
export type PublicConnectorCatalogCategoryGroup = z.infer<
  typeof publicConnectorCatalogCategoryGroupSchema
>;
export type PublicConnectorCatalogCategory = z.infer<
  typeof publicConnectorCatalogCategorySchema
>;
export type PublicConnectorCatalogCategoryMetadata = z.infer<
  typeof publicConnectorCatalogCategoryMetadataSchema
>;
export type PublicConnectorCatalogItem = z.infer<
  typeof publicConnectorCatalogItemSchema
>;
export type PublicConnectorCatalogManualField = z.infer<
  typeof publicConnectorCatalogManualFieldSchema
>;
export type PublicConnectorCatalogStartOption = z.infer<
  typeof publicConnectorCatalogStartOptionSchema
>;
export type PublicConnectorCatalogAuthMethodDetail = z.infer<
  typeof publicConnectorCatalogAuthMethodDetailSchema
>;
export type PublicConnectorCatalogDetail = z.infer<
  typeof publicConnectorCatalogDetailSchema
>;
export type PublicConnectorCatalogListResponse = z.infer<
  typeof publicConnectorCatalogListResponseSchema
>;
export type PublicConnectorCatalogDetailResponse = z.infer<
  typeof publicConnectorCatalogDetailResponseSchema
>;
export type PublicConnectorCatalogConnectionStatus = z.infer<
  typeof publicConnectorCatalogConnectionStatusSchema
>;
export type PublicConnectorCatalogConnection = z.infer<
  typeof publicConnectorCatalogConnectionSchema
>;
export type PublicConnectorCatalogStatusItem = z.infer<
  typeof publicConnectorCatalogStatusItemSchema
>;
export type PublicConnectorCatalogStatusResponse = z.infer<
  typeof publicConnectorCatalogStatusResponseSchema
>;
export type PublicConnectorCatalogDiscoveryResponse = z.infer<
  typeof publicConnectorCatalogDiscoveryResponseSchema
>;
export type PublicConnectorCatalogPermissionDetail = z.infer<
  typeof publicConnectorCatalogPermissionDetailSchema
>;
export type PublicConnectorCatalogPermissionDetailResponse = z.infer<
  typeof publicConnectorCatalogPermissionDetailResponseSchema
>;

export const connectorCatalogContract = c.router({
  list: {
    method: "GET",
    path: "/api/connector-catalog",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public connector catalog metadata",
  },
  status: {
    method: "GET",
    path: "/api/connector-catalog/status",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public connector catalog metadata with connection status",
  },
  discovery: {
    method: "GET",
    path: "/api/connector-catalog/discovery",
    headers: authHeadersSchema,
    query: z.object({
      keyword: z.string().optional(),
      /**
       * Browse one category in full instead of the per-category slice. The
       * category totals this endpoint reports are what the client offers as a
       * way in, so entering one has to return everything it counted.
       */
      category: z.string().optional(),
    }),
    responses: {
      200: publicConnectorCatalogDiscoveryResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Browse featured connectors or search by slug and label",
  },
  diagnostics: {
    method: "GET",
    path: "/api/connector-catalog/diagnostics",
    headers: authHeadersSchema,
    responses: {
      200: connectorCatalogDiagnosticsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read connector catalog diagnostics",
  },
  get: {
    method: "GET",
    path: "/api/connector-catalog/:connectorSlug",
    headers: authHeadersSchema,
    pathParams: connectorCatalogPathParamsSchema,
    responses: {
      200: publicConnectorCatalogDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get public connector catalog metadata with connection status",
  },
  permissions: {
    method: "GET",
    path: "/api/connector-catalog/:connectorSlug/permissions",
    headers: authHeadersSchema,
    pathParams: connectorCatalogPathParamsSchema,
    responses: {
      200: publicConnectorCatalogPermissionDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get public connector permission metadata",
  },
});

export type ConnectorCatalogContract = typeof connectorCatalogContract;
