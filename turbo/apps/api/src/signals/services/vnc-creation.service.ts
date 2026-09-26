import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { eq, getTableName } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import type { ReadonlyDb } from "../external/db";
import { vncFailure, type VncResult } from "./vnc-configuration.utils";
import type { VncOwner } from "./vnc-owner-lifecycle.service";

// A live resource makes creation a no-op without requiring KMS. Once deleted,
// its ID can be created again. The primary key arbitrates racing inserts.
export async function inspectVncCreationId(
  db: Pick<ReadonlyDb, "select">,
  owner: VncOwner,
  table: typeof vncConnections | typeof vncCredentials,
  id: string,
): Promise<VncResult<boolean>> {
  const [existing] = await db
    .select({
      orgId: table.orgId,
      userId: table.userId,
    })
    .from(table)
    .where(eq(table.id, id));
  if (
    existing &&
    (existing.orgId !== owner.orgId || existing.userId !== owner.userId)
  ) {
    return vncFailure("resourceIdConflict");
  }
  return { ok: true, value: existing === undefined };
}

// The failed transaction has already rolled back any inline credential insert.
export async function resolveVncCreationConflict(
  db: Pick<ReadonlyDb, "select">,
  owner: VncOwner,
  table: typeof vncConnections | typeof vncCredentials,
  id: string,
  error: unknown,
): Promise<VncResult<undefined>> {
  if (!isUniqueViolation(error, `${getTableName(table)}_pkey`)) {
    throw error;
  }
  const creation = await inspectVncCreationId(db, owner, table, id);
  return creation.ok && !creation.value
    ? { ok: true, value: undefined }
    : vncFailure("resourceIdConflict");
}
