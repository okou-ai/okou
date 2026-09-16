import { sql } from "drizzle-orm";
import type { Db } from "../external/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function lockSshOwner(
  tx: Pick<Transaction, "execute">,
  owner: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ssh_connection_owner:${owner.orgId}:${owner.userId}`}, 0))`,
  );
}
