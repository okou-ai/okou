import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { command } from "ccstate";
import { and, count, eq, gte } from "drizzle-orm";

import { writeDb$ } from "../external/db";

type SshCleanupScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | {
      readonly kind: "owner";
      readonly orgId: string;
      readonly userId: string;
    };

/** VNC dependencies must be erased before SSH. Dependent DELETE CTEs preserve
 * Host -> credential -> configuration ordering and RESTRICT atomicity. */
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
          scope.kind === "organization"
            ? eq(sshConnections.orgId, scope.orgId)
            : scope.kind === "user"
              ? eq(sshConnections.userId, scope.userId)
              : and(
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
            scope.kind === "organization"
              ? eq(sshCredentials.orgId, scope.orgId)
              : scope.kind === "user"
                ? eq(sshCredentials.userId, scope.userId)
                : and(
                    eq(sshCredentials.orgId, scope.orgId),
                    eq(sshCredentials.userId, scope.userId),
                  ),
            // Consume all removed hosts before checking their credential FK.
            // Zero hosts must still allow deleting unused owner credentials.
            gte(db.select({ count: count() }).from(removedHosts), 0),
          ),
        )
        .returning({ id: sshCredentials.id }),
    );
    if (scope.kind === "owner") {
      // Membership cleanup erases SSH logins, retaining the independent
      // personal and organization network-configuration lifecycle.
      await db
        .with(removedHosts, removedCredentials)
        .select({ count: count() })
        .from(removedCredentials);
      signal.throwIfAborted();
      return;
    }

    const removedAccess = db.$with("removed_clerk_access_configs").as(
      db
        .delete(cloudflareAccessConfigs)
        .where(
          and(
            scope.kind === "organization"
              ? eq(cloudflareAccessConfigs.orgId, scope.orgId)
              : and(
                  eq(cloudflareAccessConfigs.userId, scope.userId),
                  eq(cloudflareAccessConfigs.scope, "personal"),
                ),
            gte(db.select({ count: count() }).from(removedCredentials), 0),
          ),
        )
        .returning({ id: cloudflareAccessConfigs.id }),
    );
    const removedTailscale = db.$with("removed_clerk_tailscale_configs").as(
      db
        .delete(tailscaleConfigs)
        .where(
          and(
            scope.kind === "organization"
              ? eq(tailscaleConfigs.orgId, scope.orgId)
              : and(
                  eq(tailscaleConfigs.userId, scope.userId),
                  eq(tailscaleConfigs.scope, "personal"),
                ),
            gte(db.select({ count: count() }).from(removedAccess), 0),
          ),
        )
        .returning({ id: tailscaleConfigs.id }),
    );
    await db
      .with(removedHosts, removedCredentials, removedAccess, removedTailscale)
      .select({ count: count() })
      .from(removedTailscale);
    signal.throwIfAborted();
  },
);
