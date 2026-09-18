import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { agents } from "@okouai/db/schema/agent";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { userConnectors } from "@okouai/db/schema/user-connector";

import type { Db } from "../external/db";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { isCustomConnectorMcpEnabled } from "./custom-connector-mcp-feature.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import { publishConnectorRuntimeSyncWakeups } from "./connector-runtime-wakeup.service";
import { changedCustomConnectorIds } from "./user-custom-connector-changes";
import {
  effectiveCustomConnectorPermissionBundleRef,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
} from "./feishu-custom-connector-permissions";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { Tx } from "../../lib/db-types";

type UpdateUserConnectorsResult =
  | {
      readonly status: "updated";
      readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    }
  | { readonly status: "agentNotFound" };

type UserConnectorUpdateOperation = "replace" | "add" | "remove";

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
    }
  | { readonly status: "mcpFeatureDisabled" };

type UserCustomConnectorUpdateOperation = "replace" | "add" | "remove";
type CustomConnectorPermissionIntent = "exact" | "preserveExistingOrDefault";
type DbTransaction = Tx;

interface UserCustomConnectorTransactionResult {
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

type AddUserCustomConnectorResult =
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
    }
  | { readonly status: "mcpFeatureDisabled" };

async function lockAgentForConnectorReplace(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, args.orgId),
        eq(agents.id, args.agentId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .for("update")
    .limit(1);
  return agent !== undefined;
}

export async function lockUserCustomConnectorGrantScope(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  return await lockAgentForConnectorReplace(db, args);
}

interface LockedCustomConnectorRow {
  readonly id: string;
  readonly slug: string;
  readonly prefixTemplates: readonly string[];
  readonly mcpTransport: string | null;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly oauthProviderAdapter: string | null;
  readonly permissionBundleRef: string | null;
}

interface LockedCustomConnectorDefinitions {
  readonly missingIds: readonly string[];
  readonly mcpConnectorIds: ReadonlySet<string>;
  readonly permissionBundleRefs: ReadonlyMap<string, string | null>;
}

async function lockCustomConnectorDefinitionsForGrant(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly connectorIds: readonly string[];
  },
): Promise<LockedCustomConnectorDefinitions> {
  if (args.connectorIds.length === 0) {
    return {
      missingIds: [],
      mcpConnectorIds: new Set(),
      permissionBundleRefs: new Map(),
    };
  }

  const sortedIds = [...args.connectorIds].sort();
  const lockedRows: LockedCustomConnectorRow[] = [];
  for (const id of sortedIds) {
    const [locked] = await db
      .select({
        id: orgCustomConnectors.id,
        slug: orgCustomConnectors.slug,
        prefixTemplates: orgCustomConnectors.prefixTemplates,
        mcpTransport: orgCustomConnectors.mcpTransport,
        authMode: orgCustomConnectors.authMode,
        oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
        permissionBundleRef: orgCustomConnectors.permissionBundleRef,
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
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.id, id),
          eq(orgCustomConnectors.enabled, true),
        ),
      )
      .for("update", { of: orgCustomConnectors })
      .limit(1);
    if (locked) {
      lockedRows.push(locked);
    }
  }

  const lockedIds = new Set(
    lockedRows.map((row) => {
      return row.id;
    }),
  );
  const mcpConnectorIds = new Set(
    lockedRows.flatMap((row) => {
      return row.mcpTransport === null ? [] : [row.id];
    }),
  );
  const missingIds = args.connectorIds.filter((id) => {
    return !lockedIds.has(id);
  });
  if (missingIds.length > 0) {
    return {
      missingIds,
      mcpConnectorIds,
      permissionBundleRefs: new Map(),
    };
  }

  return {
    missingIds: [],
    mcpConnectorIds,
    permissionBundleRefs: new Map(
      lockedRows.map((row) => {
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

export async function updateUserConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly enabledConnectorSlugs: readonly ConnectorSlug[];
    readonly operation?: UserConnectorUpdateOperation;
  },
): Promise<UpdateUserConnectorsResult> {
  const enabledConnectorSlugs = Array.from(new Set(args.enabledConnectorSlugs));
  const operation = args.operation ?? "replace";

  return await db.transaction(async (tx) => {
    const agentLocked = await lockAgentForConnectorReplace(tx, args);
    if (!agentLocked) {
      return { status: "agentNotFound" };
    }

    const connectorScope = and(
      eq(userConnectors.orgId, args.orgId),
      eq(userConnectors.userId, args.userId),
      eq(userConnectors.agentId, args.agentId),
    );

    if (operation === "replace") {
      await tx.delete(userConnectors).where(connectorScope);
    } else if (operation === "remove" && enabledConnectorSlugs.length > 0) {
      await tx
        .delete(userConnectors)
        .where(
          and(
            connectorScope,
            inArray(userConnectors.connectorSlug, enabledConnectorSlugs),
          ),
        );
    }

    if (operation !== "remove" && enabledConnectorSlugs.length > 0) {
      await tx
        .insert(userConnectors)
        .values(
          enabledConnectorSlugs.map((connectorSlug) => {
            return {
              orgId: args.orgId,
              userId: args.userId,
              agentId: args.agentId,
              connectorSlug,
            };
          }),
        )
        .onConflictDoNothing();
    }

    if (operation === "replace") {
      return { status: "updated", enabledConnectorSlugs };
    }

    const rows = await tx
      .select({ connectorSlug: userConnectors.connectorSlug })
      .from(userConnectors)
      .where(connectorScope);
    return {
      status: "updated",
      enabledConnectorSlugs: rows.map((row) => {
        return row.connectorSlug;
      }),
    };
  });
}

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
  readonly snapshot: ConnectorRuntimeSnapshot | null;
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
  readonly snapshot: ConnectorRuntimeSnapshot | null;
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

async function persistUserCustomConnectorUpdate(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly grants: readonly AgentCustomConnectorGrant[];
    readonly operation: UserCustomConnectorUpdateOperation;
  },
): Promise<Extract<UpdateUserCustomConnectorsResult, { status: "updated" }>> {
  const connectorIds = args.grants.map((grant) => {
    return grant.customConnectorId;
  });
  const connectorScope = and(
    eq(userCustomConnectors.orgId, args.orgId),
    eq(userCustomConnectors.userId, args.userId),
    eq(userCustomConnectors.agentId, args.agentId),
  );
  if (args.operation === "replace") {
    await tx.delete(userCustomConnectors).where(connectorScope);
  } else if (args.operation === "remove" && connectorIds.length > 0) {
    await tx
      .delete(userCustomConnectors)
      .where(
        and(
          connectorScope,
          inArray(userCustomConnectors.customConnectorId, connectorIds),
        ),
      );
  }

  if (args.operation !== "remove" && args.grants.length > 0) {
    await tx
      .insert(userCustomConnectors)
      .values(
        args.grants.map((grant) => {
          return {
            orgId: args.orgId,
            userId: args.userId,
            agentId: args.agentId,
            customConnectorId: grant.customConnectorId,
            permissionNames: [...grant.permissionNames],
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          userCustomConnectors.orgId,
          userCustomConnectors.userId,
          userCustomConnectors.agentId,
          userCustomConnectors.customConnectorId,
        ],
        set: {
          permissionNames: sql`excluded.permission_names`,
        },
      });
  }

  if (args.operation === "replace") {
    return {
      status: "updated",
      grants: args.grants,
    };
  }
  const rows = await tx
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(and(connectorScope, eq(orgCustomConnectors.enabled, true)))
    .orderBy(userCustomConnectors.customConnectorId);
  return {
    status: "updated",
    grants: rows.map((row) => {
      return {
        customConnectorId: row.customConnectorId,
        permissionNames: [...row.permissionNames],
      };
    }),
  };
}

async function persistUserCustomConnectorTransaction(args: {
  readonly tx: DbTransaction;
  readonly request: UpdateUserCustomConnectorsArgs;
  readonly grants: readonly AgentCustomConnectorGrant[];
  readonly grantByConnectorId: ReadonlyMap<string, readonly string[]>;
  readonly operation: UserCustomConnectorUpdateOperation;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSnapshot | null;
}): Promise<UserCustomConnectorTransactionResult> {
  const agentLocked = await lockUserCustomConnectorGrantScope(
    args.tx,
    args.request,
  );
  if (!agentLocked) {
    return { result: { status: "agentNotFound" }, changedConnectorIds: [] };
  }
  const previousRows = await args.tx
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.request.orgId),
        eq(userCustomConnectors.userId, args.request.userId),
        eq(userCustomConnectors.agentId, args.request.agentId),
      ),
    )
    .for("update");
  const previousIds = previousRows.map((row) => {
    return row.customConnectorId;
  });
  const connectorIds = args.grants.map((grant) => {
    return grant.customConnectorId;
  });

  if (args.operation === "remove") {
    return {
      result: await persistUserCustomConnectorUpdate(args.tx, {
        orgId: args.request.orgId,
        userId: args.request.userId,
        agentId: args.request.agentId,
        grants: args.grants,
        operation: args.operation,
      }),
      changedConnectorIds: changedCustomConnectorIds(
        previousRows,
        args.grants,
        args.operation,
      ),
    };
  }
  const definitions = await lockCustomConnectorDefinitionsForGrant(args.tx, {
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
  const previousIdSet = new Set(previousIds);
  const addsMcpConnector = connectorIds.some((connectorId) => {
    return (
      !previousIdSet.has(connectorId) &&
      definitions.mcpConnectorIds.has(connectorId)
    );
  });
  if (addsMcpConnector) {
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      args.tx,
      args.request.orgId,
      args.request.userId,
    );
    if (!isCustomConnectorMcpEnabled(featureSwitchContext)) {
      return {
        result: { status: "mcpFeatureDisabled" },
        changedConnectorIds: [],
      };
    }
  }
  const permissionSelection = await resolveCustomConnectorPermissionSelection({
    connectorIds,
    permissionIntent: args.request.permissionIntent,
    grantByConnectorId: args.grantByConnectorId,
    previousPermissionNamesByConnectorId: new Map(
      previousRows.map((row) => {
        return [row.customConnectorId, row.permissionNames] as const;
      }),
    ),
    permissionBundleRefs: definitions.permissionBundleRefs,
    snapshot: args.connectorCatalogSnapshot,
  });
  if (!permissionSelection.ok) {
    return { result: permissionSelection.error, changedConnectorIds: [] };
  }
  const validatedGrants = connectorIds.map((customConnectorId) => {
    return {
      customConnectorId,
      permissionNames: [
        ...(permissionSelection.permissionNamesByConnectorId.get(
          customConnectorId,
        ) ?? []),
      ],
    };
  });
  return {
    result: await persistUserCustomConnectorUpdate(args.tx, {
      orgId: args.request.orgId,
      userId: args.request.userId,
      agentId: args.request.agentId,
      grants: validatedGrants,
      operation: args.operation,
    }),
    changedConnectorIds: changedCustomConnectorIds(
      previousRows,
      validatedGrants,
      args.operation,
    ),
  };
}

export async function updateUserCustomConnectors(
  db: Db,
  args: UpdateUserCustomConnectorsArgs,
  options: UpdateUserCustomConnectorsOptions = {},
): Promise<UpdateUserCustomConnectorsResult> {
  const normalized = normalizeCustomConnectorGrantRequest(args);
  if ("status" in normalized) {
    return normalized;
  }
  const { grants, grantByConnectorId } = normalized;
  const operation = args.operation ?? "replace";
  const connectorCatalogSnapshot =
    args.permissionIntent === "exact" &&
    operation !== "remove" &&
    grants.some((grant) => {
      return grant.permissionNames.length > 0;
    })
      ? await loadConnectorRuntimeSnapshot(db)
      : null;

  const committed = await db.transaction(async (tx) => {
    return await persistUserCustomConnectorTransaction({
      tx,
      request: args,
      grants,
      grantByConnectorId,
      operation,
      connectorCatalogSnapshot,
    });
  });
  if (
    committed.result.status === "updated" &&
    !options.deferRuntimeWakeupUntilOuterCommit
  ) {
    await publishConnectorRuntimeSyncWakeups({
      db,
      scope: {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
      },
      targets: committed.changedConnectorIds.map((customConnectorId) => {
        return { kind: "custom" as const, customConnectorId };
      }),
    });
  }
  return committed.result;
}

export async function addUserCustomConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly customConnectorId: string;
  },
  options: UpdateUserCustomConnectorsOptions = {},
): Promise<AddUserCustomConnectorResult> {
  const result = await updateUserCustomConnectors(
    db,
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
}
