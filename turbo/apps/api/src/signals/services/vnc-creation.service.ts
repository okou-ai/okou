import { createHash } from "node:crypto";

import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCreationReceipts } from "@okouai/db/schema/vnc-creation-receipt";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { ReadonlyDb } from "../external/db";
import {
  vncFailure,
  type VncResult,
  type VncTransaction,
} from "./vnc-configuration.utils";
import type { VncOwner } from "./vnc-owner-lifecycle.service";

function creationOwnerKey(owner: VncOwner): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "vnc-creation-owner-v1",
        owner.orgId,
        owner.userId,
        owner.membershipId,
      ]),
    )
    .digest("hex");
}

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

// Receipts outlive business-row deletion: a delayed create must never recreate
// a deleted resource. Read-only replay also requires no KMS. New writes repeat
// this check under the creation lock above.
export async function inspectVncCreationId(
  db: Pick<ReadonlyDb, "select">,
  owner: VncOwner,
  table: typeof vncConnections | typeof vncCredentials,
  id: string,
): Promise<VncResult<boolean>> {
  const [existing] = await db
    .select({ ownerKey: vncCreationReceipts.ownerKey })
    .from(vncCreationReceipts)
    .where(
      and(
        eq(vncCreationReceipts.resourceKind, getTableName(table)),
        eq(vncCreationReceipts.resourceId, id),
      ),
    );
  if (existing && existing.ownerKey !== creationOwnerKey(owner)) {
    return vncFailure("resourceIdConflict");
  }
  return { ok: true, value: existing === undefined };
}

// Register only after successful insertion, in that same transaction. This
// includes inline credentials, whose generated IDs can later appear in a POST.
export async function recordVncCreationReceipt(
  tx: VncTransaction,
  owner: VncOwner,
  table: typeof vncConnections | typeof vncCredentials,
  id: string,
): Promise<void> {
  await tx.insert(vncCreationReceipts).values({
    resourceKind: getTableName(table),
    resourceId: id,
    ownerKey: creationOwnerKey(owner),
  });
}
