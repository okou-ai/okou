import type { ConnectorConnectionMetadataArgs } from "./connector-account-mutation.service";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  isIntegrationManagedCustomConnector,
  isIntegrationManagedCustomConnectorProviderAdapter,
  type CreateCustomConnectorBody,
  type CustomConnectorAuthMode,
  type CustomConnectorField,
  type CustomConnectorFieldKind,
  type CustomConnectorHeaderInjection,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorMcpTransport,
  type CustomConnectorOAuthConfig,
  type CustomConnectorOAuthConfigInput,
  type CustomConnectorPermissionBundleRef,
  type CustomConnectorPermissionBundleResponse,
  type CustomConnectorProposal,
  type CustomConnectorQueryInjection,
  type CustomConnectorResponse,
  type CustomConnectorValueInput,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  canonicalizeFirewallBaseUrl,
  expandHostWildcardsInBaseUrl,
} from "@okouai/connectors/firewall-types";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgCustomConnectorOauthConfigs,
  type OrgCustomConnectorOAuthPkceMethod,
  type OrgCustomConnectorOAuthProviderAdapter,
  type OrgCustomConnectorOAuthTokenEndpointAuthMethod,
} from "@okouai/db/schema/org-custom-connector-oauth-config";
import { command, computed, type Computed } from "ccstate";
import { boolean, object, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { WithSubquery } from "drizzle-orm/subquery";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { safeSync, settle } from "../utils";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import type { CapturedConnectorClientInvalidationAbort } from "./connector-client-invalidation.service";
import {
  connectorConnectionMutationReadPlan as connectionMutationReadPlan,
  connectorConnectionMutationReadResult as connectionMutationReadResult,
  type ConnectorConnectionMutationArgs,
  type ReadyConnectorConnectionMutation,
  type ConnectorConnectionMutationResolution,
} from "./connector-connection-write.service";
import {
  connectorRuntimeWakeupRunColumns,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  reportConnectorRuntimeWakeupDiscoveryFailure,
  uniqueConnectorRuntimeTargets,
  type ConnectorRuntimeWakeupBusinessArgs,
  publishConnectorRuntimeSyncWakeups$,
} from "./connector-runtime-wakeup.service";
import { encryptStoredSecretValue } from "./crypto.utils";
import { parseCustomMcpEndpoint } from "./custom-mcp-endpoint";
import {
  customConnectorDefinitionConnectedAccount,
  customConnectorDefinitionFieldCompatibility,
  createCustomConnectorConnectedConnections,
  customConnectorRuntimeStorageSnapshot,
  createCustomConnectorValueMarkers,
  type CustomConnectorCredentialValueMarker,
  type CustomConnectorStoredValue,
} from "./custom-connector-credential-access.service";
import {
  customConnectorCredentialValues as credentialValues,
  customConnectorValuesPublicationSql,
  customConnectorAccountDeletionRow,
  customConnectorAccountDeletionSql,
  type CustomConnectorMemberConnectionDeletionResult,
  type PreparedCustomConnectorValue,
} from "./custom-connector-credential-storage.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorDefinitionRow,
} from "./custom-connector-definition-selection";
import {
  customConnectorPermissionBundleDependencySlug,
  loadCustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import { prepareCustomConnectorSkillVolume$ } from "./custom-connector-skill-volume.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";

import { StorageVersionIdentityConflictError } from "./storage-version-registration.service";
import { preparedVolumePublicationPlan } from "./storage-volume-publication-sql";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import { addUserCustomConnector$ } from "./user-connectors.service";

const L = logger("CustomConnectorService");

const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const SLUG_REGEX = /^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;
const TEMPLATE_REFERENCE_REGEX =
  /\{\{\s*(secrets|variables|oauth)\.([a-z][a-z0-9_]*)\s*\}\}/g;
const TEMPLATE_EXPRESSION_REGEX = /\{\{[^{}]*\}\}/;
const VARIABLE_REFERENCE_REGEX = /\{\{\s*variables\.[a-z][a-z0-9_]*\s*\}\}/;
const TEMPLATE_PLACEHOLDER_VALUE = "placeholder";
const HOST_TEMPLATE_VALUE_UNSAFE_REGEX = /[/?#\\@:]/;
const MCP_PROTECTED_HEADER_NAMES = Object.freeze([
  "accept",
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "last-event-id",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-okou-connector-intent",
]);
export const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";
export const CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME = "refresh_token";
export const CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME = "id_token";
export const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY =
  "__oauth_access_token";
const CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_REFERENCE = "oauth.access_token";

type BadRequestResponse = ReturnType<typeof badRequestMessage>;
type NotFoundResponse = ReturnType<typeof notFound>;
type ConflictResponse = ReturnType<typeof conflict>;
type ForbiddenResponse = {
  readonly status: 403;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: "FORBIDDEN";
    };
  };
};

function forbidden(message: string): ForbiddenResponse {
  return {
    status: 403,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

export function integrationManagedCustomConnectorMutationForbidden(): ForbiddenResponse {
  return forbidden("This connector is managed by its integration");
}

export interface CustomConnectorOAuthConfigRow {
  readonly connectorId: string;
  readonly orgId: string;
  readonly providerAdapter: OrgCustomConnectorOAuthProviderAdapter;
  readonly clientId: string;
  readonly encryptedClientSecret: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly tokenEndpointAuthMethod: OrgCustomConnectorOAuthTokenEndpointAuthMethod;
  readonly pkceMethod: OrgCustomConnectorOAuthPkceMethod;
  readonly scopes: readonly string[];
  readonly authorizationParams: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type CustomConnectorOAuthReadConfig = Pick<
  CustomConnectorOAuthConfigRow,
  | "providerAdapter"
  | "clientId"
  | "authorizationUrl"
  | "tokenUrl"
  | "tokenEndpointAuthMethod"
  | "pkceMethod"
  | "scopes"
  | "authorizationParams"
>;

type CustomConnectorOAuthAdapter = Pick<
  CustomConnectorOAuthConfigRow,
  "providerAdapter"
>;

interface CustomConnectorSharedRow<
  OAuthConfig extends CustomConnectorOAuthAdapter =
    CustomConnectorOAuthConfigRow,
> {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode: CustomConnectorAuthMode;
  readonly oauthConfig: OAuthConfig | null;
  readonly enabled: boolean;
  readonly skillMarkdown: string | null;
  readonly skillStorageVersionId: string | null;
  readonly storageVersion: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomConnectorHttpRow<
  OAuthConfig extends CustomConnectorOAuthAdapter =
    CustomConnectorOAuthConfigRow,
> extends CustomConnectorSharedRow<OAuthConfig> {
  readonly kind: "http";
  readonly prefixTemplates: readonly string[];
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
}

export interface CustomConnectorMcpRow<
  OAuthConfig extends CustomConnectorOAuthAdapter =
    CustomConnectorOAuthConfigRow,
> extends CustomConnectorSharedRow<OAuthConfig> {
  readonly kind: "mcp";
  readonly endpoint: string;
  readonly transport: CustomConnectorMcpTransport;
  readonly permissionBundleRef: null;
}

export type CustomConnectorRow<
  OAuthConfig extends CustomConnectorOAuthAdapter =
    CustomConnectorOAuthConfigRow,
> = CustomConnectorHttpRow<OAuthConfig> | CustomConnectorMcpRow<OAuthConfig>;

type CustomConnectorDefinitionMetadata =
  | "enabled"
  | "skillMarkdown"
  | "skillStorageVersionId"
  | "createdBy"
  | "createdAt"
  | "updatedAt";

export type CustomConnectorConnectionDefinitionRow = Omit<
  CustomConnectorDefinitionRow,
  CustomConnectorDefinitionMetadata
>;

interface DefinitionInputBase {
  readonly displayName: string;
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode?: CustomConnectorAuthMode;
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
  readonly skillMarkdown: string | null;
  readonly slug?: string;
}

interface HttpDefinitionInput extends DefinitionInputBase {
  readonly kind: "http";
  readonly prefixTemplates: readonly string[];
}

interface McpDefinitionInput extends DefinitionInputBase {
  readonly kind: "mcp";
  readonly endpoint: string;
  readonly transport: CustomConnectorMcpTransport;
  readonly permissionBundleRef: null;
}

type DefinitionInput = HttpDefinitionInput | McpDefinitionInput;

interface ValidatedDefinitionBase {
  readonly displayName: string;
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode: CustomConnectorAuthMode;
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
  readonly skillMarkdown: string | null;
  readonly slug: string | undefined;
}

interface ValidatedHttpDefinition extends ValidatedDefinitionBase {
  readonly kind: "http";
  readonly prefixTemplates: readonly string[];
}

interface ValidatedMcpDefinition extends ValidatedDefinitionBase {
  readonly kind: "mcp";
  readonly endpoint: string;
  readonly transport: CustomConnectorMcpTransport;
  readonly permissionBundleRef: null;
}

type ValidatedDefinition = ValidatedHttpDefinition | ValidatedMcpDefinition;

type ValidatedOAuthConfigUpdate =
  | { readonly kind: "none" }
  | {
      readonly kind: "preserve";
      readonly config: CustomConnectorOAuthConfigRow;
    }
  | {
      readonly kind: "upsert";
      readonly config: CustomConnectorOAuthConfig;
      readonly clientSecret: string | null;
    };

interface ValueMarker {
  readonly connectorId: string;
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}

export class CustomConnectorRuntimePrefixError extends Error {
  constructor(connectorName: string | undefined) {
    super(
      connectorName
        ? `Custom connector "${connectorName}" has an invalid configured hostname`
        : "Custom connector has an invalid configured hostname",
    );
    this.name = "CustomConnectorRuntimePrefixError";
  }
}

export type CustomConnectorStoredValueRow = CustomConnectorStoredValue;

type FeatureSwitchContextArg = Parameters<typeof encryptStoredSecretValue>[1];

function isBadRequest(value: unknown): value is BadRequestResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === 400
  );
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
}

function fieldArray(value: unknown): readonly CustomConnectorField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorField => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly key?: unknown;
      readonly label?: unknown;
      readonly kind?: unknown;
      readonly required?: unknown;
      readonly description?: unknown;
    };
    return (
      typeof candidate.key === "string" &&
      typeof candidate.label === "string" &&
      (candidate.kind === "secret" || candidate.kind === "variable") &&
      typeof candidate.required === "boolean" &&
      (candidate.description === undefined ||
        typeof candidate.description === "string")
    );
  });
}

function headerInjectionArray(
  value: unknown,
): readonly CustomConnectorHeaderInjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorHeaderInjection => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly name?: unknown;
      readonly valueTemplate?: unknown;
    };
    return (
      typeof candidate.name === "string" &&
      typeof candidate.valueTemplate === "string"
    );
  });
}

function queryInjectionArray(
  value: unknown,
): readonly CustomConnectorQueryInjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CustomConnectorQueryInjection => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const candidate = item as {
      readonly name?: unknown;
      readonly valueTemplate?: unknown;
    };
    return (
      typeof candidate.name === "string" &&
      typeof candidate.valueTemplate === "string"
    );
  });
}

type PersistedHttpDefinitionRow = CustomConnectorConnectionDefinitionRow & {
  readonly mcpEndpoint: null;
  readonly mcpTransport: null;
};

type PersistedMcpDefinitionRow = CustomConnectorConnectionDefinitionRow & {
  readonly mcpEndpoint: string;
  readonly mcpTransport: "streamable-http";
  readonly permissionBundleRef: null;
};

function hasHttpDiscriminator(
  row: CustomConnectorConnectionDefinitionRow,
): row is CustomConnectorConnectionDefinitionRow & {
  readonly mcpEndpoint: null;
  readonly mcpTransport: null;
} {
  return row.mcpEndpoint === null && row.mcpTransport === null;
}

function isValidPersistedHttpDefinition(
  row: CustomConnectorConnectionDefinitionRow & {
    readonly mcpEndpoint: null;
    readonly mcpTransport: null;
  },
  prefixTemplates: readonly string[],
  fields: readonly CustomConnectorField[],
  headerInjections: readonly CustomConnectorHeaderInjection[],
  queryInjections: readonly CustomConnectorQueryInjection[],
): row is PersistedHttpDefinitionRow {
  return (
    prefixTemplates.length > 0 &&
    (row.authMode === "none"
      ? fields.every((field) => {
          return field.kind === "variable";
        }) &&
        headerInjections.length === 0 &&
        queryInjections.length === 0
      : (row.authMode === "manual" || row.authMode === "oauth") &&
        (headerInjections.length > 0 || queryInjections.length > 0))
  );
}

function isValidPersistedMcpDefinition(
  row: CustomConnectorConnectionDefinitionRow,
  prefixTemplates: readonly string[],
  fields: readonly CustomConnectorField[],
  headerInjections: readonly CustomConnectorHeaderInjection[],
  queryInjections: readonly CustomConnectorQueryInjection[],
): row is PersistedMcpDefinitionRow {
  return (
    row.mcpEndpoint !== null &&
    row.mcpEndpoint.trim().length > 0 &&
    row.mcpTransport === "streamable-http" &&
    prefixTemplates.length === 0 &&
    (row.authMode === "none" || row.authMode === "automatic"
      ? fields.length === 0 &&
        headerInjections.length === 0 &&
        queryInjections.length === 0
      : (row.authMode === "manual" || row.authMode === "oauth") &&
        (headerInjections.length > 0 || queryInjections.length > 0)) &&
    row.permissionBundleRef === null
  );
}

export function normaliseCustomConnectorRow<
  OAuthConfig extends CustomConnectorOAuthAdapter =
    CustomConnectorOAuthConfigRow,
>(
  row: CustomConnectorDefinitionRow,
  oauthConfig: OAuthConfig | null = null,
): CustomConnectorRow<OAuthConfig> {
  return {
    ...normaliseCustomConnectorConnectionDefinition(row, oauthConfig),
    enabled: row.enabled,
    skillMarkdown: row.skillMarkdown,
    skillStorageVersionId: row.skillStorageVersionId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function normaliseCustomConnectorConnectionDefinition<
  OAuthConfig extends CustomConnectorOAuthAdapter,
>(
  row: CustomConnectorConnectionDefinitionRow,
  oauthConfig: OAuthConfig | null,
) {
  const prefixTemplates = stringArray(row.prefixTemplates);
  const storedFields = fieldArray(row.fields);
  const storedHeaderInjections = headerInjectionArray(row.headerInjections);
  const queryInjections = queryInjectionArray(row.queryInjections);
  const isHttp = hasHttpDiscriminator(row);
  if (
    (row.authMode === "manual" || row.authMode === "none") &&
    oauthConfig !== null
  ) {
    throw new Error("Invalid persisted non-OAuth Custom Connector config");
  }
  if (row.authMode === "automatic" && (isHttp || oauthConfig !== null)) {
    throw new Error("Invalid persisted Automatic Custom Connector config");
  }
  if (row.authMode === "oauth" && oauthConfig === null) {
    throw new Error("Invalid persisted Custom OAuth app configuration");
  }
  const shared = {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    displayName: row.displayName,
    fields: storedFields,
    headerInjections: storedHeaderInjections,
    queryInjections,
    authMode: row.authMode,
    oauthConfig,
    storageVersion: row.storageVersion,
  };

  if (isHttp) {
    if (
      !isValidPersistedHttpDefinition(
        row,
        prefixTemplates,
        storedFields,
        storedHeaderInjections,
        queryInjections,
      )
    ) {
      throw new Error("Invalid persisted HTTP Custom Connector definition");
    }
    return {
      ...shared,
      kind: "http" as const,
      prefixTemplates,
      permissionBundleRef: row.permissionBundleRef,
    };
  }

  if (
    !isValidPersistedMcpDefinition(
      row,
      prefixTemplates,
      storedFields,
      storedHeaderInjections,
      queryInjections,
    )
  ) {
    throw new Error("Invalid persisted MCP Custom Connector definition");
  }
  return {
    ...shared,
    kind: "mcp" as const,
    endpoint: row.mcpEndpoint,
    transport: row.mcpTransport,
    permissionBundleRef: null,
  };
}

function oauthConfigsEqual(
  left: CustomConnectorOAuthConfigRow | null,
  right: CustomConnectorOAuthConfigRow | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.providerAdapter === right.providerAdapter &&
    left.clientId === right.clientId &&
    left.encryptedClientSecret === right.encryptedClientSecret &&
    left.authorizationUrl === right.authorizationUrl &&
    left.tokenUrl === right.tokenUrl &&
    left.tokenEndpointAuthMethod === right.tokenEndpointAuthMethod &&
    left.pkceMethod === right.pkceMethod &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => {
      return scope === right.scopes[index];
    }) &&
    JSON.stringify(left.authorizationParams) ===
      JSON.stringify(right.authorizationParams)
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function grantConfigurationChanged(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly nextOAuthConfig: CustomConnectorOAuthConfigRow | null;
}): boolean {
  const protocolConfigurationChanged =
    args.existing.kind !== args.definition.kind ||
    (args.existing.kind === "http" && args.definition.kind === "http"
      ? !jsonValuesEqual(
          args.existing.prefixTemplates,
          args.definition.prefixTemplates,
        ) ||
        args.existing.permissionBundleRef !==
          args.definition.permissionBundleRef
      : args.existing.kind === "mcp" && args.definition.kind === "mcp"
        ? args.existing.endpoint !== args.definition.endpoint ||
          args.existing.transport !== args.definition.transport
        : true);
  return (
    protocolConfigurationChanged ||
    args.existing.authMode !== args.definition.authMode ||
    !jsonValuesEqual(args.existing.fields, args.definition.fields) ||
    !jsonValuesEqual(
      args.existing.headerInjections,
      args.definition.headerInjections,
    ) ||
    !jsonValuesEqual(
      args.existing.queryInjections,
      args.definition.queryInjections,
    ) ||
    !oauthConfigsEqual(args.existing.oauthConfig, args.nextOAuthConfig)
  );
}

function credentialFieldsEqual(
  left: readonly CustomConnectorField[],
  right: readonly CustomConnectorField[],
): boolean {
  const comparable = (fields: readonly CustomConnectorField[]) => {
    return fields
      .map((field) => {
        return {
          key: field.key,
          kind: field.kind,
          required: field.required,
        };
      })
      .sort((a, b) => {
        return a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind);
      });
  };
  return jsonValuesEqual(comparable(left), comparable(right));
}

function credentialContractChanged(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly nextOAuthConfig: CustomConnectorOAuthConfigRow | null;
}): boolean {
  const automaticMcpEndpointChanged =
    args.existing.kind === "mcp" &&
    args.definition.kind === "mcp" &&
    args.existing.authMode === "automatic" &&
    args.definition.authMode === "automatic" &&
    args.existing.endpoint !== args.definition.endpoint;
  return (
    automaticMcpEndpointChanged ||
    args.existing.authMode !== args.definition.authMode ||
    !credentialFieldsEqual(args.existing.fields, args.definition.fields) ||
    !oauthConfigsEqual(args.existing.oauthConfig, args.nextOAuthConfig)
  );
}

function resolveUpdatedStorageVersion(args: {
  readonly current: number;
  readonly requested: number | undefined;
  readonly contractChanged: boolean;
}): number | BadRequestResponse {
  if (args.requested === undefined) {
    return args.contractChanged ? args.current + 1 : args.current;
  }
  if (args.requested < args.current) {
    return badRequestMessage("Storage version cannot decrease");
  }
  if (args.contractChanged && args.requested === args.current) {
    return badRequestMessage(
      "Storage version must increase when the credential contract changes",
    );
  }
  return args.requested;
}

function serialiseOAuthConfig(
  config: CustomConnectorOAuthReadConfig,
): CustomConnectorOAuthConfig {
  return {
    providerAdapter: config.providerAdapter,
    clientId: config.clientId,
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    pkceMethod: config.pkceMethod,
    scopes: [...config.scopes],
    authorizationParams: { ...config.authorizationParams },
  };
}

export function customConnectorValueMarkerKey(marker: {
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}): string {
  return `${marker.kind}:${marker.key}`;
}

function configuredValueMarkerKeys(
  markers: readonly {
    readonly kind: CustomConnectorFieldKind;
    readonly key: string;
  }[],
): readonly string[] {
  return [
    ...new Set(
      markers.map((marker) => {
        return customConnectorValueMarkerKey(marker);
      }),
    ),
  ].sort();
}

function configuredFieldKeys(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly markers: readonly ValueMarker[];
}): readonly string[] {
  const configured = new Set(configuredValueMarkerKeys(args.markers));
  return args.fields
    .filter((field) => {
      return configured.has(customConnectorValueMarkerKey(field));
    })
    .map((field) => {
      return field.key;
    })
    .sort();
}

export function customConnectorMissingRequiredFieldKeys(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly markers: readonly {
    readonly kind: CustomConnectorFieldKind;
    readonly key: string;
  }[];
}): readonly string[] {
  const configured = new Set(configuredValueMarkerKeys(args.markers));
  return args.fields
    .filter((field) => {
      return (
        field.required && !configured.has(customConnectorValueMarkerKey(field))
      );
    })
    .map((field) => {
      return field.key;
    });
}

export function effectivePermissionBundleRef(
  row: Pick<
    CustomConnectorHttpRow<CustomConnectorOAuthAdapter>,
    | "slug"
    | "authMode"
    | "oauthConfig"
    | "prefixTemplates"
    | "permissionBundleRef"
  >,
): CustomConnectorPermissionBundleRef | null {
  return effectiveCustomConnectorPermissionBundleRef({
    slug: row.slug,
    authMode: row.authMode,
    oauthProviderAdapter: row.oauthConfig?.providerAdapter ?? null,
    prefixTemplates: row.prefixTemplates,
    permissionBundleRef: row.permissionBundleRef,
  });
}

export function customConnectorIsConnected(args: {
  readonly row: Pick<
    CustomConnectorRow,
    "authMode" | "fields" | "headerInjections" | "queryInjections"
  >;
  readonly connectedAccountId: string | null;
  readonly missingRequiredFields: readonly string[];
}): boolean {
  const validManualAuth =
    args.row.authMode !== "manual" ||
    customConnectorManualAuthReferencesMemberField(args.row);
  return (
    args.connectedAccountId !== null &&
    validManualAuth &&
    args.missingRequiredFields.length === 0
  );
}

export function serialiseCustomConnector(args: {
  readonly row: CustomConnectorRow<CustomConnectorOAuthReadConfig>;
  readonly managedStatus?: {
    readonly valueMarkers: readonly CustomConnectorCredentialValueMarker[];
    readonly connectedAccountId: string | null;
    readonly connectedAccountUpdatedAt?: Date | null;
  };
}): CustomConnectorResponse {
  const auth = (() => {
    if (args.row.authMode === "none") {
      return { authMode: "none" as const };
    }
    if (args.row.authMode === "manual") {
      return { authMode: "manual" as const };
    }
    if (args.row.authMode === "automatic") {
      return { authMode: "automatic" as const };
    }
    if (args.row.authMode === "oauth" && args.row.oauthConfig) {
      const oauthConfig = serialiseOAuthConfig(args.row.oauthConfig);
      if (oauthConfig.providerAdapter === "feishu") {
        const managedStatus = args.managedStatus;
        if (!managedStatus) {
          throw new Error(
            "Managed connector serialization requires account status",
          );
        }
        const connectorMarkers = managedStatus.valueMarkers.filter((marker) => {
          return (
            marker.connectorId === args.row.id &&
            marker.authMode === args.row.authMode &&
            marker.storageVersion === args.row.storageVersion
          );
        });
        const missingRequiredFields = customConnectorMissingRequiredFieldKeys({
          fields: args.row.fields,
          markers: connectorMarkers,
        });
        const configured = configuredFieldKeys({
          fields: args.row.fields,
          markers: connectorMarkers,
        });
        const connected = customConnectorIsConnected({
          row: args.row,
          connectedAccountId: managedStatus.connectedAccountId,
          missingRequiredFields,
        });
        const responseMissingRequiredFields = [
          ...missingRequiredFields,
          ...(managedStatus.connectedAccountId === null ? ["oauth"] : []),
        ];
        return {
          authMode: "oauth" as const,
          oauthConfig: { ...oauthConfig, providerAdapter: "feishu" as const },
          connected,
          ...(connected && managedStatus.connectedAccountId
            ? {
                connectedAccountId: managedStatus.connectedAccountId,
                ...(managedStatus.connectedAccountUpdatedAt
                  ? {
                      connectedAccountUpdatedAt:
                        managedStatus.connectedAccountUpdatedAt.toISOString(),
                    }
                  : {}),
              }
            : {}),
          missingRequiredFields: [...responseMissingRequiredFields],
          configuredFieldKeys: [...configured],
        };
      }
      return {
        authMode: "oauth" as const,
        oauthConfig: { ...oauthConfig, providerAdapter: "standard" as const },
      };
    }
    throw new Error("Invalid normalized Custom Connector OAuth setup");
  })();
  const common = {
    id: args.row.id,
    slug: args.row.slug,
    displayName: args.row.displayName,
    fields: [...args.row.fields],
    headerInjections: [...args.row.headerInjections],
    queryInjections: [...args.row.queryInjections],
    skillMarkdown: args.row.skillMarkdown,
    storageVersion: args.row.storageVersion,
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
  };

  if (args.row.kind === "mcp") {
    return {
      ...common,
      ...auth,
      kind: "mcp",
      endpoint: args.row.endpoint,
      transport: args.row.transport,
      prefixTemplates: [],
      permissionBundleRef: null,
    } satisfies CustomConnectorMcpResponse;
  }

  if (auth.authMode === "automatic") {
    throw new Error("HTTP Custom Connectors cannot use Automatic auth");
  }

  return {
    ...common,
    ...auth,
    kind: "http",
    prefixTemplates: [...args.row.prefixTemplates],
    permissionBundleRef: effectivePermissionBundleRef(args.row),
  } satisfies CustomConnectorHttpResponse;
}

function validateDisplayName(raw: string): string | BadRequestResponse {
  const displayName = raw.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    return badRequestMessage(
      "Display name must be between 1 and 128 characters",
    );
  }
  return displayName;
}

function validateOptionalSlug(
  raw: string | undefined,
): string | undefined | BadRequestResponse {
  const slug = raw?.trim();
  if (slug === undefined || slug.length === 0) {
    return undefined;
  }
  if (!SLUG_REGEX.test(slug)) {
    return badRequestMessage(
      "Slug must start with _, be 3-64 chars, and use lowercase alphanumeric characters or internal hyphens",
    );
  }
  return slug;
}

function declaredFieldsByNamespace(fields: readonly CustomConnectorField[]) {
  return {
    secrets: new Set(
      fields
        .filter((field) => {
          return field.kind === "secret";
        })
        .map((field) => {
          return field.key;
        }),
    ),
    variables: new Set(
      fields
        .filter((field) => {
          return field.kind === "variable";
        })
        .map((field) => {
          return field.key;
        }),
    ),
  };
}

function extractTemplateReferences(template: string): readonly {
  readonly namespace: "secrets" | "variables" | "oauth";
  readonly key: string;
}[] {
  return [...template.matchAll(TEMPLATE_REFERENCE_REGEX)].map((match) => {
    const namespace = match[1];
    if (
      namespace !== "secrets" &&
      namespace !== "variables" &&
      namespace !== "oauth"
    ) {
      throw new Error("Invalid custom connector template namespace");
    }
    return {
      namespace,
      key: match[2]!,
    };
  });
}

export function customConnectorManualAuthReferencesMemberField(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
}): boolean {
  const declared = declaredFieldsByNamespace(args.fields);
  return [...args.headerInjections, ...args.queryInjections].some(
    (injection) => {
      return extractTemplateReferences(injection.valueTemplate).some(
        (reference) => {
          const fields =
            reference.namespace === "secrets"
              ? declared.secrets
              : reference.namespace === "variables"
                ? declared.variables
                : undefined;
          return fields?.has(reference.key) ?? false;
        },
      );
    },
  );
}

export function customConnectorPrefixTemplateVariableKeys(
  prefixTemplates: readonly string[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const template of prefixTemplates) {
    for (const ref of extractTemplateReferences(template)) {
      if (ref.namespace === "variables") {
        keys.add(ref.key);
      }
    }
  }
  return keys;
}

function isSafeHostTemplateVariableValue(value: string): boolean {
  return (
    value.length > 0 &&
    !HOST_TEMPLATE_VALUE_UNSAFE_REGEX.test(value) &&
    !hasRawWhitespaceOrControlCharacter(value)
  );
}

function hasRawWhitespaceOrControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function validateTemplateReferences(args: {
  readonly template: string;
  readonly fields: readonly CustomConnectorField[];
  readonly allowSecrets: boolean;
  readonly allowOAuth: boolean;
  readonly context: string;
}): BadRequestResponse | null {
  const declared = declaredFieldsByNamespace(args.fields);
  if (
    TEMPLATE_EXPRESSION_REGEX.test(
      args.template.replaceAll(TEMPLATE_REFERENCE_REGEX, ""),
    )
  ) {
    return badRequestMessage(
      `${args.context} uses unsupported template placeholder`,
    );
  }
  for (const ref of extractTemplateReferences(args.template)) {
    if (ref.namespace === "secrets" && !args.allowSecrets) {
      return badRequestMessage(`${args.context} must not reference secrets`);
    }
    if (ref.namespace === "oauth") {
      if (
        !args.allowOAuth ||
        ref.key !== CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
      ) {
        return badRequestMessage(
          `${args.context} uses unsupported oauth.${ref.key} placeholder`,
        );
      }
      continue;
    }
    const allowed =
      ref.namespace === "secrets" ? declared.secrets : declared.variables;
    if (!allowed.has(ref.key)) {
      return badRequestMessage(
        `${args.context} references undeclared ${ref.namespace}.${ref.key}`,
      );
    }
  }
  return null;
}

function templateWithPlaceholders(template: string): string {
  return template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    TEMPLATE_PLACEHOLDER_VALUE,
  );
}

function customConnectorPrefixTemplateIdentity(raw: string): string {
  const trimmed = raw.trim();
  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const canonicalPrefix = canonicalizeFirewallBaseUrl(
    expandHostWildcardsInBaseUrl(templateWithPlaceholders(normalized)),
    "custom connector",
  );
  const schemeEnd = canonicalPrefix.indexOf("://");
  const normalizedSchemePrefix =
    canonicalPrefix.slice(0, schemeEnd).toLowerCase() +
    canonicalPrefix.slice(schemeEnd);
  const references = extractTemplateReferences(normalized).map((reference) => {
    return `${reference.namespace}.${reference.key}`;
  });
  return JSON.stringify([normalizedSchemePrefix, references]);
}

function prefixContainsPathVariable(raw: string): boolean {
  const schemePrefix = /^https?:\/\//i.exec(raw);
  if (!schemePrefix) {
    return false;
  }
  const afterScheme = raw.slice(schemePrefix[0].length);
  const firstPathSlash = afterScheme.indexOf("/");
  if (firstPathSlash === -1) {
    return false;
  }
  return VARIABLE_REFERENCE_REGEX.test(afterScheme.slice(firstPathSlash));
}

function validateAndNormalizePrefixTemplate(args: {
  readonly raw: string;
  readonly fields: readonly CustomConnectorField[];
}): string | BadRequestResponse {
  const trimmed = args.raw.trim();
  if (trimmed.length === 0) {
    return badRequestMessage("Prefix template must not be empty");
  }
  if (prefixContainsPathVariable(trimmed)) {
    return badRequestMessage(
      "Prefix template variables may only appear in the URL host",
    );
  }
  const templateError = validateTemplateReferences({
    template: trimmed,
    fields: args.fields,
    allowSecrets: false,
    allowOAuth: false,
    context: "Prefix template",
  });
  if (templateError) {
    return templateError;
  }

  const normalised = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const validationBase = expandHostWildcardsInBaseUrl(
    templateWithPlaceholders(normalised),
  );
  const validation = safeSync(() => {
    return canonicalizeFirewallBaseUrl(validationBase, "custom connector");
  });
  if ("error" in validation) {
    const message =
      validation.error instanceof Error
        ? validation.error.message.replace(validationBase, normalised)
        : "not a valid URL";
    return badRequestMessage(`Invalid prefix URL: ${args.raw}: ${message}`);
  }
  return trimmed;
}

function validateAndNormalizeMcpEndpoint(
  raw: string,
): string | BadRequestResponse {
  const validation = parseCustomMcpEndpoint(raw);
  if ("error" in validation) {
    return badRequestMessage(
      "MCP endpoint must be a valid public HTTPS URL without credentials, fragments, or templates",
    );
  }
  return validation.ok.endpoint;
}

function validateFields(
  raw: readonly CustomConnectorField[],
): readonly CustomConnectorField[] | BadRequestResponse {
  const seen = new Set<string>();
  const fields: CustomConnectorField[] = [];
  for (const field of raw) {
    const key = field.key.trim();
    if (!FIELD_KEY_REGEX.test(key)) {
      return badRequestMessage(
        "Field keys must start with a lowercase letter and contain only lowercase letters, digits, and underscores",
      );
    }
    const marker = customConnectorValueMarkerKey({ kind: field.kind, key });
    if (seen.has(marker) || seen.has(key)) {
      return badRequestMessage(`Duplicate field key: ${key}`);
    }
    seen.add(marker);
    seen.add(key);
    const label = field.label.trim();
    if (label.length === 0 || label.length > 128) {
      return badRequestMessage(`Field label is invalid for ${key}`);
    }
    const description = field.description?.trim();
    fields.push({
      key,
      label,
      kind: field.kind,
      required: field.required,
      ...(description ? { description } : {}),
    });
  }
  return fields;
}

function validateHeaderName(raw: string): string | BadRequestResponse {
  const headerName = raw.trim();
  if (!HEADER_NAME_REGEX.test(headerName)) {
    return badRequestMessage(
      "Header name must start with a letter and contain only letters, digits, and hyphens",
    );
  }
  return headerName;
}

function validateHeaderInjections(args: {
  readonly raw: readonly CustomConnectorHeaderInjection[];
  readonly fields: readonly CustomConnectorField[];
  readonly authMode: CustomConnectorAuthMode;
  readonly connectorKind: CustomConnectorRow["kind"];
}): readonly CustomConnectorHeaderInjection[] | BadRequestResponse {
  const seen = new Set<string>();
  const headers: CustomConnectorHeaderInjection[] = [];
  for (const injection of args.raw) {
    const name = validateHeaderName(injection.name);
    if (isBadRequest(name)) {
      return name;
    }
    const normalisedName = name.toLowerCase();
    if (
      args.connectorKind === "mcp" &&
      (normalisedName.startsWith("mcp-") ||
        MCP_PROTECTED_HEADER_NAMES.includes(normalisedName))
    ) {
      return badRequestMessage(
        `MCP custom connector cannot inject protected header: ${name}`,
      );
    }
    if (seen.has(normalisedName)) {
      return badRequestMessage(`Duplicate header injection: ${name}`);
    }
    seen.add(normalisedName);
    const templateError = validateTemplateReferences({
      template: injection.valueTemplate,
      fields: args.fields,
      allowSecrets: args.authMode === "manual",
      allowOAuth: args.authMode === "oauth",
      context: `Header ${name}`,
    });
    if (templateError) {
      return templateError;
    }
    headers.push({ name, valueTemplate: injection.valueTemplate });
  }
  return headers;
}

function validateQueryInjections(args: {
  readonly raw: readonly CustomConnectorQueryInjection[];
  readonly fields: readonly CustomConnectorField[];
  readonly authMode: CustomConnectorAuthMode;
}): readonly CustomConnectorQueryInjection[] | BadRequestResponse {
  const seen = new Set<string>();
  const queries: CustomConnectorQueryInjection[] = [];
  for (const injection of args.raw) {
    const name = injection.name.trim();
    if (name.length === 0 || name.length > 128) {
      return badRequestMessage("Query injection names must be 1-128 chars");
    }
    if (seen.has(name)) {
      return badRequestMessage(`Duplicate query injection: ${name}`);
    }
    seen.add(name);
    const templateError = validateTemplateReferences({
      template: injection.valueTemplate,
      fields: args.fields,
      allowSecrets: args.authMode === "manual",
      allowOAuth: args.authMode === "oauth",
      context: `Query ${name}`,
    });
    if (templateError) {
      return templateError;
    }
    queries.push({ name, valueTemplate: injection.valueTemplate });
  }
  return queries;
}

function validateOAuth2Endpoint(
  raw: string,
  label: string,
): URL | BadRequestResponse {
  if (!URL.canParse(raw)) {
    return badRequestMessage(`${label} must be a valid URL`);
  }
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    return badRequestMessage(`${label} must use https://`);
  }
  if (url.username || url.password || url.hash) {
    return badRequestMessage(
      `${label} must not contain credentials or a fragment`,
    );
  }
  return url;
}

function validateOAuthConfigInput(
  config: CustomConnectorOAuthConfigInput,
): CustomConnectorOAuthConfigInput | BadRequestResponse {
  if (config.providerAdapter !== "standard") {
    return badRequestMessage(
      "Only the standard OAuth provider adapter is supported",
    );
  }
  const authorizationUrl = validateOAuth2Endpoint(
    config.authorizationUrl.trim(),
    "OAuth authorization URL",
  );
  if (isBadRequest(authorizationUrl)) {
    return authorizationUrl;
  }
  const tokenUrl = validateOAuth2Endpoint(
    config.tokenUrl.trim(),
    "OAuth token URL",
  );
  if (isBadRequest(tokenUrl)) {
    return tokenUrl;
  }
  const scopes = config.scopes.map((scope) => {
    return scope.trim();
  });
  if (
    scopes.some((scope) => {
      return scope.length === 0 || /\s/u.test(scope);
    })
  ) {
    return badRequestMessage(
      "OAuth scopes must be non-empty and must not contain whitespace",
    );
  }
  if (new Set(scopes).size !== scopes.length) {
    return badRequestMessage("OAuth scopes must be unique");
  }
  const clientId = config.clientId.trim();
  if (clientId.length === 0 || clientId.length > 255) {
    return badRequestMessage("OAuth client ID is invalid");
  }
  if (
    config.tokenEndpointAuthMethod === "client_secret_basic" &&
    clientId.includes(":")
  ) {
    return badRequestMessage(
      "OAuth client ID must not contain a colon when using HTTP Basic authentication",
    );
  }
  const clientSecret = config.clientSecret;
  if (
    clientSecret !== undefined &&
    (clientSecret.trim().length === 0 || clientSecret.length > 4096)
  ) {
    return badRequestMessage("OAuth client secret is invalid");
  }
  const authorizationParams: Record<string, string> = {};
  const allowedAuthorizationParamNames = new Set([
    "resource",
    "audience",
    "access_type",
    "prompt",
  ]);
  for (const [name, rawValue] of Object.entries(
    config.authorizationParams,
  ).sort(([left], [right]) => {
    return left.localeCompare(right);
  })) {
    if (!allowedAuthorizationParamNames.has(name)) {
      return badRequestMessage(
        `OAuth authorization parameter is not supported: ${name}`,
      );
    }
    const value = rawValue.trim();
    if (value.length === 0 || value.length > 2048) {
      return badRequestMessage(
        `OAuth authorization parameter is invalid: ${name}`,
      );
    }
    authorizationParams[name] = value;
  }
  return {
    providerAdapter: config.providerAdapter,
    clientId,
    authorizationUrl: authorizationUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    pkceMethod: config.pkceMethod,
    scopes,
    authorizationParams,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

function validateOAuthConfigUpdate(args: {
  readonly authMode: CustomConnectorAuthMode;
  readonly input: CustomConnectorOAuthConfigInput | undefined;
  readonly existingConfig: CustomConnectorOAuthConfigRow | null;
}): ValidatedOAuthConfigUpdate | BadRequestResponse {
  if (
    args.authMode === "manual" ||
    args.authMode === "none" ||
    args.authMode === "automatic"
  ) {
    if (args.input !== undefined) {
      return badRequestMessage(
        args.authMode === "automatic"
          ? "Automatic authentication does not accept a static OAuth configuration"
          : "OAuth configuration requires OAuth authentication mode",
      );
    }
    return { kind: "none" };
  }
  if (args.input === undefined) {
    return args.existingConfig
      ? { kind: "preserve", config: args.existingConfig }
      : badRequestMessage("OAuth configuration is required");
  }
  const config = validateOAuthConfigInput(args.input);
  if (isBadRequest(config)) {
    return config;
  }
  if (config.clientSecret === undefined && !args.existingConfig) {
    return badRequestMessage("OAuth client secret is required");
  }
  const { clientSecret, ...publicConfig } = config;
  return {
    kind: "upsert",
    config: publicConfig,
    clientSecret: clientSecret ?? null,
  };
}

function validateAuthInjectionReferences(args: {
  readonly authMode: CustomConnectorAuthMode;
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
}): BadRequestResponse | null {
  const hasAuthInjections =
    args.headerInjections.length > 0 || args.queryInjections.length > 0;
  if (
    (args.authMode === "none" || args.authMode === "automatic") &&
    hasAuthInjections
  ) {
    return badRequestMessage(
      `${args.authMode === "none" ? "No-auth" : "Automatic"} custom connectors cannot include authentication injections`,
    );
  }
  if (
    (args.authMode === "manual" || args.authMode === "oauth") &&
    !hasAuthInjections
  ) {
    return badRequestMessage(
      "At least one header or query injection is required",
    );
  }
  if (
    args.authMode === "manual" &&
    !customConnectorManualAuthReferencesMemberField(args)
  ) {
    return badRequestMessage(
      "Manual custom connector injections must reference a declared secret or variable field",
    );
  }
  if (
    args.authMode === "oauth" &&
    ![...args.headerInjections, ...args.queryInjections].some((injection) => {
      return extractTemplateReferences(injection.valueTemplate).some(
        (reference) => {
          return (
            reference.namespace === "oauth" &&
            reference.key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
          );
        },
      );
    })
  ) {
    return badRequestMessage(
      `OAuth custom connector injections must reference {{${CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_REFERENCE}}}`,
    );
  }
  return null;
}

function validateDefinitionAuth(
  input: DefinitionInput,
  fields: readonly CustomConnectorField[],
): CustomConnectorAuthMode | BadRequestResponse {
  const authMode = input.authMode ?? "manual";
  if (authMode === "oauth" && fields.length > 0) {
    return badRequestMessage(
      "OAuth custom connectors cannot declare fields; remove all fields and their template references",
    );
  }
  const issue = customConnectorDefinitionFieldCompatibility({
    authMode,
    kind: input.kind ?? "http",
    fields,
  });
  if (issue === "automatic-requires-mcp") {
    return badRequestMessage(
      "Automatic authentication is available only for MCP Streamable HTTP connectors",
    );
  }
  if (issue === "secret-fields-not-supported") {
    return badRequestMessage(
      `${authMode === "none" ? "No-auth" : authMode === "automatic" ? "Automatic" : "OAuth"} custom connector fields must be variables`,
    );
  }
  if (issue === "mcp-fields-not-supported") {
    return badRequestMessage(
      `${authMode === "none" ? "No-auth" : "Automatic"} MCP connectors cannot include fields`,
    );
  }
  return authMode;
}

function validateDefinition(
  input: DefinitionInput,
): ValidatedDefinition | BadRequestResponse {
  const displayName = validateDisplayName(input.displayName);
  if (isBadRequest(displayName)) {
    return displayName;
  }
  const fields = validateFields(input.fields);
  if (isBadRequest(fields)) {
    return fields;
  }
  const authMode = validateDefinitionAuth(input, fields);
  if (isBadRequest(authMode)) {
    return authMode;
  }

  const headerInjections = validateHeaderInjections({
    raw: input.headerInjections,
    fields,
    authMode,
    connectorKind: input.kind,
  });
  if (isBadRequest(headerInjections)) {
    return headerInjections;
  }
  const queryInjections = validateQueryInjections({
    raw: input.queryInjections,
    fields,
    authMode,
  });
  if (isBadRequest(queryInjections)) {
    return queryInjections;
  }
  const authInjectionError = validateAuthInjectionReferences({
    authMode,
    fields,
    headerInjections,
    queryInjections,
  });
  if (authInjectionError) {
    return authInjectionError;
  }
  const slug = validateOptionalSlug(input.slug);
  if (isBadRequest(slug)) {
    return slug;
  }

  const shared = {
    displayName,
    fields,
    headerInjections,
    queryInjections,
    authMode,
    permissionBundleRef: input.permissionBundleRef,
    skillMarkdown: input.skillMarkdown,
    slug,
  };
  if (input.kind === "mcp") {
    const endpoint = validateAndNormalizeMcpEndpoint(input.endpoint);
    if (isBadRequest(endpoint)) {
      return endpoint;
    }
    return {
      ...shared,
      kind: "mcp",
      endpoint,
      transport: input.transport,
      permissionBundleRef: null,
    };
  }

  const prefixTemplates: string[] = [];
  if (input.prefixTemplates.length === 0) {
    return badRequestMessage("At least one prefix template is required");
  }
  for (const raw of input.prefixTemplates) {
    const normalized = validateAndNormalizePrefixTemplate({ raw, fields });
    if (isBadRequest(normalized)) {
      return normalized;
    }
    prefixTemplates.push(normalized);
  }
  const seenPrefixes = new Set<string>();
  for (const prefix of prefixTemplates) {
    const identity = customConnectorPrefixTemplateIdentity(prefix);
    if (seenPrefixes.has(identity)) {
      return badRequestMessage(`Duplicate prefix template: ${prefix}`);
    }
    seenPrefixes.add(identity);
  }
  return {
    ...shared,
    kind: "http",
    prefixTemplates,
  };
}

const validatePermissionBundleRef$ = command(
  async (
    { set },
    permissionBundleRef: CustomConnectorPermissionBundleRef | null,
    signal: AbortSignal,
  ): Promise<BadRequestResponse | null> => {
    if (permissionBundleRef === null) {
      return null;
    }
    const catalogDb = set(writeDb$);
    // A bundle reads only its dependency connector's firewall metadata.
    const dependency =
      customConnectorPermissionBundleDependencySlug(permissionBundleRef);
    const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [],
      metadataConnectorSlugs: dependency === null ? [] : [dependency],
    });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      catalogPlan.selection,
      await catalogDb
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    signal.throwIfAborted();
    const bundle = await loadCustomConnectorPermissionBundle({
      catalog: snapshot.serverFirewallMetadata,
      ref: permissionBundleRef,
    });
    signal.throwIfAborted();
    return bundle
      ? null
      : badRequestMessage(
          `Unknown custom connector permission bundle: ${permissionBundleRef}`,
        );
  },
);

function definitionFromCreateInput(
  input: CreateCustomConnectorBody,
): DefinitionInput {
  return input.kind === "mcp"
    ? {
        kind: "mcp",
        displayName: input.displayName,
        endpoint: input.endpoint,
        transport: input.transport,
        fields: input.fields,
        headerInjections: input.headerInjections,
        queryInjections: input.queryInjections,
        authMode: input.authMode,
        permissionBundleRef: null,
        skillMarkdown: input.skillMarkdown ?? null,
        slug: input.slug,
      }
    : {
        kind: "http",
        displayName: input.displayName,
        prefixTemplates: input.prefixTemplates,
        fields: input.fields,
        headerInjections: input.headerInjections,
        queryInjections: input.queryInjections,
        authMode: input.authMode,
        permissionBundleRef: input.permissionBundleRef ?? null,
        skillMarkdown: input.skillMarkdown ?? null,
        slug: input.slug,
      };
}

function definitionFromUpdateInput(
  input: UpdateCustomConnectorBody,
  existing?: CustomConnectorRow,
): DefinitionInput {
  const authMode = input.authMode ?? existing?.authMode ?? "manual";
  const skillMarkdown =
    input.skillMarkdown !== undefined
      ? input.skillMarkdown
      : (existing?.skillMarkdown ?? null);
  if (input.kind === "mcp") {
    return {
      kind: "mcp",
      displayName: input.displayName,
      endpoint: input.endpoint,
      transport: input.transport,
      fields: input.fields,
      headerInjections: input.headerInjections,
      queryInjections: input.queryInjections,
      authMode,
      permissionBundleRef: null,
      skillMarkdown,
    };
  }
  return {
    kind: "http",
    displayName: input.displayName,
    prefixTemplates: input.prefixTemplates,
    fields: input.fields,
    headerInjections: input.headerInjections,
    queryInjections: input.queryInjections,
    authMode,
    permissionBundleRef:
      input.permissionBundleRef !== undefined
        ? input.permissionBundleRef
        : (existing?.permissionBundleRef ?? null),
    skillMarkdown,
  };
}

function protocolColumns(definition: ValidatedDefinition): {
  readonly prefixTemplates: string[];
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
  readonly mcpEndpoint: string | null;
  readonly mcpTransport: CustomConnectorMcpTransport | null;
} {
  if (definition.kind === "mcp") {
    return {
      prefixTemplates: [],
      permissionBundleRef: null,
      mcpEndpoint: definition.endpoint,
      mcpTransport: definition.transport,
    };
  }
  return {
    prefixTemplates: [...definition.prefixTemplates],
    permissionBundleRef: definition.permissionBundleRef,
    mcpEndpoint: null,
    mcpTransport: null,
  };
}

function hostSlugFromCanonicalUrl(canonicalUrl: string): string {
  const authorityStart = canonicalUrl.indexOf("://") + 3;
  const authorityAndSuffix = canonicalUrl.slice(authorityStart);
  const authorityEnd = authorityAndSuffix.search(/[/?#]/u);
  const host = (
    authorityEnd === -1
      ? authorityAndSuffix
      : authorityAndSuffix.slice(0, authorityEnd)
  )
    .replace(/\{hostWildcard[0-9]+\}/g, "")
    .toLowerCase();
  return host
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function hostSlugFromPrefixTemplate(prefix: string): string {
  return hostSlugFromCanonicalUrl(
    canonicalizeFirewallBaseUrl(
      expandHostWildcardsInBaseUrl(templateWithPlaceholders(prefix)),
      "custom connector",
    ),
  );
}

function hostSlugFromDefinition(definition: ValidatedDefinition): string {
  if (definition.kind === "mcp") {
    return hostSlugFromCanonicalUrl(definition.endpoint);
  }
  const firstPrefix = definition.prefixTemplates[0];
  if (!firstPrefix) {
    throw new Error("Expected validated HTTP prefix template");
  }
  return hostSlugFromPrefixTemplate(firstPrefix);
}

function randomShortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

type PersistCustomConnectorCreateArgs = {
  readonly connectorId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly slug: string;
  readonly definition: ValidatedDefinition;
  readonly storageVersion: number;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
  readonly encryptedClientSecret: string | null;
  readonly preparedSkill: PreparedServerSideVolume | null;
};

export function customConnectorCreateSource(
  args: Pick<
    PersistCustomConnectorCreateArgs,
    | "connectorId"
    | "orgId"
    | "userId"
    | "slug"
    | "definition"
    | "storageVersion"
    | "preparedSkill"
  >,
) {
  const protocol = protocolColumns(args.definition);
  return {
    id: sql`${sql.param(args.connectorId, orgCustomConnectors.id)}`
      .mapWith(orgCustomConnectors.id)
      .as("id"),
    orgId: sql`${sql.param(args.orgId, orgCustomConnectors.orgId)}`
      .mapWith(orgCustomConnectors.orgId)
      .as("org_id"),
    slug: sql`${sql.param(args.slug, orgCustomConnectors.slug)}`
      .mapWith(orgCustomConnectors.slug)
      .as("slug"),
    displayName:
      sql`${sql.param(args.definition.displayName, orgCustomConnectors.displayName)}`
        .mapWith(orgCustomConnectors.displayName)
        .as("display_name"),
    prefixTemplates:
      sql`${sql.param(protocol.prefixTemplates, orgCustomConnectors.prefixTemplates)}`
        .mapWith(orgCustomConnectors.prefixTemplates)
        .as("prefix_templates"),
    fields:
      sql`${sql.param([...args.definition.fields], orgCustomConnectors.fields)}`
        .mapWith(orgCustomConnectors.fields)
        .as("fields"),
    headerInjections:
      sql`${sql.param([...args.definition.headerInjections], orgCustomConnectors.headerInjections)}`
        .mapWith(orgCustomConnectors.headerInjections)
        .as("header_injections"),
    queryInjections:
      sql`${sql.param([...args.definition.queryInjections], orgCustomConnectors.queryInjections)}`
        .mapWith(orgCustomConnectors.queryInjections)
        .as("query_injections"),
    authMode:
      sql`${sql.param(args.definition.authMode, orgCustomConnectors.authMode)}`
        .mapWith(orgCustomConnectors.authMode)
        .as("auth_mode"),
    enabled: sql`true`.mapWith(orgCustomConnectors.enabled).as("enabled"),
    permissionBundleRef:
      sql`${sql.param(protocol.permissionBundleRef, orgCustomConnectors.permissionBundleRef)}`
        .mapWith(orgCustomConnectors.permissionBundleRef)
        .as("permission_bundle_ref"),
    mcpEndpoint:
      sql`${sql.param(protocol.mcpEndpoint, orgCustomConnectors.mcpEndpoint)}`
        .mapWith(orgCustomConnectors.mcpEndpoint)
        .as("mcp_endpoint"),
    mcpTransport:
      sql`${sql.param(protocol.mcpTransport, orgCustomConnectors.mcpTransport)}`
        .mapWith(orgCustomConnectors.mcpTransport)
        .as("mcp_transport"),
    skillMarkdown:
      sql`${sql.param(args.definition.skillMarkdown, orgCustomConnectors.skillMarkdown)}`
        .mapWith(orgCustomConnectors.skillMarkdown)
        .as("skill_markdown"),
    skillStorageVersionId:
      sql`${sql.param(args.preparedSkill?.version.versionId ?? null, orgCustomConnectors.skillStorageVersionId)}`
        .mapWith(orgCustomConnectors.skillStorageVersionId)
        .as("skill_storage_version_id"),
    storageVersion:
      sql`${sql.param(args.storageVersion, orgCustomConnectors.storageVersion)}`
        .mapWith(orgCustomConnectors.storageVersion)
        .as("storage_version"),
    createdBy: sql`${sql.param(args.userId, orgCustomConnectors.createdBy)}`
      .mapWith(orgCustomConnectors.createdBy)
      .as("created_by"),
    createdAt: sql`now()`
      .mapWith(orgCustomConnectors.createdAt)
      .as("created_at"),
    updatedAt: sql`now()`
      .mapWith(orgCustomConnectors.updatedAt)
      .as("updated_at"),
  };
}

export function customConnectorOAuthCreateSource(
  connectorId: SQL,
  orgId: string,
  config: Extract<
    ValidatedOAuthConfigUpdate,
    { readonly kind: "upsert" }
  >["config"],
  encryptedClientSecret: string,
) {
  return {
    connectorId: connectorId.as("connector_id"),
    orgId: sql`${sql.param(orgId, orgCustomConnectorOauthConfigs.orgId)}`
      .mapWith(orgCustomConnectorOauthConfigs.orgId)
      .as("org_id"),
    providerAdapter:
      sql`${sql.param(config.providerAdapter, orgCustomConnectorOauthConfigs.providerAdapter)}`
        .mapWith(orgCustomConnectorOauthConfigs.providerAdapter)
        .as("provider_adapter"),
    clientId:
      sql`${sql.param(config.clientId, orgCustomConnectorOauthConfigs.clientId)}`
        .mapWith(orgCustomConnectorOauthConfigs.clientId)
        .as("client_id"),
    encryptedClientSecret:
      sql`${sql.param(encryptedClientSecret, orgCustomConnectorOauthConfigs.encryptedClientSecret)}`
        .mapWith(orgCustomConnectorOauthConfigs.encryptedClientSecret)
        .as("encrypted_client_secret"),
    authorizationUrl:
      sql`${sql.param(config.authorizationUrl, orgCustomConnectorOauthConfigs.authorizationUrl)}`
        .mapWith(orgCustomConnectorOauthConfigs.authorizationUrl)
        .as("authorization_url"),
    tokenUrl:
      sql`${sql.param(config.tokenUrl, orgCustomConnectorOauthConfigs.tokenUrl)}`
        .mapWith(orgCustomConnectorOauthConfigs.tokenUrl)
        .as("token_url"),
    tokenEndpointAuthMethod:
      sql`${sql.param(config.tokenEndpointAuthMethod, orgCustomConnectorOauthConfigs.tokenEndpointAuthMethod)}`
        .mapWith(orgCustomConnectorOauthConfigs.tokenEndpointAuthMethod)
        .as("token_endpoint_auth_method"),
    pkceMethod:
      sql`${sql.param(config.pkceMethod, orgCustomConnectorOauthConfigs.pkceMethod)}`
        .mapWith(orgCustomConnectorOauthConfigs.pkceMethod)
        .as("pkce_method"),
    scopes:
      sql`${sql.param(config.scopes, orgCustomConnectorOauthConfigs.scopes)}`
        .mapWith(orgCustomConnectorOauthConfigs.scopes)
        .as("scopes"),
    authorizationParams:
      sql`${sql.param(config.authorizationParams, orgCustomConnectorOauthConfigs.authorizationParams)}`
        .mapWith(orgCustomConnectorOauthConfigs.authorizationParams)
        .as("authorization_params"),
    createdAt: sql`now()`
      .mapWith(orgCustomConnectorOauthConfigs.createdAt)
      .as("created_at"),
    updatedAt: sql`now()`
      .mapWith(orgCustomConnectorOauthConfigs.updatedAt)
      .as("updated_at"),
  };
}

const persistCustomConnectorCreate$ = command(
  async (
    { set },
    args: PersistCustomConnectorCreateArgs,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly row: CustomConnectorDefinitionRow;
        readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
      }
    | BadRequestResponse
  > => {
    const db = set(writeDb$);
    const oauth =
      args.oauthConfigUpdate.kind === "upsert" && args.encryptedClientSecret
        ? {
            config: args.oauthConfigUpdate.config,
            secret: args.encryptedClientSecret,
          }
        : null;
    if ((args.definition.authMode === "oauth") !== (oauth !== null)) {
      throw new Error("custom connector OAuth mode and config do not match");
    }
    const publication = args.preparedSkill
      ? preparedVolumePublicationPlan(args.preparedSkill, nowDate())
      : null;
    const source =
      publication?.published ?? sql`(VALUES (1)) AS connector_create_source`;
    const values = db.select(customConnectorCreateSource(args)).from(source);
    const created = db
      .$with("created_connector")
      .as(db.insert(orgCustomConnectors).select(values).returning());
    const ctes = publication?.ctes ?? [];
    signal.throwIfAborted();
    if (oauth) {
      const config = db.$with("created_oauth_config").as(
        db
          .insert(orgCustomConnectorOauthConfigs)
          .select(
            db
              .select(
                customConnectorOAuthCreateSource(
                  sql`${created.id}`.mapWith(
                    orgCustomConnectorOauthConfigs.connectorId,
                  ),
                  args.orgId,
                  oauth.config,
                  oauth.secret,
                ),
              )
              .from(created),
          )
          .returning(),
      );
      const [result] = await db
        .with(...ctes, created, config)
        .select()
        .from(created)
        .innerJoin(config, eq(config.connectorId, created.id));
      signal.throwIfAborted();
      if (!result) {
        if (args.preparedSkill) {
          throw new StorageVersionIdentityConflictError(
            args.preparedSkill.version.versionId,
          );
        }
        throw new Error("Expected insert to return a row");
      }
      return {
        row: result.created_connector,
        oauthConfig: result.created_oauth_config,
      };
    }
    const [row] = await db
      .with(...ctes, created)
      .select()
      .from(created);
    signal.throwIfAborted();
    if (!row) {
      if (args.preparedSkill) {
        throw new StorageVersionIdentityConflictError(
          args.preparedSkill.version.versionId,
        );
      }
      throw new Error("Expected insert to return a row");
    }
    return { row, oauthConfig: null };
  },
);

export const createCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse> => {
    const canonicalInput = definitionFromCreateInput(args.input);
    const v = validateDefinition(canonicalInput);
    if (isBadRequest(v)) {
      return v;
    }
    const invalidPermissionBundle = await set(
      validatePermissionBundleRef$,
      v.permissionBundleRef,
      signal,
    );
    signal.throwIfAborted();
    if (invalidPermissionBundle) {
      return invalidPermissionBundle;
    }
    const oauthConfigUpdate = validateOAuthConfigUpdate({
      authMode: v.authMode,
      input: args.input.oauthConfig,
      existingConfig: null,
    });
    if (isBadRequest(oauthConfigUpdate)) {
      return oauthConfigUpdate;
    }
    signal.throwIfAborted();

    let encryptedClientSecret: string | null = null;
    if (oauthConfigUpdate.kind === "upsert" && oauthConfigUpdate.clientSecret) {
      const featureContext = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      encryptedClientSecret = await encryptStoredSecretValue(
        oauthConfigUpdate.clientSecret,
        featureContext,
      );
    }
    signal.throwIfAborted();

    const slugHost = hostSlugFromDefinition(v);
    const slug = v.slug ?? `_${slugHost}-${randomShortId()}`;
    const connectorId = randomUUID();
    L.debug("creating custom connector", { orgId: args.orgId, slug });

    const preparedSkill =
      v.skillMarkdown === null
        ? null
        : await set(
            prepareCustomConnectorSkillVolume$,
            {
              orgId: args.orgId,
              connectorId,
              connectorSlug: slug,
              displayName: v.displayName,
              skillMarkdown: v.skillMarkdown,
            },
            signal,
          );
    signal.throwIfAborted();

    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const created = await set(
      persistCustomConnectorCreate$,
      {
        connectorId,
        orgId: args.orgId,
        userId: args.userId,
        slug,
        definition: v,
        storageVersion: args.input.storageVersion ?? 1,
        oauthConfigUpdate,
        encryptedClientSecret,
        preparedSkill,
      },
      signal,
    );
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (isBadRequest(created)) {
      signal.throwIfAborted();
      return created;
    }

    const result = normaliseCustomConnectorRow(
      created.row,
      created.oauthConfig,
    );
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    return result;
  },
);

const loadCustomConnectorForUpdate$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | null> => {
    const db = set(writeDb$);
    const [result] = await db
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return result
      ? normaliseCustomConnectorRow(result.connector, result.oauthConfig)
      : null;
  },
);

function nextOAuthConfigForUpdate(args: {
  readonly connector: CustomConnectorRow;
  readonly orgId: string;
  readonly update: ValidatedOAuthConfigUpdate;
  readonly encryptedClientSecret: string | null;
}): CustomConnectorOAuthConfigRow | null {
  if (args.update.kind === "none") {
    return null;
  }
  if (args.update.kind === "preserve") {
    return args.update.config;
  }
  if (!args.encryptedClientSecret) {
    return null;
  }
  return {
    connectorId: args.connector.id,
    orgId: args.orgId,
    ...args.update.config,
    encryptedClientSecret: args.encryptedClientSecret,
    createdAt: args.connector.oauthConfig?.createdAt ?? nowDate(),
    updatedAt: nowDate(),
  };
}

interface PersistCustomConnectorUpdateArgs {
  readonly orgId: string;
  readonly id: string;
  readonly definition: ValidatedDefinition;
  readonly existing: CustomConnectorRow;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
  readonly encryptedClientSecret: string | null;
  readonly grantConfigurationChanged: boolean;
  readonly storageVersion: number;
  readonly preparedSkill: PreparedServerSideVolume | null;
}

function requireCustomConnectorOAuthConfig(
  authMode: ValidatedDefinition["authMode"],
  config: CustomConnectorOAuthConfigRow | null,
): void {
  if ((authMode === "oauth") !== (config !== null)) {
    throw new Error("custom connector OAuth mode and config do not match");
  }
}

function customConnectorDefinitionUpdateValues(
  args: PersistCustomConnectorUpdateArgs,
  at: Date,
) {
  return {
    displayName: args.definition.displayName,
    ...protocolColumns(args.definition),
    fields: [...args.definition.fields],
    headerInjections: [...args.definition.headerInjections],
    queryInjections: [...args.definition.queryInjections],
    authMode: args.definition.authMode,
    skillMarkdown: args.definition.skillMarkdown,
    skillStorageVersionId: args.preparedSkill?.version.versionId ?? null,
    storageVersion: args.storageVersion,
    updatedAt: at,
  };
}

/** Only a matching definition may publish its prepared skill and OAuth changes. */
function customConnectorUpdatePublicationPlan(
  args: PersistCustomConnectorUpdateArgs,
) {
  const oauth = args.oauthConfigUpdate;
  if (oauth.kind === "upsert" && !args.encryptedClientSecret) {
    throw new Error("Expected encrypted OAuth client secret");
  }
  if ((args.definition.authMode === "oauth") !== (oauth.kind !== "none")) {
    throw new Error("custom connector OAuth mode and config do not match");
  }
  const query = new QueryBuilder();
  const configPresent = exists(
    query
      .select({ id: orgCustomConnectorOauthConfigs.connectorId })
      .from(orgCustomConnectorOauthConfigs)
      .where(
        and(
          eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
          eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
        ),
      ),
  );
  const locked = query.$with("locked_custom_connector").as(
    query
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.storageVersion, args.existing.storageVersion),
          gte(orgCustomConnectors.updatedAt, args.existing.updatedAt),
          lt(
            orgCustomConnectors.updatedAt,
            new Date(args.existing.updatedAt.getTime() + 1),
          ),
          args.oauthConfigUpdate.kind === "preserve"
            ? configPresent
            : undefined,
        ),
      )
      .for("update", { of: orgCustomConnectors })
      .limit(1),
  );
  const publication = args.preparedSkill
    ? preparedVolumePublicationPlan(
        args.preparedSkill,
        nowDate(),
        exists(query.select({ id: locked.id }).from(locked)),
      )
    : null;
  const source = publication?.published ?? locked;
  const ready = exists(query.select({ id: source.id }).from(source));
  return {
    locked,
    ctes: [locked, ...(publication?.ctes ?? [])],
    ready,
    bindings: and(
      eq(customConnectorAccountOauthBindings.customConnectorId, args.id),
      ready,
    ),
    registrations: and(
      eq(orgCustomConnectorDcrRegistrations.customConnectorId, args.id),
      eq(orgCustomConnectorDcrRegistrations.orgId, args.orgId),
      ready,
    ),
  };
}

const failedCustomConnectorUpdate$ = command(
  async (
    { set },
    args: PersistCustomConnectorUpdateArgs,
    signal: AbortSignal,
  ): Promise<BadRequestResponse | null> => {
    const db = set(writeDb$);
    const [current] = await db
      .select({
        id: orgCustomConnectors.id,
        storageVersion: orgCustomConnectors.storageVersion,
        updatedAt: orgCustomConnectors.updatedAt,
      })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return null;
    }
    if (
      args.oauthConfigUpdate.kind === "preserve" &&
      current.storageVersion === args.existing.storageVersion &&
      current.updatedAt.getTime() === args.existing.updatedAt.getTime()
    ) {
      const [config] = await db
        .select({ id: orgCustomConnectorOauthConfigs.connectorId })
        .from(orgCustomConnectorOauthConfigs)
        .where(
          and(
            eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
            eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!config) {
        throw new Error("custom connector OAuth mode and config do not match");
      }
    }
    return badRequestMessage(
      "Custom connector changed while the definition was being saved; retry",
    );
  },
);

function publishedCustomConnectorUpdate(
  args: PersistCustomConnectorUpdateArgs,
  row: CustomConnectorDefinitionRow | null,
  oauthConfig: CustomConnectorOAuthConfigRow | null,
) {
  if (!row) {
    if (args.preparedSkill) {
      throw new StorageVersionIdentityConflictError(
        args.preparedSkill.version.versionId,
      );
    }
    throw new Error("Expected locked custom connector to be updated");
  }
  requireCustomConnectorOAuthConfig(row.authMode, oauthConfig);
  return { row, oauthConfig };
}

function customConnectorOAuthUpdateValues(
  config: CustomConnectorOAuthConfig,
  secret: string,
) {
  return {
    ...config,
    encryptedClientSecret: secret,
    scopes: [...config.scopes],
    authorizationParams: { ...config.authorizationParams },
    updatedAt: nowDate(),
  };
}

function customConnectorSnapshotOAuthPlan(
  args: PersistCustomConnectorUpdateArgs,
) {
  const query = new QueryBuilder();
  return query.$with("custom_connector_oauth_result").as(
    query
      .select()
      .from(orgCustomConnectorOauthConfigs)
      .where(
        and(
          eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
          eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
          args.oauthConfigUpdate.kind === "preserve" ? undefined : sql`false`,
        ),
      ),
  );
}

const persistCustomConnectorUpdate$ = command(
  async (
    { set },
    args: PersistCustomConnectorUpdateArgs,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly row: CustomConnectorDefinitionRow;
        readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
      }
    | BadRequestResponse
    | null
  > => {
    const db = set(writeDb$);
    const oauth = args.oauthConfigUpdate;
    const plan = customConnectorUpdatePublicationPlan(args);
    const ctes: WithSubquery[] = [...plan.ctes];
    let cleanupCompleted: SQL | undefined;
    if (
      args.existing.authMode === "automatic" &&
      args.definition.authMode !== "automatic"
    ) {
      const bindings = db.$with("removed_automatic_oauth_bindings").as(
        db
          .delete(customConnectorAccountOauthBindings)
          .where(plan.bindings)
          .returning({
            id: customConnectorAccountOauthBindings.customConnectorId,
          }),
      );
      const registrations = db
        .$with("removed_automatic_oauth_registrations")
        .as(
          db
            .delete(orgCustomConnectorDcrRegistrations)
            .where(
              and(
                plan.registrations,
                gte(db.select({ value: count() }).from(bindings), 0),
              ),
            )
            .returning({
              id: orgCustomConnectorDcrRegistrations.customConnectorId,
            }),
        );
      ctes.push(bindings, registrations);
      cleanupCompleted = gte(
        db.select({ value: count() }).from(registrations),
        0,
      );
    }
    const updated = db.$with("updated_custom_connector").as(
      db
        .update(orgCustomConnectors)
        .set(customConnectorDefinitionUpdateValues(args, nowDate()))
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
            plan.ready,
            cleanupCompleted,
          ),
        )
        .returning(customConnectorDefinitionSelection()),
    );
    ctes.push(updated);
    const config =
      oauth.kind === "upsert" && args.encryptedClientSecret
        ? db.$with("custom_connector_oauth_result").as(
            db
              .insert(orgCustomConnectorOauthConfigs)
              .select(
                db
                  .select(
                    customConnectorOAuthCreateSource(
                      sql`${updated.id}`.mapWith(
                        orgCustomConnectorOauthConfigs.connectorId,
                      ),
                      args.orgId,
                      oauth.config,
                      args.encryptedClientSecret,
                    ),
                  )
                  .from(updated),
              )
              .onConflictDoUpdate({
                target: orgCustomConnectorOauthConfigs.connectorId,
                set: customConnectorOAuthUpdateValues(
                  oauth.config,
                  args.encryptedClientSecret,
                ),
              })
              .returning(),
          )
        : customConnectorSnapshotOAuthPlan(args);
    let completed: SQL | undefined;
    if (oauth.kind === "none") {
      const removed = db.$with("removed_custom_connector_oauth").as(
        db
          .delete(orgCustomConnectorOauthConfigs)
          .where(
            and(
              eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
              eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
              exists(db.select({ id: updated.id }).from(updated)),
            ),
          )
          .returning({ id: orgCustomConnectorOauthConfigs.connectorId }),
      );
      ctes.push(removed);
      completed = gte(db.select({ value: count() }).from(removed), 0);
    }
    signal.throwIfAborted();
    const [result] = await db
      .with(...ctes, config)
      .select()
      .from(plan.locked)
      .leftJoin(updated, eq(updated.id, plan.locked.id))
      .leftJoin(config, eq(config.connectorId, updated.id))
      .where(completed);
    signal.throwIfAborted();
    return result
      ? publishedCustomConnectorUpdate(
          args,
          result.updated_custom_connector,
          result.custom_connector_oauth_result,
        )
      : await set(failedCustomConnectorUpdate$, args, signal);
  },
);

const persistCustomConnectorUpdateAndPublishRuntimeWakeup$ = command(
  async (
    { set },
    args: PersistCustomConnectorUpdateArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly result: CustomConnectorRow | BadRequestResponse | null;
    readonly postCommitAbort?: CapturedConnectorClientInvalidationAbort;
  }> => {
    const result = await set(persistCustomConnectorUpdate$, args, signal);
    if (isBadRequest(result) || !result) {
      return {
        result,
        ...(signal.aborted
          ? { postCommitAbort: { reason: signal.reason } }
          : {}),
      };
    }
    const connector = normaliseCustomConnectorRow(
      result.row,
      result.oauthConfig,
    );
    if (
      args.grantConfigurationChanged ||
      connector.storageVersion !== args.existing.storageVersion
    ) {
      // eslint-disable-next-line api/signal-check-await -- Preserve the committed wakeup outcome for the caller to propagate cancellation.
      const wakeup = await settle(
        set(
          publishConnectorRuntimeSyncWakeups$,
          {
            scope: { orgId: args.orgId },
            targets: [{ kind: "custom", customConnectorId: connector.id }],
          },
          signal,
        ),
      );
      // The wakeup command observes cancellation only after its publication.
      // Keep that outcome for the caller to propagate after resolving the result.
      if (!wakeup.ok && (!signal.aborted || wakeup.error !== signal.reason)) {
        throw wakeup.error;
      }
    }
    return {
      result: connector,
      ...(signal.aborted ? { postCommitAbort: { reason: signal.reason } } : {}),
    };
  },
);

interface PreparedCustomConnectorUpdate {
  readonly definition: ValidatedDefinition;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
}

function prepareCustomConnectorUpdate(args: {
  readonly existing: CustomConnectorRow;
  readonly input: UpdateCustomConnectorBody;
}): PreparedCustomConnectorUpdate | BadRequestResponse {
  if (args.existing.kind !== (args.input.kind ?? "http")) {
    return badRequestMessage(
      "Custom connector protocol kind cannot be changed",
    );
  }
  const definition = validateDefinition(
    definitionFromUpdateInput(args.input, args.existing),
  );
  if (isBadRequest(definition)) {
    return definition;
  }
  const oauthConfigUpdate = validateOAuthConfigUpdate({
    authMode: definition.authMode,
    input: args.input.oauthConfig,
    existingConfig: args.existing.oauthConfig,
  });
  return isBadRequest(oauthConfigUpdate)
    ? oauthConfigUpdate
    : { definition, oauthConfigUpdate };
}

function resolveCustomConnectorUpdateWrite(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
  readonly encryptedClientSecret: string | null;
  readonly requestedStorageVersion: number | undefined;
  readonly orgId: string;
}):
  | {
      readonly storageVersion: number;
      readonly grantConfigurationChanged: boolean;
    }
  | BadRequestResponse {
  const nextOAuthConfig = nextOAuthConfigForUpdate({
    connector: args.existing,
    orgId: args.orgId,
    update: args.oauthConfigUpdate,
    encryptedClientSecret: args.encryptedClientSecret,
  });
  const storageVersion = resolveUpdatedStorageVersion({
    current: args.existing.storageVersion,
    requested: args.requestedStorageVersion,
    contractChanged: credentialContractChanged({
      existing: args.existing,
      definition: args.definition,
      nextOAuthConfig,
    }),
  });
  if (isBadRequest(storageVersion)) {
    return storageVersion;
  }
  return {
    storageVersion,
    grantConfigurationChanged: grantConfigurationChanged({
      existing: args.existing,
      definition: args.definition,
      nextOAuthConfig,
    }),
  };
}

type UpdateCustomConnectorDefinitionResult =
  | CustomConnectorRow
  | BadRequestResponse
  | NotFoundResponse
  | ForbiddenResponse;

export const updateCustomConnectorDefinition$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly id: string;
      readonly input: UpdateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<UpdateCustomConnectorDefinitionResult> => {
    const existingConnector = await set(
      loadCustomConnectorForUpdate$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (!existingConnector) {
      return notFound("Custom connector not found");
    }
    if (isIntegrationManagedCustomConnector(existingConnector)) {
      return integrationManagedCustomConnectorMutationForbidden();
    }
    const prepared = prepareCustomConnectorUpdate({
      existing: existingConnector,
      input: args.input,
    });
    if (isBadRequest(prepared)) {
      return prepared;
    }
    const invalidPermissionBundle = await set(
      validatePermissionBundleRef$,
      prepared.definition.permissionBundleRef,
      signal,
    );
    signal.throwIfAborted();
    if (invalidPermissionBundle) {
      return invalidPermissionBundle;
    }
    let encryptedClientSecret =
      existingConnector.oauthConfig?.encryptedClientSecret ?? null;
    if (
      prepared.oauthConfigUpdate.kind === "upsert" &&
      prepared.oauthConfigUpdate.clientSecret
    ) {
      const featureContext = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      encryptedClientSecret = await encryptStoredSecretValue(
        prepared.oauthConfigUpdate.clientSecret,
        featureContext,
      );
      signal.throwIfAborted();
    }

    const resolved = resolveCustomConnectorUpdateWrite({
      existing: existingConnector,
      definition: prepared.definition,
      oauthConfigUpdate: prepared.oauthConfigUpdate,
      encryptedClientSecret,
      requestedStorageVersion: args.input.storageVersion,
      orgId: args.orgId,
    });
    if (isBadRequest(resolved)) {
      return resolved;
    }
    const preparedSkill =
      prepared.definition.skillMarkdown === null
        ? null
        : await set(
            prepareCustomConnectorSkillVolume$,
            {
              orgId: args.orgId,
              connectorId: existingConnector.id,
              connectorSlug: existingConnector.slug,
              displayName: prepared.definition.displayName,
              skillMarkdown: prepared.definition.skillMarkdown,
            },
            signal,
          );
    signal.throwIfAborted();
    const { result: normalized, postCommitAbort } = await set(
      persistCustomConnectorUpdateAndPublishRuntimeWakeup$,
      {
        orgId: args.orgId,
        id: args.id,
        definition: prepared.definition,
        existing: existingConnector,
        oauthConfigUpdate: prepared.oauthConfigUpdate,
        encryptedClientSecret,
        grantConfigurationChanged: resolved.grantConfigurationChanged,
        storageVersion: resolved.storageVersion,
        preparedSkill,
      },
      signal,
    );
    if (isBadRequest(normalized) || !normalized) {
      signal.throwIfAborted();
      return normalized ?? notFound("Custom connector not found");
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    return normalized;
  },
);

function customConnectorMutationOAuthJoin() {
  return and(
    eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
    eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
  );
}

function customConnectorMutationDefinitionScope(
  connectorId: string,
  orgId: string,
) {
  return and(
    eq(orgCustomConnectors.id, connectorId),
    eq(orgCustomConnectors.orgId, orgId),
  );
}

export const deleteCustomConnector$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | ForbiddenResponse | undefined> => {
    const writeDb = set(writeDb$);
    const deletion = (async () => {
      const [existing] = await writeDb
        .select({
          id: orgCustomConnectors.id,
          providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
        })
        .from(orgCustomConnectors)
        .leftJoin(
          orgCustomConnectorOauthConfigs,
          customConnectorMutationOAuthJoin(),
        )
        .where(customConnectorMutationDefinitionScope(args.id, args.orgId))
        .limit(1);
      if (!existing) {
        return false;
      }
      if (
        isIntegrationManagedCustomConnectorProviderAdapter(
          existing.providerAdapter,
        )
      ) {
        return integrationManagedCustomConnectorMutationForbidden();
      }
      signal.throwIfAborted();
      const removedSelections = writeDb
        .$with("deleted_custom_connector_selections")
        .as(
          writeDb
            .delete(chatThreadConnectorSelections)
            .where(eq(chatThreadConnectorSelections.customConnectorId, args.id))
            .returning({
              connectorId: chatThreadConnectorSelections.connectorId,
            }),
        );
      // Consume the complete cleanup before cascading account deletion. Both
      // writes share one statement, including the existing NO ACTION checks.
      await writeDb
        .with(removedSelections)
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
            gte(writeDb.select({ count: count() }).from(removedSelections), 0),
          ),
        );
      return true;
    })();
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const deleted = await (async () => {
      const result = await deletion;
      const wakeup: ConnectorRuntimeWakeupBusinessArgs | undefined =
        result === true
          ? {
              scope: { orgId: args.orgId },
              targets: [{ kind: "custom", customConnectorId: args.id }],
            }
          : undefined;
      if (wakeup) {
        await (async () => {
          const result = await settle(
            (async () => {
              const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
              if (targets.length === 0) {
                return;
              }
              const rows = await writeDb
                .select(connectorRuntimeWakeupRunColumns())
                .from(agentRuns)
                .where(connectorRuntimeWakeupCondition(wakeup.scope));
              await publishConnectorRuntimeWakeupRows({
                scope: wakeup.scope,
                targets,
                rows,
              });
            })(),
          );
          if (!result.ok) {
            reportConnectorRuntimeWakeupDiscoveryFailure({
              orgId: wakeup.scope.orgId,
              scopedToUser: wakeup.scope.userId !== undefined,
              scopedToAgent: wakeup.scope.agentId !== undefined,
              targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
              error: result.error,
            });
          }
        })();
      }
      return result;
    })();
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (deleted === false) {
      signal.throwIfAborted();
      return notFound("Custom connector not found");
    }
    if (deleted !== true) {
      signal.throwIfAborted();
      return deleted;
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    L.debug("custom connector deleted", { orgId: args.orgId, id: args.id });
    return undefined;
  },
);

export function getCustomConnectorById(args: {
  readonly orgId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorRow | null>> {
  return computed(async (get): Promise<CustomConnectorRow | null> => {
    const db = get(db$);
    const [result] = await db
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!result) {
      return null;
    }
    return normaliseCustomConnectorRow(result.connector, result.oauthConfig);
  });
}

export function getCustomConnectorResponse(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorResponse | null>> {
  const connector$ = getCustomConnectorById({
    orgId: args.orgId,
    connectorId: args.connectorId,
  });
  const managedOwner$ = computed(async (get) => {
    const connector = await get(connector$);
    return {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds:
        connector && isIntegrationManagedCustomConnector(connector)
          ? [connector.id]
          : [],
    };
  });
  const markers$ = createCustomConnectorValueMarkers(managedOwner$);
  const connectedConnections$ =
    createCustomConnectorConnectedConnections(managedOwner$);
  return computed(async (get): Promise<CustomConnectorResponse | null> => {
    const connector = await get(connector$);
    if (!connector) {
      return null;
    }
    if (!isIntegrationManagedCustomConnector(connector)) {
      return serialiseCustomConnector({ row: connector });
    }
    const [markers, connectedConnections] = await Promise.all([
      get(markers$),
      get(connectedConnections$),
    ]);
    const connectedAccount = customConnectorDefinitionConnectedAccount({
      connectedConnections,
      definition: connector,
    });
    return serialiseCustomConnector({
      row: connector,
      managedStatus: {
        valueMarkers: markers,
        connectedAccountId: connectedAccount?.id ?? null,
        connectedAccountUpdatedAt: connectedAccount?.updatedAt,
      },
    });
  });
}

export function getCustomConnectorPermissionBundle(args: {
  readonly orgId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorPermissionBundleResponse | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const connector = await get(getCustomConnectorById(args));
    if (!connector || connector.kind !== "http") {
      return null;
    }
    const permissionBundleRef = effectivePermissionBundleRef(connector);
    if (!permissionBundleRef) {
      return null;
    }
    const catalogDb = db;
    const dependency =
      customConnectorPermissionBundleDependencySlug(permissionBundleRef);
    const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [],
      metadataConnectorSlugs: dependency === null ? [] : [dependency],
    });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      catalogPlan.selection,
      await catalogDb
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    const bundle = await loadCustomConnectorPermissionBundle({
      catalog: snapshot.serverFirewallMetadata,
      ref: permissionBundleRef,
    });
    if (!bundle) {
      return null;
    }
    return {
      ref: bundle.ref,
      permissions: bundle.permissions.map((permission) => {
        return {
          name: permission.name,
          ...(permission.description
            ? { description: permission.description }
            : {}),
        };
      }),
      defaultPolicies: { ...bundle.defaultPolicies },
    };
  });
}

function validateValueInputsForDefinition(args: {
  readonly fields: readonly CustomConnectorField[];
  readonly prefixTemplates: readonly string[];
  readonly values: readonly CustomConnectorValueInput[];
}): readonly CustomConnectorValueInput[] | BadRequestResponse {
  const allowed = new Set(
    args.fields.map((field) => {
      return customConnectorValueMarkerKey(field);
    }),
  );
  const prefixVariables = customConnectorPrefixTemplateVariableKeys(
    args.prefixTemplates,
  );
  const seen = new Set<string>();
  const values: CustomConnectorValueInput[] = [];
  for (const value of args.values) {
    const key = value.key.trim();
    const marker = customConnectorValueMarkerKey({ kind: value.kind, key });
    if (!allowed.has(marker)) {
      return badRequestMessage(
        `Value references undeclared custom connector field: ${marker}`,
      );
    }
    if (seen.has(marker)) {
      return badRequestMessage(`Duplicate value for field: ${marker}`);
    }
    if (
      value.kind === "variable" &&
      prefixVariables.has(key) &&
      !isSafeHostTemplateVariableValue(value.value)
    ) {
      return badRequestMessage(
        `Value for variable ${key} contains characters that are not safe in custom connector host templates`,
      );
    }
    if (value.kind === "variable" && prefixVariables.has(key)) {
      for (const prefixTemplate of args.prefixTemplates) {
        const referencesValue = extractTemplateReferences(prefixTemplate).some(
          (reference) => {
            return reference.namespace === "variables" && reference.key === key;
          },
        );
        if (!referencesValue) {
          continue;
        }
        const rendered = prefixTemplate.replaceAll(
          TEMPLATE_REFERENCE_REGEX,
          (_match, namespace: string, referenceKey: string) => {
            return namespace === "variables" && referenceKey === key
              ? value.value
              : TEMPLATE_PLACEHOLDER_VALUE;
          },
        );
        const validation = safeSync(() => {
          return canonicalizeFirewallBaseUrl(
            expandHostWildcardsInBaseUrl(rendered),
            "custom connector",
          );
        });
        if ("error" in validation) {
          return badRequestMessage(
            `Value for variable ${key} is not a valid custom connector hostname`,
          );
        }
      }
    }
    seen.add(marker);
    values.push({ key, kind: value.kind, value: value.value });
  }
  return values;
}

function validateValueInputs(args: {
  readonly connector: CustomConnectorRow;
  readonly values: readonly CustomConnectorValueInput[];
}): readonly CustomConnectorValueInput[] | BadRequestResponse {
  return validateValueInputsForDefinition({
    fields: args.connector.fields,
    prefixTemplates:
      args.connector.kind === "http" ? args.connector.prefixTemplates : [],
    values: args.values,
  });
}

async function prepareCustomConnectorValues(
  args: {
    readonly values: readonly CustomConnectorValueInput[];
    readonly featureSwitchContext: FeatureSwitchContextArg;
  },
  signal: AbortSignal,
): Promise<readonly PreparedCustomConnectorValue[]> {
  const preparedValues: PreparedCustomConnectorValue[] = [];
  for (const value of args.values) {
    if (value.kind === "secret") {
      const encryptedValue = await encryptStoredSecretValue(
        value.value,
        args.featureSwitchContext,
      );
      signal.throwIfAborted();
      preparedValues.push({
        key: value.key,
        kind: value.kind,
        encryptedValue,
      });
      continue;
    }
    preparedValues.push({
      key: value.key,
      kind: value.kind,
      value: value.value,
    });
  }
  return preparedValues;
}

interface SetCustomConnectorValuesArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly values: readonly CustomConnectorValueInput[];
  readonly account: ConnectorAccountMutationIntent;
}

interface DeleteCustomConnectorAccountArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly memberConnectorId: string;
}

function customConnectorUserMutationWakeup(
  args: Pick<
    DeleteCustomConnectorAccountArgs,
    "orgId" | "userId" | "connectorId"
  >,
): ConnectorRuntimeWakeupBusinessArgs {
  return {
    scope: { orgId: args.orgId, userId: args.userId },
    targets: [{ kind: "custom", customConnectorId: args.connectorId }],
  };
}

interface CustomConnectorValueWriteState {
  readonly connector: CustomConnectorRow;
  readonly preservesStoredValues: boolean;
  readonly runtimeRecovered: boolean;
  readonly resolution: ReadyConnectorConnectionMutation;
}

function prepareCustomConnectorValueWrite(args: {
  readonly request: SetCustomConnectorValuesArgs;
  readonly expectedConnector: CustomConnectorRow;
  readonly expectedValues: readonly CustomConnectorValueInput[];
  readonly definition: CustomConnectorDefinitionRow;
}) {
  const lockedDefinition = args.definition;
  const connector = normaliseCustomConnectorRow(lockedDefinition);
  if (connector.authMode === "oauth" || connector.authMode === "automatic") {
    return badRequestMessage(
      "OAuth and Automatic custom connectors must be connected through authentication discovery",
    );
  }
  const currentValues = validateValueInputs({
    connector,
    values: args.request.values,
  });
  if (isBadRequest(currentValues)) {
    return currentValues;
  }
  if (
    connector.storageVersion !== args.expectedConnector.storageVersion ||
    !jsonValuesEqual(currentValues, args.expectedValues)
  ) {
    return badRequestMessage(
      "Custom connector changed while values were being saved; retry",
    );
  }

  return { connector, currentValues };
}

function customConnectorValueWriteState(
  connector: CustomConnectorRow,
  currentValues: readonly CustomConnectorValueInput[],
  resolution: ConnectorConnectionMutationResolution,
):
  | CustomConnectorValueWriteState
  | BadRequestResponse
  | NotFoundResponse
  | ConflictResponse {
  if (resolution.kind !== "ready") {
    return resolution.kind === "missing"
      ? notFound("Connector account not found")
      : conflict(
          resolution.kind === "ambiguous"
            ? "Multiple connector accounts require an exact choice"
            : "This connector does not support additional accounts",
        );
  }
  const storedConnector =
    resolution.mutation.kind === "update"
      ? resolution.mutation.existing
      : undefined;
  const missingRequired = customConnectorMissingRequiredFieldKeys({
    fields: connector.fields,
    markers: currentValues,
  });
  if (storedConnector === undefined && missingRequired.length > 0) {
    return badRequestMessage(
      `All required fields must be provided when connecting or restoring this connector: ${missingRequired.join(
        ", ",
      )}`,
    );
  }
  const replacingIncompatibleValues =
    storedConnector !== undefined &&
    (storedConnector.authMethod !== connector.authMode ||
      storedConnector.storageVersion !== connector.storageVersion);
  if (replacingIncompatibleValues && missingRequired.length > 0) {
    return badRequestMessage(
      `All required fields must be provided when restoring this connector: ${missingRequired.join(
        ", ",
      )}`,
    );
  }
  const preservesStoredValues =
    storedConnector !== undefined && !replacingIncompatibleValues;
  return {
    connector,
    preservesStoredValues,
    resolution: resolution.mutation,
    runtimeRecovered: !preservesStoredValues,
  };
}

type CustomConnectorValueWriteResult =
  | {
      readonly connector: CustomConnectorRow;
      readonly runtimeRecovered: boolean;
      readonly connectedAccountId: string;
    }
  | BadRequestResponse
  | NotFoundResponse
  | ConflictResponse;

function customConnectorValueConnectionMetadata(
  request: Pick<
    SetCustomConnectorValuesArgs,
    "orgId" | "userId" | "connectorId"
  >,
  state: Pick<CustomConnectorValueWriteState, "connector" | "resolution">,
): ConnectorConnectionMetadataArgs & {
  readonly resolution: ReadyConnectorConnectionMutation;
} {
  const { connector, resolution } = state;
  return {
    resolution,
    orgId: request.orgId,
    userId: request.userId,
    authMethod: connector.authMode,
    storageVersion: connector.storageVersion,
    tokenExpiresAt: null,
    target: {
      kind: "custom",
      customConnectorId: request.connectorId,
      oauthScopes: null,
      identity: { kind: "local" },
    },
  };
}

const customConnectorValuesPublicationRow = object({
  definition_current: boolean(),
  connection_id: uuid().nullable(),
});

type SetCustomConnectorValuesResponse =
  | (CustomConnectorResponse & { readonly connectionId: string })
  | BadRequestResponse
  | NotFoundResponse
  | ForbiddenResponse
  | ConflictResponse;

interface CustomConnectorValuePublicationContext {
  readonly request: SetCustomConnectorValuesArgs;
  readonly expectedConnector: CustomConnectorRow;
  readonly expectedValues: readonly CustomConnectorValueInput[];
  readonly preparedValues: readonly PreparedCustomConnectorValue[];
}

const prepareCustomConnectorValuePublication$ = command(
  async ({ set }, context: CustomConnectorValuePublicationContext) => {
    const writeDb = set(writeDb$);
    const [observedDefinition] = await writeDb
      .select({
        definition: customConnectorDefinitionSelection(),
        revision: sql`${orgCustomConnectors}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, context.request.connectorId),
          eq(orgCustomConnectors.orgId, context.request.orgId),
        ),
      )
      .limit(1);
    if (!observedDefinition) {
      return notFound("Custom connector not found");
    }
    const current = prepareCustomConnectorValueWrite({
      request: context.request,
      expectedConnector: context.expectedConnector,
      expectedValues: context.expectedValues,
      definition: observedDefinition.definition,
    });
    if ("status" in current) {
      return current;
    }
    const mutationReadArgs: ConnectorConnectionMutationArgs = {
      orgId: context.request.orgId,
      userId: context.request.userId,
      target: {
        kind: "custom",
        customConnectorId: context.request.connectorId,
      },
      mutation: context.request.account,
      allowSiblings: true,
    };
    const mutation = await (async () => {
      let read = connectionMutationReadPlan(mutationReadArgs);
      for (;;) {
        const rows = await writeDb
          .select({
            ...read.columns,
            publicationRevision: sql`${connectors}.xmin::text`.mapWith(
              pgTextDecoder,
            ),
          })
          .from(read.from)
          .where(read.where)
          .orderBy(...read.orderBy)
          .limit(read.limit);
        const result = connectionMutationReadResult(
          mutationReadArgs,
          read,
          rows,
        );
        if (result.kind === "resolved") {
          if (
            result.resolution.kind === "ready" &&
            result.resolution.mutation.kind === "update"
          ) {
            const existingId = result.resolution.mutation.existing.id;
            const observed = rows.find((row) => {
              return row.id === existingId;
            });
            if (!observed) {
              throw new Error(
                "Prepared connector account has no observed row version",
              );
            }
            return {
              resolution: result.resolution,
              accountRevision: observed.publicationRevision,
            };
          }
          return { resolution: result.resolution, accountRevision: null };
        }
        read = result.read;
      }
    })();
    const state = customConnectorValueWriteState(
      current.connector,
      current.currentValues,
      mutation.resolution,
    );
    if ("status" in state) {
      return state;
    }
    return {
      state,
      definitionRevision: observedDefinition.revision,
      accountRevision: mutation.accountRevision,
    };
  },
);

const publishCustomConnectorValues$ = command(
  async (
    { set },
    context: CustomConnectorValuePublicationContext,
    signal: AbortSignal,
  ): Promise<CustomConnectorValueWriteResult> => {
    const prepared = await set(
      prepareCustomConnectorValuePublication$,
      context,
    );
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }
    const { state } = prepared;
    const writeDb = set(writeDb$);
    const accountId =
      state.resolution.kind === "update"
        ? state.resolution.existing.id
        : randomUUID();
    const metadata = {
      ...customConnectorValueConnectionMetadata(context.request, state),
      ...(state.resolution.kind === "insert"
        ? { insertConnectionId: accountId }
        : {}),
    };
    const statement = customConnectorValuesPublicationSql({
      metadata,
      accountId,
      definitionRevision: prepared.definitionRevision,
      accountRevision: prepared.accountRevision,
      preservesStoredValues: state.preservesStoredValues,
      credentials: credentialValues(
        context.request,
        state.connector.fields,
        context.preparedValues,
      ),
    });
    signal.throwIfAborted();
    const [published] = parseRawRows(
      customConnectorValuesPublicationRow,
      await writeDb.execute(statement),
    );
    if (!published) {
      throw new Error("Custom connector value publication returned no row");
    }
    if (!published.definition_current || published.connection_id === null) {
      return badRequestMessage(
        "Custom connector changed while values were being saved; retry",
      );
    }
    return {
      connector: state.connector,
      runtimeRecovered: state.runtimeRecovered,
      connectedAccountId: published.connection_id,
    };
  },
);

export const setCustomConnectorValues$ = command(
  async (
    { get, set },
    args: SetCustomConnectorValuesArgs,
    signal: AbortSignal,
  ): Promise<SetCustomConnectorValuesResponse> => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      return notFound("Custom connector not found");
    }
    if (isIntegrationManagedCustomConnector(connector)) {
      return integrationManagedCustomConnectorMutationForbidden();
    }
    if (connector.authMode === "oauth" || connector.authMode === "automatic") {
      return badRequestMessage(
        "OAuth and Automatic custom connectors must be connected through authentication discovery",
      );
    }
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const values = validateValueInputs({ connector, values: args.values });
    if (isBadRequest(values)) {
      return values;
    }
    const writeDb = set(writeDb$);
    const preparationInput = { values, featureSwitchContext };
    const preparedValues = await prepareCustomConnectorValues(
      preparationInput,
      signal,
    );
    const valueWrite = set(
      publishCustomConnectorValues$,
      {
        request: args,
        expectedConnector: connector,
        expectedValues: values,
        preparedValues,
      },
      signal,
    );
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const writeResult = await (async () => {
      const result = await valueWrite;
      const wakeup: ConnectorRuntimeWakeupBusinessArgs | undefined =
        !("status" in result) && result.runtimeRecovered
          ? customConnectorUserMutationWakeup(args)
          : undefined;
      if (wakeup) {
        await (async () => {
          const result = await settle(
            (async () => {
              const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
              if (targets.length === 0) {
                return;
              }
              const rows = await writeDb
                .select(connectorRuntimeWakeupRunColumns())
                .from(agentRuns)
                .where(connectorRuntimeWakeupCondition(wakeup.scope));
              await publishConnectorRuntimeWakeupRows({
                scope: wakeup.scope,
                targets,
                rows,
              });
            })(),
          );
          if (!result.ok) {
            reportConnectorRuntimeWakeupDiscoveryFailure({
              orgId: wakeup.scope.orgId,
              scopedToUser: wakeup.scope.userId !== undefined,
              scopedToAgent: wakeup.scope.agentId !== undefined,
              targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
              error: result.error,
            });
          }
        })();
      }
      return result;
    })();
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if ("status" in writeResult) {
      signal.throwIfAborted();
      return writeResult;
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();

    return {
      ...serialiseCustomConnector({
        row: writeResult.connector,
      }),
      connectionId: writeResult.connectedAccountId,
    };
  },
);

function customConnectorAccountDeletionColumns() {
  return {
    oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    revision: sql`${orgCustomConnectors}.xmin::text`.mapWith(pgTextDecoder),
  };
}

function customConnectorAccountDeletionWhere(args: {
  readonly connectorId: string;
  readonly orgId: string;
}) {
  return customConnectorMutationDefinitionScope(args.connectorId, args.orgId);
}

// Once this one-statement mutation starts, its owner completes commit and
// invalidation even if the HTTP caller aborts. The outer command observes abort
// after its existing post-commit wakeup, so revocation never loses that effect.
const deleteCustomConnectorAccount$ = command(
  async (
    { set },
    args: {
      readonly request: DeleteCustomConnectorAccountArgs;
      readonly definitionRevision: string;
    },
  ): Promise<CustomConnectorMemberConnectionDeletionResult> => {
    const db = set(writeDb$);
    const query = customConnectorAccountDeletionSql(
      args.request,
      args.definitionRevision,
    );
    const [result] = parseRawRows(
      customConnectorAccountDeletionRow,
      await db.execute(query),
    );
    if (!result) {
      throw new Error("Custom connector account deletion returned no receipt");
    }
    return result.deleted_count === 0
      ? { kind: "missing" }
      : {
          kind: "deleted",
          resolvedSelectionCount: result.resolved_selection_count,
          promotedDefaultConnectionId: result.promoted_default_connection_id,
        };
  },
);

export const deleteCustomConnectorAccountAndPublish$ = command(
  async (
    { set },
    args: DeleteCustomConnectorAccountArgs,
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const [definition] = await writeDb
      .select(customConnectorAccountDeletionColumns())
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        customConnectorMutationOAuthJoin(),
      )
      .where(customConnectorAccountDeletionWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (!definition) {
      return { kind: "missing" as const };
    }
    if (
      isIntegrationManagedCustomConnectorProviderAdapter(
        definition.oauthProviderAdapter,
      )
    ) {
      return { kind: "managed" as const };
    }
    const deletion = set(deleteCustomConnectorAccount$, {
      request: args,
      definitionRevision: definition.revision,
    });
    const result = await (async () => {
      const result = await deletion;
      const wakeup: ConnectorRuntimeWakeupBusinessArgs | undefined =
        result.kind === "deleted"
          ? customConnectorUserMutationWakeup(args)
          : undefined;
      if (wakeup) {
        await (async () => {
          const result = await settle(
            (async () => {
              const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
              if (targets.length === 0) {
                return;
              }
              const rows = await writeDb
                .select(connectorRuntimeWakeupRunColumns())
                .from(agentRuns)
                .where(connectorRuntimeWakeupCondition(wakeup.scope));
              await publishConnectorRuntimeWakeupRows({
                scope: wakeup.scope,
                targets,
                rows,
              });
            })(),
          );
          if (!result.ok) {
            reportConnectorRuntimeWakeupDiscoveryFailure({
              orgId: wakeup.scope.orgId,
              scopedToUser: wakeup.scope.userId !== undefined,
              scopedToAgent: wakeup.scope.agentId !== undefined,
              targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
              error: result.error,
            });
          }
        })();
      }
      return result;
    })();
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (result.kind !== "deleted") {
      signal.throwIfAborted();
      return result;
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    return result;
  },
);

export function customConnectorInternalName(connectorId: string): string {
  return `custom_connector_${connectorId.replaceAll("-", "")}`;
}

export function customConnectorSecretKey(args: {
  readonly connectorId: string;
  readonly kind: CustomConnectorFieldKind;
  readonly key: string;
}): string {
  const kindPrefix = args.kind === "secret" ? "S" : "V";
  return `CUSTOM_${args.connectorId.replaceAll("-", "")}_${kindPrefix}_${args.key.toUpperCase()}`;
}

export function renderCustomConnectorTemplateForRuntime(args: {
  readonly template: string;
  readonly connectorId: string;
  readonly fields: readonly CustomConnectorField[];
  readonly configuredValueMarkers?: ReadonlySet<string>;
}): string | null {
  const fieldByReference = new Map<string, CustomConnectorField>(
    args.fields.map((field) => {
      return [
        `${field.kind === "secret" ? "secrets" : "variables"}.${field.key}`,
        field,
      ] as const;
    }),
  );

  for (const match of args.template.matchAll(TEMPLATE_REFERENCE_REGEX)) {
    const namespace = match[1];
    const key = match[2];
    if (!namespace || !key) {
      continue;
    }
    if (
      namespace === "oauth" &&
      key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
    ) {
      if (
        args.configuredValueMarkers &&
        !args.configuredValueMarkers.has(
          customConnectorValueMarkerKey({
            kind: "secret",
            key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
          }),
        )
      ) {
        return null;
      }
      continue;
    }
    const field = fieldByReference.get(`${namespace}.${key}`);
    if (!field) {
      return null;
    }
    if (
      args.configuredValueMarkers &&
      !args.configuredValueMarkers.has(customConnectorValueMarkerKey(field))
    ) {
      return null;
    }
  }

  return args.template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    (_match, namespace: string, key: string) => {
      if (
        namespace === "oauth" &&
        key === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
      ) {
        return `\${{ secrets.${customConnectorSecretKey({
          connectorId: args.connectorId,
          kind: "secret",
          key: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_RUNTIME_KEY,
        })} }}`;
      }
      const field = fieldByReference.get(`${namespace}.${key}`);
      if (!field) {
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      return `\${{ secrets.${customConnectorSecretKey({
        connectorId: args.connectorId,
        kind: field.kind,
        key: field.key,
      })} }}`;
    },
  );
}

function renderPrefixTemplate(args: {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
  readonly connectorName?: string;
}): string | null {
  let missing = false;
  let invalid = false;
  const rendered = args.template.replaceAll(
    TEMPLATE_REFERENCE_REGEX,
    (_match, namespace: string, key: string) => {
      if (namespace !== "variables") {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      const value =
        args.values[customConnectorValueMarkerKey({ kind: "variable", key })];
      if (!value) {
        missing = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      if (!isSafeHostTemplateVariableValue(value)) {
        invalid = true;
        return TEMPLATE_PLACEHOLDER_VALUE;
      }
      return value;
    },
  );
  if (invalid) {
    throw new CustomConnectorRuntimePrefixError(args.connectorName);
  }
  return missing ? null : rendered;
}

export function renderCustomConnectorRuntimePrefix(args: {
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
  readonly connectorName?: string;
}): string | null {
  const rendered = renderPrefixTemplate(args);
  if (!rendered) {
    return null;
  }
  const base = expandHostWildcardsInBaseUrl(rendered);
  const validation = safeSync(() => {
    return canonicalizeFirewallBaseUrl(base, "custom connector");
  });
  if ("error" in validation) {
    throw new CustomConnectorRuntimePrefixError(args.connectorName);
  }
  return validation.ok;
}

export function customConnectorRuntimeDefinitionReadPlan(args: {
  readonly orgId: string;
  readonly connectorIds: readonly string[] | undefined;
}) {
  return {
    columns: {
      connector: customConnectorDefinitionSelection(),
      oauthConfig: orgCustomConnectorOauthConfigs,
    },
    from: orgCustomConnectors,
    join: {
      table: orgCustomConnectorOauthConfigs,
      on: and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    },
    where: args.connectorIds
      ? and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.enabled, true),
          inArray(orgCustomConnectors.id, [...args.connectorIds]),
        )
      : and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.enabled, true),
        ),
  };
}

export function customConnectorRuntimeStorageReadInput(
  connectorRows: readonly {
    readonly connector: CustomConnectorDefinitionRow;
  }[],
  memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>,
) {
  const definitions = connectorRows.map((row) => {
    return {
      id: row.connector.id,
      authMode: row.connector.authMode,
      storageVersion: row.connector.storageVersion,
    };
  });
  const connectorIds = definitions.map((definition) => {
    return definition.id;
  });
  const memberConnectorIds = definitions.flatMap((definition) => {
    const memberConnectorId = memberConnectorIdsByCustomConnectorId.get(
      definition.id,
    );
    return memberConnectorId ? [memberConnectorId] : [];
  });
  return { definitions, connectorIds, memberConnectorIds };
}

export function customConnectorRuntimeDataFromRows(
  connectorRows: readonly {
    readonly connector: CustomConnectorDefinitionRow;
    readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
  }[],
  runtimeStorage: ReturnType<typeof customConnectorRuntimeStorageSnapshot>,
) {
  const valuesByConnectorId = new Map<
    string,
    CustomConnectorStoredValueRow[]
  >();
  for (const value of runtimeStorage.values) {
    const values = valuesByConnectorId.get(value.connectorId) ?? [];
    values.push(value);
    valuesByConnectorId.set(value.connectorId, values);
  }
  return connectorRows.map((row) => {
    const connector = normaliseCustomConnectorRow(
      row.connector,
      row.oauthConfig,
    );
    const credentialAccess = runtimeStorage.accesses.get(connector.id);
    if (!credentialAccess) {
      throw new Error("Expected custom connector credential access");
    }
    const declaredFields = new Set(
      connector.fields.map((field) => {
        return customConnectorValueMarkerKey(field);
      }),
    );
    const values = (valuesByConnectorId.get(connector.id) ?? []).filter(
      (value) => {
        return declaredFields.has(customConnectorValueMarkerKey(value));
      },
    );
    return { connector, values, credentialAccess };
  });
}

interface SaveCustomConnectorProposalArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly proposal: CustomConnectorProposal;
  readonly values: readonly CustomConnectorValueInput[];
  readonly agentId?: string;
}

type SaveCustomConnectorProposalResult =
  | {
      readonly connector: CustomConnectorResponse;
      readonly authorizedAgentId?: string;
    }
  | BadRequestResponse
  | NotFoundResponse
  | ForbiddenResponse;

function proposalUpdateInput(
  proposal: CustomConnectorProposal,
): UpdateCustomConnectorBody {
  return {
    displayName: proposal.displayName,
    prefixTemplates: proposal.prefixTemplates,
    fields: proposal.fields,
    headerInjections: proposal.headerInjections,
    queryInjections: proposal.queryInjections,
  };
}

const saveProposalDefinition$ = command(
  async (
    { set },
    args: SaveCustomConnectorProposalArgs,
    signal: AbortSignal,
  ): Promise<
    | CustomConnectorRow
    | BadRequestResponse
    | NotFoundResponse
    | ForbiddenResponse
  > => {
    const updateInput = proposalUpdateInput(args.proposal);
    if (args.proposal.operation === "create") {
      if (!args.isAdmin) {
        return forbidden("Only org admins can create custom connectors");
      }
      return await set(
        createCustomConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          input: updateInput,
        },
        signal,
      );
    }
    if (!args.proposal.connectorId) {
      return badRequestMessage("connectorId is required for updates");
    }
    if (!args.isAdmin) {
      return forbidden("Only org admins can update custom connectors");
    }
    return await set(
      updateCustomConnectorDefinition$,
      {
        orgId: args.orgId,
        userId: args.userId,
        id: args.proposal.connectorId,
        input: updateInput,
      },
      signal,
    );
  },
);

const authorizeProposalAgent$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly agentId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<string | undefined | NotFoundResponse> => {
    if (!args.agentId) {
      return undefined;
    }
    const added = await set(addUserCustomConnector$, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      customConnectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (added.status === "agentNotFound") {
      return notFound("Agent not found");
    }
    if (added.status === "customConnectorsNotFound") {
      return notFound("Custom connector not found");
    }
    if (
      added.status === "customConnectorPermissionSelectionRequired" ||
      added.status === "invalidCustomConnectorPermissions"
    ) {
      return undefined;
    }
    return args.agentId;
  },
);

export const saveCustomConnectorProposal$ = command(
  async (
    { get, set },
    args: SaveCustomConnectorProposalArgs,
    signal: AbortSignal,
  ): Promise<SaveCustomConnectorProposalResult> => {
    const proposalDefinition = validateDefinition(
      definitionFromUpdateInput(proposalUpdateInput(args.proposal)),
    );
    if (isBadRequest(proposalDefinition)) {
      return proposalDefinition;
    }
    if (proposalDefinition.kind !== "http") {
      return badRequestMessage("Custom connector proposals must use HTTP");
    }
    const proposalValues = validateValueInputsForDefinition({
      fields: proposalDefinition.fields,
      prefixTemplates: proposalDefinition.prefixTemplates,
      values: args.values,
    });
    if (isBadRequest(proposalValues)) {
      return proposalValues;
    }

    const connector = await set(saveProposalDefinition$, args, signal);
    signal.throwIfAborted();
    if ("status" in connector) {
      return connector;
    }

    const missingRequiredProposalValues =
      customConnectorMissingRequiredFieldKeys({
        fields: proposalDefinition.fields,
        markers: proposalValues,
      });
    let connectionId: string | undefined;
    if (args.values.length > 0 || missingRequiredProposalValues.length === 0) {
      const valueResult = await set(
        setCustomConnectorValues$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorId: connector.id,
          values: args.values,
          account: { intent: "add" },
        },
        signal,
      );
      if ("status" in valueResult) {
        return valueResult.status === 409
          ? badRequestMessage(valueResult.body.error.message)
          : valueResult;
      }
      connectionId = valueResult.connectionId;
    }

    const authorizedAgentId = await set(
      authorizeProposalAgent$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: connector.id,
        agentId: args.agentId,
      },
      signal,
    );
    if (authorizedAgentId && typeof authorizedAgentId !== "string") {
      return authorizedAgentId;
    }

    const response = await get(
      getCustomConnectorResponse({
        orgId: args.orgId,
        userId: args.userId,
        connectorId: connector.id,
      }),
    );
    signal.throwIfAborted();
    if (!response) {
      return notFound("Custom connector not found");
    }
    return {
      connector: response,
      ...(connectionId ? { connectionId } : {}),
      ...(authorizedAgentId ? { authorizedAgentId } : {}),
    };
  },
);
