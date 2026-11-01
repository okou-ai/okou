import { command } from "ccstate";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
  type NetworkPolicy,
} from "@okouai/connectors/firewall-types";

import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  ApplyUserPermissionGrantsRequest,
  ApplyUserPermissionGrantsBatchRequest,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { notFound } from "../../lib/error";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { db$, writeDb$ } from "../external/db";
import { publishConnectorPermissionUpdatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import {
  defaultFirewallPolicyForPermissionIndex,
  networkPolicyForFirewallPolicy,
} from "./firewall-network-policy.service";
import type { ConnectorRuntimeLookup } from "./connector-catalog-runtime.service";
import type {
  ConnectorServerFirewallSelection,
  ConnectorServerFirewallMetadataCatalog,
} from "./connector-server-firewall-catalog.service";
import {
  connectorRuntimeWakeupRunColumns,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  publishConnectorRuntimeSyncWakeups$,
  reportConnectorRuntimeWakeupDiscoveryFailure,
  uniqueConnectorRuntimeTargets,
  type ConnectorRuntimeWakeupBusinessArgs,
} from "./connector-runtime-wakeup.service";
import { settle } from "../utils";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import { visibleAgentIdentityCondition } from "./agent-data.service";
import {
  permissionGrantCondition,
  resolveGrantExpiresAt,
} from "./permission-grant-apply-plan";

const userPermissionGrantSelection = Object.freeze({
  id: userPermissionGrants.id,
  orgId: userPermissionGrants.orgId,
  userId: userPermissionGrants.userId,
  agentId: userPermissionGrants.agentId,
  connectorSlug: userPermissionGrants.connectorSlug,
  permission: userPermissionGrants.permission,
  action: userPermissionGrants.action,
  expiresAt: userPermissionGrants.expiresAt,
  createdAt: userPermissionGrants.createdAt,
  updatedAt: userPermissionGrants.updatedAt,
});

type UserPermissionGrantRow = typeof userPermissionGrants.$inferSelect;
type StoredPermissionGrantRow = UserPermissionGrantRow;
type ResolvedPermissionGrant = Pick<
  UserPermissionGrantRow,
  "connectorSlug" | "permission" | "action" | "expiresAt"
>;
type UserPermissionGrantAction = UserPermissionGrantResponse["action"];

interface ActiveNetworkPolicyRefresh {
  readonly connectorSlug: string;
  readonly networkPolicy: NetworkPolicy;
  readonly nextRefreshAt: string | null;
}

interface ConnectorPermissionPolicyBaseline {
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
}

interface UserPermissionGrantBaseScope {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: string;
}

type UserPermissionGrantScope = UserPermissionGrantBaseScope & {
  readonly agentId: string;
};

interface ApplyUserPermissionGrantsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: string;
  readonly apply: ApplyUserPermissionGrantsRequest;
}

type NotFoundResponse = ReturnType<typeof notFound>;

type ValidationErrorResponse = {
  readonly status: 400;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: "VALIDATION_ERROR";
    };
  };
};

type ListUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly UserPermissionGrantResponse[];
    }
  | NotFoundResponse;

type ApplyUserPermissionGrantsResult =
  | {
      readonly kind: "ok";
      readonly grants: readonly UserPermissionGrantResponse[];
    }
  | NotFoundResponse
  | ValidationErrorResponse;

function validationError(message: string): ValidationErrorResponse {
  return {
    status: 400 as const,
    body: {
      error: {
        message,
        code: "VALIDATION_ERROR" as const,
      },
    },
  };
}

function visibleAgentCondition(userId: string) {
  return or(eq(agents.visibility, "public"), eq(agents.owner, userId));
}

function validateGrantExpiration(grant: {
  readonly action: UserPermissionGrantAction;
  readonly expiresIn?: UserPermissionGrantExpiresIn;
}): ValidationErrorResponse | null {
  if (grant.action !== "allow") {
    return grant.expiresIn === undefined
      ? null
      : validationError(
          "Permission grant expiration is only supported for allow grants",
        );
  }

  return null;
}

export function activeUserPermissionGrantCondition(
  checkedAt: Date,
): SQL | undefined {
  return or(
    isNull(userPermissionGrants.expiresAt),
    gt(userPermissionGrants.expiresAt, checkedAt),
  );
}

function earliestTemporaryAllowExpiresAt(
  grants: readonly ResolvedPermissionGrant[],
  connectorSlug: string,
): Date | null {
  let earliest: Date | null = null;
  for (const grant of grants) {
    if (
      grant.connectorSlug !== connectorSlug ||
      grant.action !== "allow" ||
      !grant.expiresAt
    ) {
      continue;
    }
    if (!earliest || grant.expiresAt.getTime() < earliest.getTime()) {
      earliest = grant.expiresAt;
    }
  }
  return earliest;
}

function resolvedConnectorFirewallPolicies(
  grants: readonly ResolvedPermissionGrant[],
): FirewallPolicies {
  return permissionGrantsToFirewallPolicies(grants) ?? {};
}

export function networkPolicyRefreshConnectorSlugs(
  catalog: ConnectorServerFirewallMetadataCatalog,
  connectorSlugs: readonly string[],
): string[] {
  return [
    ...new Set(
      connectorSlugs.filter((connectorSlug) => {
        return catalog.has(connectorSlug);
      }),
    ),
  ];
}

/** Runtime callers supply their captured catalog; the finite read remains
 * awaited by their existing read group and its cancellation boundary. */
export const readActiveNetworkPolicyRefreshes$ = command(
  async (
    { get },
    args: {
      readonly scope: UserPermissionGrantScope;
      readonly connectorSlugs: readonly string[];
      readonly snapshot: ConnectorRuntimeLookup;
    },
    checkedAt: Date = nowDate(),
  ): Promise<readonly ActiveNetworkPolicyRefresh[]> => {
    const { scope, connectorSlugs, snapshot } = args;
    if (connectorSlugs.length === 0) {
      return [];
    }

    const uniqueConnectorSlugs = networkPolicyRefreshConnectorSlugs(
      snapshot.serverFirewalls,
      connectorSlugs,
    );
    if (uniqueConnectorSlugs.length === 0) {
      return [];
    }

    const grants = await get(db$)
      .select(userPermissionGrantSelection)
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, scope.orgId),
          eq(userPermissionGrants.userId, scope.userId),
          eq(userPermissionGrants.agentId, scope.agentId),
          inArray(userPermissionGrants.connectorSlug, uniqueConnectorSlugs),
          activeUserPermissionGrantCondition(checkedAt),
        ),
      )
      .orderBy(
        asc(userPermissionGrants.connectorSlug),
        asc(userPermissionGrants.permission),
      );
    const indexes = await Promise.all(
      uniqueConnectorSlugs.map(async (connectorSlug) => {
        return {
          connectorSlug,
          index:
            await snapshot.serverFirewalls.loadPermissionIndex(connectorSlug),
        };
      }),
    );

    return activeNetworkPolicyRefreshesForPermissionBaselines(
      indexes.flatMap(({ connectorSlug, index }) => {
        return index
          ? [
              {
                connectorSlug,
                permissionNames: [...index.permissionNames],
                defaultPolicy: defaultFirewallPolicyForPermissionIndex(index),
              },
            ]
          : [];
      }),
      grants,
    );
  },
);

function activeNetworkPolicyRefreshesForPermissionBaselines(
  baselines: readonly ConnectorPermissionPolicyBaseline[],
  grants: readonly ResolvedPermissionGrant[],
): readonly ActiveNetworkPolicyRefresh[] {
  const policies = resolvedConnectorFirewallPolicies(grants);
  return baselines.map((baseline) => {
    const defaultPolicy = baseline.defaultPolicy;
    const connectorSlug = baseline.connectorSlug;
    const overlay = policies[connectorSlug];
    const policy: FirewallPolicy = overlay
      ? {
          policies: { ...defaultPolicy.policies, ...overlay.policies },
          unknownPolicy: overlay.unknownPolicy ?? defaultPolicy.unknownPolicy,
        }
      : defaultPolicy;
    const nextRefreshAt = earliestTemporaryAllowExpiresAt(
      grants,
      connectorSlug,
    );
    return {
      connectorSlug,
      networkPolicy: networkPolicyForFirewallPolicy(
        baseline.permissionNames,
        policy,
      ),
      nextRefreshAt: nextRefreshAt?.toISOString() ?? null,
    };
  });
}

export function networkPolicyRefreshesRecord(
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): Record<string, { readonly nextRefreshAt: string }> | undefined {
  const entries = refreshes.flatMap((refresh) => {
    if (refresh.nextRefreshAt === null) {
      return [];
    }
    return [
      [
        refresh.connectorSlug,
        { nextRefreshAt: refresh.nextRefreshAt },
      ] as const,
    ];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mergeNetworkPolicyRefreshes(
  networkPolicies: NetworkPolicies | undefined,
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): NetworkPolicies | undefined {
  if (!networkPolicies && refreshes.length === 0) {
    return undefined;
  }
  const merged: NetworkPolicies = { ...networkPolicies };
  for (const refresh of refreshes) {
    if (
      networkPolicies &&
      !Object.hasOwn(networkPolicies, refresh.connectorSlug)
    ) {
      continue;
    }
    merged[refresh.connectorSlug] = refresh.networkPolicy;
  }
  return merged;
}

function formatUserPermissionGrant(
  row: Pick<
    StoredPermissionGrantRow,
    | "connectorSlug"
    | "permission"
    | "action"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >,
  scope: { readonly agentId: string },
): UserPermissionGrantResponse {
  return {
    ...scope,
    connectorSlug: row.connectorSlug,
    permission: row.permission,
    action: row.action,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function validateApplyUserPermissionGrants(
  apply: ApplyUserPermissionGrantsRequest,
  catalog: ConnectorServerFirewallSelection,
): Promise<ValidationErrorResponse | null> {
  const index = await catalog.loadPermissionIndex(apply.connectorSlug);
  if (!index) {
    if (apply.mode === "replace" && apply.grants.length === 0) {
      return null;
    }
    return validationError(`Unknown connector slug: ${apply.connectorSlug}`);
  }

  const seenPermissions = new Set<string>();
  for (const grant of apply.grants) {
    if (seenPermissions.has(grant.permission)) {
      return validationError(`Duplicate permission grant: ${grant.permission}`);
    }
    seenPermissions.add(grant.permission);

    if (
      grant.permission !== UNKNOWN_PERMISSION_GRANT &&
      !index.hasPermission(grant.permission)
    ) {
      return validationError(
        `Unknown permission "${grant.permission}" for connector "${apply.connectorSlug}"`,
      );
    }

    const expirationValidation = validateGrantExpiration(grant);
    if (expirationValidation) {
      return expirationValidation;
    }
  }
  return null;
}

function permissionGrantValues(
  grants: ApplyUserPermissionGrantsRequest["grants"],
  timestamp: Date,
) {
  return grants.map((grant) => {
    const expiresAt =
      grant.action === "allow"
        ? resolveGrantExpiresAt(grant.expiresIn, timestamp)
        : null;
    return sql`(${grant.permission}::varchar, ${grant.action}::varchar,
      ${expiresAt?.toISOString() ?? null}::timestamp)`;
  });
}

function permissionGrantRequestedColumns(
  connectorSlug: string,
  timestamp: Date,
) {
  return {
    connectorSlug: sql`${connectorSlug}`
      .mapWith(userPermissionGrants.connectorSlug)
      .as("connector_slug"),
    permission: sql`requested.permission`
      .mapWith(userPermissionGrants.permission)
      .as("permission"),
    action: sql`requested.action`
      .mapWith(userPermissionGrants.action)
      .as("action"),
    expiresAt: sql`requested.expires_at`
      .mapWith(nullableDriverValueDecoder(userPermissionGrants.expiresAt))
      .as("expires_at"),
    createdAt: sql`${timestamp.toISOString()}::timestamp`
      .mapWith(userPermissionGrants.createdAt)
      .as("created_at"),
    updatedAt: sql`${timestamp.toISOString()}::timestamp`
      .mapWith(userPermissionGrants.updatedAt)
      .as("updated_at"),
  };
}

// One statement owns the visible-agent check and all grant changes. Concurrent
// edits arbitrate per permission; replacements may combine concurrent edits.
// The entry observes cancellation after this finite write and runtime refresh.
const applyVisibleGrantRows$ = command(
  async function applyVisibleAgentGrantRows(
    { set },
    args: ApplyUserPermissionGrantsArgs,
    _signal: AbortSignal,
  ): Promise<readonly UserPermissionGrantRow[] | NotFoundResponse> {
    const db = set(writeDb$);
    const agentId = args.apply.agentId;
    const timestamp = nowDate();
    const authorized = db.$with("permission_agent").as(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(visibleAgentIdentityCondition({ ...args, agentId })),
    );
    // The INSERT owns requested keys; DELETE only touches omitted keys so a
    // replacement never modifies the same row twice within this statement.
    const removed = db.$with("permission_removed").as(
      db
        .delete(userPermissionGrants)
        .where(
          and(
            args.apply.mode === "replace" ? undefined : sql`false`,
            permissionGrantCondition({
              ...args,
              agentId,
              connectorSlug: args.apply.connectorSlug,
            }),
            notInArray(
              userPermissionGrants.permission,
              args.apply.grants.map((grant) => {
                return grant.permission;
              }),
            ),
            exists(db.select({ id: authorized.id }).from(authorized)),
          ),
        )
        .returning({ id: userPermissionGrants.id }),
    );
    if (args.apply.grants.length === 0) {
      const [agent] = await db
        .with(authorized, removed)
        .select({ id: authorized.id })
        .from(authorized);
      return agent ? [] : notFound(`Agent not found: ${agentId}`);
    }

    const requested = [...args.apply.grants].sort((left, right) => {
      return left.permission.localeCompare(right.permission);
    });
    const values = permissionGrantValues(requested, timestamp);
    const preserveExpiryPermissions = requested.flatMap((grant) => {
      return args.apply.mode === "patch" &&
        grant.action === "allow" &&
        grant.expiresIn === undefined
        ? [grant.permission]
        : [];
    });
    const rows = await db
      .with(authorized, removed)
      .insert(userPermissionGrants)
      .select(
        db
          .select({
            id: sql`gen_random_uuid()`
              .mapWith(userPermissionGrants.id)
              .as("id"),
            orgId: sql`${args.orgId}`
              .mapWith(userPermissionGrants.orgId)
              .as("org_id"),
            userId: sql`${args.userId}`
              .mapWith(userPermissionGrants.userId)
              .as("user_id"),
            agentId: authorized.id,
            ...permissionGrantRequestedColumns(
              args.apply.connectorSlug,
              timestamp,
            ),
          })
          .from(authorized)
          .crossJoin(
            sql`(values ${sql.join(values, sql`, `)}) as requested(permission, action, expires_at)`,
          )
          .where(sql`true`),
      )
      .onConflictDoUpdate({
        target: [
          userPermissionGrants.orgId,
          userPermissionGrants.userId,
          userPermissionGrants.agentId,
          userPermissionGrants.connectorSlug,
          userPermissionGrants.permission,
        ],
        set: {
          ...(args.apply.mode === "replace"
            ? { id: sql`excluded.id`, createdAt: timestamp }
            : {}),
          action: sql`excluded.action`,
          expiresAt: sql`case when ${inArray(userPermissionGrants.permission, preserveExpiryPermissions)}
            and ${eq(userPermissionGrants.action, "allow")}
            and ${gt(userPermissionGrants.expiresAt, timestamp)}
            then ${userPermissionGrants.expiresAt}
            else excluded.expires_at end`,
          updatedAt: timestamp,
        },
      })
      .returning({ ...userPermissionGrantSelection });
    if (rows.length === 0) {
      return notFound(`Agent not found: ${agentId}`);
    }
    const rowsByPermission = new Map(
      rows.map((row) => {
        return [row.permission, row];
      }),
    );
    return args.apply.grants.map((grant) => {
      const row = rowsByPermission.get(grant.permission);
      if (!row) {
        throw new Error("User permission grant apply did not return a row");
      }
      return row;
    });
  },
);

function permissionGrantResponseScope(scope: UserPermissionGrantScope): {
  readonly agentId: string;
} {
  return { agentId: scope.agentId };
}

function applyPermissionGrantResponseScope(
  args: ApplyUserPermissionGrantsArgs,
): { readonly agentId: string } {
  return { agentId: args.apply.agentId };
}

function permissionGrantCatalogSlugsFromRows(
  rows: readonly { readonly slug: string | null }[],
): ReadonlySet<string> {
  if (rows.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  return new Set(
    rows.flatMap((row) => {
      return row.slug === null ? [] : [row.slug];
    }),
  );
}

export const listUserPermissionGrants$ = command(
  async (
    { get },
    scope: UserPermissionGrantScope,
    signal: AbortSignal,
  ): Promise<ListUserPermissionGrantsResult> => {
    const db = get(db$);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, scope.orgId),
          eq(agents.id, scope.agentId),
          visibleAgentCondition(scope.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return notFound(`Agent not found: ${scope.agentId}`);
    }

    const checkedAt = nowDate();
    const grants = await db
      .select(userPermissionGrantSelection)
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, scope.orgId),
          eq(userPermissionGrants.userId, scope.userId),
          eq(userPermissionGrants.agentId, scope.agentId),
          activeUserPermissionGrantCondition(checkedAt),
        ),
      )
      .orderBy(
        asc(userPermissionGrants.connectorSlug),
        asc(userPermissionGrants.permission),
      );
    signal.throwIfAborted();
    const catalogSlugs =
      grants.length === 0
        ? undefined
        : permissionGrantCatalogSlugsFromRows(
            await db
              .select({
                current: { schemaVersion: connectorCatalog.schemaVersion },
                slug: connectorCatalogEntries.slug,
              })
              .from(connectorCatalog)
              .leftJoin(
                connectorCatalogEntries,
                connectorCatalogSlugJoin(
                  grants.map((grant) => {
                    return grant.connectorSlug;
                  }),
                ),
              )
              .where(connectorCatalogCurrentWhere()),
          );
    signal.throwIfAborted();
    const responseScope = permissionGrantResponseScope(scope);

    return {
      kind: "ok" as const,
      grants: grants.flatMap((grant) => {
        return catalogSlugs?.has(grant.connectorSlug)
          ? [formatUserPermissionGrant(grant, responseScope)]
          : [];
      }),
    };
  },
);

export const applyUserPermissionGrants$ = command(
  async (
    { set },
    args: ApplyUserPermissionGrantsArgs,
    signal: AbortSignal,
  ): Promise<ApplyUserPermissionGrantsResult> => {
    const writeDb = set(writeDb$);
    const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [args.apply.connectorSlug],
    });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      catalogPlan.selection,
      await writeDb
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    signal.throwIfAborted();
    const validation = await validateApplyUserPermissionGrants(
      args.apply,
      snapshot.serverFirewalls,
    );
    signal.throwIfAborted();
    if (validation) {
      return validation;
    }

    const commit = set(applyVisibleGrantRows$, args, signal);
    const rows = await (async () => {
      const result = await commit;
      const wakeup = ((
        rows: typeof result,
      ): ConnectorRuntimeWakeupBusinessArgs | undefined => {
        if (
          "status" in rows ||
          !snapshot.serverFirewalls.has(args.apply.connectorSlug)
        ) {
          return undefined;
        }
        const responseScope = applyPermissionGrantResponseScope(args);
        return {
          scope: {
            orgId: args.orgId,
            userId: args.userId,
            agentId: responseScope.agentId,
          },
          targets: [
            { kind: "builtin", connectorSlug: args.apply.connectorSlug },
          ],
        };
      })(result);
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
    signal.throwIfAborted();

    if ("status" in rows) {
      return rows;
    }
    await publishConnectorPermissionUpdatedSafely(args.userId);
    signal.throwIfAborted();
    const responseScope = applyPermissionGrantResponseScope(args);

    return {
      kind: "ok" as const,
      grants: rows.map((grant) => {
        return formatUserPermissionGrant(grant, responseScope);
      }),
    };
  },
);

type RequestedBatchGrant =
  ApplyUserPermissionGrantsBatchRequest["groups"][number]["grants"][number] & {
    readonly connectorSlug: string;
  };

const writeUserPermissionGrantBatch$ = command(
  async (
    { set },
    args: UserPermissionGrantBaseScope & {
      readonly agentId: string;
      readonly requested: readonly RequestedBatchGrant[];
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const timestamp = nowDate();
    const values = args.requested.map((grant) => {
      const expiresAt = resolveGrantExpiresAt(grant.expiresIn, timestamp);
      return sql`(${grant.connectorSlug}::varchar, ${grant.permission}::varchar,
        ${expiresAt?.toISOString() ?? null}::timestamp)`;
    });
    const authorized = db.$with("batch_permission_agent").as(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.orgId, args.orgId),
            eq(agents.id, args.agentId),
            visibleAgentCondition(args.userId),
          ),
        ),
    );
    const written = db.$with("batch_permission_written").as(
      db
        .insert(userPermissionGrants)
        .select(
          db
            .select({
              id: sql`gen_random_uuid()`
                .mapWith(userPermissionGrants.id)
                .as("id"),
              orgId: sql`${args.orgId}`
                .mapWith(userPermissionGrants.orgId)
                .as("org_id"),
              userId: sql`${args.userId}`
                .mapWith(userPermissionGrants.userId)
                .as("user_id"),
              agentId: authorized.id,
              connectorSlug: sql`requested.connector_slug`
                .mapWith(userPermissionGrants.connectorSlug)
                .as("connector_slug"),
              permission: sql`requested.permission`
                .mapWith(userPermissionGrants.permission)
                .as("permission"),
              action: sql`'allow'`
                .mapWith(userPermissionGrants.action)
                .as("action"),
              expiresAt: sql`requested.expires_at`
                .mapWith(
                  nullableDriverValueDecoder(userPermissionGrants.expiresAt),
                )
                .as("expires_at"),
              createdAt: sql`${timestamp.toISOString()}::timestamp`
                .mapWith(userPermissionGrants.createdAt)
                .as("created_at"),
              updatedAt: sql`${timestamp.toISOString()}::timestamp`
                .mapWith(userPermissionGrants.updatedAt)
                .as("updated_at"),
            })
            .from(authorized)
            .crossJoin(
              sql`(values ${sql.join(values, sql`, `)}) as requested(connector_slug, permission, expires_at)`,
            )
            .where(sql`true`),
        )
        .onConflictDoUpdate({
          target: [
            userPermissionGrants.orgId,
            userPermissionGrants.userId,
            userPermissionGrants.agentId,
            userPermissionGrants.connectorSlug,
            userPermissionGrants.permission,
          ],
          set: {
            action: "allow",
            expiresAt: sql`excluded.expires_at`,
            updatedAt: timestamp,
          },
          setWhere: or(
            eq(userPermissionGrants.action, "deny"),
            lte(userPermissionGrants.expiresAt, timestamp),
          ),
        })
        .returning({ id: userPermissionGrants.id }),
    );
    // The write CTE executes even when its RETURNING rows are unused. The
    // outer row distinguishes inaccessible agents from idempotent no-ops.
    const [authorizedAgent] = await db
      .with(authorized, written)
      .select({ id: authorized.id })
      .from(authorized);
    signal.throwIfAborted();
    return authorizedAgent !== undefined;
  },
);

/** Allow-only patch. All connector validation finishes against one captured
 * catalog before the sole write statement. Existing active allows are not
 * updated, including their original expiration and updatedAt.
 *
 * This does not serialize with apply/replace: PostgreSQL's existing
 * unique key arbitrates overlapping upserts, while a concurrent replacement
 * may remove grants visible to its DELETE snapshot. A batch is atomic, not a
 * global ordering barrier for other permission edits.
 */
export const applyUserPermissionGrantsBatch$ = command(
  async (
    { set },
    args: UserPermissionGrantBaseScope & {
      readonly apply: ApplyUserPermissionGrantsBatchRequest;
    },
    signal: AbortSignal,
  ): Promise<ApplyUserPermissionGrantsResult> => {
    const db = set(writeDb$);
    const connectorSlugs = [
      ...new Set(
        args.apply.groups.map((group) => {
          return group.connectorSlug;
        }),
      ),
    ];
    const plan = connectorRuntimeSlugSelectionReadPlan({ connectorSlugs });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      plan.selection,
      await db
        .select(plan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, plan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    signal.throwIfAborted();
    for (const group of args.apply.groups) {
      const validation = await validateApplyUserPermissionGrants(
        { ...group, agentId: args.apply.agentId, mode: "patch" },
        snapshot.serverFirewalls,
      );
      signal.throwIfAborted();
      if (validation) {
        return validation;
      }
    }

    const requested = args.apply.groups
      .flatMap((group) => {
        return group.grants.map((grant) => {
          return { ...grant, connectorSlug: group.connectorSlug };
        });
      })
      .sort((left, right) => {
        return (
          left.connectorSlug.localeCompare(right.connectorSlug) ||
          left.permission.localeCompare(right.permission)
        );
      });
    const authorizedAgent = await set(
      writeUserPermissionGrantBatch$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.apply.agentId,
        requested,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!authorizedAgent) {
      return notFound(`Agent not found: ${args.apply.agentId}`);
    }
    await publishConnectorPermissionUpdatedSafely(args.userId);
    signal.throwIfAborted();
    await set(
      publishConnectorRuntimeSyncWakeups$,
      {
        scope: {
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.apply.agentId,
        },
        targets: connectorSlugs.map((connectorSlug) => {
          return { kind: "builtin" as const, connectorSlug };
        }),
      },
      signal,
    );

    const rows = await db
      .select(userPermissionGrantSelection)
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, args.orgId),
          eq(userPermissionGrants.userId, args.userId),
          eq(userPermissionGrants.agentId, args.apply.agentId),
          or(
            ...requested.map((grant) => {
              return and(
                eq(userPermissionGrants.connectorSlug, grant.connectorSlug),
                eq(userPermissionGrants.permission, grant.permission),
              );
            }),
          ),
          eq(userPermissionGrants.action, "allow"),
          activeUserPermissionGrantCondition(nowDate()),
        ),
      )
      .orderBy(
        asc(userPermissionGrants.connectorSlug),
        asc(userPermissionGrants.permission),
      );
    signal.throwIfAborted();
    return {
      kind: "ok",
      grants: rows.map((row) => {
        return formatUserPermissionGrant(row, { agentId: args.apply.agentId });
      }),
    };
  },
);
