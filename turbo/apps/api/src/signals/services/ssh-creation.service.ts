import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { eq, getTableName, sql } from "drizzle-orm";
import type { Db } from "../external/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Call after the owner lock and before any inline inserts. The ID lock also
// serializes requests from different owners, whose owner locks cannot do so.
export async function checkSshCreationId(
  tx: Transaction,
  owner: { readonly orgId: string; readonly userId: string },
  table:
    | typeof sshConnections
    | typeof sshCredentials
    | typeof cloudflareAccessConfigs,
  id: string,
) {
  await tx.execute(
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
    return {
      ok: false as const,
      kind: "conflict" as const,
      code: SSH_ERROR_CODES.RESOURCE_ID_CONFLICT,
      message: "This resource ID cannot be used for this SSH configuration.",
    };
  }
  return { ok: true as const, value: existing === undefined };
}
