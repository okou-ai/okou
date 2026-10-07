import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { BuiltinConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import {
  isOneClickConnectorGrantKind,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogAuthMethodSummary,
  type PublicConnectorCatalogConnectItem,
  type PublicConnectorCatalogConnectListResponse,
  type PublicConnectorCatalogConnection,
  type PublicConnectorCatalogConnectionStatus,
  type PublicConnectorCatalogDetail,
  type PublicConnectorCatalogDiscoveryResponse,
  type PublicConnectorCatalogIcon,
  type PublicConnectorCatalogItem,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { BuiltinConnectorBrief } from "@okouai/api-contracts/contracts/connector-overview";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import { asc, eq } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { onRejection } from "../utils";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifactConnector,
  type ConnectorCatalogAuthMethod,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  compactConnectorCatalogDefaultPolicy,
  connectorCatalogPermissionSummary,
} from "@okouai/connectors/connector-catalog/entry-columns";
import {
  connectorCatalogDisplayColumns,
  connectorCatalogRuntimeColumns,
  materializeConnectorCatalogDisplayRow,
  materializeConnectorCatalogRuntimeRow,
  type ConnectorCatalogDisplayConnector,
} from "./connector-catalog-columns";
import { isConnectorCatalogIconKey } from "@okouai/connectors/connector-catalog/artifacts/icon";
import { deriveConnectorCatalogFirewallPermissions } from "@okouai/connectors/connector-catalog/artifacts/relationships";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import type { ConnectorFeatureStates } from "./connector-catalog-feature-states";
import type { ConnectorCatalogLoadTiming } from "./connector-catalog-load-timing.service";
import type { ApiDispatchTimingActionType } from "./api-dispatch-timing.service";
import {
  connectorAuthMethodFeatureSwitch,
  connectorAuthMethodHiddenFeatureSwitch,
} from "./connector-auth-method-feature-switches";
import {
  CONNECTOR_DISCOVERY_PER_CATEGORY,
  CONNECTOR_SEARCH_LIMIT,
  compareConnectorPopularity,
  connectorPopularityRank,
  createConnectorPopularityIndex,
  isInternalConnector,
} from "./connector-popularity";
import type { ConnectorCatalogConnection } from "./connector-catalog-connection";
import {
  catalogIdentityFromCapture,
  type ConnectorCatalogRuntimeView,
  type ExternalCatalogIdentity,
} from "./connector-catalog-view";
const CONNECTOR_CATALOG_ICON_BASE_URL = "https://static.vm0.io/";

interface PrivateAuthMethodFacts {
  readonly requestedScopes: readonly string[];
  readonly supportsRefresh: boolean;
}

export type AcceptedConnectorCatalogSnapshot = ConnectorCatalogRuntimeView;

/**
 * A subset of accepted connectors, together with the compatibility filter that
 * applies to their auth methods. Per-slug reads build it from current and
 * immutable entries; catalog-wide reads build it from the accepted snapshot.
 */
type CompatibleCatalogConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp"
>;

type CatalogPermissionConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp" | "label" | "icon" | "firewall"
>;

export interface ConnectorCatalogSlugSource<
  Connector extends CompatibleCatalogConnector =
    ConnectorCatalogArtifactConnector,
> {
  readonly connectors: readonly Connector[];
  readonly filteredMethodKeys: ReadonlySet<string>;
}

interface AcceptedCatalogSnapshot<
  Connector extends CompatibleCatalogConnector,
> {
  readonly identity: ExternalCatalogIdentity;
  readonly artifact: { readonly connectors: Connector[] };
  readonly connectorBySlug: ReadonlyMap<string, Connector>;
  readonly filteredMethodKeys: ReadonlySet<string>;
}

type AcceptedDisplayCatalogSnapshot =
  AcceptedCatalogSnapshot<ConnectorCatalogDisplayConnector>;

interface PreparedExternalCatalogCache<
  Catalog extends { readonly identity: ExternalCatalogIdentity },
> {
  completed:
    | {
        readonly key: string;
        readonly catalog: Catalog;
      }
    | undefined;
  readonly inFlight: Map<string, Promise<Catalog>>;
}

interface EffectiveConnector<
  Connector extends CompatibleCatalogConnector =
    ConnectorCatalogDisplayConnector,
> {
  readonly connector: Connector;
  readonly authMethods: readonly ConnectorCatalogAuthMethod[];
}

interface ExternalCatalogReadArgs {
  readonly db: ReadonlyDb;
  readonly featureStates: ConnectorFeatureStates;
}

interface ExternalCatalogSourceArgs<
  Connector extends CompatibleCatalogConnector =
    ConnectorCatalogDisplayConnector,
> {
  readonly catalog: ConnectorCatalogSlugSource<Connector>;
  readonly featureStates: ConnectorFeatureStates;
}

interface ExternalCatalogConnectorReadArgs<
  Connector extends CompatibleCatalogConnector =
    ConnectorCatalogDisplayConnector,
> extends ExternalCatalogSourceArgs<Connector> {
  readonly connectorSlug: string;
}

interface ExternalCatalogConnectorStatusReadArgs extends ExternalCatalogConnectorReadArgs {
  readonly connections: readonly ConnectorCatalogConnection[];
}

interface ExternalCatalogSearchArgs extends ExternalCatalogReadArgs {
  readonly keyword: string | undefined;
}

interface ExternalCatalogStatusArgs extends ExternalCatalogReadArgs {
  readonly connections: readonly ConnectorCatalogConnection[];
  readonly referenceConnectorSlugs: readonly string[];
}

interface ExternalCatalogDiscoveryArgs extends ExternalCatalogStatusArgs {
  readonly keyword: string | undefined;
  readonly category: string | undefined;
}

interface ConnectorCatalogReferenceMetadata {
  readonly connectorSlug: string;
  readonly label: string;
  readonly icon: PublicConnectorCatalogIcon;
}

interface ConnectorCatalogStatusRead {
  readonly status: PublicConnectorCatalogStatusResponse;
  readonly referenceMetadata: readonly ConnectorCatalogReferenceMetadata[];
}

interface ConnectorCatalogDiscoveryRead {
  readonly status: PublicConnectorCatalogDiscoveryResponse;
  readonly referenceMetadata: readonly ConnectorCatalogReferenceMetadata[];
}

type ExternalConnectorCatalogUnavailableReason =
  | "missing_current_identity"
  | "missing_entries"
  | "missing_required_entries";

export class ExternalConnectorCatalogUnavailableError extends Error {
  readonly code: `CONNECTOR_CATALOG_UNAVAILABLE:${ExternalConnectorCatalogUnavailableReason}`;

  constructor(
    readonly reason: ExternalConnectorCatalogUnavailableReason,
    message = "Accepted external connector catalog is unavailable",
  ) {
    super(message);
    this.name = "ExternalConnectorCatalogUnavailableError";
    this.code = `CONNECTOR_CATALOG_UNAVAILABLE:${reason}`;
  }
}

/**
 * Without a manifest, a missing entry and a slug the generation never had are
 * indistinguishable. Paths whose slugs are already authorized business facts
 * (a Run's enabled connectors, its admitted accounts) must not shrink that
 * scope silently, so they fail with this error instead of omitting the slug.
 */
export class RequiredConnectorCatalogEntriesMissingError extends ExternalConnectorCatalogUnavailableError {
  constructor(readonly connectorSlugs: readonly ConnectorSlug[]) {
    super(
      "missing_required_entries",
      `Connector catalog entries are missing for required connectors: ${connectorSlugs.join(", ")}`,
    );
    this.name = "RequiredConnectorCatalogEntriesMissingError";
  }
}

/** Throws when any required slug has no entry at the captured catalog hash. */
export function assertRequiredConnectorCatalogEntries(
  presentConnectorSlugs: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  requiredConnectorSlugs: readonly ConnectorSlug[],
): void {
  const missing = [...new Set(requiredConnectorSlugs)]
    .filter((connectorSlug) => {
      return !presentConnectorSlugs.has(connectorSlug);
    })
    .sort((left, right) => {
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (missing.length > 0) {
    throw new RequiredConnectorCatalogEntriesMissingError(missing);
  }
}

const preparedCatalogCache = singleton(
  (): PreparedExternalCatalogCache<AcceptedConnectorCatalogSnapshot> => {
    return {
      completed: undefined,
      inFlight: new Map<string, Promise<AcceptedConnectorCatalogSnapshot>>(),
    };
  },
);

const preparedDisplayCatalogCache = singleton(
  (): PreparedExternalCatalogCache<AcceptedDisplayCatalogSnapshot> => {
    return {
      completed: undefined,
      inFlight: new Map<string, Promise<AcceptedDisplayCatalogSnapshot>>(),
    };
  },
);

function authMethodKey(connectorSlug: string, authMethodId: string): string {
  return `${connectorSlug}\0${authMethodId}`;
}

function identityKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

function requestedScopes(
  method: ConnectorCatalogAuthMethod,
): readonly string[] {
  switch (method.grant.kind) {
    case "auth-code":
    case "device-auth":
    case "external-code": {
      return method.grant.scopes;
    }
    case "manual":
    case "none":
    case "automatic":
    case "openid-auth": {
      return [];
    }
  }
}

function privateMethodFacts(
  method: ConnectorCatalogAuthMethod,
): PrivateAuthMethodFacts {
  return {
    requestedScopes: requestedScopes(method),
    supportsRefresh: method.access.kind === "refresh-token",
  };
}

async function measureCatalogLoad<T>(
  timing: ConnectorCatalogLoadTiming | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T | Promise<T>,
): Promise<T> {
  return timing
    ? await timing.measure(actionType, operation)
    : await operation();
}

function measureCatalogLoadSync<T>(
  timing: ConnectorCatalogLoadTiming | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T,
): T {
  return timing ? timing.measureSync(actionType, operation) : operation();
}

async function readCurrentIdentity(args: {
  readonly db: ReadonlyDb;
  readonly capabilityDigest: string;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<ExternalCatalogIdentity | undefined> {
  const [row] = await measureCatalogLoad(
    args.timing,
    "api_dispatch_connector_catalog_query_identity",
    async () => {
      return await args.db
        .select({
          schemaVersion: connectorCatalog.schemaVersion,
          hash: connectorCatalog.hash,
        })
        .from(connectorCatalog)
        .where(
          eq(
            connectorCatalog.schemaVersion,
            SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          ),
        )
        .limit(1);
    },
  );
  return row
    ? catalogIdentityFromCapture(row, args.capabilityDigest)
    : undefined;
}

async function readCurrentRuntimeCatalogRows(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly timing?: ConnectorCatalogLoadTiming;
}) {
  return await measureCatalogLoad(
    args.timing,
    "api_dispatch_connector_catalog_query_payload",
    async () => {
      return await args.db
        .select({
          slug: connectorCatalogRuntimeColumns.slug,
          authMethods: connectorCatalogRuntimeColumns.authMethods,
          mcp: connectorCatalogRuntimeColumns.mcp,
          label: connectorCatalogRuntimeColumns.label,
          description: connectorCatalogRuntimeColumns.description,
          category: connectorCatalogRuntimeColumns.category,
          icon: connectorCatalogRuntimeColumns.icon,
          tags: connectorCatalogRuntimeColumns.tags,
          generation: connectorCatalogRuntimeColumns.generation,
          skill: connectorCatalogRuntimeColumns.skill,
          firewall: connectorCatalogRuntimeColumns.firewall,
        })
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, args.identity.catalogDigest))
        .orderBy(asc(connectorCatalogEntries.slug));
    },
  );
}

async function readCurrentCatalog(args: {
  readonly db: ReadonlyDb;
  readonly identity: ExternalCatalogIdentity;
  readonly capability: ExecutableCapabilityState;
  readonly timing?: ConnectorCatalogLoadTiming;
}): Promise<AcceptedConnectorCatalogSnapshot> {
  const rows = await readCurrentRuntimeCatalogRows(args);
  // A published artifact contains at least one connector. A whole-catalog
  // read must not turn an unavailable generation into a successful empty list.
  if (rows.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError("missing_entries");
  }
  return materializeAcceptedConnectorCatalog({
    ...args,
    connectors: rows.map(materializeConnectorCatalogRuntimeRow),
  });
}

function materializeAcceptedConnectorCatalog<
  Connector extends CompatibleCatalogConnector,
>(args: {
  readonly identity: ExternalCatalogIdentity;
  readonly capability: ExecutableCapabilityState;
  readonly timing?: ConnectorCatalogLoadTiming;
  readonly connectors: readonly Connector[];
}): AcceptedCatalogSnapshot<Connector> {
  const artifact = { connectors: [...args.connectors] };
  args.timing?.recordValidationResult({ outcome: "not_run" });
  const filteredAuthMethods = measureCatalogLoadSync(
    args.timing,
    "api_dispatch_connector_catalog_validate_compatibility",
    () => {
      return evaluateConnectorCatalogCompatibility({
        artifact,
        capability: args.capability,
      });
    },
  );

  return measureCatalogLoadSync(
    args.timing,
    "api_dispatch_connector_catalog_materialize_accepted_snapshot",
    () => {
      return {
        identity: args.identity,
        artifact,
        connectorBySlug: new Map(
          artifact.connectors.map((connector) => {
            return [connector.slug, connector];
          }),
        ),
        filteredMethodKeys: new Set(
          filteredAuthMethods.map((filtered) => {
            return authMethodKey(filtered.connectorSlug, filtered.authMethodId);
          }),
        ),
      };
    },
  );
}

function deleteInFlightCatalog<
  Catalog extends { readonly identity: ExternalCatalogIdentity },
>(
  cache: PreparedExternalCatalogCache<Catalog>,
  key: string,
  promise: Promise<Catalog>,
): void {
  if (cache.inFlight.get(key) === promise) {
    cache.inFlight.delete(key);
  }
}

async function readCachedConnectorCatalogSnapshot<
  Catalog extends { readonly identity: ExternalCatalogIdentity },
>(args: {
  readonly cache: PreparedExternalCatalogCache<Catalog>;
  readonly load: () => Promise<Catalog>;
  readonly identity: ExternalCatalogIdentity;
  readonly timing: ConnectorCatalogLoadTiming | undefined;
}): Promise<Catalog> {
  const { identity: currentIdentity, timing, cache } = args;
  const currentKey = identityKey(currentIdentity);
  if (cache.completed?.key === currentKey) {
    timing?.recordAcceptedCacheOutcome("hit");
    timing?.recordValidationResult({ outcome: "not_run" });
    return cache.completed.catalog;
  }

  const existing = cache.inFlight.get(currentKey);
  if (existing) {
    timing?.recordAcceptedCacheOutcome("in_flight");
    timing?.recordValidationResult({ outcome: "not_run" });
    return await existing;
  }

  const completedIdentity = cache.completed?.catalog.identity;
  timing?.recordAcceptedCacheMissReason(
    completedIdentity === undefined
      ? "process_empty"
      : completedIdentity.sourceId !== currentIdentity.sourceId ||
          completedIdentity.schemaVersion !== currentIdentity.schemaVersion ||
          completedIdentity.catalogDigest !== currentIdentity.catalogDigest
        ? "catalog_identity_changed"
        : "capability_identity_changed",
  );
  timing?.recordAcceptedCacheOutcome("miss");
  const promise = args.load();
  cache.inFlight.set(currentKey, promise);
  const catalog = await onRejection(promise, () => {
    deleteInFlightCatalog(cache, currentKey, promise);
  });
  deleteInFlightCatalog(cache, currentKey, promise);
  cache.completed = { key: currentKey, catalog };
  return catalog;
}

export async function loadAcceptedConnectorCatalogSnapshot(
  db: ReadonlyDb,
  timing?: ConnectorCatalogLoadTiming,
): Promise<AcceptedConnectorCatalogSnapshot> {
  const capability = connectorCatalogExecutableCapabilityState();
  const identity = await readCurrentIdentity({
    db,
    capabilityDigest: capability.digest,
    ...(timing === undefined ? {} : { timing }),
  });
  if (!identity) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  // Entries are immutable and retained by hash. A later pointer switch cannot
  // strand this capture, so the legacy mutable-snapshot retry is unnecessary.
  return await readCachedConnectorCatalogSnapshot({
    cache: preparedCatalogCache(),
    identity,
    timing,
    load: async () => {
      return await readCurrentCatalog({
        db,
        identity,
        capability,
        ...(timing === undefined ? {} : { timing }),
      });
    },
  });
}

/** Display reads keep their own narrow cache and never materialize runtime entries. */
async function loadDisplayConnectorCatalogSnapshot(
  db: ReadonlyDb,
): Promise<AcceptedDisplayCatalogSnapshot> {
  const capability = connectorCatalogExecutableCapabilityState();
  const identity = await readCurrentIdentity({
    db,
    capabilityDigest: capability.digest,
  });
  if (!identity) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  return await readCachedConnectorCatalogSnapshot({
    cache: preparedDisplayCatalogCache(),
    identity,
    timing: undefined,
    load: async () => {
      const rows = await db
        .select({
          slug: connectorCatalogDisplayColumns.slug,
          authMethods: connectorCatalogDisplayColumns.authMethods,
          mcp: connectorCatalogDisplayColumns.mcp,
          label: connectorCatalogDisplayColumns.label,
          description: connectorCatalogDisplayColumns.description,
          category: connectorCatalogDisplayColumns.category,
          icon: connectorCatalogDisplayColumns.icon,
          tags: connectorCatalogDisplayColumns.tags,
          generation: connectorCatalogDisplayColumns.generation,
          permissionSummary: connectorCatalogDisplayColumns.permissionSummary,
        })
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, identity.catalogDigest))
        .orderBy(asc(connectorCatalogEntries.slug));
      if (rows.length === 0) {
        throw new ExternalConnectorCatalogUnavailableError("missing_entries");
      }
      return materializeAcceptedConnectorCatalog({
        identity,
        capability,
        connectors: rows.map(materializeConnectorCatalogDisplayRow),
      });
    },
  });
}

/**
 * Applies rollout policy to discovery projections only. Feature switches must
 * never be reused as connector authorization or execution checks;
 * ConnectorActionResolver intentionally does not read them.
 */
function featureSwitchEnabled(
  connectorSlug: string,
  authMethodId: string,
  featureStates: ConnectorFeatureStates,
): boolean {
  const featureSwitch = connectorAuthMethodFeatureSwitch(
    connectorSlug,
    authMethodId,
  );
  return featureSwitch === undefined || featureStates?.[featureSwitch] === true;
}

function featureSwitchHidesAuthMethod(
  connectorSlug: string,
  authMethodId: string,
  featureStates: ConnectorFeatureStates,
): boolean {
  const featureSwitch = connectorAuthMethodHiddenFeatureSwitch(
    connectorSlug,
    authMethodId,
  );
  return featureSwitch !== undefined && featureStates?.[featureSwitch] === true;
}

function catalogSource<Connector extends CompatibleCatalogConnector>(
  catalog: AcceptedCatalogSnapshot<Connector>,
): ConnectorCatalogSlugSource<Connector> {
  return {
    connectors: catalog.artifact.connectors,
    filteredMethodKeys: catalog.filteredMethodKeys,
  };
}

function effectiveConnectors<
  Connector extends CompatibleCatalogConnector,
>(args: {
  readonly catalog: ConnectorCatalogSlugSource<Connector>;
  readonly featureStates: ConnectorFeatureStates;
}): readonly EffectiveConnector<Connector>[] {
  return args.catalog.connectors.flatMap((connector) => {
    const authMethods = connector.authMethods.filter((method) => {
      if (
        args.catalog.filteredMethodKeys.has(
          authMethodKey(connector.slug, method.id),
        )
      ) {
        return false;
      }
      if (!method.visible) {
        return false;
      }
      if (
        !featureSwitchEnabled(connector.slug, method.id, args.featureStates)
      ) {
        return false;
      }
      if (
        featureSwitchHidesAuthMethod(
          connector.slug,
          method.id,
          args.featureStates,
        )
      ) {
        return false;
      }
      return true;
    });
    if (authMethods.length === 0) {
      return [];
    }
    return [{ connector, authMethods }];
  });
}

function iconForCatalog(
  connector: Pick<ConnectorCatalogArtifactConnector, "icon">,
): PublicConnectorCatalogIcon {
  const key = connector.icon.key;
  if (!isConnectorCatalogIconKey(key)) {
    throw new Error(`Invalid connector catalog icon key "${key}"`);
  }
  return {
    url: `${CONNECTOR_CATALOG_ICON_BASE_URL}${key}`,
    invertInDarkMode: connector.icon.invertInDarkMode,
    ...(connector.icon.scale === undefined
      ? {}
      : { scale: connector.icon.scale }),
  };
}

function referenceMetadataForCatalog(
  catalog: AcceptedDisplayCatalogSnapshot,
  connectorSlugs: readonly string[],
): readonly ConnectorCatalogReferenceMetadata[] {
  const requestedSlugs = new Set(connectorSlugs);
  return catalog.artifact.connectors.flatMap((connector) => {
    return requestedSlugs.has(connector.slug)
      ? [
          {
            connectorSlug: connector.slug,
            label: connector.label,
            icon: iconForCatalog(connector),
          },
        ]
      : [];
  });
}

function authMethodSummaryForCatalog(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: method.id,
    label: method.label,
    description: method.description,
    grantKind: method.grant.kind,
  };
}

export function authMethodDetailForCatalog(
  method: ConnectorCatalogAuthMethod,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    ...authMethodSummaryForCatalog(method),
    manualFields:
      method.grant.kind === "manual"
        ? method.grant.fields.map((field) => {
            return {
              id: field.publicId,
              label: field.label,
              required: field.required,
              placeholder: field.placeholder,
              inputType: field.storage === "variable" ? "text" : "password",
            };
          })
        : [],
    startOptions:
      method.grant.kind === "device-auth"
        ? method.grant.startOptions.map((option) => {
            return {
              id: option.publicId,
              kind: option.kind,
              label: option.label,
              required: option.required,
              defaultValue: option.defaultValue,
              options: option.options.map((choice) => {
                return { ...choice };
              }),
            };
          })
        : [],
  };
}

function connectorCatalogItem(
  effective: EffectiveConnector,
  popularityIndex: ReadonlyMap<
    string,
    number
  > = createConnectorPopularityIndex(),
): PublicConnectorCatalogItem {
  const rank = connectorPopularityRank(
    popularityIndex,
    effective.connector.slug,
  );
  return {
    slug: effective.connector.slug,
    label: effective.connector.label,
    description: effective.connector.description,
    icon: iconForCatalog(effective.connector),
    category: effective.connector.category,
    ...(rank === Number.MAX_SAFE_INTEGER ? {} : { popularityRank: rank }),
    generation: [...effective.connector.generation],
    tags: [...effective.connector.tags],
    ...(effective.connector.mcp === undefined
      ? {}
      : { mcp: { ...effective.connector.mcp } }),
    authMethods: effective.authMethods.map(authMethodSummaryForCatalog),
    permissionSummary: effective.connector.permissionSummary,
  };
}

function connectorCatalogDetail(
  effective: EffectiveConnector,
  popularityIndex?: ReadonlyMap<string, number>,
): PublicConnectorCatalogDetail {
  return {
    ...connectorCatalogItem(effective, popularityIndex),
    authMethods: effective.authMethods.map(authMethodDetailForCatalog),
  };
}

export function getConnectorCatalogResolutionDetail(
  connector: ConnectorCatalogArtifactConnector,
): PublicConnectorCatalogDetail {
  return connectorCatalogDetail({
    connector: {
      ...connector,
      permissionSummary: connectorCatalogPermissionSummary(connector),
    },
    authMethods: connector.authMethods,
  });
}

/** The whole accepted catalog, for reads that must scan every connector. */
export async function loadCompleteConnectorCatalogSource(
  db: ReadonlyDb,
): Promise<ConnectorCatalogSlugSource<ConnectorCatalogDisplayConnector>> {
  return catalogSource(await loadDisplayConnectorCatalogSnapshot(db));
}

export function listAcceptedConnectorCatalogAvailableSlugs(args: {
  readonly snapshot: AcceptedConnectorCatalogSnapshot;
  readonly featureStates: ConnectorFeatureStates;
}): readonly ConnectorSlug[] {
  return effectiveConnectors({
    catalog: catalogSource(args.snapshot),
    featureStates: args.featureStates,
  })
    .map((entry) => {
      return entry.connector.slug;
    })
    .sort();
}

function connectionForCatalogStatus(
  connector: BuiltinConnectorResponse | null,
): PublicConnectorCatalogConnection | null {
  if (!connector) {
    return null;
  }
  return {
    id: connector.id,
    authMethod: connector.authMethod,
    externalUsername: connector.externalUsername,
    externalEmail: connector.externalEmail,
    reconnectReason: connector.reconnectReason,
  };
}

function hasRequestedScopes(
  requested: readonly string[],
  stored: readonly string[] | null,
): boolean {
  if (requested.length === 0) {
    return true;
  }
  if (!stored) {
    return false;
  }
  const storedScopes = new Set(stored);
  return requested.every((scope) => {
    return storedScopes.has(scope);
  });
}

function hasCatalogScopeMismatch(args: {
  readonly connector: BuiltinConnectorResponse | null;
  readonly facts: PrivateAuthMethodFacts | undefined;
  readonly storedRequestedScopes: readonly string[] | null;
}): boolean {
  if (args.connector === null || args.facts === undefined) {
    return false;
  }
  return !hasRequestedScopes(
    args.facts.requestedScopes,
    args.storedRequestedScopes,
  );
}

function connectionMethodForCatalogStatus(args: {
  readonly effective: EffectiveConnector;
  readonly featureStates: ConnectorFeatureStates;
  readonly response: BuiltinConnectorResponse | null;
}): ConnectorCatalogAuthMethod | undefined {
  if (!args.response) {
    return undefined;
  }
  const authMethodId = args.response.authMethod;
  const effectiveMethod = args.effective.authMethods.find((method) => {
    return method.id === authMethodId;
  });
  if (effectiveMethod) {
    return effectiveMethod;
  }
  if (
    !featureSwitchHidesAuthMethod(
      args.effective.connector.slug,
      authMethodId,
      args.featureStates,
    )
  ) {
    return undefined;
  }
  // Rollout replacements are unavailable for new connections, but existing
  // connections still need to remain visible and manageable.
  return args.effective.connector.authMethods.find((method) => {
    return method.id === authMethodId;
  });
}

interface ConnectorCatalogStatusItemArgs {
  readonly effective: EffectiveConnector;
  readonly featureStates: ConnectorFeatureStates;
  readonly connection: ConnectorCatalogConnection | null;
  readonly popularityIndex: ReadonlyMap<string, number>;
}

type ConnectorCatalogConnectionFields = Omit<
  PublicConnectorCatalogStatusItem,
  keyof PublicConnectorCatalogDetail
>;

function connectorCatalogStatusItem(
  args: ConnectorCatalogStatusItemArgs,
): PublicConnectorCatalogStatusItem {
  return {
    ...connectorCatalogDetail(args.effective, args.popularityIndex),
    ...connectorCatalogConnectionFields(args),
  };
}

/**
 * The status item without the per-connector detail a list does not show. The
 * permission summary is the costly part: it derives every firewall permission.
 */
function connectorCatalogConnectItem(
  args: ConnectorCatalogStatusItemArgs,
): PublicConnectorCatalogConnectItem {
  const rank = connectorPopularityRank(
    args.popularityIndex,
    args.effective.connector.slug,
  );
  return {
    slug: args.effective.connector.slug,
    label: args.effective.connector.label,
    description: args.effective.connector.description,
    icon: iconForCatalog(args.effective.connector),
    ...(rank === Number.MAX_SAFE_INTEGER ? {} : { popularityRank: rank }),
    authMethods: args.effective.authMethods.map(authMethodDetailForCatalog),
    ...connectorCatalogConnectionFields(args),
  };
}

function connectorCatalogConnectionFields(
  args: ConnectorCatalogStatusItemArgs,
): ConnectorCatalogConnectionFields {
  const response = args.connection?.response ?? null;
  const connectionMethod = connectionMethodForCatalogStatus({
    effective: args.effective,
    featureStates: args.featureStates,
    response,
  });
  const connector = connectionMethod ? response : null;
  const facts = connectionMethod
    ? privateMethodFacts(connectionMethod)
    : undefined;
  const scopeMismatch = hasCatalogScopeMismatch({
    connector,
    facts,
    storedRequestedScopes: args.connection?.oauthRequestedScopes ?? null,
  });
  let connectionStatus: PublicConnectorCatalogConnectionStatus =
    "not-connected";
  if (connector !== null) {
    connectionStatus =
      connector.connectionStatus === "reconnect-required"
        ? "reconnect-required"
        : scopeMismatch
          ? "scope-mismatch"
          : "connected";
  }
  const [singleMethod] = args.effective.authMethods;

  return {
    connection: connectionForCatalogStatus(connector),
    connected: connector !== null,
    connectionStatus,
    scopeMismatch,
    authMethodSupportsRefresh:
      connector !== null && facts?.supportsRefresh === true,
    tokenExpiresAt: connector?.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId:
      args.effective.authMethods.length === 1 &&
      singleMethod?.grant.kind === "auth-code"
        ? singleMethod.id
        : null,
    connectNotice: null,
  };
}

export async function listExternalPublicConnectorCatalog(
  args: ExternalCatalogReadArgs,
): Promise<PublicConnectorCatalogListResponse> {
  const catalog = await loadDisplayConnectorCatalogSnapshot(args.db);
  const connectors = effectiveConnectors({
    catalog: catalogSource(catalog),
    featureStates: args.featureStates,
  });
  const popularityIndex = createConnectorPopularityIndex();
  return {
    connectors: connectors.map((connector) => {
      return connectorCatalogItem(connector, popularityIndex);
    }),
  };
}

function connectorMatchesKeyword(
  entry: EffectiveConnector,
  keyword: string,
): boolean {
  return (
    entry.connector.slug.toLowerCase().includes(keyword) ||
    entry.connector.label.toLowerCase().includes(keyword)
  );
}

function sortedByPopularity(
  effective: readonly EffectiveConnector[],
): EffectiveConnector[] {
  const index = createConnectorPopularityIndex();
  return [...effective].sort((left, right) => {
    return compareConnectorPopularity(index, left.connector, right.connector);
  });
}

function withoutInternalConnectors(
  effective: readonly EffectiveConnector[],
): EffectiveConnector[] {
  return effective.filter((entry) => {
    return !isInternalConnector(entry.connector.slug);
  });
}

/**
 * The keyword-free discovery response. Every category contributes its own top
 * slice, so a category holding a quarter of the catalog cannot crowd out the
 * eleven others, and each slice is ordered by rank rather than alphabetically.
 *
 * Only discovery browses this way. `/api/connectors/search` answers a
 * keyword-free call with a ranked head of the whole catalog, because an agent
 * asking that endpoint for "everything" wants the catalog, not a shelf layout.
 */
function browseEffectiveConnectors(
  effective: readonly EffectiveConnector[],
): EffectiveConnector[] {
  const perCategory = new Map<string, EffectiveConnector[]>();
  for (const entry of withoutInternalConnectors(
    sortedByPopularity(effective),
  )) {
    const bucket = perCategory.get(entry.connector.category);
    if (bucket) {
      if (bucket.length < CONNECTOR_DISCOVERY_PER_CATEGORY) {
        bucket.push(entry);
      }
      continue;
    }
    perCategory.set(entry.connector.category, [entry]);
  }
  return [...perCategory.values()].flat();
}

/** Every connector in one category, best-ranked first. */
function categoryEffectiveConnectors(
  effective: readonly EffectiveConnector[],
  category: string,
): EffectiveConnector[] {
  return withoutInternalConnectors(sortedByPopularity(effective)).filter(
    (entry) => {
      return entry.connector.category === category;
    },
  );
}

function searchEffectiveConnectors(
  effective: readonly EffectiveConnector[],
  keyword: string | undefined,
  options: { readonly excludeInternal: boolean } = { excludeInternal: false },
): EffectiveConnector[] {
  const ranked = options.excludeInternal
    ? withoutInternalConnectors(sortedByPopularity(effective))
    : sortedByPopularity(effective);
  const normalizedKeyword = keyword?.trim().toLowerCase();
  if (!normalizedKeyword) {
    return ranked.slice(0, CONNECTOR_SEARCH_LIMIT);
  }
  return ranked
    .filter((entry) => {
      return connectorMatchesKeyword(entry, normalizedKeyword);
    })
    .slice(0, CONNECTOR_SEARCH_LIMIT);
}

/** How many connectors each category holds, before the per-category slice. */
function categoryConnectorCounts(
  effective: readonly EffectiveConnector[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of effective) {
    if (isInternalConnector(entry.connector.slug)) {
      continue;
    }
    counts[entry.connector.category] =
      (counts[entry.connector.category] ?? 0) + 1;
  }
  return counts;
}

function discoveryEffectiveConnectors(
  effective: readonly EffectiveConnector[],
  args: Pick<
    ExternalCatalogDiscoveryArgs,
    "connections" | "keyword" | "category"
  >,
): EffectiveConnector[] {
  if (args.keyword?.trim()) {
    return searchEffectiveConnectors(effective, args.keyword, {
      excludeInternal: true,
    });
  }
  const category = args.category?.trim();
  if (category) {
    // A category is asked for by name, so it answers with the whole category
    // rather than the browse slice. The count the client already shows next to
    // the category is that same number; returning twelve of it would make the
    // count a claim the page cannot keep.
    return categoryEffectiveConnectors(effective, category);
  }
  const connectedSlugs = new Set(
    args.connections.map((connection) => {
      return connection.response.slug;
    }),
  );
  const connected = effective.filter((entry) => {
    return connectedSlugs.has(entry.connector.slug);
  });
  return [
    ...connected,
    ...browseEffectiveConnectors(effective).filter((entry) => {
      return !connectedSlugs.has(entry.connector.slug);
    }),
  ];
}

export async function searchExternalConnectorCatalog(
  args: ExternalCatalogSearchArgs,
): Promise<BuiltinConnectorSearchItem[]> {
  const catalog = await loadDisplayConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog: catalogSource(catalog),
    featureStates: args.featureStates,
  });
  return searchEffectiveConnectors(effective, args.keyword).map((entry) => {
    const connector = entry.connector;
    return {
      slug: connector.slug,
      label: connector.label,
      description: connector.description,
      authMethods: entry.authMethods.map((method) => {
        return method.id;
      }),
    };
  });
}

export function publicConnectorCatalogStatusFromSource(
  args: ExternalCatalogConnectorStatusReadArgs,
): PublicConnectorCatalogStatusItem | null {
  const effective = effectiveConnectors({
    catalog: args.catalog,
    featureStates: args.featureStates,
  });
  const entry = effective.find((connector) => {
    return connector.connector.slug === args.connectorSlug;
  });
  if (!entry) {
    return null;
  }
  const connection = args.connections.find((candidate) => {
    return candidate.response.slug === args.connectorSlug;
  });
  return connectorCatalogStatusItem({
    effective: entry,
    featureStates: args.featureStates,
    connection: connection ?? null,
    popularityIndex: createConnectorPopularityIndex(),
  });
}

/**
 * Connect items for the connectors a connect surface lists: every connector in
 * the source, or only those that connect in one browser step.
 */
export function connectorCatalogConnectItemsFromSource(
  args: ExternalCatalogSourceArgs & {
    readonly connections: readonly ConnectorCatalogConnection[];
    readonly oneClickOnly: boolean;
  },
): PublicConnectorCatalogConnectListResponse {
  const effective = effectiveConnectors(args).filter((entry) => {
    return (
      !args.oneClickOnly ||
      entry.authMethods.some((method) => {
        return isOneClickConnectorGrantKind(method.grant.kind);
      })
    );
  });
  const connectionsBySlug = new Map(
    args.connections.map((connection) => {
      return [connection.response.slug, connection];
    }),
  );
  const popularityIndex = createConnectorPopularityIndex();
  return {
    connectors: effective.map((entry) => {
      return connectorCatalogConnectItem({
        effective: entry,
        featureStates: args.featureStates,
        connection: connectionsBySlug.get(entry.connector.slug) ?? null,
        popularityIndex,
      });
    }),
  };
}

/**
 * Label, icon, and permission presence for connectors a caller already names,
 * limited to the ones visible under the caller's feature switches.
 */
export function connectorBriefsFromSource(
  args: ExternalCatalogSourceArgs,
): readonly BuiltinConnectorBrief[] {
  return effectiveConnectors(args).map((entry) => {
    return {
      slug: entry.connector.slug,
      label: entry.connector.label,
      icon: iconForCatalog(entry.connector),
      hasPermissions: entry.connector.permissionSummary.hasPermissions,
    };
  });
}

export async function listExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogStatusArgs,
): Promise<ConnectorCatalogStatusRead> {
  const catalog = await loadDisplayConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog: catalogSource(catalog),
    featureStates: args.featureStates,
  });
  return connectorCatalogStatusRead({
    catalog,
    effective,
    featureStates: args.featureStates,
    connections: args.connections,
    referenceConnectorSlugs: args.referenceConnectorSlugs,
  });
}

export async function discoverExternalPublicConnectorCatalogStatus(
  args: ExternalCatalogDiscoveryArgs,
): Promise<ConnectorCatalogDiscoveryRead> {
  const catalog = await loadDisplayConnectorCatalogSnapshot(args.db);
  const effective = effectiveConnectors({
    catalog: catalogSource(catalog),
    featureStates: args.featureStates,
  });
  const read = connectorCatalogStatusRead({
    catalog,
    effective: discoveryEffectiveConnectors(effective, args),
    featureStates: args.featureStates,
    connections: args.connections,
    referenceConnectorSlugs: args.referenceConnectorSlugs,
  });
  return {
    ...read,
    status: {
      ...read.status,
      totalConnectorCount: effective.length,
      categoryConnectorCounts: categoryConnectorCounts(effective),
    },
  };
}

function connectorCatalogStatusRead(args: {
  readonly catalog: AcceptedDisplayCatalogSnapshot;
  readonly effective: readonly EffectiveConnector[];
  readonly featureStates: ConnectorFeatureStates;
  readonly connections: readonly ConnectorCatalogConnection[];
  readonly referenceConnectorSlugs: readonly string[];
}): ConnectorCatalogStatusRead {
  const connectionsBySlug = new Map(
    args.connections.map((connection) => {
      return [connection.response.slug, connection];
    }),
  );
  const popularityIndex = createConnectorPopularityIndex();
  const connectors = args.effective.map((entry) => {
    return connectorCatalogStatusItem({
      effective: entry,
      featureStates: args.featureStates,
      connection: connectionsBySlug.get(entry.connector.slug) ?? null,
      popularityIndex,
    });
  });
  return {
    status: { connectors },
    referenceMetadata: referenceMetadataForCatalog(
      args.catalog,
      args.referenceConnectorSlugs,
    ),
  };
}

export function publicConnectorCatalogPermissionDetailFromSource(
  args: ExternalCatalogConnectorReadArgs<CatalogPermissionConnector>,
): PublicConnectorCatalogPermissionDetail | null {
  const effective = effectiveConnectors(args);
  const entry = effective.find((connector) => {
    return connector.connector.slug === args.connectorSlug;
  });
  if (
    !entry ||
    entry.connector.mcp !== undefined ||
    entry.connector.firewall.kind === "none"
  ) {
    return null;
  }
  const firewall = entry.connector.firewall;
  const permissions = deriveConnectorCatalogFirewallPermissions(
    firewall.config.apis,
  );
  return {
    connectorSlug: entry.connector.slug,
    label: entry.connector.label,
    icon: iconForCatalog(entry.connector),
    permissionCount: permissions.length,
    permissions: permissions.map((permission) => {
      return { ...permission };
    }),
    categories:
      firewall.categories === null
        ? null
        : {
            categories: { ...firewall.categories.byPermission },
            displayOrder: [...firewall.categories.displayOrder],
          },
    defaultPolicy: compactConnectorCatalogDefaultPolicy(entry.connector),
  };
}
