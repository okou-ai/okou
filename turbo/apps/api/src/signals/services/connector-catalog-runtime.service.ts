import { createHash } from "node:crypto";

import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  getConnectorAuthProviderRegistrationCapabilities,
  type ConnectorAuthProviderRegistrationCapability,
} from "@okouai/connectors/auth-providers";
import {
  CONNECTOR_PLATFORM_SECRET_NAMES,
  type ConnectorAccessConfig,
  type ConnectorAuthClientConfig,
  type ConnectorAuthMethodRuntimeConfig,
  type ConnectorDeviceAuthStartOptionConfig,
  type ConnectorEnvBindingValue,
  type ConnectorGrantOutputBindings,
  type ConnectorPlatformSecretName,
  type PublicConnectorAuthClientConfig,
  type ConnectorRefreshTokenInputBindings,
  type ConnectorRefreshTokenOutputBindings,
  type ConnectorRevokeInputBindings,
  type ConnectorSecretValueRef,
  type ConnectorVariableValueRef,
} from "@okouai/connectors/connector-config";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { onRejection } from "../utils";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type {
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
  ConnectorCatalogSkill,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  getConnectorCatalogResolutionDetail,
  listAcceptedConnectorCatalogAvailableSlugs,
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import {
  ConnectorCatalogLoadTiming,
  type ConnectorRuntimeProjectionCacheObservation,
} from "./connector-catalog-load-timing.service";
import {
  countConnectorCatalogRuntimeProjectionRows,
  queryConnectorCatalogRuntimeProjectionRows,
  readConnectorCatalogRuntimeProjectionIdentity,
  validateConnectorCatalogRuntimeProjectionRows,
  type ConnectorCatalogRuntimeProjectionFallbackReason,
  type ConnectorCatalogRuntimeProjectionIdentity,
  type ConnectorCatalogRuntimeProjectionReadyIdentity,
  type ConnectorCatalogRuntimeProjectionRowsRead,
} from "./connector-catalog-runtime-projection.service";
import {
  createAcceptedConnectorServerFirewallCatalog,
  createAcceptedConnectorServerFirewallCatalogFromConnectors,
  selectConnectorServerFirewalls,
  type ConnectorServerFirewallCatalog,
  type ConnectorServerFirewallMetadataCatalog,
  type ConnectorServerFirewallSelection,
} from "./connector-server-firewall-catalog.service";

export interface ConnectorRuntimeMethod {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly executable: boolean;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}

export interface ConnectorRuntimeConnector {
  readonly connectorSlug: ConnectorSlug;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly methods: ReadonlyMap<ConnectorAuthMethodId, ConnectorRuntimeMethod>;
  readonly authoredVisibleMethodIds: ReadonlySet<ConnectorAuthMethodId>;
  readonly skill: ConnectorCatalogSkill;
}

export interface ConnectorRuntimeSelection {
  readonly catalogIdentity: ExternalCatalogIdentity;
  readonly connectors: ReadonlyMap<ConnectorSlug, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallSelection;
  readonly serverFirewallMetadata: ConnectorServerFirewallMetadataCatalog;
}

export interface ConnectorRuntimeSnapshot extends ConnectorRuntimeSelection {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
  readonly serverFirewallMetadata: ConnectorServerFirewallCatalog;
}

function methodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

const providerRegistrations = singleton(() => {
  return new Map(
    getConnectorAuthProviderRegistrationCapabilities().map((registration) => {
      return [
        methodKey(registration.connectorSlug, registration.authMethodId),
        registration,
      ];
    }),
  );
});

function providerRegistrationFor(
  connectorSlug: string,
  authMethodId: string,
): ConnectorAuthProviderRegistrationCapability | null {
  return (
    providerRegistrations().get(methodKey(connectorSlug, authMethodId)) ?? null
  );
}

function providerBackedGrant(
  kind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
): kind is "auth-code" | "device-auth" | "external-code" | "openid-auth" {
  return (
    kind === "auth-code" ||
    kind === "device-auth" ||
    kind === "external-code" ||
    kind === "openid-auth"
  );
}

function registrationSupportsMethod(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly registration: ConnectorAuthProviderRegistrationCapability | null;
}): boolean {
  if (
    providerBackedGrant(args.method.grant.kind) &&
    args.registration?.handlers.grant !== args.method.grant.kind
  ) {
    return false;
  }
  if (
    args.method.access.kind === "refresh-token" &&
    args.registration?.handlers.access !== "refresh-token"
  ) {
    return false;
  }
  if (
    args.method.revoke.kind === "token-revoke" &&
    args.registration?.handlers.revoke !== "token-revoke"
  ) {
    return false;
  }
  return true;
}

function isSecretValueRef(value: string): value is ConnectorSecretValueRef {
  return /^\$secrets\.[A-Z][A-Z0-9_]*$/u.test(value);
}

function isVariableValueRef(value: string): value is ConnectorVariableValueRef {
  return /^\$vars\.[A-Z][A-Z0-9_]*$/u.test(value);
}

function outputValueRef(
  value: string,
): ConnectorSecretValueRef | ConnectorVariableValueRef {
  if (isSecretValueRef(value) || isVariableValueRef(value)) {
    return value;
  }
  throw new Error("Invalid accepted connector value reference");
}

function secretValueRef(value: string): ConnectorSecretValueRef {
  if (isSecretValueRef(value)) {
    return value;
  }
  throw new Error("Invalid accepted connector secret reference");
}

function outputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorGrantOutputBindings {
  const result: ConnectorGrantOutputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function refreshInputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRefreshTokenInputBindings {
  const result: ConnectorRefreshTokenInputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function refreshOutputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRefreshTokenOutputBindings {
  const result: ConnectorRefreshTokenOutputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = outputValueRef(value);
  }
  return result;
}

function revokeInputBindings(
  bindings: Readonly<Record<string, string>>,
): ConnectorRevokeInputBindings {
  const result: ConnectorRevokeInputBindings = {};
  for (const [name, value] of Object.entries(bindings)) {
    result[name] = secretValueRef(value);
  }
  return result;
}

function envBindingValue(
  binding: string | { readonly valueRef: string; readonly optional: true },
): ConnectorEnvBindingValue {
  return typeof binding === "string"
    ? outputValueRef(binding)
    : { valueRef: outputValueRef(binding.valueRef), optional: true };
}

function platformSecretName(value: string): ConnectorPlatformSecretName {
  const name = CONNECTOR_PLATFORM_SECRET_NAMES.find((candidate) => {
    return candidate === value;
  });
  if (name === undefined) {
    throw new Error("Unsupported accepted connector platform secret");
  }
  return name;
}

function runtimeAccess(
  access: ConnectorCatalogAuthMethod["access"],
): ConnectorAccessConfig {
  if (access.kind === "none" || access.kind === "automatic") {
    throw new Error("Unsupported accepted connector access capability");
  }
  const envBindings: Record<string, ConnectorEnvBindingValue> = {};
  for (const [name, binding] of Object.entries(access.envBindings)) {
    envBindings[name] = envBindingValue(binding);
  }
  const platformSecrets = access.platformSecrets?.map(platformSecretName);
  if (access.kind === "static") {
    return {
      kind: "static",
      envBindings,
      ...(platformSecrets === undefined ? {} : { platformSecrets }),
    };
  }
  return {
    kind: "refresh-token",
    envBindings,
    ...(platformSecrets === undefined ? {} : { platformSecrets }),
    inputs: refreshInputBindings(access.inputs),
    outputs: refreshOutputBindings(access.outputs),
    refreshableSecrets: [...access.refreshableSecrets],
  };
}

function runtimeClient(
  client: ConnectorCatalogAuthMethod["client"],
): ConnectorAuthClientConfig | undefined {
  return client === undefined ? undefined : { ...client };
}

function requiredRuntimeClient(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthClientConfig {
  const client = runtimeClient(method.client);
  if (client === undefined) {
    throw new Error("Accepted connector auth method is missing its client");
  }
  return client;
}

function requiredPublicRuntimeClient(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorAuthClientConfig {
  const client = requiredRuntimeClient(method);
  if (client.clientType !== "public") {
    throw new Error("Accepted device auth method requires a public client");
  }
  return client;
}

function manualGrant(
  grant: Extract<ConnectorCatalogAuthMethod["grant"], { kind: "manual" }>,
): Extract<ConnectorAuthMethodRuntimeConfig["grant"], { kind: "manual" }> {
  const fields: Record<
    string,
    Extract<
      ConnectorAuthMethodRuntimeConfig["grant"],
      { kind: "manual" }
    >["fields"][string]
  > = {};
  for (const field of grant.fields) {
    fields[field.privateName] = {
      publicId: field.publicId,
      label: field.label,
      required: field.required,
      ...(field.placeholder === null ? {} : { placeholder: field.placeholder }),
      storage: field.storage,
      ...(field.normalize === undefined ? {} : { normalize: field.normalize }),
    };
  }
  return { kind: "manual", fields };
}

function deviceStartOption(
  option: Extract<
    ConnectorCatalogAuthMethod["grant"],
    { kind: "device-auth" }
  >["startOptions"][number],
): ConnectorDeviceAuthStartOptionConfig {
  const [first, ...rest] = option.options;
  if (first === undefined) {
    throw new Error("Accepted connector device option has no choices");
  }
  return {
    kind: "select",
    publicId: option.publicId,
    label: option.label,
    required: option.required,
    ...(option.defaultValue === null
      ? {}
      : { defaultValue: option.defaultValue }),
    options: [
      { ...first },
      ...rest.map((choice) => {
        return { ...choice };
      }),
    ],
  };
}

function deviceStartOptions(
  grant: Extract<ConnectorCatalogAuthMethod["grant"], { kind: "device-auth" }>,
): Readonly<Record<string, ConnectorDeviceAuthStartOptionConfig>> | undefined {
  const options: Record<string, ConnectorDeviceAuthStartOptionConfig> = {};
  for (const option of grant.startOptions) {
    options[option.privateName] = deviceStartOption(option);
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function runtimeMethod(
  method: ConnectorCatalogAuthMethod,
): ConnectorAuthMethodRuntimeConfig {
  const access = runtimeAccess(method.access);
  const revoke: ConnectorAuthMethodRuntimeConfig["revoke"] =
    method.revoke.kind === "none"
      ? { kind: "none" }
      : {
          kind: "token-revoke",
          inputs: revokeInputBindings(method.revoke.inputs),
          ...(method.revoke.revokePreviousOnReplace === undefined
            ? {}
            : {
                revokePreviousOnReplace: method.revoke.revokePreviousOnReplace,
              }),
        };
  const storage = {
    version: method.storage.version,
    secrets: [...method.storage.secrets],
    variables: [...method.storage.variables],
  };

  switch (method.grant.kind) {
    case "none":
    case "automatic": {
      throw new Error("Unsupported accepted connector grant capability");
    }
    case "manual": {
      return {
        storage,
        grant: manualGrant(method.grant),
        access,
        revoke,
        ...(method.client === undefined
          ? {}
          : { client: runtimeClient(method.client) }),
      };
    }
    case "auth-code": {
      return {
        client: requiredRuntimeClient(method),
        storage,
        grant: {
          kind: "auth-code",
          scopes: [...method.grant.scopes],
          callbackOrigin: method.grant.callbackOrigin,
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "openid-auth": {
      return {
        ...(method.client === undefined
          ? {}
          : { client: runtimeClient(method.client) }),
        storage,
        grant: {
          kind: "openid-auth",
          callbackOrigin: method.grant.callbackOrigin,
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "external-code": {
      return {
        client: requiredRuntimeClient(method),
        storage,
        grant: {
          kind: "external-code",
          scopes: [...method.grant.scopes],
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
    }
    case "device-auth": {
      const startOptions = deviceStartOptions(method.grant);
      return {
        client: requiredPublicRuntimeClient(method),
        storage,
        grant: {
          kind: "device-auth",
          scopes: [...method.grant.scopes],
          outputs: outputBindings(method.grant.outputs),
          ...(startOptions === undefined ? {} : { startOptions }),
        },
        access,
        revoke,
      };
    }
  }
}

function runtimeMethodEntry(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
}): ConnectorRuntimeMethod {
  const registration = providerRegistrationFor(
    args.connectorSlug,
    args.catalogMethod.id,
  );
  return {
    connectorSlug: args.connectorSlug,
    authMethodId: args.catalogMethod.id,
    catalogMethod: args.catalogMethod,
    method: args.method,
    registration,
    executable: registrationSupportsMethod({
      method: args.method,
      registration,
    }),
  };
}

function runtimeConnector(
  connector: ConnectorCatalogArtifactConnector,
  filteredMethodKeys: ReadonlySet<string>,
): ConnectorRuntimeConnector {
  const connectorSlug = connector.slug;
  const catalogConnector = getConnectorCatalogResolutionDetail(connector);
  const catalogMethods = new Map(
    catalogConnector.authMethods.map((method) => {
      return [method.id, method];
    }),
  );
  const methods = new Map<ConnectorAuthMethodId, ConnectorRuntimeMethod>();
  const authoredVisibleMethodIds = new Set<ConnectorAuthMethodId>();
  for (const method of connector.authMethods) {
    if (method.visible) {
      authoredVisibleMethodIds.add(method.id);
    }
    // Catalog recognition does not enable execution. The builtin MCP runtime
    // and generic authentication capabilities are delivered in #34910/#34911.
    if (
      connector.mcp !== undefined ||
      method.grant.kind === "none" ||
      method.grant.kind === "automatic" ||
      method.access.kind === "none" ||
      method.access.kind === "automatic"
    ) {
      continue;
    }
    if (filteredMethodKeys.has(methodKey(connectorSlug, method.id))) {
      continue;
    }
    const catalogMethod = catalogMethods.get(method.id);
    if (catalogMethod === undefined) {
      throw new Error("Accepted connector auth method alignment is incomplete");
    }
    methods.set(
      method.id,
      runtimeMethodEntry({
        connectorSlug,
        catalogMethod,
        method: runtimeMethod(method),
      }),
    );
  }
  return {
    connectorSlug,
    catalogConnector,
    methods,
    authoredVisibleMethodIds,
    skill: connector.skill,
  };
}

function runtimeCatalogKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

interface ConnectorRuntimeState {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
  readonly connectors: Map<ConnectorSlug, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
  snapshot: ConnectorRuntimeSnapshot | undefined;
}

interface RuntimeCatalogCache {
  key: string | undefined;
  state: ConnectorRuntimeState | undefined;
}

const runtimeCatalogCache = singleton((): RuntimeCatalogCache => {
  return { key: undefined, state: undefined };
});

function materializeConnectorRuntimeEntry(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  connectors: Map<ConnectorSlug, ConnectorRuntimeConnector>,
  connectorSlug: ConnectorSlug,
): ConnectorRuntimeConnector {
  const cached = connectors.get(connectorSlug);
  if (cached !== undefined) {
    return cached;
  }
  const source = acceptedSnapshot.connectorBySlug.get(connectorSlug);
  if (source === undefined) {
    throw new Error("Accepted connector runtime source is unavailable");
  }
  const connector = runtimeConnector(
    source,
    acceptedSnapshot.filteredMethodKeys,
  );
  connectors.set(connectorSlug, connector);
  return connector;
}

function connectorRuntimeState(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  timing: ConnectorCatalogLoadTiming | undefined,
): { readonly state: ConnectorRuntimeState; readonly created: boolean } {
  const key = runtimeCatalogKey(acceptedSnapshot.identity);
  const cache = runtimeCatalogCache();
  if (cache.key === key && cache.state !== undefined) {
    return { state: cache.state, created: false };
  }
  const connectors = new Map<ConnectorSlug, ConnectorRuntimeConnector>();
  const createServerFirewalls = (): ConnectorServerFirewallCatalog => {
    return createAcceptedConnectorServerFirewallCatalog({
      artifact: acceptedSnapshot.artifact,
      runtimeMethodsForSlug: (connectorSlug) => {
        return [
          ...materializeConnectorRuntimeEntry(
            acceptedSnapshot,
            connectors,
            connectorSlug,
          ).methods.values(),
        ].map((method) => {
          return method.method;
        });
      },
    });
  };
  const state: ConnectorRuntimeState = {
    acceptedSnapshot,
    connectors,
    serverFirewalls: timing
      ? timing.measureSync(
          "api_dispatch_connector_catalog_materialize_server_firewalls",
          () => {
            return createServerFirewalls();
          },
        )
      : createServerFirewalls(),
    snapshot: undefined,
  };
  cache.key = key;
  cache.state = state;
  return { state, created: true };
}

function acceptedRequestedConnectorSlugs(
  acceptedSnapshot: AcceptedConnectorCatalogSnapshot,
  requestedConnectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  return [...new Set(requestedConnectorSlugs)].filter((connectorSlug) => {
    return acceptedSnapshot.connectorBySlug.has(connectorSlug);
  });
}

function selectedRuntimeConnectors(
  state: ConnectorRuntimeState,
  connectorSlugs: readonly ConnectorSlug[],
): ReadonlyMap<ConnectorSlug, ConnectorRuntimeConnector> {
  return new Map(
    connectorSlugs.map(
      (connectorSlug): [ConnectorSlug, ConnectorRuntimeConnector] => {
        return [
          connectorSlug,
          materializeConnectorRuntimeEntry(
            state.acceptedSnapshot,
            state.connectors,
            connectorSlug,
          ),
        ];
      },
    ),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSortedConnectorSlugs(
  connectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  return [...new Set(connectorSlugs)].sort(compareStrings);
}

function projectionIdentityKey(
  identity: ConnectorCatalogRuntimeProjectionIdentity,
): string {
  return [
    identity.projectionSetId,
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
    identity.projectionVersion,
    identity.connectorCount,
  ].join("\0");
}

function externalCatalogIdentity(
  identity: ConnectorCatalogRuntimeProjectionIdentity,
): ExternalCatalogIdentity {
  return {
    sourceId: identity.sourceId,
    schemaVersion: identity.schemaVersion,
    catalogVersion: identity.catalogVersion,
    catalogDigest: identity.catalogDigest,
    capabilityDigest: identity.capabilityDigest,
  };
}

function runtimeSelectionProjectionKey(args: {
  readonly identity: ConnectorCatalogRuntimeProjectionIdentity;
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): string {
  return [
    projectionIdentityKey(args.identity),
    "runtime",
    ...args.runtimeConnectorSlugs,
    "metadata",
    ...args.metadataConnectorSlugs,
  ].join("\0");
}

function requestedProjectionConnectorSlugs(args: {
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): readonly ConnectorSlug[] {
  return uniqueSortedConnectorSlugs([
    ...args.runtimeConnectorSlugs,
    ...args.metadataConnectorSlugs,
  ]);
}

function selectedArtifacts(args: {
  readonly connectorBySlug: ReadonlyMap<
    ConnectorSlug,
    ConnectorCatalogArtifactConnector
  >;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): readonly ConnectorCatalogArtifactConnector[] {
  return args.connectorSlugs.flatMap((connectorSlug) => {
    const connector = args.connectorBySlug.get(connectorSlug);
    return connector === undefined ? [] : [connector];
  });
}

function runtimeSelectionFromProjectedConnectors(args: {
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectors: readonly ConnectorCatalogArtifactConnector[];
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): ConnectorRuntimeSelection {
  const connectorBySlug = new Map(
    args.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  const runtimeArtifacts = selectedArtifacts({
    connectorBySlug,
    connectorSlugs: args.runtimeConnectorSlugs,
  });
  const runtimeConnectors = new Map(
    runtimeArtifacts.map((connector) => {
      return [
        connector.slug,
        runtimeConnector(connector, args.projection.filteredMethodKeys),
      ] as const;
    }),
  );
  const runtimeCatalog =
    createAcceptedConnectorServerFirewallCatalogFromConnectors({
      connectors: runtimeArtifacts,
      runtimeMethodsForSlug: (connectorSlug) => {
        return [
          ...(runtimeConnectors.get(connectorSlug)?.methods.values() ?? []),
        ].map((method) => {
          return method.method;
        });
      },
    });
  const metadataArtifacts = selectedArtifacts({
    connectorBySlug,
    connectorSlugs: uniqueSortedConnectorSlugs([
      ...args.runtimeConnectorSlugs,
      ...args.metadataConnectorSlugs,
    ]),
  });
  const metadataCatalog =
    createAcceptedConnectorServerFirewallCatalogFromConnectors({
      connectors: metadataArtifacts,
      runtimeMethodsForSlug: (connectorSlug) => {
        return [
          ...(runtimeConnectors.get(connectorSlug)?.methods.values() ?? []),
        ].map((method) => {
          return method.method;
        });
      },
    });
  return {
    catalogIdentity: externalCatalogIdentity(args.projection.identity),
    connectors: runtimeConnectors,
    serverFirewalls: selectConnectorServerFirewalls({
      catalog: runtimeCatalog,
      connectorSlugs: args.runtimeConnectorSlugs,
    }),
    serverFirewallMetadata: metadataCatalog,
  };
}

async function loadCompleteRuntimeSelection(args: {
  readonly db: ReadonlyDb;
  readonly timing: ConnectorCatalogLoadTiming;
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): Promise<ConnectorRuntimeSelection> {
  const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(
    args.db,
    args.timing,
  );
  const connectorSlugs = acceptedRequestedConnectorSlugs(
    acceptedSnapshot,
    args.runtimeConnectorSlugs,
  );
  args.timing.recordCatalogFacts({
    rawSize: acceptedSnapshot.catalogRawSize,
    compressedSize: acceptedSnapshot.catalogCompressedSize,
    connectorCount: acceptedSnapshot.artifact.connectors.length,
    resolvedConnectorCount: connectorSlugs.length,
  });
  const { state, created } = connectorRuntimeState(
    acceptedSnapshot,
    args.timing,
  );
  const missingConnectorSlugs = connectorSlugs.filter((connectorSlug) => {
    return !state.connectors.has(connectorSlug);
  });
  const cacheMiss = created || missingConnectorSlugs.length > 0;
  args.timing.recordRuntimeCacheOutcome(cacheMiss ? "miss" : "hit");
  args.timing.recordMaterializedConnectorCount(missingConnectorSlugs.length);
  if (cacheMiss) {
    args.timing.measureSync(
      "api_dispatch_connector_catalog_materialize_runtime_snapshot",
      () => {
        for (const connectorSlug of missingConnectorSlugs) {
          materializeConnectorRuntimeEntry(
            state.acceptedSnapshot,
            state.connectors,
            connectorSlug,
          );
        }
      },
    );
  }
  return {
    catalogIdentity: acceptedSnapshot.identity,
    connectors: selectedRuntimeConnectors(state, connectorSlugs),
    serverFirewalls: selectConnectorServerFirewalls({
      catalog: state.serverFirewalls,
      connectorSlugs,
    }),
    serverFirewallMetadata: selectConnectorServerFirewalls({
      catalog: state.serverFirewalls,
      connectorSlugs: uniqueSortedConnectorSlugs([
        ...connectorSlugs,
        ...args.metadataConnectorSlugs,
      ]),
    }),
  };
}

interface RuntimeSelectionLoad {
  readonly selection: ConnectorRuntimeSelection;
  readonly source: "projection" | "full_fallback";
  readonly fallbackReason?: ConnectorCatalogRuntimeProjectionFallbackReason;
}

interface RuntimeSelectionBuildResult {
  readonly key: string;
  readonly load: RuntimeSelectionLoad;
  readonly cacheable: boolean;
}

interface RuntimeSelectionCache {
  completed:
    | {
        readonly key: string;
        readonly load: RuntimeSelectionLoad;
      }
    | undefined;
  inFlight:
    | {
        readonly key: string;
        readonly promise: Promise<RuntimeSelectionBuildResult>;
      }
    | undefined;
}

const runtimeSelectionCache = singleton((): RuntimeSelectionCache => {
  return { completed: undefined, inFlight: undefined };
});

interface RuntimeSelectionObservationHistory {
  identityDigest: string | undefined;
  readonly selectionDigests: string[];
}

// This is a diagnostic window, not a payload-cache capacity. Keep only fixed-size
// digests locally; neither the digests nor the original keys are telemetry fields.
const RUNTIME_SELECTION_OBSERVATION_WINDOW = 16;
const runtimeSelectionObservationHistory = singleton(
  (): RuntimeSelectionObservationHistory => {
    return { identityDigest: undefined, selectionDigests: [] };
  },
);

function observeRuntimeSelection(
  identity: ConnectorCatalogRuntimeProjectionIdentity,
  key: string,
): ConnectorRuntimeProjectionCacheObservation {
  const history = runtimeSelectionObservationHistory();
  const identityDigest = createHash("sha256")
    .update(projectionIdentityKey(identity))
    .digest("hex");
  const selectionDigest = createHash("sha256").update(key).digest("hex");
  const previousIdentity = history.identityDigest;
  if (previousIdentity !== identityDigest) {
    history.identityDigest = identityDigest;
    history.selectionDigests.length = 0;
  }
  const index = history.selectionDigests.indexOf(selectionDigest);
  if (index !== -1) {
    history.selectionDigests.splice(index, 1);
  }
  history.selectionDigests.unshift(selectionDigest);
  if (history.selectionDigests.length > RUNTIME_SELECTION_OBSERVATION_WINDOW) {
    history.selectionDigests.pop();
  }

  if (previousIdentity === undefined) {
    return "first_observation";
  }
  if (previousIdentity !== identityDigest) {
    return "identity_changed";
  }
  if (index === -1) {
    return "not_in_recent_history";
  }
  if (index === 0) {
    return "reuse_1";
  }
  if (index === 1) {
    return "reuse_2";
  }
  if (index < 4) {
    return "reuse_3_4";
  }
  if (index < 8) {
    return "reuse_5_8";
  }
  return "reuse_9_16";
}

async function completeRuntimeSelectionFallback(args: {
  readonly db: ReadonlyDb;
  readonly timing: ConnectorCatalogLoadTiming;
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
  readonly reason: ConnectorCatalogRuntimeProjectionFallbackReason;
}): Promise<RuntimeSelectionLoad> {
  return {
    selection: await loadCompleteRuntimeSelection(args),
    source: "full_fallback",
    fallbackReason: args.reason,
  };
}

async function completeRuntimeSelectionBuildFallback(args: {
  readonly db: ReadonlyDb;
  readonly timing: ConnectorCatalogLoadTiming;
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
  readonly key: string;
  readonly reason: ConnectorCatalogRuntimeProjectionFallbackReason;
}): Promise<RuntimeSelectionBuildResult> {
  return {
    key: args.key,
    cacheable: false,
    load: await completeRuntimeSelectionFallback(args),
  };
}

function materializeProjectedRuntimeSelection(args: {
  readonly timing: ConnectorCatalogLoadTiming;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectors: readonly ConnectorCatalogArtifactConnector[];
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): ConnectorRuntimeSelection {
  const selection = args.timing.measureSync(
    "api_dispatch_connector_catalog_materialize_projection",
    () => {
      return runtimeSelectionFromProjectedConnectors(args);
    },
  );
  args.timing.recordMaterializedConnectorCount(selection.connectors.size);
  return selection;
}

async function readProjectedRuntimeRows(args: {
  readonly db: ReadonlyDb;
  readonly timing: ConnectorCatalogLoadTiming;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): Promise<ConnectorCatalogRuntimeProjectionRowsRead> {
  if (args.connectorSlugs.length === 0) {
    return { kind: "ready", connectors: [], missingConnectorSlugs: [] };
  }
  return await args.timing.measure(
    "api_dispatch_connector_catalog_query_projection_rows",
    async () => {
      const connectorSlugs = [...new Set(args.connectorSlugs)];
      const rows = await args.timing.measure(
        "api_dispatch_connector_catalog_fetch_projection_rows",
        async () => {
          return await queryConnectorCatalogRuntimeProjectionRows({
            db: args.db,
            projection: args.projection,
            connectorSlugs,
          });
        },
      );
      return args.timing.measureProjectionRowValidation((timing) => {
        return validateConnectorCatalogRuntimeProjectionRows({
          rows,
          connectorSlugs,
          timing,
        });
      });
    },
  );
}

async function buildProjectedRuntimeSelection(args: {
  readonly db: ReadonlyDb;
  readonly timing: ConnectorCatalogLoadTiming;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): Promise<RuntimeSelectionBuildResult> {
  let projection = args.projection;
  const selectedConnectorSlugs = requestedProjectionConnectorSlugs(args);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = runtimeSelectionProjectionKey({
      identity: projection.identity,
      runtimeConnectorSlugs: args.runtimeConnectorSlugs,
      metadataConnectorSlugs: args.metadataConnectorSlugs,
    });
    const rows = await readProjectedRuntimeRows({
      db: args.db,
      timing: args.timing,
      projection,
      connectorSlugs: selectedConnectorSlugs,
    });
    if (rows.kind === "fallback") {
      return await completeRuntimeSelectionBuildFallback({
        ...args,
        key,
        reason: rows.reason,
      });
    }
    if (rows.missingConnectorSlugs.length === 0) {
      const selection = materializeProjectedRuntimeSelection({
        ...args,
        projection,
        connectors: rows.connectors,
      });
      return {
        key,
        cacheable: true,
        load: {
          selection,
          source: "projection",
        },
      };
    }
    const actualConnectorCount = await args.timing.measure(
      "api_dispatch_connector_catalog_count_projection_rows",
      async () => {
        return await countConnectorCatalogRuntimeProjectionRows({
          db: args.db,
          identity: projection.identity,
        });
      },
    );
    const confirmedRows =
      actualConnectorCount === projection.identity.connectorCount
        ? await readProjectedRuntimeRows({
            db: args.db,
            timing: args.timing,
            projection,
            connectorSlugs: rows.missingConnectorSlugs,
          })
        : undefined;
    const latest = await args.timing.measure(
      "api_dispatch_connector_catalog_query_projection_identity",
      async () => {
        return await readConnectorCatalogRuntimeProjectionIdentity(args.db);
      },
    );
    if (latest.kind === "fallback") {
      return await completeRuntimeSelectionBuildFallback({
        ...args,
        key,
        reason: latest.reason,
      });
    }
    if (
      projectionIdentityKey(latest.projection.identity) !==
      projectionIdentityKey(projection.identity)
    ) {
      if (attempt === 0) {
        projection = latest.projection;
        continue;
      }
      return await completeRuntimeSelectionBuildFallback({
        ...args,
        key,
        reason: "unstable",
      });
    }
    if (actualConnectorCount !== projection.identity.connectorCount) {
      return await completeRuntimeSelectionBuildFallback({
        ...args,
        key,
        reason: "incomplete",
      });
    }
    if (confirmedRows?.kind === "fallback") {
      return await completeRuntimeSelectionBuildFallback({
        ...args,
        key,
        reason: confirmedRows.reason,
      });
    }
    const selection = materializeProjectedRuntimeSelection({
      ...args,
      projection,
      connectors: [...rows.connectors, ...(confirmedRows?.connectors ?? [])],
    });
    return {
      key,
      cacheable: true,
      load: {
        selection,
        source: "projection",
      },
    };
  }
  throw new Error("Connector runtime projection retry exhausted");
}

function clearRuntimeSelectionInFlight(
  cache: RuntimeSelectionCache,
  key: string,
  promise: Promise<RuntimeSelectionBuildResult>,
): void {
  if (cache.inFlight?.key === key && cache.inFlight.promise === promise) {
    cache.inFlight = undefined;
  }
}

export async function loadConnectorRuntimeSelection(
  db: ReadonlyDb,
  options: {
    readonly timing?: ApiDispatchTimingCollector;
    readonly requestedConnectorSlugs: readonly ConnectorSlug[];
    readonly metadataConnectorSlugs?: readonly ConnectorSlug[];
  },
): Promise<ConnectorRuntimeSelection> {
  const runtimeConnectorSlugs = uniqueSortedConnectorSlugs(
    options.requestedConnectorSlugs,
  );
  const metadataConnectorSlugs = uniqueSortedConnectorSlugs(
    options.metadataConnectorSlugs ?? [],
  );
  const timing = new ConnectorCatalogLoadTiming(
    options.timing,
    options.requestedConnectorSlugs.length,
    options.metadataConnectorSlugs?.length ?? 0,
  );
  return await timing.measureComplete(async () => {
    const identity = await timing.measure(
      "api_dispatch_connector_catalog_query_projection_identity",
      async () => {
        return await readConnectorCatalogRuntimeProjectionIdentity(db);
      },
    );
    if (identity.kind === "fallback") {
      const load = await completeRuntimeSelectionFallback({
        db,
        timing,
        runtimeConnectorSlugs,
        metadataConnectorSlugs,
        reason: identity.reason,
      });
      timing.recordProjectionResult({
        source: load.source,
        cacheOutcome: "not_applicable",
        fallbackReason: load.fallbackReason,
      });
      return load.selection;
    }
    const key = runtimeSelectionProjectionKey({
      identity: identity.projection.identity,
      runtimeConnectorSlugs,
      metadataConnectorSlugs,
    });
    timing.recordProjectionCacheObservation(
      observeRuntimeSelection(identity.projection.identity, key),
    );
    const cache = runtimeSelectionCache();
    if (cache.completed?.key === key) {
      timing.recordMaterializedConnectorCount(0);
      timing.recordProjectionResult({
        source: cache.completed.load.source,
        cacheOutcome: "hit",
        fallbackReason: cache.completed.load.fallbackReason,
      });
      return cache.completed.load.selection;
    }
    if (cache.inFlight?.key === key) {
      const result = await cache.inFlight.promise;
      timing.recordMaterializedConnectorCount(0);
      timing.recordProjectionResult({
        source: result.load.source,
        cacheOutcome: "in_flight",
        fallbackReason: result.load.fallbackReason,
      });
      return result.load.selection;
    }
    const promise = buildProjectedRuntimeSelection({
      db,
      timing,
      projection: identity.projection,
      runtimeConnectorSlugs,
      metadataConnectorSlugs,
    });
    cache.inFlight = { key, promise };
    const result = await onRejection(promise, () => {
      clearRuntimeSelectionInFlight(cache, key, promise);
    });
    clearRuntimeSelectionInFlight(cache, key, promise);
    if (result.cacheable) {
      cache.completed = { key: result.key, load: result.load };
    }
    timing.recordProjectionResult({
      source: result.load.source,
      cacheOutcome: "miss",
      fallbackReason: result.load.fallbackReason,
    });
    return result.load.selection;
  });
}

export async function loadConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot> {
  const acceptedSnapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const { state } = connectorRuntimeState(acceptedSnapshot, undefined);
  if (state.snapshot !== undefined) {
    return state.snapshot;
  }
  const connectorSlugs = acceptedSnapshot.artifact.connectors.map(
    (connector) => {
      return connector.slug;
    },
  );
  const snapshot: ConnectorRuntimeSnapshot = {
    acceptedSnapshot,
    catalogIdentity: acceptedSnapshot.identity,
    connectors: selectedRuntimeConnectors(state, connectorSlugs),
    serverFirewalls: state.serverFirewalls,
    serverFirewallMetadata: state.serverFirewalls,
  };
  state.snapshot = snapshot;
  return snapshot;
}

export function getConnectorRuntimeConnector(
  snapshot: ConnectorRuntimeSelection,
  connectorSlug: string,
): ConnectorRuntimeConnector | undefined {
  return snapshot.connectors.get(connectorSlug);
}

export function getConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly requireExecutable?: boolean;
}): ConnectorRuntimeMethod | undefined {
  const method = args.snapshot.connectors
    .get(args.connectorSlug)
    ?.methods.get(args.authMethodId);
  if (args.requireExecutable === true && method?.executable !== true) {
    return undefined;
  }
  return method;
}

export function listConnectorRuntimeVisibleSlugs(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorSlug[] {
  return listAcceptedConnectorCatalogAvailableSlugs({
    snapshot: args.snapshot.acceptedSnapshot,
    featureStates: args.featureStates,
  });
}
