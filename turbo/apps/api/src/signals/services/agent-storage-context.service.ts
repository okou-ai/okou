import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import {
  storageIndexKey,
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";

export interface AgentStorageContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

/** Every Run selects the current user memory root independently of its Skills. */
export function agentStorageReadPlan(owner: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return [
    { lookup: { ...owner, name: MEMORY_ARTIFACT_NAME }, version: undefined },
  ];
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
