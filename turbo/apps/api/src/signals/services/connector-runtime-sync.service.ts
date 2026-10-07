import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorRuntimeTargetKey,
  type ConnectorRuntimeCustomAbsentReason,
  type ConnectorRuntimeCustomUnresolvedReason,
  type ConnectorRuntimeSyncResult,
  type ConnectorRuntimeTarget,
  type ConnectorRuntimeTargetRegistration,
} from "@okouai/api-contracts/contracts/runners";
import type { FirewallApi } from "@okouai/connectors/firewall-types";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { resolveBuiltinConnectorCredentialAccess } from "./builtin-connector-credential-access.service";
import {
  connectorAccountTargetKey,
  resolveConnectorAccounts,
  resolvedConnectorAccountIdsByTarget,
  type ConnectorAccountResolutionRequest,
} from "./connector-account-resolution.service";
import type { ConnectorRuntimeLookup } from "./connector-catalog-runtime.service";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugRuntimeFromRows,
} from "./connector-catalog-slug-source.service";
import {
  buildCustomConnectorRuntimeContext,
  customConnectorRuntimeExecutionState,
  loadEffectiveCustomConnectorPermissionBundle,
  type CustomConnectorRuntimeDataRows,
} from "./connector-runtime-preparation.service";
import { loadCustomConnectorPermissionBundleDependencySlugs } from "./custom-connector-permission-bundle.service";
import { loadCustomConnectorRuntimeData } from "./custom-connector.service";

import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";

const L = logger("connector-runtime-sync");

interface ConnectorRuntimeScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface CustomTargetSnapshot {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly grant: AgentCustomConnectorGrant | undefined;
}

type ConnectorRuntimeBuiltinSyncResult = Extract<
  ConnectorRuntimeSyncResult,
  { readonly target: { readonly kind: "builtin" } }
>;

type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

type ConnectorRuntimeCustomSyncResult = Extract<
  ConnectorRuntimeSyncResult,
  { readonly target: { readonly kind: "custom" } }
>;

type ResolvedConnectorRuntimeTarget =
  | {
      readonly kind: "builtin";
      readonly result: ConnectorRuntimeBuiltinSyncResult;
      readonly credentialResolution?: "network-boundary" | "none";
    }
  | {
      readonly kind: "custom";
      readonly result: ConnectorRuntimeCustomSyncResult;
      readonly customSnapshot: CustomTargetSnapshot | undefined;
    };

interface ConnectorRuntimeDiagnosticApi {
  readonly base: string;
  readonly usesAwsSigv4: boolean;
  readonly permissions: readonly {
    readonly name: string;
    readonly rules: readonly string[];
  }[];
}

export type ConnectorRuntimeDiagnosticResult =
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "builtin" }
      >;
      readonly state: "available";
      readonly credentialResolution?: "network-boundary" | "none";
      readonly networkPolicy: Extract<
        ConnectorRuntimeSyncResult,
        {
          readonly target: { readonly kind: "builtin" };
          readonly state: "available";
        }
      >["networkPolicy"];
    }
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "builtin" }
      >;
      readonly state: "unresolved";
      readonly reason: "connector-unavailable";
    }
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "builtin" }
      >;
      readonly state: "absent";
      readonly reason: "connector-unavailable";
    }
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "custom" }
      >;
      readonly state: "available";
      readonly label: string;
      readonly credentialResolution: "network-boundary" | "none";
      readonly apis: readonly ConnectorRuntimeDiagnosticApi[];
      readonly networkPolicy: Extract<
        ConnectorRuntimeSyncResult,
        {
          readonly target: { readonly kind: "custom" };
          readonly state: "available";
        }
      >["networkPolicy"];
    }
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "custom" }
      >;
      readonly state: "unresolved";
      readonly reason: ConnectorRuntimeCustomUnresolvedReason;
    }
  | {
      readonly target: Extract<
        ConnectorRuntimeTarget,
        { readonly kind: "custom" }
      >;
      readonly state: "absent";
      readonly reason: ConnectorRuntimeCustomAbsentReason;
    };

function customAbsentResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomAbsentReason,
): ConnectorRuntimeCustomSyncResult {
  return {
    target,
    state: "absent",
    reason,
  };
}

function customUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "custom" }>,
  reason: ConnectorRuntimeCustomUnresolvedReason,
): ConnectorRuntimeCustomSyncResult {
  return {
    target,
    state: "unresolved",
    reason,
  };
}

function builtinUnresolvedResult(
  target: Extract<ConnectorRuntimeTarget, { readonly kind: "builtin" }>,
): ConnectorRuntimeBuiltinSyncResult {
  return {
    target,
    state: "unresolved",
    reason: "connector-unavailable",
  };
}

function authResolvesAtNetworkBoundary(auth: FirewallApi["auth"]): boolean {
  return (
    Object.keys(auth.headers ?? {}).length > 0 ||
    Object.keys(auth.query ?? {}).length > 0
  );
}

function builtinMcpCredentialResolution(args: {
  readonly snapshot: ConnectorRuntimeLookup | undefined;
  readonly registration: BuiltinRuntimeTargetRegistration;
  readonly credentialAvailable: boolean;
}): "network-boundary" | "none" | undefined {
  if (
    !args.snapshot ||
    !args.credentialAvailable ||
    !args.snapshot.serverFirewalls.isMcp(args.registration.connectorSlug)
  ) {
    return undefined;
  }
  const credentialed =
    args.snapshot.serverFirewalls
      .getRuntimeFirewall(args.registration.connectorSlug)
      ?.apis.some((api) => {
        return authResolvesAtNetworkBoundary(api.auth);
      }) ?? false;
  return credentialed ? "network-boundary" : "none";
}

function customTargetsFromRows(
  runtimeRows: CustomConnectorRuntimeDataRows,
  grantRows: readonly {
    readonly customConnectorId: string;
    readonly permissionNames: readonly string[];
  }[],
): ReadonlyMap<string, CustomTargetSnapshot> {
  const grants = new Map(
    grantRows.map((grant) => {
      return [grant.customConnectorId, grant] as const;
    }),
  );
  return new Map(
    runtimeRows.map((row) => {
      const grant = grants.get(row.connector.id);
      return [
        row.connector.id,
        {
          row,
          grant: grant
            ? {
                customConnectorId: grant.customConnectorId,
                permissionNames: [...grant.permissionNames],
              }
            : undefined,
        },
      ] as const;
    }),
  );
}

async function loadCustomSnapshot(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly registrations: readonly Extract<
    ConnectorRuntimeTargetRegistration,
    { readonly kind: "custom" }
  >[];
}) {
  return await args.db.transaction(
    async (tx) => {
      const customConnectorIds = args.registrations.map((registration) => {
        return registration.customConnectorId;
      });
      const metadataConnectorSlugs =
        await loadCustomConnectorPermissionBundleDependencySlugs(tx, {
          orgId: args.scope.orgId,
          customConnectorIds,
        });
      const catalogRows = await tx
        .select({
          current: {
            schemaVersion: connectorCatalog.schemaVersion,
            hash: connectorCatalog.hash,
          },
          entry: {
            slug: connectorCatalogEntries.slug,
            payload: connectorCatalogEntries.payload,
          },
        })
        .from(connectorCatalog)
        .leftJoin(
          connectorCatalogEntries,
          connectorCatalogSlugJoin(metadataConnectorSlugs),
        )
        .where(connectorCatalogCurrentWhere());
      // Permission-bundle dependencies are metadata only. A missing entry
      // resolves through the fail-closed unavailable custom runtime row.
      const connectorCatalogSelection = connectorCatalogSlugRuntimeFromRows(
        catalogRows,
        {
          runtimeConnectorSlugs: [],
          metadataConnectorSlugs,
          missingRuntimeEntries: "omit",
        },
      );
      const accountResolutions = await resolveConnectorAccounts(tx, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        requests: args.registrations.flatMap((registration) => {
          return registration.sourceId === undefined
            ? []
            : [
                {
                  target: {
                    kind: "custom" as const,
                    customConnectorId: registration.customConnectorId,
                  },
                  selection: {
                    kind: "exact" as const,
                    sourceId: registration.sourceId,
                  },
                },
              ];
        }),
      });
      const resolvedAccountIds =
        resolvedConnectorAccountIdsByTarget(accountResolutions);
      const memberConnectorIdsByCustomConnectorId = new Map<string, string>();
      for (const customConnectorId of customConnectorIds) {
        const memberConnectorId = resolvedAccountIds.get(
          connectorAccountTargetKey({ kind: "custom", customConnectorId }),
        );
        if (memberConnectorId) {
          memberConnectorIdsByCustomConnectorId.set(
            customConnectorId,
            memberConnectorId,
          );
        }
      }
      const featureSwitchContextRows0 = await tx
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(
          userFeatureSwitchRowCondition(args.scope.orgId, args.scope.userId),
        );
      const featureSwitchContext = featureSwitchContextFromRows(
        args.scope.orgId,
        args.scope.userId,
        featureSwitchContextRows0,
      );
      const runtimeRows = await loadCustomConnectorRuntimeData(tx, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        connectorIds: customConnectorIds,
        memberConnectorIdsByCustomConnectorId,
      });
      const grantRows = await tx
        .select({
          customConnectorId: userCustomConnectors.customConnectorId,
          permissionNames: userCustomConnectors.permissionNames,
        })
        .from(userCustomConnectors)
        .where(
          and(
            eq(userCustomConnectors.orgId, args.scope.orgId),
            eq(userCustomConnectors.userId, args.scope.userId),
            eq(userCustomConnectors.agentId, args.scope.agentId),
            inArray(userCustomConnectors.customConnectorId, customConnectorIds),
          ),
        );
      const customTargets = customTargetsFromRows(runtimeRows, grantRows);
      return {
        connectorCatalogSelection,
        featureSwitchContext,
        customTargets,
        accountResolutions,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function resolveCustomTarget(args: {
  readonly registration: Extract<
    ConnectorRuntimeTargetRegistration,
    { readonly kind: "custom" }
  >;
  readonly snapshot: Awaited<ReturnType<typeof loadCustomSnapshot>>;
}): Promise<ConnectorRuntimeCustomSyncResult> {
  const target = {
    kind: "custom" as const,
    customConnectorId: args.registration.customConnectorId,
  };
  const accountResolution = args.snapshot.accountResolutions.get(
    connectorAccountTargetKey(target),
  );
  if (accountResolution?.kind !== "resolved") {
    return customAbsentResult(target, "connector-unavailable");
  }
  const custom = args.snapshot.customTargets.get(target.customConnectorId);
  if (!custom) {
    return customAbsentResult(target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "incompatible") {
    L.debug("Custom connector credential storage is incompatible", {
      customConnectorId: target.customConnectorId,
      memberConnectorId: custom.row.credentialAccess.memberConnectorId,
      expectedAuthMethod: custom.row.credentialAccess.expectedAuthMethod,
      storedAuthMethod: custom.row.credentialAccess.storedAuthMethod,
      expectedStorageVersion:
        custom.row.credentialAccess.expectedStorageVersion,
      storedStorageVersion: custom.row.credentialAccess.storedStorageVersion,
      definitionAuthMethod: custom.row.credentialAccess.definitionAuthMethod,
      definitionStorageVersion:
        custom.row.credentialAccess.definitionStorageVersion,
    });
    return customAbsentResult(target, "connector-unavailable");
  }
  if (custom.row.credentialAccess.kind === "absent") {
    return customAbsentResult(target, "connector-unavailable");
  }
  const row = custom.row;
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row,
    snapshot: args.snapshot.connectorCatalogSelection,
  });
  if (permissionBundle === undefined) {
    return customUnresolvedResult(target, "permission-bundle-unavailable");
  }

  const baseUrlVarsByConnectorId = new Map([
    [target.customConnectorId, args.registration.baseUrlVars] as const,
  ]);

  const context = await buildCustomConnectorRuntimeContext({
    rows: [row],
    featureSwitchContext: args.snapshot.featureSwitchContext,
    connectorCatalogSnapshot: args.snapshot.connectorCatalogSelection,
    grants: [
      custom.grant ?? {
        customConnectorId: target.customConnectorId,
        permissionNames: [],
      },
    ],
    baseUrlVarsByConnectorId,
  });
  const state = customConnectorRuntimeExecutionState({
    context,
    connectorId: target.customConnectorId,
  });
  const resolvedTarget = context.targets.find((candidate) => {
    return (
      candidate.kind === "custom" &&
      candidate.customConnectorId === target.customConnectorId
    );
  });
  if (!state || resolvedTarget?.kind !== "custom") {
    return customUnresolvedResult(target, "runtime-configuration-unavailable");
  }
  return {
    target,
    state: "available" as const,
    firewall: {
      ...state.firewall,
      sourceId: accountResolution.account.connectorId,
    },
    networkPolicy: state.networkPolicy,
    baseUrlVars: { ...resolvedTarget.baseUrlVars },
  };
}

function connectorAccountRequests(
  registrations: readonly ConnectorRuntimeTargetRegistration[],
  catalogConnectorSlugs: ReadonlySet<string>,
): readonly ConnectorAccountResolutionRequest[] {
  return registrations.flatMap((registration) => {
    return registration.kind === "builtin" &&
      catalogConnectorSlugs.has(registration.connectorSlug) &&
      registration.sourceId !== undefined
      ? [
          {
            target: {
              kind: "builtin" as const,
              connectorSlug: registration.connectorSlug,
            },
            selection: {
              kind: "exact" as const,
              sourceId: registration.sourceId,
            },
          },
        ]
      : [];
  });
}

function resolveBuiltinTarget(args: {
  readonly registration: BuiltinRuntimeTargetRegistration;
  readonly scope: ConnectorRuntimeScope;
  readonly snapshot: ConnectorRuntimeLookup | undefined;
  readonly accounts: Awaited<ReturnType<typeof resolveConnectorAccounts>>;
  readonly refreshes: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof resolveActiveNetworkPolicyRefreshes>>[number]
  >;
}): ResolvedConnectorRuntimeTarget {
  const { registration, scope, snapshot } = args;
  const target = {
    kind: "builtin" as const,
    connectorSlug: registration.connectorSlug,
  };
  const accountResolution = args.accounts.get(
    connectorAccountTargetKey(target),
  );
  const credentialAccess =
    accountResolution?.kind === "resolved" && snapshot
      ? resolveBuiltinConnectorCredentialAccess({
          snapshot,
          stored: {
            authMethodId: accountResolution.account.authMethod,
            automaticAuthType: accountResolution.account.automaticAuthType,
            connectorId: accountResolution.account.connectorId,
            connectorSlug: registration.connectorSlug,
            orgId: scope.orgId,
            storageVersion: accountResolution.account.storageVersion,
            userId: scope.userId,
          },
        })
      : undefined;
  const refresh = args.refreshes.get(connectorRuntimeTargetKey(target));
  const credentialResolution = builtinMcpCredentialResolution({
    snapshot,
    registration,
    credentialAvailable: credentialAccess?.kind === "ok",
  });
  return {
    kind: "builtin",
    ...(credentialResolution === undefined ? {} : { credentialResolution }),
    // Without a manifest a missing entry cannot prove the connector was
    // retired. Keep the Run's registered scope (last-known-good) and retry.
    result: !snapshot?.connectors.has(registration.connectorSlug)
      ? builtinUnresolvedResult(target)
      : refresh && credentialAccess?.kind === "ok"
        ? {
            target,
            state: "available",
            networkPolicy: refresh.networkPolicy,
            ...(refresh.nextRefreshAt
              ? { nextSyncAt: refresh.nextRefreshAt }
              : {}),
          }
        : builtinUnresolvedResult(target),
  };
}

async function resolveConnectorRuntimeTargetStates(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}): Promise<readonly ResolvedConnectorRuntimeTarget[]> {
  const builtinConnectorSlugs = args.targets.flatMap((target) => {
    return target.kind === "builtin" ? [target.connectorSlug] : [];
  });
  const customRegistrations = args.targets.flatMap((target) => {
    return target.kind === "custom" ? [target] : [];
  });
  const builtinCatalogSelection =
    builtinConnectorSlugs.length > 0
      ? connectorCatalogSlugRuntimeFromRows(
          await args.db
            .select({
              current: {
                schemaVersion: connectorCatalog.schemaVersion,
                hash: connectorCatalog.hash,
              },
              entry: {
                slug: connectorCatalogEntries.slug,
                payload: connectorCatalogEntries.payload,
              },
            })
            .from(connectorCatalog)
            .leftJoin(
              connectorCatalogEntries,
              connectorCatalogSlugJoin(builtinConnectorSlugs),
            )
            .where(connectorCatalogCurrentWhere()),
          // Registered targets are required, but per target: a missing entry
          // becomes `unresolved` below, never an authoritative `absent`.
          {
            runtimeConnectorSlugs: builtinConnectorSlugs,
            missingRuntimeEntries: "omit",
          },
        )
      : undefined;
  const builtinCatalogConnectorSlugs = new Set(
    builtinCatalogSelection?.connectors.keys() ?? [],
  );
  const catalogBuiltinConnectorSlugs = builtinConnectorSlugs.filter(
    (connectorSlug) => {
      return builtinCatalogConnectorSlugs.has(connectorSlug);
    },
  );
  if (catalogBuiltinConnectorSlugs.length < builtinConnectorSlugs.length) {
    L.warn("Registered connector runtime targets have no catalog entry", {
      connectorSlugs: builtinConnectorSlugs.filter((connectorSlug) => {
        return !builtinCatalogConnectorSlugs.has(connectorSlug);
      }),
    });
  }
  const [builtinRefreshes, builtinAccountResolutions, customSnapshot] =
    await Promise.all([
      resolveActiveNetworkPolicyRefreshes(
        args.db,
        args.scope,
        catalogBuiltinConnectorSlugs,
        builtinCatalogSelection,
      ),
      resolveConnectorAccounts(args.db, {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        requests: connectorAccountRequests(
          args.targets,
          builtinCatalogConnectorSlugs,
        ),
      }),
      customRegistrations.length > 0
        ? loadCustomSnapshot({
            db: args.db,
            scope: args.scope,
            registrations: customRegistrations,
          })
        : undefined,
    ]);
  const builtinByTarget = new Map(
    builtinRefreshes.map((refresh) => {
      return [
        connectorRuntimeTargetKey({
          kind: "builtin",
          connectorSlug: refresh.connectorSlug,
        }),
        refresh,
      ] as const;
    }),
  );

  const resolvedTargets: ResolvedConnectorRuntimeTarget[] = [];
  for (const registration of args.targets) {
    if (registration.kind === "custom") {
      if (!customSnapshot) {
        throw new Error("Custom connector runtime snapshot is unavailable");
      }
      resolvedTargets.push({
        kind: "custom",
        result: await resolveCustomTarget({
          registration,
          snapshot: customSnapshot,
        }),
        customSnapshot: customSnapshot.customTargets.get(
          registration.customConnectorId,
        ),
      });
      continue;
    }
    resolvedTargets.push(
      resolveBuiltinTarget({
        registration,
        scope: args.scope,
        snapshot: builtinCatalogSelection,
        accounts: builtinAccountResolutions,
        refreshes: builtinByTarget,
      }),
    );
  }
  logResolvedConnectorRuntimeTargets(args.targets, resolvedTargets);
  return resolvedTargets;
}

function logResolvedConnectorRuntimeTargets(
  targets: readonly ConnectorRuntimeTargetRegistration[],
  resolvedTargets: readonly ResolvedConnectorRuntimeTarget[],
): void {
  const stateCounts = { available: 0, absent: 0, unresolved: 0 };
  for (const target of resolvedTargets) {
    stateCounts[target.result.state] += 1;
  }
  L.debug("Resolved connector runtime targets", {
    targetCount: targets.length,
    builtinTargetCount: targets.filter((target) => {
      return target.kind === "builtin";
    }).length,
    customTargetCount: targets.filter((target) => {
      return target.kind === "custom";
    }).length,
    availableCount: stateCounts.available,
    absentCount: stateCounts.absent,
    unresolvedCount: stateCounts.unresolved,
  });
}

export async function resolveConnectorRuntimeTargets(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}): Promise<readonly ConnectorRuntimeSyncResult[]> {
  const resolvedTargets = await resolveConnectorRuntimeTargetStates(args);
  return resolvedTargets.map((target) => {
    return target.result;
  });
}

function diagnosticCustomApis(
  result: Extract<
    ConnectorRuntimeSyncResult,
    {
      readonly target: { readonly kind: "custom" };
      readonly state: "available";
    }
  >,
): readonly ConnectorRuntimeDiagnosticApi[] {
  return result.firewall.firewall.apis.map((api) => {
    return {
      base: api.base,
      usesAwsSigv4: api.auth.awsSigv4 !== undefined,
      permissions: (api.permissions ?? []).map((permission) => {
        return { name: permission.name, rules: [...permission.rules] };
      }),
    };
  });
}

function diagnosticCustomCredentialResolution(
  result: Extract<
    ConnectorRuntimeSyncResult,
    {
      readonly target: { readonly kind: "custom" };
      readonly state: "available";
    }
  >,
): "network-boundary" | "none" {
  return result.firewall.firewall.apis.some((api) => {
    return authResolvesAtNetworkBoundary(api.auth);
  })
    ? "network-boundary"
    : "none";
}

export async function resolveConnectorRuntimeDiagnosticTargets(args: {
  readonly db: Db;
  readonly scope: ConnectorRuntimeScope;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
}): Promise<readonly ConnectorRuntimeDiagnosticResult[]> {
  const resolvedTargets = await resolveConnectorRuntimeTargetStates(args);
  return resolvedTargets.map((resolved): ConnectorRuntimeDiagnosticResult => {
    if (resolved.kind === "builtin") {
      const { result } = resolved;
      if (result.state === "absent") {
        return {
          target: result.target,
          state: result.state,
          reason: result.reason,
        };
      }
      if (result.state === "unresolved") {
        return {
          target: result.target,
          state: result.state,
          reason: result.reason,
        };
      }
      return {
        target: result.target,
        state: result.state,
        networkPolicy: result.networkPolicy,
        ...(resolved.credentialResolution !== undefined
          ? {
              credentialResolution: resolved.credentialResolution,
            }
          : {}),
      };
    }
    const { result } = resolved;
    if (result.state === "absent") {
      return {
        target: result.target,
        state: result.state,
        reason: result.reason,
      };
    }
    if (result.state === "unresolved") {
      return {
        target: result.target,
        state: result.state,
        reason: result.reason,
      };
    }
    if (!resolved.customSnapshot) {
      throw new Error(
        `Missing custom connector diagnostic metadata: ${result.target.customConnectorId}`,
      );
    }
    return {
      target: result.target,
      state: result.state,
      label: resolved.customSnapshot.row.connector.displayName,
      credentialResolution: diagnosticCustomCredentialResolution(result),
      apis: diagnosticCustomApis(result),
      networkPolicy: result.networkPolicy,
    };
  });
}
