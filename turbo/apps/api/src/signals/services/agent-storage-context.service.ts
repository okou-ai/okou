import {
  SYSTEM_ORG_ID,
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import {
  getConnectorRuntimeConnector,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import type { AgentConnectorSelection } from "./execution-agent-connectors.service";
import {
  storageRequestKey,
  storageIndexKey,
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";

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
  connectors: AgentConnectorSelection,
  catalog: ConnectorRuntimeSelection | null,
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
  facts: readonly [AgentConnectorSelection, ConnectorRuntimeSelection | null],
) {
  const [connectors, catalog] = facts;
  const requests = agentStorageRequests(owner, connectors, catalog);
  return requests;
}

export function captureAgentStorageContext(
  requests: readonly StorageRequest[],
  index: StorageIndex,
): AgentStorageContext {
  return {
    requests,
    lookupKeys: new Set(
      requests.map((request) => {
        return storageIndexKey(
          request.lookup.orgId,
          request.lookup.userId,
          request.lookup.name,
        );
      }),
    ),
    index,
  };
}
