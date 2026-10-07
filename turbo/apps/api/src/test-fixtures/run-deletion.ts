import { blobs } from "@okouai/db/schema/blob";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/** Infrastructure-only observation: no production endpoint exposes the ledger. */
export async function readHistoryBlobReferenceCountFixture(
  hash: string,
): Promise<number | null> {
  const [row] = await db()
    .select({ count: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, hash));
  return row?.count ?? null;
}
