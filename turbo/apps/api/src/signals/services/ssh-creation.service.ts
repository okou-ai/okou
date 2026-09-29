import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { eq, getTableName } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import type { Db, ReadonlyDb } from "../external/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Owner = { readonly orgId: string; readonly userId: string | null };
type CreationTable =
  | typeof sshConnections
  | typeof sshCredentials
  | typeof cloudflareAccessConfigs;

export function resourceIdConflict() {
  return {
    ok: false as const,
    kind: "conflict" as const,
    code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message: "This resource ID cannot be used for this SSH configuration.",
  };
}

// Recognize an existing resource before preparing inline rows. Concurrent
// creations are arbitrated by its primary key and resolved after rollback.
export async function checkSshCreationId(
  tx: Transaction,
  owner: Owner,
  table: CreationTable,
  id: string,
) {
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

/** Shared interpretation only; callers own the reads and transaction. */
export function sshCreationResult(owner: Owner, existing: Owner | undefined) {
  if (
    existing &&
    (existing.orgId !== owner.orgId || existing.userId !== owner.userId)
  ) {
    return resourceIdConflict();
  }
  return { ok: true as const, value: existing === undefined };
}
