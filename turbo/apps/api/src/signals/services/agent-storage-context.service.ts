import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import {
  SYSTEM_ORG_ID,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
  getSkillStorageName,
  getCustomSkillStorageName,
  getInstructionsStorageName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import {
  getConnectorRuntimeConnector,
  type ConnectorRuntimeLookup,
} from "./connector-catalog-runtime.service";
import type { AgentConnectorSelection } from "./execution-agent-connectors.service";
import type { SelectedAgentWorkflow } from "./execution-agent-workflows.service";
import type { OfficialWorkflowContextFacts } from "./official-workflow-context.signals";
import {
  storageRequestKey,
  storageIndexKey,
  mergeStorageIndexes,
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";
import {
  executionStorageCachePairs,
  type ExecutionStorageRequest,
} from "./execution-storage.service";
import type { BootstrapAgent } from "./agent-data.service";

export interface AgentStorageContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

function agentStorageCacheMounts(context: AgentStorageContext) {
  const facts = context.requests.flatMap((request, position) => {
    const storage = context.index.get(
      storageIndexKey(
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
      ),
    );
    const version =
      request.version === undefined || request.version === "latest"
        ? storage?.headVersion
        : storage?.headVersion?.id === request.version
          ? storage.headVersion
          : storage?.exactVersions.get(request.version);
    if (!storage || !version) {
      return [];
    }
    const identity = {
      ...request.lookup,
      storageId: storage.storageId,
      versionId: version.id,
    };
    const mount: ExecutionStorageRequest = {
      ...identity,
      mountPath: `/cache/${position}`,
      mode: "readonly",
    };
    return [
      {
        mount,
        version: {
          ...identity,
          s3Key: version.s3Key,
          archiveSize: version.archiveSize,
          fileCount: version.fileCount,
        },
      },
    ];
  });
  return {
    mounts: facts.map((fact) => {
      return fact.mount;
    }),
    versions: facts.map((fact) => {
      return fact.version;
    }),
  };
}

/** Database identities only: framework-specific mount paths are assembled later. */
function agentStorageRequests(
  owner: {
    readonly orgId: string;
    readonly userId: string;
    readonly agent: Pick<BootstrapAgent, "name" | "orgId"> | null;
  },
  workflows: readonly SelectedAgentWorkflow[],
  connectors: AgentConnectorSelection,
  catalog: ConnectorRuntimeLookup | null,
  official: OfficialWorkflowContextFacts,
): readonly StorageRequest[] {
  const { orgId, userId } = owner;
  // The root identity is independent of framework, thread and message. A Pi
  // continuation's pinned historical version is still resolved by its Thread.
  const requests: StorageRequest[] = [
    {
      lookup: { orgId, userId, name: MEMORY_ARTIFACT_NAME },
      version: undefined,
    },
  ];
  const add = (ownerOrgId: string, name: string, version?: string) => {
    requests.push({
      lookup: { orgId: ownerOrgId, userId: VOLUME_ORG_USER_ID, name },
      version,
    });
  };
  if (owner.agent) {
    add(owner.agent.orgId, getInstructionsStorageName(owner.agent.name));
  }
  for (const skill of SEED_SKILLS) {
    const parsed = parseGitHubTreeUrl(resolveSkillRef(skill));
    if (parsed) {
      const name = getSkillStorageName(parsed.fullPath);
      add(SYSTEM_ORG_ID, name);
      add(orgId, name);
    }
  }
  for (const workflow of workflows) {
    if (SEED_SKILLS.includes(workflow.name)) {
      continue;
    }
    if (workflow.officialDefinitionName === null) {
      add(orgId, getCustomSkillStorageName(workflow.workflowId));
    } else {
      const accepted = official?.catalog.payload.definitions.find(
        (definition) => {
          return definition.name === workflow.officialDefinitionName;
        },
      );
      if (accepted) {
        add(
          SYSTEM_ORG_ID,
          accepted.artifact.storageName,
          accepted.artifact.storageVersion,
        );
      }
    }
  }
  for (const selected of connectors.customConnectors) {
    if (selected.skillStorageVersionId !== null) {
      add(
        orgId,
        getCustomConnectorSkillStorageName(selected.customConnectorId),
        selected.skillStorageVersionId,
      );
    }
  }
  if (catalog) {
    for (const slug of connectors.builtinConnectorSlugs) {
      const connector = getConnectorRuntimeConnector(catalog, slug);
      if (connector?.skill.kind === "bundled") {
        add(
          SYSTEM_ORG_ID,
          connector.skill.storageName,
          connector.skill.versionId,
        );
      }
    }
  }
  return [
    ...new Map(
      requests.map((request) => {
        return [storageRequestKey(request), request];
      }),
    ).values(),
  ];
}

export function agentStorageReadPlan(
  owner: { readonly orgId: string; readonly userId: string },
  facts: readonly [
    BootstrapAgent | null,
    readonly SelectedAgentWorkflow[],
    AgentConnectorSelection,
    ConnectorRuntimeLookup | null,
    OfficialWorkflowContextFacts,
  ],
) {
  const [agent, workflows, connectors, catalog, official] = facts;
  const requests = agentStorageRequests(
    { ...owner, agent },
    workflows,
    connectors,
    catalog,
    official,
  );
  const published = official?.storageIndex ?? new Map();
  const ownedRequests = requests.filter((request) => {
    return !published.has(
      storageIndexKey(
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
      ),
    );
  });
  return { requests, published, ownedRequests };
}

export function captureAgentStorageContext(
  plan: ReturnType<typeof agentStorageReadPlan>,
  index: StorageIndex,
): AgentStorageContext {
  return {
    requests: plan.requests,
    lookupKeys: new Set(
      plan.requests.map((request) => {
        return storageIndexKey(
          request.lookup.orgId,
          request.lookup.userId,
          request.lookup.name,
        );
      }),
    ),
    index: mergeStorageIndexes(index, plan.published),
  };
}

export function agentStorageCacheSnapshot(context: AgentStorageContext) {
  const { mounts, versions } = agentStorageCacheMounts(context);
  const { pairs } = executionStorageCachePairs(mounts, versions);
  return {
    keys: new Set(
      pairs.map((pair) => {
        return JSON.stringify([pair.scope, pair.cacheKey]);
      }),
    ),
    rows: [...context.index.values()].flatMap((entry) => {
      return entry.cachedUrls ?? [];
    }),
  };
}
