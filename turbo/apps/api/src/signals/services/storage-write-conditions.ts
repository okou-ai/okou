import { agentRuns } from "@okouai/db/runtime/agent-run";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { and, eq } from "drizzle-orm";
import type { SandboxAuth } from "../../types/auth";
export type StorageIdentity = Pick<
  typeof storages.$inferSelect,
  "id" | "orgId" | "userId" | "name"
>;
export function sandboxStorageRunCondition(auth: SandboxAuth) {
  return and(
    eq(agentRuns.id, auth.runId),
    eq(agentRuns.orgId, auth.orgId),
    eq(agentRuns.userId, auth.userId),
  );
}
export function storageIdentityCondition(identity: StorageIdentity) {
  return and(
    eq(storages.id, identity.id),
    eq(storages.orgId, identity.orgId),
    eq(storages.userId, identity.userId),
    eq(storages.name, identity.name),
  );
}
export function storageVersionCondition(storageId: string, versionId: string) {
  return and(
    eq(storageVersions.storageId, storageId),
    eq(storageVersions.id, versionId),
  );
}
export function storageCommitLineageCondition(
  storageId: string,
  versionId: string,
  parentVersionId: string,
  runId: string,
) {
  return and(
    eq(storageVersionLineage.storageId, storageId),
    eq(storageVersionLineage.versionId, versionId),
    eq(storageVersionLineage.parentVersionId, parentVersionId),
    eq(storageVersionLineage.runId, runId),
  );
}
