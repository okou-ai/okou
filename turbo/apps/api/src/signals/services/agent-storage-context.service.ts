import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import {
  SYSTEM_ORG_ID,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
  getSkillStorageName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import {
  getConnectorRuntimeConnector,
  type ConnectorRuntimeSelection,
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
import type { BootstrapAgent } from "./agent-data.service";

export interface AgentStorageContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

/** Database identities only: framework-specific mount paths are assembled later. */
function agentStorageRequests(
  owner: {
    readonly orgId: string;
    readonly userId: string;
  },
  workflows: readonly SelectedAgentWorkflow[],
  connectors: AgentConnectorSelection,
  catalog: ConnectorRuntimeSelection | null,
  official: OfficialWorkflowContextFacts,
): readonly StorageRequest[] {
  const { orgId, userId } = owner;
  // Every Run selects the current user memory root, independently of native
  // session continuation and framework.
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
    if (workflow.officialDefinitionName !== null) {
      const accepted = official?.catalog.payload.definitions.find(
        (definition) => {
          return definition.name === workflow.officialDefinitionName;
        },
      );
      if (accepted?.artifact) {
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
    ConnectorRuntimeSelection | null,
    OfficialWorkflowContextFacts,
  ],
) {
  const [, workflows, connectors, catalog, official] = facts;
  const requests = agentStorageRequests(
    owner,
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
