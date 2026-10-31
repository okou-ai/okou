import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
  string,
  url,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { publicConnectorCatalogIconSchema } from "../validators/connector-catalog";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import { apiErrorSchema } from "./errors";

export { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";
export { publicConnectorCatalogIconSchema } from "../validators/connector-catalog";

const c = initContract();

const publicConnectorCatalogAuthMethodSummarySchema = object({
  id: connectorAuthMethodIdSchema,
  label: string(),
  description: string().nullable(),
  supportsRefresh: boolean(),
  grantKind: zEnum([
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

const publicConnectorCatalogPermissionSummarySchema = object({
  hasPermissions: boolean(),
  permissionCount: number().int().nonnegative(),
  hasCategories: boolean(),
  hasDefaultPolicyOverrides: boolean(),
});

const publicConnectorCatalogItemSchema = object({
  slug: connectorSlugSchema,
  label: string(),
  description: string(),
  icon: publicConnectorCatalogIconSchema,
  category: string(),
  /**
   * Discovery ordering, lower first. Absent for connectors outside the ranked
   * head, which sort after every ranked one.
   */
  popularityRank: number().int().nonnegative().optional(),
  generation: array(string()),
  tags: array(string()),
  mcp: object({
    transport: literal("streamable-http"),
    endpoint: url({ protocol: /^https$/u }),
  }).optional(),
  authMethods: array(publicConnectorCatalogAuthMethodSummarySchema),
  permissionSummary: publicConnectorCatalogPermissionSummarySchema,
});

const publicConnectorCatalogManualFieldSchema = object({
  id: string(),
  label: string(),
  required: boolean(),
  placeholder: string().nullable(),
  inputType: zEnum(["password", "text"]),
});

const publicConnectorCatalogStartOptionChoiceSchema = object({
  value: string(),
  label: string(),
});

const publicConnectorCatalogStartOptionSchema = object({
  id: string(),
  kind: literal("select"),
  label: string(),
  required: boolean(),
  defaultValue: string().nullable(),
  options: array(publicConnectorCatalogStartOptionChoiceSchema),
});

const publicConnectorCatalogAuthMethodDetailSchema =
  publicConnectorCatalogAuthMethodSummarySchema.extend({
    manualFields: array(publicConnectorCatalogManualFieldSchema),
    startOptions: array(publicConnectorCatalogStartOptionSchema),
  });

const publicConnectorCatalogDetailSchema =
  publicConnectorCatalogItemSchema.extend({
    authMethods: array(publicConnectorCatalogAuthMethodDetailSchema),
  });

const publicConnectorCatalogListResponseSchema = object({
  connectors: array(publicConnectorCatalogItemSchema),
});

export const publicConnectorCatalogStatusItemSchema =
  publicConnectorCatalogDetailSchema.extend({
    singleAuthCodeAuthMethodId: connectorAuthMethodIdSchema.nullable(),
    connectNotice: zEnum(["google-security-warning"]).nullable(),
  });

/**
 * A connector as a connect surface lists it: what draws its card and what
 * starts a connection from the same click, since the provider window has to
 * open inside that click. Detail that only one connector's page shows
 * (permissions, MCP, tags) stays on `GET /api/connector-catalog/:slug`.
 */
export const publicConnectorCatalogConnectItemSchema =
  publicConnectorCatalogStatusItemSchema.pick({
    slug: true,
    label: true,
    description: true,
    icon: true,
    popularityRank: true,
    authMethods: true,
    singleAuthCodeAuthMethodId: true,
    connectNotice: true,
  });

export const publicConnectorCatalogConnectListResponseSchema = object({
  connectors: array(publicConnectorCatalogConnectItemSchema),
});

const publicConnectorCatalogDetailResponseSchema = object({
  connector: publicConnectorCatalogStatusItemSchema,
});

const publicConnectorCatalogStatusResponseSchema = object({
  connectors: array(publicConnectorCatalogStatusItemSchema),
});

const publicConnectorCatalogDiscoveryResponseSchema =
  publicConnectorCatalogStatusResponseSchema.extend({
    totalConnectorCount: number().int().nonnegative(),
    /**
     * How many connectors each category holds in total. Discovery returns a
     * slice per category, so the client needs this to offer "show all" without
     * a second request.
     */
    categoryConnectorCounts: record(
      string(),
      number().int().nonnegative(),
    ).optional(),
  });

const publicFirewallPolicyValueSchema = zEnum(["allow", "deny", "ask"]);

const publicConnectorCatalogPermissionSchema = object({
  name: string(),
  description: string().optional(),
});

const publicConnectorCatalogPermissionCategoriesSchema = object({
  categories: record(string(), string()),
  displayOrder: array(string()),
});

const publicConnectorCatalogDefaultPolicySchema = object({
  permissionDefault: publicFirewallPolicyValueSchema,
  permissionOverrides: record(string(), array(string())).optional(),
  unknownPolicy: publicFirewallPolicyValueSchema,
});

const publicConnectorCatalogPermissionDetailSchema = object({
  connectorSlug: connectorSlugSchema,
  label: string(),
  icon: publicConnectorCatalogIconSchema,
  permissionCount: number().int().nonnegative(),
  permissions: array(publicConnectorCatalogPermissionSchema),
  categories: publicConnectorCatalogPermissionCategoriesSchema.nullable(),
  defaultPolicy: publicConnectorCatalogDefaultPolicySchema,
});

const publicConnectorCatalogPermissionDetailResponseSchema = object({
  permissions: publicConnectorCatalogPermissionDetailSchema,
});

const connectorCatalogPathParamsSchema = object({
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

export type PublicConnectorCatalogAuthMethodSummary = zInfer<
  typeof publicConnectorCatalogAuthMethodSummarySchema
>;
export type PublicConnectorCatalogPermissionSummary = zInfer<
  typeof publicConnectorCatalogPermissionSummarySchema
>;
export type PublicConnectorCatalogIcon = zInfer<
  typeof publicConnectorCatalogIconSchema
>;
export type PublicConnectorCatalogItem = zInfer<
  typeof publicConnectorCatalogItemSchema
>;
export type PublicConnectorCatalogManualField = zInfer<
  typeof publicConnectorCatalogManualFieldSchema
>;
export type PublicConnectorCatalogStartOption = zInfer<
  typeof publicConnectorCatalogStartOptionSchema
>;
export type PublicConnectorCatalogAuthMethodDetail = zInfer<
  typeof publicConnectorCatalogAuthMethodDetailSchema
>;
export type PublicConnectorCatalogDetail = zInfer<
  typeof publicConnectorCatalogDetailSchema
>;
export type PublicConnectorCatalogListResponse = zInfer<
  typeof publicConnectorCatalogListResponseSchema
>;
export type PublicConnectorCatalogDetailResponse = zInfer<
  typeof publicConnectorCatalogDetailResponseSchema
>;
export type PublicConnectorCatalogStatusItem = zInfer<
  typeof publicConnectorCatalogStatusItemSchema
>;
export type PublicConnectorCatalogConnectItem = zInfer<
  typeof publicConnectorCatalogConnectItemSchema
>;
export type PublicConnectorCatalogConnectListResponse = zInfer<
  typeof publicConnectorCatalogConnectListResponseSchema
>;
export type PublicConnectorCatalogStatusResponse = zInfer<
  typeof publicConnectorCatalogStatusResponseSchema
>;
export type PublicConnectorCatalogDiscoveryResponse = zInfer<
  typeof publicConnectorCatalogDiscoveryResponseSchema
>;
export type PublicConnectorCatalogPermissionDetail = zInfer<
  typeof publicConnectorCatalogPermissionDetailSchema
>;
export type PublicConnectorCatalogPermissionDetailResponse = zInfer<
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
    summary: "List public connector catalog metadata and connect hints",
  },
  discovery: {
    method: "GET",
    path: "/api/connector-catalog/discovery",
    headers: authHeadersSchema,
    query: object({
      keyword: string().optional(),
      /**
       * Browse one category in full instead of the per-category slice. The
       * category totals this endpoint reports are what the client offers as a
       * way in, so entering one has to return everything it counted.
       */
      category: string().optional(),
    }),
    responses: {
      200: publicConnectorCatalogDiscoveryResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Browse featured connectors or search by slug and label",
  },
  oneClick: {
    method: "GET",
    path: "/api/connector-catalog/one-click",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogConnectListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List metadata for connectors that connect in one browser step",
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
    summary: "Get public connector catalog metadata and connect hints",
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
