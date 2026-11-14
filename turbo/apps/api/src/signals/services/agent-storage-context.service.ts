import {
  storageIndexKey,
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";

export interface MemberMemoryContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

/** Keep the legacy index representation at Memory's persistence boundary. */
export function captureMemberMemoryContext(
  requests: readonly StorageRequest[],
  index: StorageIndex,
): MemberMemoryContext {
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
