import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { array, object, string } from "zod";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { agents } from "@okouai/db/schema/agent";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";

import { writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import { publishUserSignal } from "../external/realtime";
import { settle } from "../utils";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import {
  customConnectorPermissionBundleDependencySlug,
  loadCustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import {
  uniqueConnectorRuntimeTargets,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  reportConnectorRuntimeWakeupDiscoveryFailure,
} from "./connector-runtime-wakeup.service";
import { changedCustomConnectorIds } from "./user-custom-connector-changes";
import { persistUserCustomConnectorGrants$ } from "./user-custom-connector-grant-persistence.service";
import {
  effectiveCustomConnectorPermissionBundleRef,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
} from "./feishu-custom-connector-permissions";

type UpdateUserBuiltinConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    }
  | { readonly status: "agentNotFound" };

type UserBuiltinConnectorUpdateOperation = "replace" | "add" | "remove";

type UpdateUserCustomConnectorsResult =
  | {
      readonly status: "updated";
      readonly grants: readonly AgentCustomConnectorGrant[];
    }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    };

type UserCustomConnectorUpdateOperation = "replace" | "add" | "remove";
type CustomConnectorPermissionIntent = "exact" | "preserveExistingOrDefault";

interface UserCustomConnectorUpdateOutcome {
  readonly result: UpdateUserCustomConnectorsResult;
  readonly changedConnectorIds: readonly string[];
}

interface UpdateUserCustomConnectorsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly grants: readonly AgentCustomConnectorGrant[];
  readonly permissionIntent: CustomConnectorPermissionIntent;
  readonly operation?: UserCustomConnectorUpdateOperation;
}

interface UpdateUserCustomConnectorsOptions {
  readonly deferRuntimeWakeupUntilOuterCommit?: boolean;
}

export type AddUserCustomConnectorResult =
  | { readonly status: "added" }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "customConnectorsNotFound";
      readonly missingIds: readonly string[];
    }
  | {
      readonly status: "customConnectorPermissionSelectionRequired";
      readonly connectorIds: readonly string[];
    }
  | {
      readonly status: "invalidCustomConnectorPermissions";
      readonly message: string;
    };

function grantAgentCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}) {
  return and(
    eq(agents.orgId, args.orgId),
    eq(agents.id, args.agentId),
    or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
  );
}

export function userCustomConnectorGrantAgentReadPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}) {
  return {
    columns: { id: agents.id },
    from: agents,
    where: grantAgentCondition(args),
  };
}

interface CustomConnectorDefinitionRow {
  readonly id: string;
  readonly slug: string;
  readonly prefixTemplates: readonly string[];
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly oauthProviderAdapter: string | null;
  readonly permissionBundleRef: string | null;
}

interface CustomConnectorDefinitions {
  readonly missingIds: readonly string[];
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
}

export function customConnectorDefinitionSelection() {
  return {
    id: orgCustomConnectors.id,
    slug: orgCustomConnectors.slug,
    prefixTemplates: orgCustomConnectors.prefixTemplates,
    authMode: orgCustomConnectors.authMode,
    oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    permissionBundleRef: orgCustomConnectors.permissionBundleRef,
  };
}

export function customConnectorDefinitionJoin() {
  return and(
    eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
    eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
  );
}

export function customConnectorDefinitionWhere(args: {
  readonly orgId: string;
  readonly connectorIds: readonly string[];
}) {
  return and(
    eq(orgCustomConnectors.orgId, args.orgId),
    inArray(orgCustomConnectors.id, [...new Set(args.connectorIds)]),
    eq(orgCustomConnectors.enabled, true),
  );
}

export function customConnectorDefinitions(
  rows: readonly CustomConnectorDefinitionRow[],
  connectorIds: readonly string[],
): CustomConnectorDefinitions {
  const foundIds = new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
  const missingIds = connectorIds.filter((id) => {
    return !foundIds.has(id);
  });
  if (missingIds.length > 0) {
    return {
      missingIds,
      permissionBundleRefs: new Map(),
    };
  }

  return {
    missingIds: [],
    permissionBundleRefs: new Map(
      rows.map((row) => {
        return [
          row.id,
          effectiveCustomConnectorPermissionBundleRef({
            slug: row.slug,
            authMode: row.authMode,
            oauthProviderAdapter: row.oauthProviderAdapter,
            prefixTemplates: row.prefixTemplates,
            permissionBundleRef: row.permissionBundleRef,
          }),
        ] as const;
      }),
    ),
  };
}

const builtinConnectorSelectionRowSchema = object({
  connector_slugs: array(string()),
});

/** Admit slug text only after the routine's existing Agent authorization lock. */
function builtinConnectorSelectionPayload(slugs: readonly ConnectorSlug[]) {
  return Buffer.from(
    JSON.stringify(
      slugs.map((slug) => {
        return Buffer.from(slug, "utf8").toString("base64");
      }),
    ),
    "utf8",
  );
}

export const updateUserBuiltinConnectors$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
      readonly operation?: UserBuiltinConnectorUpdateOperation;
    },
  ): Promise<UpdateUserBuiltinConnectorsResult> => {
    const db = set(writeDb$);
    const enabledConnectorSlugs = Array.from(
      new Set(args.enabledConnectorSlugs),
    );
    const operation = args.operation ?? "replace";

    const [selection] = parseRawRows(
      builtinConnectorSelectionRowSchema,
      await db.execute(sql`
        SELECT connector_slugs FROM public.update_user_builtin_connectors(
          ${args.orgId}, ${args.userId}, ${args.agentId}::uuid, ${operation},
          ${builtinConnectorSelectionPayload(enabledConnectorSlugs)}::bytea
        )
      `),
    );
    if (!selection) {
      return { status: "agentNotFound" };
    }
    const committed: UpdateUserBuiltinConnectorsResult = {
      status: "updated",
      enabledConnectorSlugs:
        operation === "replace"
          ? enabledConnectorSlugs
          : selection.connector_slugs,
    };
    // Register invalidation before callers observe cancellation after commit.
    await publishUserSignal([args.userId], "composerAgentConnectorsChanged", {
      agentId: args.agentId,
    });
    return committed;
  },
);

interface NormalizedCustomConnectorGrantRequest {
  readonly grants: readonly AgentCustomConnectorGrant[];
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
}

type InvalidCustomConnectorPermissionsResult = Extract<
  UpdateUserCustomConnectorsResult,
  { readonly status: "invalidCustomConnectorPermissions" }
>;

type PermissionSelectionError = Extract<
  UpdateUserCustomConnectorsResult,
  {
    readonly status:
      | "invalidCustomConnectorPermissions"
      | "customConnectorPermissionSelectionRequired";
  }
>;

function normalizeCustomConnectorGrantRequest(args: {
  readonly grants: readonly AgentCustomConnectorGrant[];
}):
  | NormalizedCustomConnectorGrantRequest
  | InvalidCustomConnectorPermissionsResult {
  const grantByConnectorId = new Map<string, readonly string[]>();
  const grants: AgentCustomConnectorGrant[] = [];
  for (const grant of args.grants) {
    if (grantByConnectorId.has(grant.customConnectorId)) {
      return {
        status: "invalidCustomConnectorPermissions",
        message: `Duplicate custom connector grant: ${grant.customConnectorId}`,
      };
    }
    const uniquePermissionNames = new Set(grant.permissionNames);
    if (uniquePermissionNames.size !== grant.permissionNames.length) {
      return {
        status: "invalidCustomConnectorPermissions",
        message: `Duplicate permission names for custom connector ${grant.customConnectorId}`,
      };
    }
    const permissionNames = [...uniquePermissionNames];
    grantByConnectorId.set(grant.customConnectorId, permissionNames);
    grants.push({
      customConnectorId: grant.customConnectorId,
      permissionNames,
    });
  }
  return { grants, grantByConnectorId };
}

async function validateExplicitPermissionNames(args: {
  readonly snapshot: ConnectorRuntimeSelection | null;
  readonly connectorId: string;
  readonly permissionNames: readonly string[];
  readonly permissionBundleRef: string | null;
}): Promise<
  | { readonly ok: true; readonly permissionNames: readonly string[] }
  | {
      readonly ok: false;
      readonly error: InvalidCustomConnectorPermissionsResult;
    }
> {
  if (args.permissionNames.length === 0) {
    return { ok: true, permissionNames: [] };
  }
  if (args.permissionBundleRef === null) {
    return {
      ok: false,
      error: {
        status: "invalidCustomConnectorPermissions",
        message: `Custom connector ${args.connectorId} has no permission bundle`,
      },
    };
  }
  if (!args.snapshot) {
    throw new Error("Expected connector catalog snapshot");
  }

  const bundle = await loadCustomConnectorPermissionBundle({
    catalog: args.snapshot.serverFirewallMetadata,
    ref: args.permissionBundleRef,
  });
  if (!bundle) {
    return {
      ok: false,
      error: {
        status: "invalidCustomConnectorPermissions",
        message: `Permission bundle is unavailable for custom connector ${args.connectorId}`,
      },
    };
  }
  const invalidPermissionNames = args.permissionNames.filter(
    (permissionName) => {
      return !bundle.permissionNames.has(permissionName);
    },
  );
  return invalidPermissionNames.length === 0
    ? { ok: true, permissionNames: [...args.permissionNames] }
    : {
        ok: false,
        error: {
          status: "invalidCustomConnectorPermissions",
          message: `Unknown permission names for custom connector ${args.connectorId}: ${invalidPermissionNames.join(", ")}`,
        },
      };
}

async function resolveCustomConnectorPermissionSelection(args: {
  readonly connectorIds: readonly string[];
  readonly permissionIntent: CustomConnectorPermissionIntent;
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
  readonly previousPermissionNamesByConnectorId: ReadonlyMap<
    string,
    readonly string[]
  >;
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
  readonly snapshot: ConnectorRuntimeSelection | null;
}): Promise<
  | {
      readonly ok: true;
      readonly permissionNamesByConnectorId: ReadonlyMap<
        string,
        readonly string[]
      >;
    }
  | { readonly ok: false; readonly error: PermissionSelectionError }
> {
  if (args.permissionIntent === "preserveExistingOrDefault") {
    const selectionRequiredIds = args.connectorIds.filter((connectorId) => {
      if (args.previousPermissionNamesByConnectorId.has(connectorId)) {
        return false;
      }
      const permissionBundleRef =
        args.permissionBundleRefs.get(connectorId) ?? null;
      return (
        permissionBundleRef !== null &&
        permissionBundleRef !== FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF
      );
    });
    return selectionRequiredIds.length === 0
      ? {
          ok: true,
          permissionNamesByConnectorId: new Map(
            args.connectorIds.map((connectorId) => {
              return [
                connectorId,
                args.previousPermissionNamesByConnectorId.get(connectorId) ??
                  [],
              ] as const;
            }),
          ),
        }
      : {
          ok: false,
          error: {
            status: "customConnectorPermissionSelectionRequired",
            connectorIds: selectionRequiredIds,
          },
        };
  }

  const permissionNamesByConnectorId = new Map<string, readonly string[]>();
  for (const connectorId of args.connectorIds) {
    const result = await validateExplicitPermissionNames({
      snapshot: args.snapshot,
      connectorId,
      permissionNames: args.grantByConnectorId.get(connectorId) ?? [],
      permissionBundleRef: args.permissionBundleRefs.get(connectorId) ?? null,
    });
    if (!result.ok) {
      return result;
    }
    permissionNamesByConnectorId.set(connectorId, result.permissionNames);
  }
  return { ok: true, permissionNamesByConnectorId };
}

function permissionBundleDependencySlugs(
  permissionBundleRefs: Iterable<string | null>,
): ConnectorSlug[] {
  return [
    ...new Set(
      [...permissionBundleRefs].flatMap((permissionBundleRef) => {
        const dependency =
          permissionBundleRef === null
            ? null
            : customConnectorPermissionBundleDependencySlug(
                permissionBundleRef,
              );
        return dependency === null ? [] : [dependency];
      }),
    ),
  ];
}

/**
 * Concurrent updates are last-writer-wins. A connector or agent removed
 * meanwhile leaves the grant unusable, as if it were never configured.
 */
function customConnectorPermissionNamesById(
  rows: readonly {
    readonly customConnectorId: string;
    readonly permissionNames: readonly string[];
  }[],
) {
  return new Map(
    rows.map((row) => {
      return [row.customConnectorId, row.permissionNames] as const;
    }),
  );
}

function validatedCustomConnectorGrants(
  connectorIds: readonly string[],
  permissionNamesByConnectorId: ReadonlyMap<string, readonly string[]>,
): readonly AgentCustomConnectorGrant[] {
  return connectorIds.map((customConnectorId) => {
    return {
      customConnectorId,
      permissionNames: [
        ...(permissionNamesByConnectorId.get(customConnectorId) ?? []),
      ],
    };
  });
}

function customConnectorGrantScopeCondition(
  request: UpdateUserCustomConnectorsArgs,
) {
  return and(
    eq(userCustomConnectors.orgId, request.orgId),
    eq(userCustomConnectors.userId, request.userId),
    eq(userCustomConnectors.agentId, request.agentId),
  );
}

const readCustomConnectorDefinitions$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly connectorIds: readonly string[];
    },
  ): Promise<CustomConnectorDefinitions> => {
    if (args.connectorIds.length === 0) {
      return { missingIds: [], permissionBundleRefs: new Map() };
    }
    const rows: CustomConnectorDefinitionRow[] = await set(writeDb$)
      .select(customConnectorDefinitionSelection())
      .from(orgCustomConnectors)
      .leftJoin(orgCustomConnectorOauthConfigs, customConnectorDefinitionJoin())
      .where(customConnectorDefinitionWhere(args));
    return customConnectorDefinitions(rows, args.connectorIds);
  },
);

const persistUserCustomConnectors$ = command(
  async (
    { set },
    args: {
      readonly request: UpdateUserCustomConnectorsArgs;
      readonly grants: readonly AgentCustomConnectorGrant[];
      readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
      readonly operation: UserCustomConnectorUpdateOperation;
      readonly readsConnectorCatalog: boolean;
      readonly deferClientInvalidationUntilOuterCommit?: boolean;
    },
  ): Promise<UserCustomConnectorUpdateOutcome> => {
    const db = set(writeDb$);
    const grantRead = userCustomConnectorGrantAgentReadPlan(args.request);
    const [agent] = await db
      .select(grantRead.columns)
      .from(grantRead.from)
      .where(grantRead.where)
      .limit(1);
    if (agent === undefined) {
      return { result: { status: "agentNotFound" }, changedConnectorIds: [] };
    }
    const previousRows = await db
      .select({
        customConnectorId: userCustomConnectors.customConnectorId,
        permissionNames: userCustomConnectors.permissionNames,
      })
      .from(userCustomConnectors)
      .where(customConnectorGrantScopeCondition(args.request));
    const connectorIds = args.grants.map((grant) => {
      return grant.customConnectorId;
    });

    if (args.operation === "remove") {
      return {
        result: await set(persistUserCustomConnectorGrants$, {
          orgId: args.request.orgId,
          userId: args.request.userId,
          agentId: args.request.agentId,
          grants: args.grants,
          operation: args.operation,
          deferClientInvalidationUntilOuterCommit:
            args.deferClientInvalidationUntilOuterCommit,
        }),
        changedConnectorIds: changedCustomConnectorIds(
          previousRows,
          args.grants,
          args.operation,
        ),
      };
    }
    const definitions = await set(readCustomConnectorDefinitions$, {
      orgId: args.request.orgId,
      connectorIds,
    });
    if (definitions.missingIds.length > 0) {
      return {
        result: {
          status: "customConnectorsNotFound",
          missingIds: definitions.missingIds,
        },
        changedConnectorIds: [],
      };
    }
    // Permission bundles read only their dependency connectors' metadata.
    let connectorCatalogSnapshot: ConnectorRuntimeSelection | null = null;
    if (args.readsConnectorCatalog) {
      const catalogDb = db;
      const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
        connectorSlugs: [],
        metadataConnectorSlugs: permissionBundleDependencySlugs(
          definitions.permissionBundleRefs.values(),
        ),
      });
      connectorCatalogSnapshot = connectorRuntimeSlugSelectionFromRows(
        catalogPlan.selection,
        await catalogDb
          .select(catalogPlan.columns)
          .from(connectorCatalog)
          .leftJoin(connectorCatalogEntries, catalogPlan.join)
          .where(connectorCatalogCurrentWhere()),
      );
    }
    const permissionSelection = await resolveCustomConnectorPermissionSelection(
      {
        connectorIds,
        permissionIntent: args.request.permissionIntent,
        grantByConnectorId: args.grantByConnectorId,
        previousPermissionNamesByConnectorId:
          customConnectorPermissionNamesById(previousRows),
        permissionBundleRefs: definitions.permissionBundleRefs,
        snapshot: connectorCatalogSnapshot,
      },
    );
    if (!permissionSelection.ok) {
      return { result: permissionSelection.error, changedConnectorIds: [] };
    }
    const validatedGrants = validatedCustomConnectorGrants(
      connectorIds,
      permissionSelection.permissionNamesByConnectorId,
    );
    return {
      result: await set(persistUserCustomConnectorGrants$, {
        orgId: args.request.orgId,
        userId: args.request.userId,
        agentId: args.request.agentId,
        grants: validatedGrants,
        operation: args.operation,
        deferClientInvalidationUntilOuterCommit:
          args.deferClientInvalidationUntilOuterCommit,
      }),
      changedConnectorIds: changedCustomConnectorIds(
        previousRows,
        validatedGrants,
        args.operation,
      ),
    };
  },
);

export const updateUserCustomConnectors$ = command(
  async (
    { set },
    args: UpdateUserCustomConnectorsArgs,
    options: UpdateUserCustomConnectorsOptions = {},
  ): Promise<UpdateUserCustomConnectorsResult> => {
    const db = set(writeDb$);
    const normalized = normalizeCustomConnectorGrantRequest(args);
    if ("status" in normalized) {
      return normalized;
    }
    const { grants, grantByConnectorId } = normalized;
    const operation = args.operation ?? "replace";
    const committed = await set(persistUserCustomConnectors$, {
      request: args,
      grants,
      grantByConnectorId,
      operation,
      deferClientInvalidationUntilOuterCommit:
        options.deferRuntimeWakeupUntilOuterCommit,
      readsConnectorCatalog:
        args.permissionIntent === "exact" &&
        operation !== "remove" &&
        grants.some((grant) => {
          return grant.permissionNames.length > 0;
        }),
    });
    if (
      committed.result.status === "updated" &&
      !options.deferRuntimeWakeupUntilOuterCommit
    ) {
      const wakeupArgs = {
        scope: {
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
        },
        targets: committed.changedConnectorIds.map((customConnectorId) => {
          return { kind: "custom" as const, customConnectorId };
        }),
      };
      await (async () => {
        const result = await settle(
          (async () => {
            const targets = uniqueConnectorRuntimeTargets(wakeupArgs.targets);
            if (targets.length === 0) {
              return;
            }

            const rows = await db
              .select({
                runId: agentRuns.id,
                runnerGroup: agentRuns.runnerGroup,
              })
              .from(agentRuns)

              .where(connectorRuntimeWakeupCondition(wakeupArgs.scope));

            await publishConnectorRuntimeWakeupRows({
              scope: wakeupArgs.scope,
              targets,
              rows,
            });
          })(),
        );
        if (!result.ok) {
          reportConnectorRuntimeWakeupDiscoveryFailure({
            orgId: wakeupArgs.scope.orgId,
            scopedToUser: wakeupArgs.scope.userId !== undefined,
            scopedToAgent: wakeupArgs.scope.agentId !== undefined,
            targetCount: uniqueConnectorRuntimeTargets(wakeupArgs.targets)
              .length,
            error: result.error,
          });
        }
      })();
    }
    return committed.result;
  },
);

export const addUserCustomConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
      readonly customConnectorId: string;
    },
    options: UpdateUserCustomConnectorsOptions = {},
  ): Promise<AddUserCustomConnectorResult> => {
    const result = await set(
      updateUserCustomConnectors$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
        grants: [
          {
            customConnectorId: args.customConnectorId,
            permissionNames: [],
          },
        ],
        permissionIntent: "preserveExistingOrDefault",
        operation: "add",
      },
      options,
    );
    if (result.status === "updated") {
      return { status: "added" };
    }
    return result;
  },
);
