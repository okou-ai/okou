import { command, computed, type Computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
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
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  canonicalizeFirewallBaseUrl,
  expandHostWildcardsInBaseUrl,
  validateBaseUrlHostPolicy,
} from "@okouai/connectors/firewall-types";
import {
  orgCustomConnectorOauthConfigs,
  type OrgCustomConnectorOAuthPkceMethod,
  type OrgCustomConnectorOAuthProviderAdapter,
  type OrgCustomConnectorOAuthTokenEndpointAuthMethod,
} from "@okouai/db/schema/org-custom-connector-oauth-config";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";

import { clerk$ } from "../external/clerk";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { safeSync } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { addUserCustomConnector } from "./user-connectors.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorDefinitionRow,
} from "./custom-connector-definition-selection";
import {
  deleteCustomConnectorMemberConnectionExact,
  type PreparedCustomConnectorValue,
  upsertCustomConnectorStoredValues,
} from "./custom-connector-credential-storage.service";
import { deleteConnectorSelectionsForCustomConnectorDefinition } from "./connector-credential-storage-write.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import {
  customConnectorDefinitionConnectedAccount,
  loadCurrentCustomConnectorStoredValues,
  loadCurrentCustomConnectorValueMarkers,
  loadConnectedCustomConnectorConnections,
  type CustomConnectorCredentialAccess,
  type CustomConnectorCredentialValueMarker,
  type CustomConnectorStoredValue,
} from "./custom-connector-credential-access.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import {
  commitPreparedCustomConnectorSkillStorage,
  prepareCustomConnectorSkillVolume$,
} from "./custom-connector-skill-volume.service";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import {
  commitConnectorRuntimeMutation,
  publishConnectorRuntimeSyncWakeups,
} from "./connector-runtime-wakeup.service";
import {
  publishCustomConnectorOrganizationInvalidationAfterCommit,
  publishCustomConnectorUserInvalidationAfterCommit,
  type CapturedConnectorClientInvalidationAbort,
} from "./connector-client-invalidation.service";
import { isCustomConnectorMcpEnabled } from "./custom-connector-mcp-feature.service";
import {
  type ConnectorConnectionMetadataArgs,
  replaceConnectorConnection,
  resolveConnectorConnectionMutation,
  type ReadyConnectorConnectionMutation,
  writeConnectorConnectionMetadata,
} from "./connector-connection-write.service";
import type { Tx } from "../../lib/db-types";

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
const MCP_ENDPOINT_TEMPLATE_CHARACTER_REGEX = /[{}]/;
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
  // The runner reads and strips both connector-intent names, so both stay
  // protected here. `x-vm0-connector-intent` is the legacy name older CLI
  // packages still send; it is removable with the runner's legacy handling
  // once those packages have drained (vm0-ai/vm0#33661 step 3).
  "x-okou-connector-intent",
  "x-vm0-connector-intent",
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
type DbTransaction = Tx;

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

interface CustomConnectorSharedRow {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly fields: readonly CustomConnectorField[];
  readonly headerInjections: readonly CustomConnectorHeaderInjection[];
  readonly queryInjections: readonly CustomConnectorQueryInjection[];
  readonly authMode: CustomConnectorAuthMode;
  readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
  readonly enabled: boolean;
  readonly skillMarkdown: string | null;
  readonly skillStorageVersionId: string | null;
  readonly storageVersion: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomConnectorHttpRow extends CustomConnectorSharedRow {
  readonly kind: "http";
  readonly prefixTemplates: readonly string[];
  readonly permissionBundleRef: CustomConnectorPermissionBundleRef | null;
}

export interface CustomConnectorMcpRow extends CustomConnectorSharedRow {
  readonly kind: "mcp";
  readonly endpoint: string;
  readonly transport: CustomConnectorMcpTransport;
  readonly permissionBundleRef: null;
}

export type CustomConnectorRow = CustomConnectorHttpRow | CustomConnectorMcpRow;

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

export type StoredValueRow = CustomConnectorStoredValue;

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

type PersistedHttpDefinitionRow = CustomConnectorDefinitionRow & {
  readonly mcpEndpoint: null;
  readonly mcpTransport: null;
};

type PersistedMcpDefinitionRow = CustomConnectorDefinitionRow & {
  readonly mcpEndpoint: string;
  readonly mcpTransport: "streamable-http";
  readonly permissionBundleRef: null;
};

function hasHttpDiscriminator(
  row: CustomConnectorDefinitionRow,
): row is CustomConnectorDefinitionRow & {
  readonly mcpEndpoint: null;
  readonly mcpTransport: null;
} {
  return row.mcpEndpoint === null && row.mcpTransport === null;
}

function isValidPersistedHttpDefinition(
  row: CustomConnectorDefinitionRow & {
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
  row: CustomConnectorDefinitionRow,
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

export function normaliseCustomConnectorRow(
  row: CustomConnectorDefinitionRow,
  oauthConfig: CustomConnectorOAuthConfigRow | null = null,
): CustomConnectorRow {
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
    enabled: row.enabled,
    skillMarkdown: row.skillMarkdown,
    skillStorageVersionId: row.skillStorageVersionId,
    storageVersion: row.storageVersion,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
      kind: "http",
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
    kind: "mcp",
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

function mcpDefinitionUpdateIsAccessNeutralOrReducing(args: {
  readonly existing: CustomConnectorMcpRow;
  readonly definition: ValidatedMcpDefinition;
  readonly nextOAuthConfig: CustomConnectorOAuthConfigRow | null;
  readonly requestedStorageVersion: number | undefined;
}): boolean {
  return (
    args.existing.endpoint === args.definition.endpoint &&
    args.existing.transport === args.definition.transport &&
    args.existing.authMode === args.definition.authMode &&
    jsonValuesEqual(args.existing.fields, args.definition.fields) &&
    jsonValuesEqual(
      args.existing.headerInjections,
      args.definition.headerInjections,
    ) &&
    jsonValuesEqual(
      args.existing.queryInjections,
      args.definition.queryInjections,
    ) &&
    args.existing.skillMarkdown === args.definition.skillMarkdown &&
    oauthConfigsEqual(args.existing.oauthConfig, args.nextOAuthConfig) &&
    (args.requestedStorageVersion === undefined ||
      args.requestedStorageVersion >= args.existing.storageVersion)
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
  config: CustomConnectorOAuthConfigRow,
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

function effectivePermissionBundleRef(
  row: CustomConnectorHttpRow,
): CustomConnectorPermissionBundleRef | null {
  return effectiveCustomConnectorPermissionBundleRef({
    slug: row.slug,
    authMode: row.authMode,
    oauthProviderAdapter: row.oauthConfig?.providerAdapter ?? null,
    prefixTemplates: row.prefixTemplates,
    permissionBundleRef: row.permissionBundleRef,
  });
}

export function serialiseCustomConnector(args: {
  readonly row: CustomConnectorRow;
  readonly valueMarkers: readonly CustomConnectorCredentialValueMarker[];
  readonly connectedAccountId: string | null;
  readonly connectedAccountUpdatedAt?: Date | null;
}): CustomConnectorResponse {
  const connectorMarkers = args.valueMarkers.filter((marker) => {
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
  const validManualAuth =
    args.row.authMode !== "manual" ||
    customConnectorManualAuthReferencesMemberField(args.row);
  const connected =
    args.connectedAccountId !== null &&
    validManualAuth &&
    missingRequiredFields.length === 0;
  const responseMissingRequiredFields = [
    ...missingRequiredFields,
    ...(args.row.authMode === "oauth" && args.connectedAccountId === null
      ? ["oauth"]
      : []),
  ];
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
      return {
        authMode: "oauth" as const,
        oauthConfig: serialiseOAuthConfig(args.row.oauthConfig),
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
    connected,
    ...(connected && args.connectedAccountId
      ? {
          connectedAccountId: args.connectedAccountId,
          ...(args.connectedAccountUpdatedAt
            ? {
                connectedAccountUpdatedAt:
                  args.connectedAccountUpdatedAt.toISOString(),
              }
            : {}),
        }
      : {}),
    missingRequiredFields: [...responseMissingRequiredFields],
    configuredFieldKeys: [...configured],
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
  if (!raw.startsWith("https://")) {
    return false;
  }
  const afterScheme = raw.slice("https://".length);
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
  const canonicalPrefix = validation.ok;
  const schemeEnd = canonicalPrefix.indexOf("://");
  const scheme = canonicalPrefix.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "https") {
    return badRequestMessage(`Prefix must use https://: ${args.raw}`);
  }

  return normalised;
}

function validateAndNormalizeMcpEndpoint(
  raw: string,
): string | BadRequestResponse {
  const endpoint = raw.trim();
  if (MCP_ENDPOINT_TEMPLATE_CHARACTER_REGEX.test(endpoint)) {
    return badRequestMessage("MCP endpoint must not contain templates");
  }
  const validation = safeSync(() => {
    const canonical = canonicalizeFirewallBaseUrl(
      endpoint,
      "MCP custom connector",
    );
    const url = new URL(canonical);
    if (url.protocol !== "https:") {
      throw new Error("MCP endpoint must use https://");
    }
    validateBaseUrlHostPolicy({
      base: canonical,
      serviceName: "MCP custom connector",
      hostPolicy: { kind: "publicDestination" },
    });
    return canonical;
  });
  if ("error" in validation) {
    return badRequestMessage(
      validation.error instanceof Error
        ? validation.error.message
        : "Invalid MCP endpoint",
    );
  }
  return validation.ok;
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
  if (authMode === "automatic" && input.kind !== "mcp") {
    return badRequestMessage(
      "Automatic authentication is available only for MCP Streamable HTTP connectors",
    );
  }
  if (
    authMode !== "manual" &&
    fields.some((field) => {
      return field.kind === "secret";
    })
  ) {
    return badRequestMessage(
      `${authMode === "none" ? "No-auth" : authMode === "automatic" ? "Automatic" : "OAuth"} custom connector fields must be variables`,
    );
  }
  if (
    (authMode === "none" || authMode === "automatic") &&
    input.kind === "mcp" &&
    fields.length > 0
  ) {
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

async function validatePermissionBundleRef(
  db: ReadonlyDb,
  permissionBundleRef: CustomConnectorPermissionBundleRef | null,
): Promise<BadRequestResponse | null> {
  if (permissionBundleRef === null) {
    return null;
  }
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  const bundle = await loadCustomConnectorPermissionBundle({
    catalog: snapshot.serverFirewallMetadata,
    ref: permissionBundleRef,
  });
  return bundle
    ? null
    : badRequestMessage(
        `Unknown custom connector permission bundle: ${permissionBundleRef}`,
      );
}

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
  const pathStart = canonicalUrl.indexOf("/", authorityStart);
  const authorityEnd = pathStart === -1 ? canonicalUrl.length : pathStart;
  const host = canonicalUrl
    .slice(authorityStart, authorityEnd)
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

async function findCustomConnectorPrefixConflict(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly prefixTemplates: readonly string[];
    readonly excludeConnectorId?: string;
  },
): Promise<BadRequestResponse | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custom_connector_prefixes:${args.orgId}`}, 0))`,
  );
  const existingConnectors = await tx
    .select({
      id: orgCustomConnectors.id,
      displayName: orgCustomConnectors.displayName,
      prefixTemplates: orgCustomConnectors.prefixTemplates,
    })
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.orgId, args.orgId));
  const requestedPrefixes = new Map(
    args.prefixTemplates.map((prefix) => {
      return [customConnectorPrefixTemplateIdentity(prefix), prefix] as const;
    }),
  );

  for (const connector of existingConnectors) {
    if (connector.id === args.excludeConnectorId) {
      continue;
    }
    const prefixTemplates = stringArray(connector.prefixTemplates);
    for (const prefix of prefixTemplates) {
      const requestedPrefix = requestedPrefixes.get(
        customConnectorPrefixTemplateIdentity(prefix),
      );
      if (requestedPrefix) {
        return badRequestMessage(
          `Prefix "${requestedPrefix}" is already used by custom connector "${connector.displayName}"`,
        );
      }
    }
  }
  return null;
}

async function persistCustomConnectorCreate(
  db: Db,
  args: {
    readonly connectorId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly slug: string;
    readonly definition: ValidatedDefinition;
    readonly storageVersion: number;
    readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
    readonly encryptedClientSecret: string | null;
    readonly preparedSkill: PreparedServerSideVolume | null;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly row: CustomConnectorDefinitionRow;
      readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
    }
  | BadRequestResponse
> {
  return await db.transaction(async (tx) => {
    if (args.definition.kind === "http") {
      const prefixConflict = await findCustomConnectorPrefixConflict(tx, {
        orgId: args.orgId,
        prefixTemplates: args.definition.prefixTemplates,
      });
      if (prefixConflict) {
        return prefixConflict;
      }
    }
    if (args.preparedSkill) {
      await commitPreparedCustomConnectorSkillStorage(
        { db: tx, volume: args.preparedSkill },
        signal,
      );
    }
    const [row] = await tx
      .insert(orgCustomConnectors)
      .values({
        id: args.connectorId,
        orgId: args.orgId,
        slug: args.slug,
        displayName: args.definition.displayName,
        ...protocolColumns(args.definition),
        fields: [...args.definition.fields],
        headerInjections: [...args.definition.headerInjections],
        queryInjections: [...args.definition.queryInjections],
        authMode: args.definition.authMode,
        skillMarkdown: args.definition.skillMarkdown,
        skillStorageVersionId: args.preparedSkill?.version.versionId ?? null,
        storageVersion: args.storageVersion,
        createdBy: args.userId,
      })
      .returning(customConnectorDefinitionSelection());
    if (!row) {
      throw new Error("Expected insert to return a row");
    }
    let oauthConfig: CustomConnectorOAuthConfigRow | null = null;
    if (
      args.oauthConfigUpdate.kind === "upsert" &&
      args.encryptedClientSecret
    ) {
      const [insertedOAuthConfig] = await tx
        .insert(orgCustomConnectorOauthConfigs)
        .values({
          connectorId: row.id,
          orgId: args.orgId,
          ...args.oauthConfigUpdate.config,
          encryptedClientSecret: args.encryptedClientSecret,
        })
        .returning();
      if (!insertedOAuthConfig) {
        throw new Error("Expected OAuth config insert to return a row");
      }
      oauthConfig = insertedOAuthConfig;
    }
    return { row, oauthConfig };
  });
}

export const createCustomConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateCustomConnectorBody;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse | ForbiddenResponse> => {
    const canonicalInput = definitionFromCreateInput(args.input);
    const writeDb = set(writeDb$);
    const v = validateDefinition(canonicalInput);
    if (isBadRequest(v)) {
      return v;
    }
    const featureSwitchContext =
      v.kind === "mcp"
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : null;
    signal.throwIfAborted();
    if (
      v.kind === "mcp" &&
      featureSwitchContext &&
      !isCustomConnectorMcpEnabled(featureSwitchContext)
    ) {
      return forbidden("MCP custom connector management is not enabled");
    }
    const invalidPermissionBundle = await validatePermissionBundleRef(
      writeDb,
      v.permissionBundleRef,
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
      const featureContext =
        featureSwitchContext ??
        (await get(userFeatureSwitchContext(args.orgId, args.userId)));
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
    const created = await persistCustomConnectorCreate(
      writeDb,
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
    await publishCustomConnectorOrganizationInvalidationAfterCommit(
      args.orgId,
      get(clerk$).organizations,
      signal,
      postCommitAbort,
    );
    return result;
  },
);

async function loadCustomConnectorForUpdate(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly id: string },
): Promise<CustomConnectorRow | null> {
  const [result] = await db
    .select({
      connector: customConnectorDefinitionSelection(),
      oauthConfig: orgCustomConnectorOauthConfigs,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
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
  return result
    ? normaliseCustomConnectorRow(result.connector, result.oauthConfig)
    : null;
}

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

async function deleteReplacedAutomaticOAuthData(
  tx: DbTransaction,
  args: Pick<
    PersistCustomConnectorUpdateArgs,
    "existing" | "definition" | "id" | "orgId"
  >,
): Promise<void> {
  if (
    args.existing.authMode !== "automatic" ||
    args.definition.authMode === "automatic"
  ) {
    return;
  }
  await tx
    .delete(customConnectorAccountOauthBindings)
    .where(eq(customConnectorAccountOauthBindings.customConnectorId, args.id));
  await tx
    .delete(orgCustomConnectorDcrRegistrations)
    .where(
      and(
        eq(orgCustomConnectorDcrRegistrations.customConnectorId, args.id),
        eq(orgCustomConnectorDcrRegistrations.orgId, args.orgId),
      ),
    );
}

async function persistCustomConnectorUpdate(
  db: Db,
  args: PersistCustomConnectorUpdateArgs,
  signal: AbortSignal,
): Promise<
  | {
      readonly row: CustomConnectorDefinitionRow;
      readonly oauthConfig: CustomConnectorOAuthConfigRow | null;
    }
  | BadRequestResponse
  | null
> {
  return await db.transaction(async (tx) => {
    if (args.definition.kind === "http") {
      const prefixConflict = await findCustomConnectorPrefixConflict(tx, {
        orgId: args.orgId,
        prefixTemplates: args.definition.prefixTemplates,
        excludeConnectorId: args.id,
      });
      if (prefixConflict) {
        return prefixConflict;
      }
    }
    const [locked] = await tx
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
        ),
      )
      .for("update", { of: orgCustomConnectors })
      .limit(1);
    if (!locked) {
      const [current] = await tx
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        )
        .limit(1);
      return current
        ? badRequestMessage(
            "Custom connector changed while the definition was being saved; retry",
          )
        : null;
    }
    if (args.preparedSkill) {
      await commitPreparedCustomConnectorSkillStorage(
        { db: tx, volume: args.preparedSkill },
        signal,
      );
    }
    await deleteReplacedAutomaticOAuthData(tx, args);
    const kindColumns = protocolColumns(args.definition);
    const [updated] = await tx
      .update(orgCustomConnectors)
      .set({
        displayName: args.definition.displayName,
        ...kindColumns,
        fields: [...args.definition.fields],
        headerInjections: [...args.definition.headerInjections],
        queryInjections: [...args.definition.queryInjections],
        authMode: args.definition.authMode,
        skillMarkdown: args.definition.skillMarkdown,
        skillStorageVersionId: args.preparedSkill?.version.versionId ?? null,
        storageVersion: args.storageVersion,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgCustomConnectors.id, args.id),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .returning(customConnectorDefinitionSelection());
    if (!updated) {
      throw new Error("Expected locked custom connector to be updated");
    }
    let storedOAuthConfig: CustomConnectorOAuthConfigRow | null = null;
    if (args.oauthConfigUpdate.kind === "none") {
      await tx
        .delete(orgCustomConnectorOauthConfigs)
        .where(
          and(
            eq(orgCustomConnectorOauthConfigs.connectorId, args.id),
            eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
          ),
        );
    } else if (args.oauthConfigUpdate.kind === "preserve") {
      storedOAuthConfig = args.oauthConfigUpdate.config;
    } else {
      if (!args.encryptedClientSecret) {
        throw new Error("Expected encrypted OAuth client secret");
      }
      const [upserted] = await tx
        .insert(orgCustomConnectorOauthConfigs)
        .values({
          connectorId: args.id,
          orgId: args.orgId,
          ...args.oauthConfigUpdate.config,
          encryptedClientSecret: args.encryptedClientSecret,
        })
        .onConflictDoUpdate({
          target: orgCustomConnectorOauthConfigs.connectorId,
          set: {
            ...args.oauthConfigUpdate.config,
            encryptedClientSecret: args.encryptedClientSecret,
            updatedAt: nowDate(),
          },
        })
        .returning();
      storedOAuthConfig = upserted ?? null;
    }
    return { row: updated, oauthConfig: storedOAuthConfig };
  });
}

async function persistCustomConnectorUpdateAndPublishRuntimeWakeup(
  db: Db,
  args: PersistCustomConnectorUpdateArgs,
  signal: AbortSignal,
): Promise<{
  readonly result: CustomConnectorRow | BadRequestResponse | null;
  readonly postCommitAbort?: CapturedConnectorClientInvalidationAbort;
}> {
  const result = await persistCustomConnectorUpdate(db, args, signal);
  if (isBadRequest(result) || !result) {
    return {
      result,
      ...(signal.aborted ? { postCommitAbort: { reason: signal.reason } } : {}),
    };
  }
  const connector = normaliseCustomConnectorRow(result.row, result.oauthConfig);
  if (
    args.grantConfigurationChanged ||
    connector.storageVersion !== args.existing.storageVersion
  ) {
    await publishConnectorRuntimeSyncWakeups({
      db,
      scope: { orgId: args.orgId },
      targets: [{ kind: "custom", customConnectorId: connector.id }],
    });
  }
  return {
    result: connector,
    ...(signal.aborted ? { postCommitAbort: { reason: signal.reason } } : {}),
  };
}

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

function mcpUpdateRequiresEnabledFeature(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
  readonly comparisonNextOAuthConfig: CustomConnectorOAuthConfigRow | null;
  readonly requestedStorageVersion: number | undefined;
  readonly featureEnabled: boolean;
}): boolean {
  if (
    args.featureEnabled ||
    args.existing.kind !== "mcp" ||
    args.definition.kind !== "mcp"
  ) {
    return false;
  }
  if (
    args.oauthConfigUpdate.kind === "upsert" &&
    args.oauthConfigUpdate.clientSecret !== null
  ) {
    return true;
  }
  return !mcpDefinitionUpdateIsAccessNeutralOrReducing({
    existing: args.existing,
    definition: args.definition,
    nextOAuthConfig: args.comparisonNextOAuthConfig,
    requestedStorageVersion: args.requestedStorageVersion,
  });
}

function customConnectorUpdateFeatureForbiddenMessage(args: {
  readonly existing: CustomConnectorRow;
  readonly definition: ValidatedDefinition;
  readonly oauthConfigUpdate: ValidatedOAuthConfigUpdate;
  readonly comparisonNextOAuthConfig: CustomConnectorOAuthConfigRow | null;
  readonly requestedStorageVersion: number | undefined;
  readonly featureSwitchContext: NonNullable<FeatureSwitchContextArg> | null;
}): string | null {
  if (
    mcpUpdateRequiresEnabledFeature({
      existing: args.existing,
      definition: args.definition,
      oauthConfigUpdate: args.oauthConfigUpdate,
      comparisonNextOAuthConfig: args.comparisonNextOAuthConfig,
      requestedStorageVersion: args.requestedStorageVersion,
      featureEnabled:
        args.featureSwitchContext === null ||
        isCustomConnectorMcpEnabled(args.featureSwitchContext),
    })
  ) {
    return "MCP custom connector management is not enabled";
  }
  return null;
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
    const writeDb = set(writeDb$);
    const existingConnector = await loadCustomConnectorForUpdate(writeDb, args);
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
    const invalidPermissionBundle = await validatePermissionBundleRef(
      writeDb,
      prepared.definition.permissionBundleRef,
    );
    signal.throwIfAborted();
    if (invalidPermissionBundle) {
      return invalidPermissionBundle;
    }
    const featureSwitchContext =
      existingConnector.kind === "mcp"
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : null;
    signal.throwIfAborted();
    let encryptedClientSecret =
      existingConnector.oauthConfig?.encryptedClientSecret ?? null;
    const comparisonNextOAuthConfig = nextOAuthConfigForUpdate({
      connector: existingConnector,
      orgId: args.orgId,
      update: prepared.oauthConfigUpdate,
      encryptedClientSecret,
    });
    const featureForbiddenMessage =
      customConnectorUpdateFeatureForbiddenMessage({
        existing: existingConnector,
        definition: prepared.definition,
        oauthConfigUpdate: prepared.oauthConfigUpdate,
        comparisonNextOAuthConfig,
        requestedStorageVersion: args.input.storageVersion,
        featureSwitchContext,
      });
    if (featureForbiddenMessage) {
      return forbidden(featureForbiddenMessage);
    }
    if (
      prepared.oauthConfigUpdate.kind === "upsert" &&
      prepared.oauthConfigUpdate.clientSecret
    ) {
      const featureContext =
        featureSwitchContext ??
        (await get(userFeatureSwitchContext(args.orgId, args.userId)));
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
    const { result: normalized, postCommitAbort } =
      await persistCustomConnectorUpdateAndPublishRuntimeWakeup(
        writeDb,
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
    await publishCustomConnectorOrganizationInvalidationAfterCommit(
      args.orgId,
      get(clerk$).organizations,
      signal,
      postCommitAbort,
    );
    return normalized;
  },
);

export const deleteCustomConnector$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | ForbiddenResponse | undefined> => {
    const writeDb = set(writeDb$);
    const deletion = writeDb.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: orgCustomConnectors.id,
          providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
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
      await deleteConnectorSelectionsForCustomConnectorDefinition(
        tx,
        { customConnectorId: args.id },
        signal,
      );
      await tx
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        );
      return true;
    });
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const deleted = await commitConnectorRuntimeMutation(deletion, (result) => {
      return result === true
        ? {
            db: writeDb,
            scope: { orgId: args.orgId },
            targets: [{ kind: "custom", customConnectorId: args.id }],
          }
        : undefined;
    });
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
    await publishCustomConnectorOrganizationInvalidationAfterCommit(
      args.orgId,
      get(clerk$).organizations,
      signal,
      postCommitAbort,
    );
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
  return computed(async (get): Promise<CustomConnectorResponse | null> => {
    const db = get(db$);
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    if (!connector) {
      return null;
    }
    const [markers, connectedConnections] = await Promise.all([
      loadCurrentCustomConnectorValueMarkers(db, {
        orgId: args.orgId,
        userId: args.userId,
      }),
      loadConnectedCustomConnectorConnections(db, {
        orgId: args.orgId,
        userId: args.userId,
      }),
    ]);
    const connectedAccount = customConnectorDefinitionConnectedAccount({
      connectedConnections,
      definition: connector,
    });
    return serialiseCustomConnector({
      row: connector,
      valueMarkers: markers,
      connectedAccountId: connectedAccount?.id ?? null,
      connectedAccountUpdatedAt: connectedAccount?.updatedAt,
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
    const snapshot = await loadConnectorRuntimeSnapshot(db);
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

interface CustomConnectorValueWriteState {
  readonly connector: CustomConnectorRow;
  readonly preservesStoredValues: boolean;
  readonly runtimeRecovered: boolean;
  readonly resolution: ReadyConnectorConnectionMutation;
}

async function prepareCustomConnectorValueWrite(args: {
  readonly tx: Tx;
  readonly request: SetCustomConnectorValuesArgs;
  readonly expectedConnector: CustomConnectorRow;
  readonly expectedValues: readonly CustomConnectorValueInput[];
}): Promise<
  | CustomConnectorValueWriteState
  | BadRequestResponse
  | NotFoundResponse
  | ConflictResponse
> {
  const [lockedDefinition] = await args.tx
    .select(customConnectorDefinitionSelection())
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.id, args.request.connectorId),
        eq(orgCustomConnectors.orgId, args.request.orgId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lockedDefinition) {
    return notFound("Custom connector not found");
  }
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

  const resolution = await resolveConnectorConnectionMutation(args.tx, {
    orgId: args.request.orgId,
    userId: args.request.userId,
    target: {
      kind: "custom",
      customConnectorId: args.request.connectorId,
    },
    mutation: args.request.account,
    allowSiblings: true,
  });
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

async function persistCustomConnectorValues(
  args: {
    readonly tx: Tx;
    readonly request: SetCustomConnectorValuesArgs;
    readonly expectedConnector: CustomConnectorRow;
    readonly expectedValues: readonly CustomConnectorValueInput[];
    readonly preparedValues: readonly PreparedCustomConnectorValue[];
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly connector: CustomConnectorRow;
      readonly runtimeRecovered: boolean;
      readonly connectedConnection: boolean;
      readonly connectedAccountId: string;
    }
  | BadRequestResponse
  | NotFoundResponse
  | ConflictResponse
> {
  const state = await prepareCustomConnectorValueWrite(args);
  if ("status" in state) {
    return state;
  }
  const writeValues = async (
    tx: Tx,
    connectionId: string,
    writeSignal: AbortSignal,
  ) => {
    await upsertCustomConnectorStoredValues(
      tx,
      {
        connectionId,
        fields: state.connector.fields,
        orgId: args.request.orgId,
        userId: args.request.userId,
        values: args.preparedValues,
      },
      writeSignal,
    );
  };
  const connectionArgs: ConnectorConnectionMetadataArgs = {
    orgId: args.request.orgId,
    userId: args.request.userId,
    authMethod: state.connector.authMode,
    storageVersion: state.connector.storageVersion,
    tokenExpiresAt: null,
    target: {
      kind: "custom",
      customConnectorId: args.request.connectorId,
      oauthScopes: null,
    },
  };
  let connectedAccountId: string;
  if (state.preservesStoredValues) {
    const connection = await writeConnectorConnectionMetadata(args.tx, {
      ...connectionArgs,
      resolution: state.resolution,
    });
    connectedAccountId = connection.id;
    signal.throwIfAborted();
    await writeValues(args.tx, connection.id, signal);
  } else {
    const connection = await replaceConnectorConnection(
      args.tx,
      {
        ...connectionArgs,
        resolution: state.resolution,
        writeCredentials: async ({ db, connectorId }, writeSignal) => {
          await writeValues(db, connectorId, writeSignal);
        },
      },
      signal,
    );
    connectedAccountId = connection.id;
  }
  return {
    connector: state.connector,
    runtimeRecovered: state.runtimeRecovered,
    connectedConnection: true,
    connectedAccountId,
  };
}

export const setCustomConnectorValues$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly values: readonly CustomConnectorValueInput[];
      readonly account: ConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<
    | (CustomConnectorResponse & { readonly connectedAccountId: string })
    | BadRequestResponse
    | NotFoundResponse
    | ForbiddenResponse
    | ConflictResponse
  > => {
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
    if (
      connector.kind === "mcp" &&
      !isCustomConnectorMcpEnabled(featureSwitchContext)
    ) {
      return forbidden("MCP custom connector management is not enabled");
    }
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
    const valueWrite = writeDb.transaction(async (tx) => {
      return await persistCustomConnectorValues(
        {
          tx,
          request: args,
          expectedConnector: connector,
          expectedValues: values,
          preparedValues,
        },
        signal,
      );
    });
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const writeResult = await commitConnectorRuntimeMutation(
      valueWrite,
      (result) => {
        return !("status" in result) && result.runtimeRecovered
          ? {
              db: writeDb,
              scope: { orgId: args.orgId, userId: args.userId },
              targets: [
                { kind: "custom", customConnectorId: args.connectorId },
              ],
            }
          : undefined;
      },
    );
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if ("status" in writeResult) {
      signal.throwIfAborted();
      return writeResult;
    }
    await publishCustomConnectorUserInvalidationAfterCommit(
      args.userId,
      signal,
      postCommitAbort,
    );

    const db = get(db$);
    const markers = await loadCurrentCustomConnectorValueMarkers(db, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    return {
      ...serialiseCustomConnector({
        row: writeResult.connector,
        valueMarkers: markers,
        connectedAccountId: writeResult.connectedAccountId,
      }),
      connectedAccountId: writeResult.connectedAccountId,
    };
  },
);

export const deleteCustomConnectorAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly memberConnectorId: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const deletion = writeDb.transaction(async (tx) => {
      const [connector] = await tx
        .select({
          oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
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
        .for("update", { of: orgCustomConnectors })
        .limit(1);
      signal.throwIfAborted();
      if (!connector) {
        return { kind: "missing" as const };
      }
      if (
        isIntegrationManagedCustomConnectorProviderAdapter(
          connector.oauthProviderAdapter,
        )
      ) {
        return { kind: "managed" as const };
      }
      return await deleteCustomConnectorMemberConnectionExact(tx, args, signal);
    });
    const result = await commitConnectorRuntimeMutation(deletion, (value) => {
      return value.kind === "deleted"
        ? {
            db: writeDb,
            scope: { orgId: args.orgId, userId: args.userId },
            targets: [
              { kind: "custom" as const, customConnectorId: args.connectorId },
            ],
          }
        : undefined;
    });
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (result.kind !== "deleted") {
      signal.throwIfAborted();
      return result;
    }
    await publishCustomConnectorUserInvalidationAfterCommit(
      args.userId,
      signal,
      postCommitAbort,
    );
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

export function renderTemplateForRuntime(args: {
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

type CustomConnectorRuntimeDataTimingStep =
  | "connectorRows"
  | "connectorValueRows";
type CustomConnectorRuntimeDataTimingMeasure = <T>(
  step: CustomConnectorRuntimeDataTimingStep,
  operation: () => Promise<T>,
) => Promise<T>;

export async function loadCustomConnectorRuntimeData(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[] | undefined;
    readonly memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>;
    readonly measure?: CustomConnectorRuntimeDataTimingMeasure;
  },
): Promise<
  readonly {
    readonly connector: CustomConnectorRow;
    readonly values: readonly StoredValueRow[];
    readonly credentialAccess: CustomConnectorCredentialAccess;
  }[]
> {
  const measure =
    args.measure ??
    (async <T>(
      _step: CustomConnectorRuntimeDataTimingStep,
      operation: () => Promise<T>,
    ) => {
      return await operation();
    });
  const connectorRows = await measure("connectorRows", async () => {
    return await db
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
        args.connectorIds
          ? and(
              eq(orgCustomConnectors.orgId, args.orgId),
              eq(orgCustomConnectors.enabled, true),
              inArray(orgCustomConnectors.id, [...args.connectorIds]),
            )
          : and(
              eq(orgCustomConnectors.orgId, args.orgId),
              eq(orgCustomConnectors.enabled, true),
            ),
      );
  });
  if (connectorRows.length === 0) {
    return [];
  }

  return await measure("connectorValueRows", async () => {
    const definitions = connectorRows.map((row) => {
      return {
        id: row.connector.id,
        authMode: row.connector.authMode,
        storageVersion: row.connector.storageVersion,
      };
    });
    const runtimeStorage = await loadCurrentCustomConnectorStoredValues(db, {
      orgId: args.orgId,
      userId: args.userId,
      definitions,
      memberConnectorIdsByCustomConnectorId:
        args.memberConnectorIdsByCustomConnectorId,
    });
    const valuesByConnectorId = new Map<string, StoredValueRow[]>();
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
    const writeDb = set(writeDb$);
    const added = await addUserCustomConnector(writeDb, {
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
      added.status === "invalidCustomConnectorPermissions" ||
      added.status === "mcpFeatureDisabled"
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
      ...(authorizedAgentId ? { authorizedAgentId } : {}),
    };
  },
);
