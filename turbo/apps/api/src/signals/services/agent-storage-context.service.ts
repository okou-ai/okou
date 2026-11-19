import { computed } from "ccstate";
import { db$ } from "../external/db";
import { memberMemoryReadPlan, type MemberMemoryOwner } from "./member-memory";
import {
  storageBaseIndexFromRows,
  storageBaseIndexReadPlan,
  storageIndexKey,
  type StorageRequest,
  type StorageIndex,
} from "./storage-index.service";

export interface MemberMemoryContext {
  readonly requests: readonly StorageRequest[];
  readonly lookupKeys: ReadonlySet<string>;
  readonly index: StorageIndex;
}

export function createMemberMemoryContext(owner: MemberMemoryOwner) {
  const requests = memberMemoryReadPlan(owner);
  return computed(async (get): Promise<MemberMemoryContext> => {
    const readPlan = storageBaseIndexReadPlan(requests);
    if (readPlan === null) {
      throw new Error("Member Memory lookup requires an index request");
    }
    const rows = await get(db$)
      .select(readPlan.columns)
      .from(readPlan.from)
      .innerJoin(readPlan.requested, readPlan.requestedCondition)
      .leftJoin(readPlan.head, readPlan.headCondition)
      .leftJoin(readPlan.exact, readPlan.exactCondition)
      .leftJoin(readPlan.cache, readPlan.cacheCondition);
    return captureMemberMemoryContext(requests, storageBaseIndexFromRows(rows));
  });
}

/** Keep the legacy index representation at Memory's persistence boundary. */
function captureMemberMemoryContext(
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
