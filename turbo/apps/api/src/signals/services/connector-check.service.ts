import type {
  ConnectorCheckDiagnosticResult,
  ConnectorCheckPolicy,
  ConnectorCheckRequest,
  ConnectorCheckRequestBody,
  ConnectorCheckResponseBody,
  ConnectorCheckTargetAwareDiagnosticResult,
  ConnectorCheckTargetAwareUrlRequest,
} from "@okouai/api-contracts/contracts/connector-check";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  connectorRuntimeTargetKey,
  type ConnectorRuntimeTarget,
  type ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@okouai/connectors/connector-auth-method";
import {
  matchFirewallBaseUrl,
  matchFirewallRequestDecision,
  type FirewallRequestDecision,
} from "@okouai/connectors/firewall-rule-matcher";
import type {
  NetworkPolicies,
  NetworkPolicy,
} from "@okouai/connectors/firewall-types";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
  parseConnectorDiagnosticRequest,
  publicConnectorDiagnosticBase,
  resolveConnectorDiagnosticBase,
  type ConnectorDiagnosticBaseCandidate,
  type ConnectorDiagnosticCatalogView,
  type ParsedConnectorDiagnosticRequest,
} from "./connector-diagnostic-runtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  getConnectorRuntimeConnector,
  listConnectorRuntimeVisibleSlugs,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  resolveConnectorRuntimeDiagnosticTargets,
  type ConnectorRuntimeDiagnosticResult,
} from "./connector-runtime-sync.service";
import type { FirewallRoutingRouteMetadata } from "./connector-server-firewall-catalog.service";
import {
  builtinConnectorCredentialVariableReadCondition,
  resolveBuiltinConnectorCredentialAccess,
  type BuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";

type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ConnectorCheckLegacyIdentity {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly visibility: "available" | "unavailable";
  readonly credentialResolution: "network-boundary" | "none";
}

interface ConnectorCheckTargetIdentity {
  readonly target: ConnectorRuntimeTarget;
  readonly label: string;
  readonly visibility: "available" | "unavailable";
  readonly credentialResolution: "network-boundary" | "none";
}

interface ConnectorCheckRoutingConfig {
  readonly target: ConnectorRuntimeTarget;
  readonly label: string;
  readonly credentialResolution: "network-boundary" | "none";
  readonly candidates: readonly ConnectorDiagnosticBaseCandidate[];
  readonly hasUnresolvedDynamicBase: boolean;
  readonly networkPolicy: NetworkPolicy | null | undefined;
}

interface StoredRuntimeState {
  readonly credentialResolutionBySlug: ReadonlyMap<
    ConnectorSlug,
    "network-boundary" | "none"
  >;
  readonly baseUrlVarsBySlug: ReadonlyMap<
    ConnectorSlug,
    Readonly<Record<string, string>> | null
  >;
}

interface StoredConnectorRuntimeCandidate {
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly storageVersion: number;
}

interface PendingStoredConnectorRuntime {
  readonly access: BuiltinConnectorCredentialAccess;
  readonly storageNameByRuntimeName: ReadonlyMap<string, string>;
}

type ConnectorCheckTargetUnavailableReason = Extract<
  ConnectorCheckTargetAwareDiagnosticResult,
  { readonly outcome: "target-unavailable" }
>["reason"];

interface RunDiagnosticState {
  readonly configs: readonly ConnectorCheckRoutingConfig[];
  readonly admittedTargetKeys: ReadonlySet<string>;
  readonly unavailableReasonByTargetKey: ReadonlyMap<
    string,
    ConnectorCheckTargetUnavailableReason
  >;
}

type ConnectorCheckTimeline =
  | { readonly kind: "stored"; readonly state: StoredRuntimeState }
  | { readonly kind: "run"; readonly state: RunDiagnosticState };

interface ResolveConnectorCheckArgs {
  readonly request: ConnectorCheckRequestBody;
  readonly orgId: string;
  readonly userId: string;
  readonly stateSource:
    | { readonly kind: "stored" }
    | { readonly kind: "run"; readonly runId: string };
}

type ResolveConnectorCheckResult =
  | {
      readonly kind: "ok";
      readonly diagnostic: ConnectorCheckResponseBody;
    }
  | { readonly kind: "not-found" };

interface DecisionPermission {
  readonly name: string;
  readonly rules: readonly string[];
}

interface ConnectorCheckCatalogContext {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly visibleConnectorSlugs: ReadonlySet<ConnectorSlug>;
}

function isConnectorSlug(
  snapshot: ConnectorRuntimeSnapshot,
  value: string,
): value is ConnectorSlug {
  return snapshot.connectors.has(value);
}

function baseKey(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function connectorCredentialResolution(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
): "network-boundary" | "none" {
  return (snapshot.serverFirewalls.getExecutionMetadata(connectorSlug)
    ?.secretPlaceholderNames.length ?? 0) > 0
    ? "network-boundary"
    : "none";
}

function builtinTargetIdentity(
  connectorSlug: ConnectorSlug,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckTargetIdentity {
  const connector = getConnectorRuntimeConnector(
    catalogContext.snapshot,
    connectorSlug,
  );
  if (!connector) {
    throw new Error(`Missing connector runtime metadata: ${connectorSlug}`);
  }
  return {
    target: { kind: "builtin", connectorSlug },
    label: connector.catalogConnector.label,
    visibility: catalogContext.visibleConnectorSlugs.has(connectorSlug)
      ? "available"
      : "unavailable",
    credentialResolution: connectorCredentialResolution(
      catalogContext.snapshot,
      connectorSlug,
    ),
  };
}

function targetIdentity(
  config: ConnectorCheckRoutingConfig,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckTargetIdentity {
  if (config.target.kind === "builtin") {
    return {
      ...builtinTargetIdentity(config.target.connectorSlug, catalogContext),
      credentialResolution: config.credentialResolution,
    };
  }
  return {
    target: config.target,
    label: config.label,
    visibility: "available",
    credentialResolution: config.credentialResolution,
  };
}

const connectorCheckFeatureStates$ = command(
  async ({ get }, orgId: string, userId: string): Promise<FeatureStates> => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return getAllFeatureStates({ orgId, userId, overrides });
  },
);

function pendingStoredConnectorRuntimes(
  rows: readonly StoredConnectorRuntimeCandidate[],
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
): ReadonlyMap<ConnectorSlug, PendingStoredConnectorRuntime | null> {
  const pending = new Map<
    ConnectorSlug,
    PendingStoredConnectorRuntime | null
  >();

  for (const row of rows) {
    if (pending.has(row.connectorSlug)) {
      throw new Error(
        `Duplicate stored connector state for ${row.connectorSlug}`,
      );
    }
    const accessResult = resolveBuiltinConnectorCredentialAccess({
      snapshot: args.snapshot,
      stored: {
        authMethodId: row.authMethod,
        automaticAuthType: row.automaticAuthType,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: args.orgId,
        storageVersion: row.storageVersion,
        userId: args.userId,
      },
    });
    if (!isConnectorSlug(args.snapshot, row.connectorSlug)) {
      continue;
    }
    if (accessResult.kind !== "ok") {
      pending.set(row.connectorSlug, null);
      continue;
    }
    const { access } = accessResult;
    const requiredRuntimeNames =
      args.snapshot.serverFirewalls.getExecutionMetadata(row.connectorSlug)
        ?.baseUrlVarNames ?? [];
    if (requiredRuntimeNames.length === 0) {
      pending.set(row.connectorSlug, {
        access,
        storageNameByRuntimeName: new Map(),
      });
      continue;
    }

    const runtimeMetadata = connectorAuthMethodRuntimeMetadata(
      access.runtimeMethod.method,
    );
    const requiredNameSet = new Set(requiredRuntimeNames);
    const storageNameByRuntimeName = new Map<string, string>();
    for (const binding of runtimeMetadata.runtimeBindings) {
      if (
        requiredNameSet.has(binding.envName) &&
        binding.source.kind === "connector-variable"
      ) {
        storageNameByRuntimeName.set(binding.envName, binding.source.name);
      }
    }
    pending.set(
      row.connectorSlug,
      storageNameByRuntimeName.size === requiredNameSet.size
        ? { access, storageNameByRuntimeName }
        : null,
    );
  }

  return pending;
}

async function loadStoredRuntimeState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
): Promise<StoredRuntimeState> {
  return await db.transaction(
    async (tx) => {
      const connectorRows = await tx
        .select({
          connectorId: connectors.id,
          connectorSlug: sql`${connectors.connectorSlug}`
            .mapWith(pgTextDecoder)
            .as("connector_slug"),
          authMethod: connectors.authMethod,
          automaticAuthType: connectors.automaticAuthType,
          storageVersion: connectors.storageVersion,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            isNotNull(connectors.connectorSlug),
            eq(connectors.isDefault, true),
          ),
        );

      const pending = pendingStoredConnectorRuntimes(connectorRows, args);
      const credentialResolutionBySlug = new Map<
        ConnectorSlug,
        "network-boundary" | "none"
      >();
      for (const row of connectorRows) {
        const runtime = pending.get(row.connectorSlug);
        if (
          runtime?.access.runtimeMethod.method.grant.kind === "automatic" &&
          row.automaticAuthType !== null
        ) {
          credentialResolutionBySlug.set(
            row.connectorSlug,
            row.automaticAuthType === "oauth" ? "network-boundary" : "none",
          );
        }
      }

      const readGroups = [...pending.values()].flatMap((value) => {
        return value === null || value.storageNameByRuntimeName.size === 0
          ? []
          : [
              {
                access: value.access,
                names: [...value.storageNameByRuntimeName.values()],
              },
            ];
      });
      const variableRows =
        readGroups.length === 0
          ? []
          : await tx
              .select({ name: variables.name, value: variables.value })
              .from(variables)
              .where(
                builtinConnectorCredentialVariableReadCondition({
                  db: tx,
                  groups: readGroups,
                }),
              );
      const valueByStorageName = new Map(
        variableRows.map((row) => {
          return [row.name, row.value] as const;
        }),
      );
      const baseUrlVarsBySlug = new Map<
        ConnectorSlug,
        Readonly<Record<string, string>> | null
      >();
      for (const [connectorSlug, pendingState] of pending) {
        if (pendingState === null) {
          baseUrlVarsBySlug.set(connectorSlug, null);
          continue;
        }
        const values: Record<string, string> = {};
        let complete = true;
        for (const [
          runtimeName,
          storageName,
        ] of pendingState.storageNameByRuntimeName) {
          const value = valueByStorageName.get(storageName);
          if (!value) {
            complete = false;
            break;
          }
          values[runtimeName] = value;
        }
        baseUrlVarsBySlug.set(connectorSlug, complete ? values : null);
      }

      return { baseUrlVarsBySlug, credentialResolutionBySlug };
    },
    {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    },
  );
}

function routesToDecisionPermissions(
  routes: readonly FirewallRoutingRouteMetadata[],
): DecisionPermission[] {
  const rulesByPermission = new Map<string, string[]>();
  for (const route of routes) {
    const rules = rulesByPermission.get(route.permissionName);
    if (rules) {
      rules.push(route.rule);
    } else {
      rulesByPermission.set(route.permissionName, [route.rule]);
    }
  }
  return [...rulesByPermission].map(([name, rules]) => {
    return { name, rules };
  });
}

function configsToDecisionFirewalls(
  configs: readonly ConnectorCheckRoutingConfig[],
) {
  return configs.map((config) => {
    return {
      name: connectorRuntimeTargetKey(config.target),
      apis: config.candidates.map((candidate) => {
        return {
          base: candidate.decisionBase,
          auth: {},
          permissions: routesToDecisionPermissions(candidate.routes),
        };
      }),
    };
  });
}

function configFromCatalogView(
  view: ConnectorDiagnosticCatalogView,
  baseUrlVars: Readonly<Record<string, string>> | null,
  allowStructuralDynamic: boolean,
  networkPolicy?: NetworkPolicy | null,
  credentialResolution?: "network-boundary" | "none",
): ConnectorCheckRoutingConfig {
  const result = buildConnectorDiagnosticBaseCandidates(view, baseUrlVars, {
    allowStructuralDynamic,
  });
  return {
    target: { kind: "builtin", connectorSlug: view.connectorSlug },
    label: view.label,
    credentialResolution:
      credentialResolution ??
      (view.executionMetadata.secretPlaceholderNames.length > 0
        ? "network-boundary"
        : "none"),
    candidates: result.candidates,
    hasUnresolvedDynamicBase: result.hasUnresolvedDynamicBase,
    networkPolicy,
  };
}

function customDiagnosticRoutes(
  permissions: Extract<
    ConnectorRuntimeDiagnosticResult,
    {
      readonly target: { readonly kind: "custom" };
      readonly state: "available";
    }
  >["apis"][number]["permissions"],
): FirewallRoutingRouteMetadata[] {
  return permissions.flatMap((permission) => {
    return permission.rules.map((rule) => {
      return { permissionName: permission.name, rule };
    });
  });
}

function configFromCustomRuntime(
  runtime: Extract<
    ConnectorRuntimeDiagnosticResult,
    {
      readonly target: { readonly kind: "custom" };
      readonly state: "available";
    }
  >,
): ConnectorCheckRoutingConfig {
  return {
    target: runtime.target,
    label: runtime.label,
    credentialResolution: runtime.credentialResolution,
    candidates: runtime.apis.map((api) => {
      return {
        sourceBase: api.base,
        decisionBase: api.base,
        displayBase: baseKey(api.base),
        routes: customDiagnosticRoutes(api.permissions),
        environmentNames: null,
      };
    }),
    hasUnresolvedDynamicBase: false,
    networkPolicy: runtime.networkPolicy,
  };
}

interface RunDiagnosticRegistration {
  readonly agentId: string;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}

type LoadRunDiagnosticRegistrationResult =
  | {
      readonly kind: "available";
      readonly registration: RunDiagnosticRegistration;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "not-found" };

async function loadRunDiagnosticRegistration(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<LoadRunDiagnosticRegistrationResult> {
  const [row] = await db
    .select({
      agentId: agents.id,
      registrationRunId: agentRunConnectorDiagnosticRegistrations.runId,
      payload: agentRunConnectorDiagnosticRegistrations.payload,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .leftJoin(
      agentRunConnectorDiagnosticRegistrations,
      eq(agentRunConnectorDiagnosticRegistrations.runId, agentRuns.id),
    )
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .limit(1);
  if (!row) {
    return { kind: "not-found" };
  }
  if (row.registrationRunId === null) {
    return { kind: "missing" };
  }
  const payload = agentRunConnectorDiagnosticRegistrationPayloadSchema.parse(
    row.payload,
  );
  return {
    kind: "available",
    registration: { agentId: row.agentId, targets: payload.targets },
  };
}

function targetAwareUrlRequest(
  request: ConnectorCheckRequestBody,
): request is ConnectorCheckTargetAwareUrlRequest {
  return (
    request.mode === "url" &&
    ("includeCustomConnectors" in request || "target" in request)
  );
}

function runtimeTargetsForRequest(
  registration: RunDiagnosticRegistration,
  request: ConnectorCheckRequestBody,
): readonly ConnectorRuntimeTargetRegistration[] {
  if (!targetAwareUrlRequest(request)) {
    return registration.targets.filter((target) => {
      return target.kind === "builtin";
    });
  }
  const includeCustomConnectors =
    request.includeCustomConnectors === true ||
    request.target?.kind === "custom";
  return registration.targets.filter((target) => {
    return target.kind === "builtin" || includeCustomConnectors;
  });
}

function unavailableRuntimeReason(
  runtime: Exclude<
    ConnectorRuntimeDiagnosticResult,
    { readonly state: "available" }
  >,
): ConnectorCheckTargetUnavailableReason {
  return runtime.reason;
}

function isBuiltinDiagnosticRuntime(
  runtime: ConnectorRuntimeDiagnosticResult,
): runtime is Extract<
  ConnectorRuntimeDiagnosticResult,
  { readonly target: { readonly kind: "builtin" } }
> {
  return runtime.target.kind === "builtin";
}

function isCustomAvailableDiagnosticRuntime(
  runtime: ConnectorRuntimeDiagnosticResult,
): runtime is Extract<
  ConnectorRuntimeDiagnosticResult,
  { readonly label: string }
> {
  return "label" in runtime;
}

async function loadRunDiagnosticState(args: {
  readonly db: Db;
  readonly scope: RunDiagnosticRegistration;
  readonly request: ConnectorCheckRequestBody;
  readonly orgId: string;
  readonly userId: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Promise<RunDiagnosticState> {
  const targets = runtimeTargetsForRequest(args.scope, args.request);
  const runtimes =
    targets.length === 0
      ? []
      : await resolveConnectorRuntimeDiagnosticTargets({
          db: args.db,
          scope: {
            orgId: args.orgId,
            userId: args.userId,
            agentId: args.scope.agentId,
          },
          targets,
        });
  const runtimeByTargetKey = new Map(
    runtimes.map((runtime) => {
      return [connectorRuntimeTargetKey(runtime.target), runtime] as const;
    }),
  );

  const configs: ConnectorCheckRoutingConfig[] = [];
  const unavailableReasonByTargetKey = new Map<
    string,
    ConnectorCheckTargetUnavailableReason
  >();
  for (const registration of targets) {
    const key = connectorRuntimeTargetKey(registration);
    const runtime = runtimeByTargetKey.get(key);
    if (!runtime) {
      throw new Error(`Missing connector runtime diagnostic result: ${key}`);
    }
    if (isCustomAvailableDiagnosticRuntime(runtime)) {
      configs.push(configFromCustomRuntime(runtime));
      continue;
    }
    if (!isBuiltinDiagnosticRuntime(runtime)) {
      unavailableReasonByTargetKey.set(key, unavailableRuntimeReason(runtime));
      continue;
    }
    const connectorSlug = runtime.target.connectorSlug;
    const view = await loadConnectorDiagnosticCatalogView(
      args.snapshot.serverFirewalls,
      connectorSlug,
    );
    if (!view) {
      unavailableReasonByTargetKey.set(key, "connector-unavailable");
      continue;
    }
    const networkPolicy =
      runtime.state === "available" ? runtime.networkPolicy : null;
    if (runtime.state !== "available") {
      unavailableReasonByTargetKey.set(key, unavailableRuntimeReason(runtime));
    }
    configs.push(
      configFromCatalogView(
        view,
        registration.kind === "builtin"
          ? (registration.baseUrlVars ?? null)
          : null,
        false,
        networkPolicy,
        runtime.state === "available"
          ? runtime.credentialResolution
          : undefined,
      ),
    );
  }
  return {
    configs,
    admittedTargetKeys: new Set(
      args.scope.targets.map((target) => {
        return connectorRuntimeTargetKey(target);
      }),
    ),
    unavailableReasonByTargetKey,
  };
}

async function catalogConfig(
  connectorSlug: ConnectorSlug,
  state: StoredRuntimeState,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorCheckRoutingConfig | null> {
  const view = await loadConnectorDiagnosticCatalogView(
    snapshot.serverFirewalls,
    connectorSlug,
  );
  if (!view) {
    return null;
  }
  return configFromCatalogView(
    view,
    state.baseUrlVarsBySlug.get(connectorSlug) ?? null,
    true,
    undefined,
    state.credentialResolutionBySlug.get(connectorSlug),
  );
}

async function loadGlobalCatalogConfigs(
  request: ParsedConnectorDiagnosticRequest,
  requestedConnectorSlug: ConnectorSlug | undefined,
  state: StoredRuntimeState,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorCheckRoutingConfig[]> {
  let bestScore: number | null = null;
  const ownerSlugs = new Set<ConnectorSlug>();

  for (const connectorSlug of snapshot.serverFirewalls.connectorSlugs) {
    const metadata =
      snapshot.serverFirewalls.getRoutingIndexMetadata(connectorSlug);
    const execution =
      snapshot.serverFirewalls.getExecutionMetadata(connectorSlug);
    if (!metadata || !execution) {
      throw new Error(
        `Missing indexed connector server firewall metadata for ${connectorSlug}`,
      );
    }
    const baseUrlVars = state.baseUrlVarsBySlug.get(connectorSlug) ?? null;
    for (const api of metadata.apis) {
      const resolution = resolveConnectorDiagnosticBase(
        execution,
        api.base,
        baseUrlVars,
        { allowStructuralDynamic: true },
      );
      if (!resolution.candidate) {
        continue;
      }
      const match = matchFirewallBaseUrl(
        request.url,
        resolution.candidate.decisionBase,
      );
      if (!match) {
        continue;
      }
      if (bestScore === null || match.score > bestScore) {
        bestScore = match.score;
        ownerSlugs.clear();
      }
      if (match.score === bestScore) {
        ownerSlugs.add(connectorSlug);
      }
    }
  }

  if (ownerSlugs.size === 0 && requestedConnectorSlug) {
    const selected = await catalogConfig(
      requestedConnectorSlug,
      state,
      snapshot,
    );
    return selected ? [selected] : [];
  }

  const configs = await Promise.all(
    [...ownerSlugs].sort().map(async (connectorSlug) => {
      const config = await catalogConfig(connectorSlug, state, snapshot);
      if (!config) {
        throw new Error(
          `Missing indexed firewall metadata for ${connectorSlug}`,
        );
      }
      return config;
    }),
  );
  return configs;
}

function decisionOwnerNames(
  decision: FirewallRequestDecision,
): readonly string[] {
  if (decision.kind === "ambiguous") {
    return decision.candidates;
  }
  if (decision.kind === "allow" || decision.kind === "block") {
    return [decision.firewallName];
  }
  return [];
}

function environmentNamesForWinningCandidates(
  config: ConnectorCheckRoutingConfig,
  request: ParsedConnectorDiagnosticRequest,
): readonly string[] | null {
  const candidateByOwner = new Map<string, ConnectorDiagnosticBaseCandidate>();
  const firewalls = config.candidates.map((candidate, index) => {
    const name = `diagnostic-api-${index}`;
    candidateByOwner.set(name, candidate);
    return {
      name,
      apis: [
        {
          base: candidate.decisionBase,
          auth: {},
          permissions: routesToDecisionPermissions(candidate.routes),
        },
      ],
    };
  });
  const decision = matchFirewallRequestDecision(
    firewalls,
    request.method,
    request.url,
  );
  const names = new Set<string>();
  let found = false;
  for (const owner of decisionOwnerNames(decision)) {
    const candidate = candidateByOwner.get(owner);
    if (!candidate) {
      continue;
    }
    found = true;
    if (candidate.environmentNames === null) {
      return null;
    }
    for (const name of candidate.environmentNames) {
      names.add(name);
    }
  }
  return found ? [...names].sort() : null;
}

function connectorEnvironmentBindings(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
): readonly ConnectorRuntimeBindingEntry[] {
  const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
  if (!connector) {
    return [];
  }
  return [...connector.methods.values()]
    .filter((runtimeMethod) => {
      return runtimeMethod.executable;
    })
    .flatMap((runtimeMethod) => {
      return connectorAuthMethodRuntimeMetadata(runtimeMethod.method)
        .runtimeBindings;
    });
}

function environmentValueRefs(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
  environmentName: string,
): ReadonlySet<string> {
  return new Set(
    connectorEnvironmentBindings(snapshot, connectorSlug)
      .filter((entry) => {
        return entry.envName === environmentName;
      })
      .map((entry) => {
        return entry.valueRef;
      }),
  );
}

function environmentNameSupportsRoute(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
  environmentName: string,
  routeEnvironmentNames: readonly string[],
): boolean {
  const requestedRefs = environmentValueRefs(
    snapshot,
    connectorSlug,
    environmentName,
  );
  return routeEnvironmentNames.some((routeEnvironmentName) => {
    if (routeEnvironmentName === environmentName) {
      return true;
    }
    const routeRefs = environmentValueRefs(
      snapshot,
      connectorSlug,
      routeEnvironmentName,
    );
    return [...requestedRefs].some((valueRef) => {
      return routeRefs.has(valueRef);
    });
  });
}

function configuredBases(config: ConnectorCheckRoutingConfig): string[] {
  return [
    ...new Set(
      config.candidates.map((candidate) => {
        return publicConnectorDiagnosticBase(candidate.displayBase);
      }),
    ),
  ].sort();
}

function runStatus(
  timeline: ConnectorCheckTimeline,
  config: ConnectorCheckRoutingConfig | undefined,
) {
  if (timeline.kind === "stored") {
    return { status: "not-scoped" as const };
  }
  if (!config) {
    return { status: "not-configured" as const };
  }
  return { status: "configured" as const, bases: configuredBases(config) };
}

function unavailablePolicy(
  timeline: ConnectorCheckTimeline,
  config: ConnectorCheckRoutingConfig | undefined,
): ConnectorCheckPolicy | null {
  if (timeline.kind === "stored") {
    return { outcome: "unavailable", basis: "not-run-scoped" };
  }
  if (!config) {
    return { outcome: "unavailable", basis: "connector-not-configured" };
  }
  if (config.networkPolicy === null) {
    return { outcome: "unavailable", basis: "policies-unavailable" };
  }
  if (config.networkPolicy === undefined) {
    throw new Error("Missing run-scoped connector policy state");
  }
  return null;
}

function permissionPolicy(
  config: ConnectorCheckRoutingConfig | undefined,
  permission: string,
  timeline: ConnectorCheckTimeline,
): ConnectorCheckPolicy {
  const unavailable = unavailablePolicy(timeline, config);
  if (unavailable) {
    return unavailable;
  }
  if (
    timeline.kind !== "run" ||
    !config ||
    config.networkPolicy === undefined
  ) {
    throw new Error("Missing resolved run policy timeline");
  }
  const policy = config.networkPolicy;
  if (policy === null) {
    throw new Error("Missing available connector policy");
  }
  if (policy.deny.includes(permission)) {
    return { outcome: "deny", basis: "deny-list" };
  }
  if (policy.ask.includes(permission)) {
    return { outcome: "ask", basis: "ask-list" };
  }
  if (policy.allow.includes(permission)) {
    return { outcome: "allow", basis: "allow-list" };
  }
  return { outcome: "allow", basis: "not-blocked" };
}

function unknownPolicy(
  config: ConnectorCheckRoutingConfig,
  timeline: ConnectorCheckTimeline,
): ConnectorCheckPolicy {
  const unavailable = unavailablePolicy(timeline, config);
  if (unavailable) {
    return unavailable;
  }
  if (timeline.kind !== "run" || config.networkPolicy === undefined) {
    throw new Error("Missing resolved run policy timeline");
  }
  const policy = config.networkPolicy;
  if (policy === null) {
    throw new Error("Missing available connector policy");
  }
  switch (policy.unknownPolicy) {
    case "allow": {
      return { outcome: "allow", basis: "unknown-policy" };
    }
    case "deny": {
      return { outcome: "deny", basis: "unknown-policy" };
    }
    case "ask": {
      return { outcome: "ask", basis: "unknown-policy" };
    }
  }
}

function decisionPermissionResult(
  config: ConnectorCheckRoutingConfig,
  decision: Exclude<
    FirewallRequestDecision,
    { readonly kind: "no_match" | "ambiguous" }
  >,
  timeline: ConnectorCheckTimeline,
) {
  if (decision.kind === "allow") {
    if (decision.permission === undefined) {
      return {
        kind: "unknown-endpoint" as const,
        policy: unknownPolicy(config, timeline),
      };
    }
    return {
      kind: "matched" as const,
      permissions: [
        {
          name: decision.permission,
          policy: permissionPolicy(config, decision.permission, timeline),
        },
      ],
    };
  }

  if (decision.reason === "unknown_endpoint") {
    return {
      kind: "unknown-endpoint" as const,
      policy: unknownPolicy(config, timeline),
    };
  }
  if (decision.reason !== "permission_denied") {
    throw new Error(
      `Invalid connector diagnostic decision: ${decision.reason}`,
    );
  }
  const permissions = [...new Set(decision.permissions)].sort().map((name) => {
    const policy = permissionPolicy(config, name, timeline);
    if (policy.outcome !== "deny" && policy.outcome !== "ask") {
      throw new Error(
        `Inconsistent blocked permission policy for ${connectorRuntimeTargetKey(config.target)}`,
      );
    }
    return { name, policy };
  });
  if (permissions.length === 0) {
    throw new Error(
      `Missing blocked permissions for ${connectorRuntimeTargetKey(config.target)}`,
    );
  }
  return { kind: "matched" as const, permissions };
}

function displayBaseForDecision(
  config: ConnectorCheckRoutingConfig,
  decisionBase: string,
): string {
  const candidate = config.candidates.find((entry) => {
    return baseKey(entry.decisionBase) === baseKey(decisionBase);
  });
  if (!candidate) {
    throw new Error(
      `Missing diagnostic display base for ${connectorRuntimeTargetKey(config.target)}`,
    );
  }
  return publicConnectorDiagnosticBase(candidate.displayBase);
}

function connectorSlugForEnvironmentName(
  snapshot: ConnectorRuntimeSnapshot,
  environmentName: string,
): ConnectorSlug | null {
  const owners = [...snapshot.connectors.keys()].filter((connectorSlug) => {
    return connectorEnvironmentBindings(snapshot, connectorSlug).some(
      (entry) => {
        return entry.envName === environmentName;
      },
    );
  });
  const [owner, ...others] = owners;
  if (!owner) {
    return null;
  }
  if (others.length > 0) {
    throw new Error(`Ambiguous connector environment name: ${environmentName}`);
  }
  return owner;
}

function policyMap(timeline: ConnectorCheckTimeline): NetworkPolicies | null {
  if (timeline.kind === "stored") {
    return null;
  }
  return Object.fromEntries(
    timeline.state.configs.flatMap((config) => {
      return config.networkPolicy
        ? [[connectorRuntimeTargetKey(config.target), config.networkPolicy]]
        : [];
    }),
  );
}

function noMatchDiagnostic(
  requestedTarget: ConnectorRuntimeTarget | undefined,
  configs: readonly ConnectorCheckRoutingConfig[],
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
  targetAware: boolean,
): ConnectorCheckTargetAwareDiagnosticResult {
  const selectedConfig = requestedTarget
    ? configs.find((config) => {
        return (
          connectorRuntimeTargetKey(config.target) ===
          connectorRuntimeTargetKey(requestedTarget)
        );
      })
    : undefined;
  if (requestedTarget && selectedConfig?.hasUnresolvedDynamicBase) {
    return {
      outcome: "unresolved-dynamic-base",
      connector: targetIdentity(selectedConfig, catalogContext),
    };
  }
  if (
    targetAware &&
    requestedTarget &&
    !selectedConfig &&
    timeline.kind === "run"
  ) {
    const key = connectorRuntimeTargetKey(requestedTarget);
    return {
      outcome: "target-unavailable",
      target: requestedTarget,
      reason: timeline.state.admittedTargetKeys.has(key)
        ? (timeline.state.unavailableReasonByTargetKey.get(key) ??
          "connector-unavailable")
        : "not-admitted",
    };
  }
  return {
    outcome: "no-match",
    scope: timeline.kind === "run" ? "run" : "catalog",
  };
}

function unresolvedOwnerDiagnostic(
  decision: Extract<FirewallRequestDecision, { readonly kind: "ambiguous" }>,
  configs: readonly ConnectorCheckRoutingConfig[],
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckTargetAwareDiagnosticResult {
  const candidates = decision.candidates.map((candidate) => {
    const config = configs.find((entry) => {
      return connectorRuntimeTargetKey(entry.target) === candidate;
    });
    if (!config) {
      throw new Error(`Matched an unknown connector target: ${candidate}`);
    }
    return config;
  });
  const [soleCandidate] = candidates;
  if (
    decision.reason === "connector_intent_not_candidate" &&
    candidates.length === 1 &&
    soleCandidate
  ) {
    return {
      outcome: "connector-mismatch",
      connector: targetIdentity(soleCandidate, catalogContext),
    };
  }
  return {
    outcome: "ambiguous",
    candidates: candidates.map((config) => {
      return {
        target: config.target,
        label: config.label,
      };
    }),
  };
}

type UrlEnvironmentSelection =
  | {
      readonly kind: "selected";
      readonly environmentNames: string[] | null;
    }
  | {
      readonly kind: "diagnostic";
      readonly diagnostic: ConnectorCheckTargetAwareDiagnosticResult;
    };

function selectUrlEnvironmentNames(args: {
  readonly catalogContext: ConnectorCheckCatalogContext;
  readonly config: ConnectorCheckRoutingConfig;
  readonly parsed: ParsedConnectorDiagnosticRequest;
  readonly requestedEnvironmentName: string | undefined;
  readonly identity: ConnectorCheckTargetIdentity;
}): UrlEnvironmentSelection {
  const environmentNames = environmentNamesForWinningCandidates(
    args.config,
    args.parsed,
  );
  if (args.requestedEnvironmentName === undefined) {
    return {
      kind: "selected",
      environmentNames:
        environmentNames === null ? null : [...environmentNames],
    };
  }
  if (args.config.target.kind === "custom") {
    return {
      kind: "diagnostic",
      diagnostic: {
        outcome: "environment-not-owned",
        connector: args.identity,
      },
    };
  }
  const connectorSlug = args.config.target.connectorSlug;
  const owned = connectorEnvironmentBindings(
    args.catalogContext.snapshot,
    connectorSlug,
  ).some((entry) => {
    return entry.envName === args.requestedEnvironmentName;
  });
  if (!owned) {
    return {
      kind: "diagnostic",
      diagnostic: {
        outcome: "environment-not-owned",
        connector: args.identity,
      },
    };
  }
  if (
    environmentNames !== null &&
    !environmentNameSupportsRoute(
      args.catalogContext.snapshot,
      connectorSlug,
      args.requestedEnvironmentName,
      environmentNames,
    )
  ) {
    return {
      kind: "diagnostic",
      diagnostic: {
        outcome: "environment-not-used",
        connector: args.identity,
        environmentNames: [...environmentNames],
      },
    };
  }
  return {
    kind: "selected",
    environmentNames: [args.requestedEnvironmentName],
  };
}

interface ResolvedUrlDiagnosticArgs {
  readonly request: Extract<
    ConnectorCheckRequestBody,
    { readonly mode: "url" }
  >;
  readonly parsed: ParsedConnectorDiagnosticRequest;
  readonly decision: Exclude<
    FirewallRequestDecision,
    { readonly kind: "no_match" | "ambiguous" }
  >;
  readonly configs: readonly ConnectorCheckRoutingConfig[];
  readonly timeline: ConnectorCheckTimeline;
  readonly catalogContext: ConnectorCheckCatalogContext;
}

function resolvedUrlDiagnostic(
  args: ResolvedUrlDiagnosticArgs,
): ConnectorCheckTargetAwareDiagnosticResult {
  const { request, parsed, decision, configs, timeline, catalogContext } = args;
  if (decision.kind === "block" && decision.reason === "unsafe_path") {
    return { outcome: "unsafe-input", reason: "unsafe-path" };
  }
  if (
    decision.kind === "block" &&
    (decision.reason === "malformed_firewall_config" ||
      decision.reason === "malformed_network_policy")
  ) {
    throw new Error(
      `Invalid connector diagnostic decision: ${decision.reason}`,
    );
  }
  const config = configs.find((entry) => {
    return connectorRuntimeTargetKey(entry.target) === decision.firewallName;
  });
  if (!config) {
    throw new Error(
      `Missing selected connector routing config for ${decision.firewallName}`,
    );
  }
  const requestedTarget = requestedUrlTarget(request);
  if (
    requestedTarget &&
    connectorRuntimeTargetKey(config.target) !==
      connectorRuntimeTargetKey(requestedTarget)
  ) {
    return {
      outcome: "connector-mismatch",
      connector: targetIdentity(config, catalogContext),
    };
  }

  const identity = targetIdentity(config, catalogContext);
  const environmentSelection = selectUrlEnvironmentNames({
    catalogContext,
    config,
    parsed,
    requestedEnvironmentName: request.environmentName,
    identity,
  });
  if (environmentSelection.kind === "diagnostic") {
    return environmentSelection.diagnostic;
  }
  return {
    outcome: "resolved",
    mode: "url",
    connector: identity,
    environmentNames: environmentSelection.environmentNames,
    run: runStatus(timeline, config),
    method: parsed.method,
    base: displayBaseForDecision(config, decision.base),
    relativePath: decision.relativePath,
    permission: decisionPermissionResult(config, decision, timeline),
  };
}

function requestedUrlTarget(
  request: Extract<ConnectorCheckRequestBody, { readonly mode: "url" }>,
): ConnectorRuntimeTarget | undefined {
  if (targetAwareUrlRequest(request)) {
    return request.target;
  }
  return request.connectorSlug
    ? { kind: "builtin", connectorSlug: request.connectorSlug }
    : undefined;
}

async function resolveUrlMode(
  request: Extract<ConnectorCheckRequestBody, { readonly mode: "url" }>,
  parsed: ParsedConnectorDiagnosticRequest,
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
): Promise<ConnectorCheckTargetAwareDiagnosticResult> {
  const targetAware = targetAwareUrlRequest(request);
  const requestedTarget = requestedUrlTarget(request);
  const requestedConnectorSlug =
    requestedTarget?.kind === "builtin"
      ? requestedTarget.connectorSlug
      : undefined;
  if (
    !targetAware &&
    requestedConnectorSlug !== undefined &&
    !isConnectorSlug(catalogContext.snapshot, requestedConnectorSlug)
  ) {
    return { outcome: "unknown-connector" };
  }

  const configs =
    timeline.kind === "run"
      ? timeline.state.configs
      : await loadGlobalCatalogConfigs(
          parsed,
          requestedConnectorSlug,
          timeline.state,
          catalogContext.snapshot,
        );
  if (
    targetAware &&
    requestedTarget &&
    timeline.kind === "run" &&
    !configs.some((config) => {
      return (
        connectorRuntimeTargetKey(config.target) ===
        connectorRuntimeTargetKey(requestedTarget)
      );
    })
  ) {
    return noMatchDiagnostic(
      requestedTarget,
      configs,
      timeline,
      catalogContext,
      targetAware,
    );
  }
  const decision = matchFirewallRequestDecision(
    configsToDecisionFirewalls(configs),
    parsed.method,
    parsed.url,
    policyMap(timeline),
    requestedTarget
      ? {
          status: "present",
          value: connectorRuntimeTargetKey(requestedTarget),
        }
      : { status: "absent" },
  );

  if (decision.kind === "no_match") {
    return noMatchDiagnostic(
      requestedTarget,
      configs,
      timeline,
      catalogContext,
      targetAware,
    );
  }
  if (decision.kind === "ambiguous") {
    return unresolvedOwnerDiagnostic(decision, configs, catalogContext);
  }
  return resolvedUrlDiagnostic({
    request,
    parsed,
    decision,
    configs,
    timeline,
    catalogContext,
  });
}

function resolveEnvironmentMode(
  request: Extract<ConnectorCheckRequest, { readonly mode: "environment" }>,
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckTargetAwareDiagnosticResult {
  const connectorSlug = connectorSlugForEnvironmentName(
    catalogContext.snapshot,
    request.environmentName,
  );
  if (!connectorSlug) {
    return { outcome: "unknown-environment" };
  }
  const configs = timeline.kind === "run" ? timeline.state.configs : [];
  const config = configs.find((entry) => {
    return (
      entry.target.kind === "builtin" &&
      entry.target.connectorSlug === connectorSlug
    );
  });
  return {
    outcome: "resolved",
    mode: "environment",
    connector: builtinTargetIdentity(connectorSlug, catalogContext),
    environmentName: request.environmentName,
    run: runStatus(timeline, config),
    permission:
      request.permission === undefined
        ? null
        : permissionPolicy(config, request.permission, timeline),
  };
}

function legacyIdentity(
  identity: ConnectorCheckTargetIdentity,
): ConnectorCheckLegacyIdentity {
  if (identity.target.kind !== "builtin") {
    throw new Error(
      "Legacy connector diagnostics cannot contain custom targets",
    );
  }
  return {
    connectorSlug: identity.target.connectorSlug,
    label: identity.label,
    visibility: identity.visibility,
    credentialResolution: identity.credentialResolution,
  };
}

function legacyDiagnostic(
  diagnostic: ConnectorCheckTargetAwareDiagnosticResult,
): ConnectorCheckDiagnosticResult {
  switch (diagnostic.outcome) {
    case "resolved": {
      return diagnostic.mode === "url"
        ? {
            outcome: diagnostic.outcome,
            mode: diagnostic.mode,
            connector: legacyIdentity(diagnostic.connector),
            environmentNames: diagnostic.environmentNames,
            run: diagnostic.run,
            method: diagnostic.method,
            base: diagnostic.base,
            relativePath: diagnostic.relativePath,
            permission: diagnostic.permission,
          }
        : {
            outcome: diagnostic.outcome,
            mode: diagnostic.mode,
            connector: legacyIdentity(diagnostic.connector),
            environmentName: diagnostic.environmentName,
            run: diagnostic.run,
            permission: diagnostic.permission,
          };
    }
    case "ambiguous": {
      return {
        outcome: diagnostic.outcome,
        candidates: diagnostic.candidates.map((candidate) => {
          if (candidate.target.kind !== "builtin") {
            throw new Error(
              "Legacy connector diagnostics cannot contain custom candidates",
            );
          }
          return {
            connectorSlug: candidate.target.connectorSlug,
            label: candidate.label,
          };
        }),
      };
    }
    case "connector-mismatch":
    case "environment-not-owned":
    case "unresolved-dynamic-base": {
      return {
        outcome: diagnostic.outcome,
        connector: legacyIdentity(diagnostic.connector),
      };
    }
    case "environment-not-used": {
      return {
        outcome: diagnostic.outcome,
        connector: legacyIdentity(diagnostic.connector),
        environmentNames: diagnostic.environmentNames,
      };
    }
    case "target-unavailable": {
      throw new Error("Legacy connector diagnostics cannot be target-aware");
    }
    case "unsafe-input":
    case "unknown-connector":
    case "unknown-environment":
    case "no-match":
    case "run-context-unavailable": {
      return diagnostic;
    }
  }
}

export const resolveConnectorCheck$ = command(
  async (
    { set },
    args: ResolveConnectorCheckArgs,
    signal: AbortSignal,
  ): Promise<ResolveConnectorCheckResult> => {
    let parsed: ParsedConnectorDiagnosticRequest | null = null;
    if (args.request.mode === "url") {
      const parseResult = parseConnectorDiagnosticRequest(
        args.request.method,
        args.request.url,
      );
      if ("outcome" in parseResult) {
        return { kind: "ok", diagnostic: parseResult };
      }
      parsed = parseResult;
    }

    const db = set(writeDb$);
    let runRegistration: RunDiagnosticRegistration | undefined;
    if (args.stateSource.kind === "run") {
      const registration = await loadRunDiagnosticRegistration(db, {
        runId: args.stateSource.runId,
        userId: args.userId,
        orgId: args.orgId,
      });
      signal.throwIfAborted();
      if (registration.kind === "not-found") {
        return { kind: "not-found" };
      }
      if (registration.kind === "missing") {
        return {
          kind: "ok",
          diagnostic: { outcome: "run-context-unavailable" },
        };
      }
      runRegistration = registration.registration;
    }

    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    let timeline: ConnectorCheckTimeline;
    if (runRegistration) {
      const state = await loadRunDiagnosticState({
        db,
        scope: runRegistration,
        request: args.request,
        orgId: args.orgId,
        userId: args.userId,
        snapshot,
      });
      signal.throwIfAborted();
      timeline = { kind: "run", state };
    } else {
      if (args.stateSource.kind !== "stored") {
        throw new Error("Missing active run diagnostic registration");
      }
      const state =
        args.request.mode === "url"
          ? await loadStoredRuntimeState(db, {
              orgId: args.orgId,
              userId: args.userId,
              snapshot,
            })
          : {
              baseUrlVarsBySlug: new Map(),
              credentialResolutionBySlug: new Map(),
            };
      signal.throwIfAborted();
      timeline = { kind: "stored", state };
    }

    const featureStates = await set(
      connectorCheckFeatureStates$,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    const visibleConnectorSlugs = listConnectorRuntimeVisibleSlugs({
      snapshot,
      featureStates,
    });
    signal.throwIfAborted();
    const catalogContext: ConnectorCheckCatalogContext = {
      snapshot,
      visibleConnectorSlugs: new Set(visibleConnectorSlugs),
    };
    let diagnostic: ConnectorCheckTargetAwareDiagnosticResult;
    if (args.request.mode === "url") {
      if (!parsed) {
        throw new Error("Missing parsed connector diagnostic request");
      }
      diagnostic = await resolveUrlMode(
        args.request,
        parsed,
        timeline,
        catalogContext,
      );
    } else {
      diagnostic = await resolveEnvironmentMode(
        args.request,
        timeline,
        catalogContext,
      );
    }
    signal.throwIfAborted();
    return {
      kind: "ok",
      diagnostic: targetAwareUrlRequest(args.request)
        ? diagnostic
        : legacyDiagnostic(diagnostic),
    };
  },
);
