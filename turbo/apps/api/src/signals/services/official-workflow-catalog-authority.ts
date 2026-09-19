import { AsyncLocalStorage } from "node:async_hooks";

import { getOfficialWorkflowDefinitionStorageName } from "@okouai/core/storage-names";
import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";

export const OFFICIAL_WORKFLOW_CATALOG_AUTHORITY = "official" as const;

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
