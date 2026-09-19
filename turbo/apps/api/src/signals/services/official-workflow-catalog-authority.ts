import { AsyncLocalStorage } from "node:async_hooks";

import { getOfficialWorkflowDefinitionStorageName } from "@okouai/core/storage-names";
import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";

const OFFICIAL_WORKFLOW_CATALOG_AUTHORITY = "official" as const;

const TEST_AUTHORITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const scopedOfficialWorkflowCatalogAuthority = singleton(() => {
  return new AsyncLocalStorage<string>();
});

type OfficialWorkflowCatalogLockDb = Pick<Db, "execute">;

export function officialWorkflowCatalogTestAuthority(testId: string): string {
  if (!TEST_AUTHORITY_ID_PATTERN.test(testId)) {
    throw new Error("Official Workflow catalog test authority is invalid");
  }
  return `test:${testId}`;
}

export async function withOfficialWorkflowCatalogAuthorityForTest<T>(
  testId: string,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedOfficialWorkflowCatalogAuthority().run(
    officialWorkflowCatalogTestAuthority(testId),
    work,
  );
}

export function currentOfficialWorkflowCatalogAuthority(): string {
  return (
    scopedOfficialWorkflowCatalogAuthority.peek()?.getStore() ??
    OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
  );
}

export function officialWorkflowCatalogIsTestScoped(): boolean {
  return (
    currentOfficialWorkflowCatalogAuthority() !==
    OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
  );
}

export function currentOfficialWorkflowCatalogStoragePrefix(): string {
  const authority = currentOfficialWorkflowCatalogAuthority();
  return authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
    ? "official-workflow@"
    : `official-workflow@${authority}@`;
}

export function currentOfficialWorkflowDefinitionStorageName(
  definitionName: string,
): string {
  const authority = currentOfficialWorkflowCatalogAuthority();
  return authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
    ? getOfficialWorkflowDefinitionStorageName(definitionName)
    : `${currentOfficialWorkflowCatalogStoragePrefix()}${definitionName}`;
}

export function officialWorkflowCatalogDefinitionKey(
  authority: string,
  definitionName: string,
): string {
  return authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
    ? definitionName
    : `${authority}@${definitionName}`;
}

export function currentOfficialWorkflowCatalogDefinitionKey(
  definitionName: string,
): string {
  return officialWorkflowCatalogDefinitionKey(
    currentOfficialWorkflowCatalogAuthority(),
    definitionName,
  );
}

export function officialWorkflowCatalogDefinitionName(
  authority: string,
  definitionKey: string,
): string {
  if (authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY) {
    return definitionKey;
  }
  const prefix = `${authority}@`;
  const definitionName = definitionKey.startsWith(prefix)
    ? definitionKey.slice(prefix.length)
    : "";
  if (definitionName.length === 0 || definitionName.length > 64) {
    throw new Error("Official Workflow catalog definition key is invalid");
  }
  return definitionName;
}

export function officialWorkflowCatalogReleaseKey(
  authority: string,
  releaseId: string,
): string {
  return authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
    ? releaseId
    : `${authority}@${releaseId}`;
}

export function currentOfficialWorkflowCatalogReleaseKey(
  releaseId: string,
): string {
  return officialWorkflowCatalogReleaseKey(
    currentOfficialWorkflowCatalogAuthority(),
    releaseId,
  );
}

export function officialWorkflowCatalogReleaseId(
  authority: string,
  releaseKey: string,
): string {
  const releaseId =
    authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
      ? releaseKey
      : releaseKey.startsWith(`${authority}@`)
        ? releaseKey.slice(authority.length + 1)
        : "";
  if (!/^[0-9a-f]{64}$/.test(releaseId)) {
    throw new Error("Official Workflow catalog release key is invalid");
  }
  return releaseId;
}

export function currentOfficialWorkflowCatalogActivationLock(): string {
  const authority = currentOfficialWorkflowCatalogAuthority();
  return authority === OFFICIAL_WORKFLOW_CATALOG_AUTHORITY
    ? OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK
    : `${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}:${authority}`;
}

export async function lockOfficialWorkflowCatalogActivation(
  db: OfficialWorkflowCatalogLockDb,
  mode: "shared" | "exclusive" = "exclusive",
): Promise<void> {
  const key = currentOfficialWorkflowCatalogActivationLock();
  await db.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`
      : sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`,
  );
}
