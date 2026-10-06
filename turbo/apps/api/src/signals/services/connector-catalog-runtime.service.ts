import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
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
  type ConnectorRefreshTokenInputBindings,
  type ConnectorRefreshTokenOutputBindings,
  type ConnectorRevokeInputBindings,
  type ConnectorSecretValueRef,
  type ConnectorVariableValueRef,
  type PublicConnectorAuthClientConfig,
} from "@okouai/connectors/connector-config";

import type {
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
  ConnectorCatalogSkill,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import {
  getConnectorCatalogResolutionDetail,
  listAcceptedConnectorCatalogAvailableSlugs,
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
} from "./connector-catalog-external-reader.service";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import type {
  ConnectorCatalogLookup,
  ConnectorCatalogView,
  ExternalCatalogIdentity,
} from "./connector-catalog-view";
import type { ConnectorCatalogLoadTiming } from "./connector-catalog-load-timing.service";
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

export interface ConnectorRuntimeLookup {
  readonly connectors: ReadonlyMap<ConnectorSlug, ConnectorRuntimeConnector>;
  readonly serverFirewalls: ConnectorServerFirewallSelection;
  readonly serverFirewallMetadata: ConnectorServerFirewallMetadataCatalog;
}

export interface ConnectorRuntimeSelection extends ConnectorRuntimeLookup {
  readonly catalogIdentity: ExternalCatalogIdentity;
}

/** Full firewall iteration/host ownership, without the accepted storage snapshot. */
export interface ConnectorRuntimeCatalogView extends ConnectorRuntimeSelection {
  readonly serverFirewalls: ConnectorServerFirewallCatalog;
  readonly serverFirewallMetadata: ConnectorServerFirewallCatalog;
}

export interface ConnectorRuntimeSnapshot extends ConnectorRuntimeCatalogView {
  readonly acceptedSnapshot: AcceptedConnectorCatalogSnapshot;
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
  if (access.kind === "none") {
    return { kind: "none" };
  }
  if (access.kind === "automatic") {
    return {
      kind: "automatic",
      inputs: refreshInputBindings(access.inputs),
      outputs: refreshOutputBindings(access.outputs),
    };
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
    case "none": {
      if (access.kind !== "none" || revoke.kind !== "none") {
        throw new Error("Accepted no-auth connector has incompatible access");
      }
      return { storage, grant: { kind: "none" }, access, revoke };
    }
    case "automatic": {
      if (access.kind !== "automatic" || revoke.kind !== "none") {
        throw new Error("Accepted Automatic connector has incompatible access");
      }
      return {
        storage,
        grant: {
          kind: "automatic",
          callbackOrigin: "api",
          outputs: outputBindings(method.grant.outputs),
        },
        access,
        revoke,
      };
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
    // Provider-backed MCP methods require separately installed handlers.
    if (
      connector.mcp !== undefined &&
      !(
        method.revoke.kind === "none" &&
        ((method.grant.kind === "none" && method.access.kind === "none") ||
          (method.grant.kind === "manual" && method.access.kind === "static") ||
          (method.grant.kind === "automatic" &&
            method.access.kind === "automatic"))
      )
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
  readonly acceptedSnapshot: ConnectorCatalogView;
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
  acceptedSnapshot: ConnectorCatalogLookup,
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
  acceptedSnapshot: ConnectorCatalogView,
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

export function uniqueSortedConnectorSlugs(
  connectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  return [...new Set(connectorSlugs)].sort(compareStrings);
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

/** Plain captured entries only; metadata dependencies never grant execution. */
export function materializeConnectorRuntimeLookup(args: {
  readonly filteredMethodKeys: ReadonlySet<string>;
  readonly connectors: readonly ConnectorCatalogArtifactConnector[];
  readonly runtimeConnectorSlugs: readonly ConnectorSlug[];
  readonly metadataConnectorSlugs: readonly ConnectorSlug[];
}): ConnectorRuntimeLookup {
  const builtinConnectorBySlug = new Map(
    args.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  const runtimeArtifacts = selectedArtifacts({
    connectorBySlug: builtinConnectorBySlug,
    connectorSlugs: args.runtimeConnectorSlugs,
  });
  const runtimeConnectors = new Map(
    runtimeArtifacts.map((connector) => {
      return [
        connector.slug,
        runtimeConnector(connector, args.filteredMethodKeys),
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
    connectorBySlug: builtinConnectorBySlug,
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
    connectors: runtimeConnectors,
    serverFirewalls: selectConnectorServerFirewalls({
      catalog: runtimeCatalog,
      connectorSlugs: args.runtimeConnectorSlugs,
    }),
    serverFirewallMetadata: metadataCatalog,
  };
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
  snapshot: ConnectorRuntimeLookup,
  connectorSlug: string,
): ConnectorRuntimeConnector | undefined {
  return snapshot.connectors.get(connectorSlug);
}

export function getConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeLookup;
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
