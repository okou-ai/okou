import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { count, eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * A deleted user cannot authenticate to inspect their own resources. This
 * fixture checks physical erasure of otherwise-invisible encrypted state.
 */
export async function countUserSshAccessResourcesFixture(userId: string) {
  const [configs, hosts, credentials] = await Promise.all([
    db()
      .select({ count: count() })
      .from(cloudflareAccessConfigs)
      .where(eq(cloudflareAccessConfigs.userId, userId)),
    db()
      .select({ count: count() })
      .from(sshConnections)
      .where(eq(sshConnections.userId, userId)),
    db()
      .select({ count: count() })
      .from(sshCredentials)
      .where(eq(sshCredentials.userId, userId)),
  ]);
  const configCount = configs[0]?.count;
  const hostCount = hosts[0]?.count;
  const credentialCount = credentials[0]?.count;
  if (
    configCount === undefined ||
    hostCount === undefined ||
    credentialCount === undefined
  ) {
    throw new Error("SSH/Access lifecycle count query returned no row");
  }
  return {
    configs: configCount,
    hosts: hostCount,
    credentials: credentialCount,
  };
}
