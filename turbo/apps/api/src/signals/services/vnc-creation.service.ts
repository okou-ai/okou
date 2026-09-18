import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { eq, getTableName, sql } from "drizzle-orm";
import type { ReadonlyDb } from "../external/db";
import {
  vncFailure,
  type VncResult,
  type VncTransaction,
} from "./vnc-configuration.utils";
import type { VncOwner } from "./vnc-owner-lifecycle.service";

// Owner admission precedes the globally scoped resource-ID lock. No inline
// credential may be inserted before the creation replay has been checked.
export async function checkVncCreationId(
  tx: VncTransaction,
  owner: VncOwner,
  table: typeof vncConnections | typeof vncCredentials,
  id: string,
): Promise<VncResult<boolean>> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vnc_creation:${getTableName(table)}:${id.toLowerCase()}`}, 0))`,
  );
  return inspectVncCreationId(tx, owner, table, id);
}

// A live resource makes creation a no-op without requiring KMS. Once deleted,
// its ID can be created again. New writes repeat this check under the lock above.
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
