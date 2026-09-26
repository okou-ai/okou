import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { eq, getTableName, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import type { Db, ReadonlyDb } from "../external/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Owner = { readonly orgId: string; readonly userId: string | null };
type CreationTable =
  | typeof sshConnections
  | typeof sshCredentials
  | typeof cloudflareAccessConfigs;

function resourceIdConflict() {
  return {
    ok: false as const,
    kind: "conflict" as const,
    code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message: "This resource ID cannot be used for this SSH configuration.",
  };
}

// Call after the owner lock and before any inline inserts. The ID lock also
// serializes requests from different owners, whose owner locks cannot do so.
// Retain it until every serving writer can recover a primary-key conflict;
// the following release can remove it. See docs/deployment-compatibility.md.
export async function checkSshCreationId(
  tx: Transaction,
  owner: Owner,
  table: CreationTable,
  id: string,
) {
  await tx.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ssh_creation:${getTableName(table)}:${id.toLowerCase()}`}, 0))`,
  );
  const [existing] = await tx
    .select({ orgId: table.orgId, userId: table.userId })
    .from(table)
    .where(eq(table.id, id));
  if (
    existing &&
    (existing.orgId !== owner.orgId || existing.userId !== owner.userId)
  ) {
    return resourceIdConflict();
  }
  return { ok: true as const, value: existing === undefined };
}

// Handle only the requested resource's primary key, after its whole transaction
// has rolled back. Inline credentials and Access configs must roll back with it.
export async function resolveSshCreationConflict(
  db: Pick<ReadonlyDb, "select">,
  owner: Owner,
  table: CreationTable,
  id: string,
  error: unknown,
) {
  if (!isUniqueViolation(error, `${getTableName(table)}_pkey`)) {
    throw error;
  }
  const [existing] = await db
    .select({ orgId: table.orgId, userId: table.userId })
    .from(table)
    .where(eq(table.id, id));
  if (
    existing &&
    existing.orgId === owner.orgId &&
    existing.userId === owner.userId
  ) {
    return { ok: true as const, value: undefined };
  }
  return resourceIdConflict();
}
