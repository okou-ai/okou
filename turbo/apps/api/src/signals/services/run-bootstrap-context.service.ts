import { userPermissionGrantActionSchema } from "@okouai/api-contracts/contracts/user-permission-grants";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type {
  FirewallPermissionGrant,
  FirewallPermissionGrantAction,
} from "@okouai/connectors/firewall-metadata/policy";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";
import {
  agentConnectorScopeFromRows,
  type AgentConnectorScope,
  type AgentConnectorSlugRow,
  type AgentCustomConnectorRow,
} from "./agent-connector-scope.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
  type UserFeatureSwitchOverrideRow,
} from "./feature-switches.service";
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";
import {
  workflowsForRunFromRows,
  type RunWorkflowRef,
  type RunWorkflowSourceRow,
} from "./workflow-data.service";

const bootstrapMetadataRowKindSchema = z.enum([
  "user_info",
  "feature_switch",
  "builtin_connector",
  "custom_connector",
  "permission_grant",
]);
type BootstrapMetadataRowKind = z.output<typeof bootstrapMetadataRowKindSchema>;
const bootstrapMetadataRowKindDecoder = zodEnumDriverValueDecoder(
  bootstrapMetadataRowKindSchema,
);
const bootstrapMetadataSwitchesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.boolean()),
);
const customConnectorPermissionNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);
const permissionGrantActionDecoder = zodEnumDriverValueDecoder(
  userPermissionGrantActionSchema,
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);
const nullableBootstrapMetadataSwitchesDecoder = nullableDriverValueDecoder(
  bootstrapMetadataSwitchesDecoder,
);
const nullablePermissionGrantActionDecoder = nullableDriverValueDecoder(
  permissionGrantActionDecoder,
);
const nullableCustomConnectorPermissionNamesDecoder =
  nullableDriverValueDecoder(customConnectorPermissionNamesDecoder);

interface BootstrapMetadataQueryRow {
  readonly kind: BootstrapMetadataRowKind;
  readonly id: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly featureUserId: string | null;
  readonly switches: Record<string, boolean> | null;
  readonly detail: string | null;
  readonly action: FirewallPermissionGrantAction | null;
  readonly permissionNames: readonly string[] | null;
  readonly permissionBundleRef: string | null;
}

export interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly slackDisplayName?: string;
  readonly slackUserId?: string;
  readonly feishuDisplayName?: string;
  readonly feishuOpenId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly teamsUserId?: string;
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
  readonly agentphoneHandle?: string;
}

export interface RunBootstrapContext extends AgentConnectorScope {
  readonly userInfo: UserInfo;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly workflows: readonly RunWorkflowRef[];
  readonly permissionGrants: readonly FirewallPermissionGrant[];
  readonly connectorCatalogMetadataSlugs: readonly ConnectorSlug[];
}

interface RunBootstrapSnapshotArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly checkedAt: Date;
}

export interface RunBootstrapSnapshotRows {
  readonly metadataRows: readonly BootstrapMetadataQueryRow[];
  readonly workflowRows: readonly RunWorkflowSourceRow[];
}

function emptyBootstrapMetadataFields() {
  return {
    id: sql`NULL::text`.mapWith(nullableTextDecoder).as("id"),
    name: sql`NULL::text`.mapWith(nullableTextDecoder).as("name"),
    email: sql`NULL::text`.mapWith(nullableTextDecoder).as("email"),
    timezone: sql`NULL::text`.mapWith(nullableTextDecoder).as("timezone"),
    featureUserId: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("feature_user_id"),
    switches: sql`NULL::jsonb`
      .mapWith(nullableBootstrapMetadataSwitchesDecoder)
      .as("switches"),
    detail: sql`NULL::text`.mapWith(nullableTextDecoder).as("detail"),
    action: sql`NULL::text`
      .mapWith(nullablePermissionGrantActionDecoder)
      .as("action"),
    permissionNames: sql`NULL::text[]`
      .mapWith(nullableCustomConnectorPermissionNamesDecoder)
      .as("permission_names"),
    permissionBundleRef: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("permission_bundle_ref"),
  };
}

function agentRunCustomConnectorMetadataQuery(
  db: ReadonlyDb,
  args: RunBootstrapSnapshotArgs,
) {
  return db
    .select({
      kind: sql`'custom_connector'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      id: sql`${userCustomConnectors.customConnectorId}::text`
        .mapWith(nullableTextDecoder)
        .as("id"),
      permissionNames: sql`${userCustomConnectors.permissionNames}`
        .mapWith(nullableCustomConnectorPermissionNamesDecoder)
        .as("permission_names"),
      permissionBundleRef: sql`${orgCustomConnectors.permissionBundleRef}`
        .mapWith(nullableTextDecoder)
        .as("permission_bundle_ref"),
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
        eq(orgCustomConnectors.enabled, true),
      ),
    );
}

async function queryRunBootstrapMetadataSnapshot(
  db: ReadonlyDb,
  args: RunBootstrapSnapshotArgs,
): Promise<BootstrapMetadataQueryRow[]> {
  const userInfoQuery = db
    .select({
      kind: sql`'user_info'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      name: userCache.name,
      email: sql`${userCache.email}`.mapWith(nullableTextDecoder).as("email"),
      timezone: orgMembersMetadata.timezone,
    })
    .from(userCache)
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    )
    .where(eq(userCache.userId, args.userId));
  const featureSwitchQuery = db
    .select({
      kind: sql`'feature_switch'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      featureUserId: sql`${userFeatureSwitches.userId}`
        .mapWith(nullableTextDecoder)
        .as("feature_user_id"),
      switches: sql`${userFeatureSwitches.switches}`
        .mapWith(nullableBootstrapMetadataSwitchesDecoder)
        .as("switches"),
    })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, args.orgId),
        inArray(userFeatureSwitches.userId, [
          args.userId,
          ORG_SENTINEL_USER_ID,
        ]),
      ),
    );
  const builtinConnectorQuery = db
    .select({
      kind: sql`'builtin_connector'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      name: sql`${userConnectors.connectorSlug}`
        .mapWith(nullableTextDecoder)
        .as("name"),
    })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );
  const customConnectorQuery = agentRunCustomConnectorMetadataQuery(db, args);
  const permissionGrantQuery = db
    .select({
      kind: sql`'permission_grant'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      name: sql`${userPermissionGrants.connectorSlug}`
        .mapWith(nullableTextDecoder)
        .as("name"),
      detail: sql`${userPermissionGrants.permission}`
        .mapWith(nullableTextDecoder)
        .as("detail"),
      action: sql`${userPermissionGrants.action}`
        .mapWith(nullablePermissionGrantActionDecoder)
        .as("action"),
    })
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, args.orgId),
        eq(userPermissionGrants.userId, args.userId),
        eq(userPermissionGrants.agentId, args.agentId),
        activeUserPermissionGrantCondition(args.checkedAt),
      ),
    );
  return await unionAll(
    userInfoQuery,
    featureSwitchQuery,
    builtinConnectorQuery,
    customConnectorQuery,
    permissionGrantQuery,
  );
}

async function queryAgentRunWorkflowCandidates(
  db: ReadonlyDb,
  args: RunBootstrapSnapshotArgs,
): Promise<RunWorkflowSourceRow[]> {
  return await db
    .select({
      id: workflows.id,
      name: workflows.name,
      visibility: workflows.visibility,
      ownerUserId: workflows.ownerUserId,
      officialDefinitionName: workflows.officialDefinitionName,
      createdAt: workflows.createdAt,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.agentId),
        or(
          isNull(workflows.officialDefinitionName),
          eq(workflows.officialInstallationState, "installed"),
        ),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, args.userId),
        ),
      ),
    );
}

export async function loadRunBootstrapSnapshotRows(
  db: ReadonlyDb,
  args: RunBootstrapSnapshotArgs,
): Promise<RunBootstrapSnapshotRows> {
  const [metadataRows, workflowRows] = await Promise.all([
    queryRunBootstrapMetadataSnapshot(db, args),
    queryAgentRunWorkflowCandidates(db, args),
  ]);
  return { metadataRows, workflowRows };
}

export function materializeRunBootstrapContext(
  rows: RunBootstrapSnapshotRows,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): RunBootstrapContext {
  let userInfo: UserInfo = {
    name: null,
    email: null,
    timezone: null,
  };
  const featureSwitchRows: UserFeatureSwitchOverrideRow[] = [];
  const connectorRows: AgentConnectorSlugRow[] = [];
  const customConnectorRows: AgentCustomConnectorRow[] = [];
  const connectorCatalogMetadataSlugs = new Set<ConnectorSlug>();
  const permissionGrants: FirewallPermissionGrant[] = [];

  for (const row of rows.metadataRows) {
    switch (row.kind) {
      case "user_info": {
        userInfo = {
          name: row.name,
          email: row.email,
          timezone: row.timezone,
        };
        break;
      }
      case "feature_switch": {
        if (row.featureUserId === null || row.switches === null) {
          throw new Error("Invalid bootstrap metadata feature-switch row");
        }
        featureSwitchRows.push({
          userId: row.featureUserId,
          switches: row.switches,
        });
        break;
      }
      case "builtin_connector": {
        if (row.name === null) {
          throw new Error("Invalid bootstrap metadata connector row");
        }
        connectorRows.push({ connectorSlug: row.name });
        break;
      }
      case "custom_connector": {
        if (row.id === null || row.permissionNames === null) {
          throw new Error("Invalid bootstrap metadata custom connector row");
        }
        customConnectorRows.push({
          customConnectorId: row.id,
          permissionNames: row.permissionNames,
        });
        if (row.permissionBundleRef !== null) {
          const dependency = customConnectorPermissionBundleDependencySlug(
            row.permissionBundleRef,
          );
          if (dependency !== null) {
            connectorCatalogMetadataSlugs.add(dependency);
          }
        }
        break;
      }
      case "permission_grant": {
        if (row.name === null || row.detail === null || row.action === null) {
          throw new Error("Invalid bootstrap metadata permission grant row");
        }
        permissionGrants.push({
          connectorSlug: row.name,
          permission: row.detail,
          action: row.action,
        });
        break;
      }
    }
  }

  permissionGrants.sort((left, right) => {
    return (
      left.connectorSlug.localeCompare(right.connectorSlug) ||
      left.permission.localeCompare(right.permission)
    );
  });
  const connectorScope = agentConnectorScopeFromRows({
    connectorRows,
    customConnectorRows,
  });
  const featureSwitchContext: FeatureSwitchContext = {
    orgId: args.orgId,
    userId: args.userId,
    email: userInfo.email ?? undefined,
    overrides: userFeatureSwitchOverridesFromRows(
      featureSwitchRows,
      args.userId,
    ),
  };

  return {
    userInfo,
    featureSwitchContext,
    ...connectorScope,
    workflows: workflowsForRunFromRows(rows.workflowRows, args.userId),
    permissionGrants,
    connectorCatalogMetadataSlugs: [...connectorCatalogMetadataSlugs].sort(),
  };
}
