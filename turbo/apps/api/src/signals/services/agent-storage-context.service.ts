import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import {
  SYSTEM_ORG_ID,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
  getSkillStorageName,
  getCustomSkillStorageName,
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
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";
import type { ExecutionStorageRequest } from "./execution-storage.service";

export interface AgentStorageContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

export function agentStorageCacheMounts(context: AgentStorageContext) {
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
export function agentStorageRequests(
  owner: { readonly orgId: string; readonly userId: string },
  workflows: readonly SelectedAgentWorkflow[],
  connectors: AgentConnectorSelection,
  catalog: ConnectorRuntimeSelection | null,
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
