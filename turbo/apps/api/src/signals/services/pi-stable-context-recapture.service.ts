import { PI_SKILLS_ROOT } from "@okouai/api-contracts/contracts/runners";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { parseGitHubTreeUrl, resolveSkillRef } from "@okouai/core/github-url";
import { INTRO_VIDEO_SKILL_NAME } from "@okouai/core/seed-skills";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
  getOfficialWorkflowDefinitionStorageName,
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import type {
  PiStableContextBuildInput,
  PiStableContextPromptInputs,
  PiStableContextSemanticInput,
  PiStableContextStorageMount,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import { userCache } from "@okouai/db/schema/user-cache";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import type { PersistedStorageMount } from "@okouai/db/types";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { loadAgentConnectorScopeSerial } from "./agent-connector-scope.service";
import { buildAgentToolsPrompt } from "./agent-tools-prompt.service";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import { loadConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import { readAcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";
import { piStableContextVariantDigest } from "./pi-stable-context-digest.service";
import {
  workflowsForRunFromRows,
  type RunWorkflowRef,
} from "./workflow-data.service";

interface StableContextSourceSnapshot {
  readonly promptInputs: PiStableContextPromptInputs;
  readonly connectorScope: PiStableContextSemanticInput["connectorScope"];
  readonly permissionPolicies: ReturnType<
    typeof permissionGrantsToFirewallPolicies
  >;
  readonly permissionValidityHorizon: string | null;
  readonly catalogSelection:
    | { readonly kind: "empty" }
    | {
        readonly kind: "scoped";
        readonly selection: Awaited<
          ReturnType<typeof loadConnectorRuntimeSelection>
        >;
      };
}

interface DesiredDynamicMount {
  readonly kind: "custom_connector" | "injected";
  readonly orgId: string;
  readonly storageName: string;
  readonly versionId: string | undefined;
  readonly expectedStorageId?: string;
  readonly mountPath: string;
}

interface ResolvedDynamicMount {
  readonly desired: DesiredDynamicMount;
  readonly storage: PiStableContextStorageMount;
  readonly persisted: PersistedStorageMount;
}

function featurePromptInputs(
  previous: PiStableContextPromptInputs,
  featureContext: FeatureSwitchContext,
): PiStableContextPromptInputs {
  return {
    ...previous,
    privateArtifactsEnabled: isFeatureEnabled(
      FeatureSwitchKey.PrivateArtifacts,
      featureContext,
    ),
    sshEnabled: isFeatureEnabled(FeatureSwitchKey.SshAccess, featureContext),
    bankingEnabled: isFeatureEnabled(FeatureSwitchKey.Banking, featureContext),
    larkEnabled: isFeatureEnabled(
      FeatureSwitchKey.LarkIntegration,
      featureContext,
    ),
    deliveryFormatGuidanceEnabled: isFeatureEnabled(
      FeatureSwitchKey.DeliveryFormatGuidance,
      featureContext,
    ),
    introVideoEnabled: isFeatureEnabled(
      FeatureSwitchKey.IntroVideo,
      featureContext,
    ),
  };
}

async function loadFeaturePromptInputs(
  db: Db,
  input: PiStableContextBuildInput,
): Promise<PiStableContextPromptInputs> {
  if (!input.semantic) {
    throw new Error("Stable-context recapture requires semantic input");
  }
  const rows = await db
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, input.owner.orgId),
        inArray(userFeatureSwitches.userId, [
          input.owner.userId,
          ORG_SENTINEL_USER_ID,
        ]),
      ),
    );
  const [user] = await db
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, input.owner.userId))
    .limit(1);
  return featurePromptInputs(input.semantic.promptInputs, {
    orgId: input.owner.orgId,
    userId: input.owner.userId,
    email: user?.email ?? undefined,
    overrides: userFeatureSwitchOverridesFromRows(rows, input.owner.userId),
  });
}

async function loadRunWorkflows(
  db: Db,
  input: PiStableContextBuildInput,
): Promise<readonly RunWorkflowRef[]> {
  const rows = await db
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
        eq(workflows.orgId, input.owner.orgId),
        eq(workflows.agentId, input.owner.agentId),
        or(
          isNull(workflows.officialDefinitionName),
          eq(workflows.officialInstallationState, "installed"),
        ),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, input.owner.userId),
        ),
      ),
    );
  return workflowsForRunFromRows(rows, input.owner.userId);
}

async function loadPermissionSnapshot(
  db: Db,
  input: PiStableContextBuildInput,
  checkedAt: Date,
) {
  const rows = await db
    .select({
      connectorSlug: userPermissionGrants.connectorSlug,
      permission: userPermissionGrants.permission,
      action: userPermissionGrants.action,
      expiresAt: userPermissionGrants.expiresAt,
    })
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, input.owner.orgId),
        eq(userPermissionGrants.userId, input.owner.userId),
        eq(userPermissionGrants.agentId, input.owner.agentId),
        or(
          isNull(userPermissionGrants.expiresAt),
          gt(userPermissionGrants.expiresAt, checkedAt),
        ),
      ),
    )
    .orderBy(
      asc(userPermissionGrants.connectorSlug),
      asc(userPermissionGrants.permission),
    );
  let horizon: Date | null = null;
  for (const row of rows) {
    if (
      row.expiresAt !== null &&
      (horizon === null || row.expiresAt.getTime() < horizon.getTime())
    ) {
      horizon = row.expiresAt;
    }
  }
  return {
    policies: permissionGrantsToFirewallPolicies(rows),
    validityHorizon: horizon?.toISOString() ?? null,
  };
}

async function loadStableContextSourceSnapshot(
  db: Db,
  input: PiStableContextBuildInput,
  checkedAt: Date,
): Promise<StableContextSourceSnapshot> {
  if (!input.semantic) {
    throw new Error("Stable-context recapture requires semantic input");
  }
  // Source writers call this inside one transaction-bound PostgreSQL client;
  // keep reads serial instead of issuing unsupported concurrent client queries.
  const promptInputs = await loadFeaturePromptInputs(db, input);
  const connectorScopeBase = await loadAgentConnectorScopeSerial(db, {
    orgId: input.owner.orgId,
    userId: input.owner.userId,
    agentId: input.owner.agentId,
  });
  const runWorkflows = await loadRunWorkflows(db, input);
  const permission = await loadPermissionSnapshot(db, input, checkedAt);
  const connectorScope = {
    ...connectorScopeBase,
    workflows: runWorkflows,
  };
  const catalogSelection: StableContextSourceSnapshot["catalogSelection"] =
    connectorScope.allowedConnectorSlugs.length === 0 &&
    connectorScope.allowedCustomConnectorIds.length === 0
      ? { kind: "empty" }
      : {
          kind: "scoped",
          selection: await loadConnectorRuntimeSelection(db, {
            requestedConnectorSlugs: connectorScope.allowedConnectorSlugs,
          }),
        };
  const permissionPolicies =
    catalogSelection.kind === "empty"
      ? permission.policies
      : await expandConnectorServerFirewallPolicies({
          catalog: catalogSelection.selection.serverFirewalls,
          stored: permission.policies,
          connectorSlugs: [...connectorScope.allowedConnectorSlugs],
        });
  return {
    promptInputs,
    connectorScope,
    permissionPolicies,
    permissionValidityHorizon: permission.validityHorizon,
    catalogSelection,
  };
}

function introVideoStorageName(): string {
  const parsed = parseGitHubTreeUrl(resolveSkillRef(INTRO_VIDEO_SKILL_NAME));
  if (!parsed) {
    throw new Error("Intro Video skill source is invalid");
  }
  return getSkillStorageName(parsed.fullPath);
}

function customConnectorMounts(
  snapshot: StableContextSourceSnapshot,
  orgId: string,
): readonly DesiredDynamicMount[] {
  return snapshot.connectorScope.customConnectorDefinitions.flatMap(
    (definition) => {
      if (!definition.skillStorageVersionId) {
        return [];
      }
      return [
        {
          kind: "custom_connector" as const,
          orgId,
          storageName: getCustomConnectorSkillStorageName(
            definition.customConnectorId,
          ),
          versionId: definition.skillStorageVersionId,
          mountPath: `${PI_SKILLS_ROOT}/${getCustomConnectorSkillName(
            definition.connectorSlug,
            definition.customConnectorId,
          )}`,
        },
      ];
    },
  );
}

function builtinConnectorMounts(
  snapshot: StableContextSourceSnapshot,
): readonly DesiredDynamicMount[] | null {
  if (snapshot.catalogSelection.kind === "empty") {
    return [];
  }
  const selection = snapshot.catalogSelection.selection;
  const desired: DesiredDynamicMount[] = [];
  for (const slug of snapshot.connectorScope.allowedConnectorSlugs) {
    const connector = selection.connectors.get(slug);
    if (!connector) {
      return null;
    }
    if (connector.skill.kind !== "none") {
      desired.push({
        kind: "injected",
        orgId: SYSTEM_ORG_ID,
        storageName: connector.skill.storageName,
        versionId: connector.skill.versionId,
        mountPath: `${PI_SKILLS_ROOT}/${slug}`,
      });
    }
  }
  return desired;
}

async function workflowMounts(
  db: Db,
  snapshot: StableContextSourceSnapshot,
  orgId: string,
): Promise<readonly DesiredDynamicMount[] | null> {
  const needsOfficialCatalog = snapshot.connectorScope.workflows.some(
    (workflow) => {
      return workflow.officialDefinitionName !== null;
    },
  );
  const catalog = needsOfficialCatalog
    ? await readAcceptedOfficialWorkflowCatalog(db)
    : null;
  const desired: DesiredDynamicMount[] = [];
  for (const workflow of snapshot.connectorScope.workflows) {
    if (workflow.officialDefinitionName === null) {
      desired.push({
        kind: "injected",
        orgId,
        storageName: getCustomSkillStorageName(workflow.workflowId),
        versionId: undefined,
        mountPath: `${PI_SKILLS_ROOT}/${workflow.name}`,
      });
      continue;
    }
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === workflow.officialDefinitionName;
    });
    if (!definition) {
      return null;
    }
    desired.push({
      kind: "injected",
      orgId: SYSTEM_ORG_ID,
      storageName: definition.artifact.storageName,
      versionId: definition.artifact.storageVersion,
      expectedStorageId: definition.artifact.storageId,
      mountPath: `${PI_SKILLS_ROOT}/${workflow.name}`,
    });
  }
  return desired;
}

async function desiredDynamicMounts(
  db: Db,
  input: PiStableContextBuildInput,
  snapshot: StableContextSourceSnapshot,
): Promise<readonly DesiredDynamicMount[] | null> {
  const workflow = await workflowMounts(db, snapshot, input.owner.orgId);
  const builtin = builtinConnectorMounts(snapshot);
  if (!workflow || !builtin) {
    return null;
  }
  return [
    ...customConnectorMounts(snapshot, input.owner.orgId),
    ...(snapshot.promptInputs.introVideoEnabled
      ? [
          {
            kind: "injected" as const,
            orgId: SYSTEM_ORG_ID,
            storageName: introVideoStorageName(),
            versionId: undefined,
            mountPath: `${PI_SKILLS_ROOT}/${INTRO_VIDEO_SKILL_NAME}`,
          },
        ]
      : []),
    ...builtin,
    ...workflow,
  ];
}

async function resolveDynamicMount(
  db: Db,
  desired: DesiredDynamicMount,
): Promise<ResolvedDynamicMount | null> {
  const conditions = [
    eq(storages.orgId, desired.orgId),
    eq(storages.userId, VOLUME_ORG_USER_ID),
    eq(storages.name, desired.storageName),
  ];
  if (desired.expectedStorageId) {
    conditions.push(eq(storages.id, desired.expectedStorageId));
  }
  const [row] = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      storageId: storages.id,
      versionId: storageVersions.id,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storages)
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        desired.versionId
          ? eq(storageVersions.id, desired.versionId)
          : eq(storageVersions.id, storages.headVersionId),
      ),
    )
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    desired,
    storage: {
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      storageId: row.storageId,
      versionId: row.versionId,
      mountPath: desired.mountPath,
      archiveSize: row.archiveSize,
      ...(row.fileCount === 0 ? { empty: true as const } : {}),
    },
    persisted: {
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      storageId: row.storageId,
      version: row.versionId,
      mountPath: desired.mountPath,
    },
  };
}

async function resolveDynamicMounts(
  db: Db,
  desired: readonly DesiredDynamicMount[],
): Promise<readonly ResolvedDynamicMount[] | null> {
  const resolved: ResolvedDynamicMount[] = [];
  for (const mount of desired) {
    const selected = await resolveDynamicMount(db, mount);
    if (!selected) {
      return null;
    }
    resolved.push(selected);
  }
  return resolved;
}

function dynamicStorageIdentities(
  semantic: PiStableContextSemanticInput,
  orgId: string,
): ReadonlySet<string> {
  const identities = new Set<string>();
  const add = (storageOrgId: string, name: string) => {
    identities.add(`${storageOrgId}\0${name}`);
  };
  for (const definition of semantic.connectorScope.customConnectorDefinitions) {
    add(
      orgId,
      getCustomConnectorSkillStorageName(definition.customConnectorId),
    );
  }
  for (const workflow of semantic.connectorScope.workflows) {
    if (workflow.officialDefinitionName === null) {
      add(orgId, getCustomSkillStorageName(workflow.workflowId));
    } else {
      add(
        SYSTEM_ORG_ID,
        getOfficialWorkflowDefinitionStorageName(
          workflow.officialDefinitionName,
        ),
      );
    }
  }
  if (semantic.promptInputs.introVideoEnabled) {
    add(SYSTEM_ORG_ID, introVideoStorageName());
  }
  return identities;
}

function mergeDynamicMounts<
  T extends {
    readonly orgId: string;
    readonly name: string;
    readonly mountPath: string;
  },
>(args: {
  readonly current: readonly T[];
  readonly resolved: readonly ResolvedDynamicMount[];
  readonly previousSemantic: PiStableContextSemanticInput;
  readonly nextSemantic: PiStableContextSemanticInput;
  readonly ownerOrgId: string;
  readonly select: (mount: ResolvedDynamicMount) => T;
}): readonly T[] {
  const previous = dynamicStorageIdentities(
    args.previousSemantic,
    args.ownerOrgId,
  );
  const next = dynamicStorageIdentities(args.nextSemantic, args.ownerOrgId);
  const desired = new Set(
    args.resolved.map((mount) => {
      return `${mount.storage.orgId}\0${mount.storage.name}`;
    }),
  );
  const isDynamic = (mount: T) => {
    const identity = `${mount.orgId}\0${mount.name}`;
    return (
      previous.has(identity) ||
      next.has(identity) ||
      desired.has(identity) ||
      (mount.orgId === SYSTEM_ORG_ID &&
        mount.name.startsWith("connector-skill@"))
    );
  };
  const firstDynamicIndex = args.current.findIndex(isDynamic);
  const base = args.current.filter((mount) => {
    return !isDynamic(mount);
  });
  const custom = args.resolved
    .filter((mount) => {
      return mount.desired.kind === "custom_connector";
    })
    .map(args.select);
  const injected = args.resolved
    .filter((mount) => {
      return mount.desired.kind === "injected";
    })
    .map(args.select);
  const firstSkillIndex = base.findIndex((mount) => {
    return mount.mountPath.startsWith(`${PI_SKILLS_ROOT}/`);
  });
  if (firstSkillIndex === -1) {
    const insertion =
      firstDynamicIndex === -1 ? base.length : firstDynamicIndex;
    return [
      ...base.slice(0, insertion),
      ...custom,
      ...injected,
      ...base.slice(insertion),
    ];
  }
  const withCustom = [
    ...base.slice(0, firstSkillIndex),
    ...custom,
    ...base.slice(firstSkillIndex),
  ];
  let lastSkillIndex = -1;
  for (let index = 0; index < withCustom.length; index += 1) {
    if (withCustom[index]?.mountPath.startsWith(`${PI_SKILLS_ROOT}/`)) {
      lastSkillIndex = index;
    }
  }
  return [
    ...withCustom.slice(0, lastSkillIndex + 1),
    ...injected,
    ...withCustom.slice(lastSkillIndex + 1),
  ];
}

/**
 * Rebuilds every mutable source component from one post-write DB snapshot.
 * The returned value is immutable worker input; a missing referenced artifact
 * leaves the head missing instead of publishing a mixed generation.
 */
export async function recapturePiStableContextInput(
  db: Db,
  input: PiStableContextBuildInput,
  checkedAt = nowDate(),
): Promise<PiStableContextBuildInput | null> {
  if (!input.semantic) {
    return input;
  }
  const captured = await settle(
    loadStableContextSourceSnapshot(db, input, checkedAt),
  );
  if (!captured.ok) {
    if (captured.error instanceof ExternalConnectorCatalogUnavailableError) {
      return null;
    }
    throw captured.error;
  }
  const snapshot = captured.value;
  const semantic: PiStableContextSemanticInput = {
    promptInputs: snapshot.promptInputs,
    feishuPlatform: input.semantic.feishuPlatform,
    connectorScope: snapshot.connectorScope,
  };
  const desired = await desiredDynamicMounts(db, input, snapshot);
  if (!desired) {
    return null;
  }
  const resolved = await resolveDynamicMounts(db, desired);
  if (!resolved) {
    return null;
  }
  const permissionDigest = piStableContextVariantDigest(
    snapshot.permissionPolicies ?? null,
  );
  return {
    ...input,
    prompt: {
      ...input.prompt,
      tools: buildAgentToolsPrompt({
        ...snapshot.promptInputs,
        feishuPlatform: semantic.feishuPlatform ?? undefined,
      }),
    },
    semantic,
    source: {
      ...input.source,
      catalogIdentity:
        snapshot.catalogSelection.kind === "scoped"
          ? piStableContextVariantDigest(
              snapshot.catalogSelection.selection.catalogIdentity,
            )
          : null,
      featurePromptDigest: piStableContextVariantDigest(snapshot.promptInputs),
      permissionDigest,
      connectorScopeDigest: piStableContextVariantDigest(
        snapshot.connectorScope,
      ),
      validityHorizon: snapshot.permissionValidityHorizon,
    },
    storageMounts: mergeDynamicMounts({
      current: input.storageMounts,
      resolved,
      previousSemantic: input.semantic,
      nextSemantic: semantic,
      ownerOrgId: input.owner.orgId,
      select(mount) {
        return mount.storage;
      },
    }),
    persistedStorageMounts: mergeDynamicMounts({
      current: input.persistedStorageMounts,
      resolved,
      previousSemantic: input.semantic,
      nextSemantic: semantic,
      ownerOrgId: input.owner.orgId,
      select(mount) {
        return mount.persisted;
      },
    }),
  };
}
