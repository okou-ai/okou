import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userCache } from "@okouai/db/schema/user-cache";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { workflows } from "@okouai/db/schema/workflow";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import {
  emptyBootstrapMetadataFields,
  ORG_SENTINEL_USER_ID,
  type AgentRunRecord,
  type BootstrapMetadataQueryRow,
  type RunBootstrapSnapshotRows,
  type DisabledPaidToolsSnapshot,
  type RunMemberSnapshot,
  materializeRunBootstrapContext,
  runEnvironmentSecretNames,
} from "./agent-run-execution.service";
import { buildAgentExecutionConfig } from "./agent-execution-config";
import {
  createAgentDisabledPaidTools,
  createAgentMemberSnapshot,
  createAgentCustomConnectorDefinitions,
  createAgentEnvironment,
  type AgentEnvironmentSnapshot,
} from "./agent-bootstrap-resources";
import {
  createAgentCatalogIdentity,
  createAgentCatalogProjectionRows,
  type AgentBootstrapCatalog,
} from "./agent-bootstrap-catalog";
import { requestedProjectionConnectorSlugs } from "./connector-catalog-runtime.service";
import type { normaliseCustomConnectorRow } from "./custom-connector.service";
import type { RunWorkflowSourceRow } from "./workflow-data.service";

export interface AgentBootstrap extends RunBootstrapSnapshotRows {
  readonly agent: AgentRunRecord | null;
  readonly member: RunMemberSnapshot;
  readonly disabledPaidTools: DisabledPaidToolsSnapshot;
  readonly environment: AgentEnvironmentSnapshot;
  readonly customConnectorDefinitions: readonly ReturnType<
    typeof normaliseCustomConnectorRow
  >[];
  readonly catalog: AgentBootstrapCatalog;
}

/** Request-owned speculative reads; the key is available without awaiting them. */
export interface PrefetchedAgentBootstrap {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly bootstrap: Promise<AgentBootstrap>;
}

const metadataRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum([
    "user_info",
    "feature_switch",
    "builtin_connector",
    "custom_connector",
    "permission_grant",
  ]),
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);

function createAgentDefinition(agentId: string) {
  return computed(async (get): Promise<AgentRunRecord | null> => {
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        name: agents.name,
        orgId: agents.orgId,
        defaultAgentId: orgMetadata.defaultAgentId,
        owner: agents.owner,
        visibility: agents.visibility,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        modelProviderId: agents.modelProviderId,
        selectedModel: agents.selectedModel,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(eq(agents.id, agentId))
      .limit(1);
    return agent ?? null;
  });
}

function createAgentBootstrapMetadata(
  userId: string,
  orgId: string,
  agentId: string,
) {
  return computed(async (get): Promise<BootstrapMetadataQueryRow[]> => {
    const db = get(db$);
    // The first UNION branch owns every returned field's runtime decoder.
    const userInfoQuery = db
      .select({
        kind: sql`'user_info'`.mapWith(metadataRowKindDecoder).as("kind"),
        ...emptyBootstrapMetadataFields(),
        name: userCache.name,
        email: sql`${userCache.email}`.mapWith(nullableTextDecoder).as("email"),
        timezone: orgMembersMetadata.timezone,
      })
      .from(userCache)
      .leftJoin(
        orgMembersMetadata,
        and(
          eq(orgMembersMetadata.userId, userId),
          eq(orgMembersMetadata.orgId, orgId),
        ),
      )
      .where(eq(userCache.userId, userId));
    const featureSwitchQuery = db
      .select({
        kind: sql`'feature_switch'`.mapWith(metadataRowKindDecoder).as("kind"),
        ...emptyBootstrapMetadataFields(),
        featureUserId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          inArray(userFeatureSwitches.userId, [userId, ORG_SENTINEL_USER_ID]),
        ),
      );
    const builtinConnectorQuery = db
      .select({
        kind: sql`'builtin_connector'`
          .mapWith(metadataRowKindDecoder)
          .as("kind"),
        ...emptyBootstrapMetadataFields(),
        name: userBuiltinConnectors.connectorSlug,
      })
      .from(userBuiltinConnectors)
      .where(
        and(
          eq(userBuiltinConnectors.orgId, orgId),
          eq(userBuiltinConnectors.userId, userId),
          eq(userBuiltinConnectors.agentId, agentId),
        ),
      );
    const customConnectorQuery = db
      .select({
        kind: sql`'custom_connector'`
          .mapWith(metadataRowKindDecoder)
          .as("kind"),
        ...emptyBootstrapMetadataFields(),
        id: sql`${userCustomConnectors.customConnectorId}::text`
          .mapWith(nullableTextDecoder)
          .as("id"),
        detail: orgCustomConnectors.slug,
        permissionNames: userCustomConnectors.permissionNames,
        permissionBundleRef: orgCustomConnectors.permissionBundleRef,
        storageVersion: orgCustomConnectors.storageVersion,
        skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
        isMcp: isNotNull(orgCustomConnectors.mcpEndpoint)
          .mapWith(pgBooleanDecoder)
          .as("is_mcp"),
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
          eq(userCustomConnectors.orgId, orgId),
          eq(userCustomConnectors.userId, userId),
          eq(userCustomConnectors.agentId, agentId),
          eq(orgCustomConnectors.enabled, true),
        ),
      );
    // Expiry is evaluated at consumption, not at speculative-read time.
    const permissionGrantQuery = db
      .select({
        kind: sql`'permission_grant'`
          .mapWith(metadataRowKindDecoder)
          .as("kind"),
        ...emptyBootstrapMetadataFields(),
        name: userPermissionGrants.connectorSlug,
        detail: userPermissionGrants.permission,
        action: userPermissionGrants.action,
        expiresAt: userPermissionGrants.expiresAt,
      })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, orgId),
          eq(userPermissionGrants.userId, userId),
          eq(userPermissionGrants.agentId, agentId),
        ),
      );
    return await unionAll(
      userInfoQuery,
      featureSwitchQuery,
      builtinConnectorQuery,
      customConnectorQuery,
      permissionGrantQuery,
    );
  });
}

function createAgentWorkflows(userId: string, orgId: string, agentId: string) {
  return computed(async (get): Promise<RunWorkflowSourceRow[]> => {
    return await get(db$)
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
          eq(workflows.orgId, orgId),
          eq(workflows.agentId, agentId),
          or(
            isNull(workflows.officialDefinitionName),
            eq(workflows.officialInstallationState, "installed"),
          ),
          or(
            eq(workflows.visibility, "public"),
            eq(workflows.ownerUserId, userId),
          ),
        ),
      );
  });
}

/** Keep authorization's agent read independent from post-authorization metadata. */
export function createAgentBootstrapObjects(
  userId: string,
  orgId: string,
  agentId: string,
) {
  const agent$ = createAgentDefinition(agentId);
  const metadataRows$ = createAgentBootstrapMetadata(userId, orgId, agentId);
  const workflowRows$ = createAgentWorkflows(userId, orgId, agentId);
  const member$ = createAgentMemberSnapshot(userId, orgId);
  const disabledPaidTools$ = createAgentDisabledPaidTools(userId, orgId);
  const catalogIdentity$ = createAgentCatalogIdentity();
  const metadata$ = computed(async (get) => {
    return materializeRunBootstrapContext(
      { metadataRows: await get(metadataRows$), workflowRows: [] },
      { userId, orgId },
    );
  });
  const environment$ = computed(async (get) => {
    const agent = await get(agent$);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return await get(
      createAgentEnvironment(
        userId,
        orgId,
        runEnvironmentSecretNames(buildAgentExecutionConfig(agent.name)),
      ),
    );
  });
  const customConnectorDefinitions$ = computed(async (get) => {
    const metadata = await get(metadata$);
    return await get(
      createAgentCustomConnectorDefinitions(
        orgId,
        metadata.allowedCustomConnectorIds,
      ),
    );
  });
  const catalog$ = computed(async (get): Promise<AgentBootstrapCatalog> => {
    const [captured, metadata] = await Promise.all([
      get(catalogIdentity$),
      get(metadata$),
    ]);
    const connectorSlugs = requestedProjectionConnectorSlugs({
      runtimeConnectorSlugs: metadata.allowedConnectorSlugs,
      metadataConnectorSlugs: metadata.connectorCatalogMetadataSlugs,
    });
    const rows =
      captured.projection.kind === "ready"
        ? await get(
            createAgentCatalogProjectionRows(
              captured.projection.projection.identity.projectionSetId,
              connectorSlugs,
            ),
          )
        : [];
    return { captured, connectorSlugs, rows };
  });
  const bootstrap$ = computed(async (get): Promise<AgentBootstrap> => {
    const [
      agent,
      metadataRows,
      workflowRows,
      member,
      disabledPaidTools,
      environment,
      customConnectorDefinitions,
      catalog,
    ] = await Promise.all([
      get(agent$),
      get(metadataRows$),
      get(workflowRows$),
      get(member$),
      get(disabledPaidTools$),
      get(environment$),
      get(customConnectorDefinitions$),
      get(catalog$),
    ]);
    return {
      agent,
      metadataRows,
      workflowRows,
      member,
      disabledPaidTools,
      environment,
      customConnectorDefinitions,
      catalog,
    };
  });
  return { agent$, bootstrap$ };
}

/** One query graph shared by S1 prefetch and a claim's canonical read. */
export function createAgentBootstrap(
  userId: string,
  orgId: string,
  agentId: string,
): Computed<Promise<AgentBootstrap>> {
  return createAgentBootstrapObjects(userId, orgId, agentId).bootstrap$;
}
