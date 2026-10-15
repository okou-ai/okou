import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { command } from "ccstate";
import { and, count, eq, gte } from "drizzle-orm";

import { writeDb$ } from "../external/db";

type SshCleanupScope = {
  readonly kind: "owner";
  readonly orgId: string;
  readonly userId: string;
};

/** VNC dependencies must be erased before SSH. Dependent DELETE CTEs preserve
 * Host -> credential ordering and RESTRICT atomicity. */
export const eraseSshOwnerData$ = command(
  async (
    { set },
    scope: SshCleanupScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const removedHosts = db.$with("removed_clerk_ssh_hosts").as(
      db
        .delete(sshConnections)
        .where(
          and(
            eq(sshConnections.orgId, scope.orgId),
            eq(sshConnections.userId, scope.userId),
          ),
        )
        .returning({ id: sshConnections.id }),
    );
    const removedCredentials = db.$with("removed_clerk_ssh_credentials").as(
      db
        .delete(sshCredentials)
        .where(
          and(
            eq(sshCredentials.orgId, scope.orgId),
            eq(sshCredentials.userId, scope.userId),
            // Consume all removed hosts before checking their credential FK.
            // Zero hosts must still allow deleting unused owner credentials.
            gte(db.select({ count: count() }).from(removedHosts), 0),
          ),
        )
        .returning({ id: sshCredentials.id }),
    );
    // Membership cleanup erases SSH logins, retaining the independent
    // personal and organization network-configuration lifecycle.
    await db
      .with(removedHosts, removedCredentials)
      .select({ count: count() })
      .from(removedCredentials);
    signal.throwIfAborted();
  },
);
