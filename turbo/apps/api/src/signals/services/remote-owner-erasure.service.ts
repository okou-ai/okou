import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { orgCustomConnectorCloudflareBindings } from "@okouai/db/schema/org-custom-connector-cloudflare-binding";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, eq, exists } from "drizzle-orm";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

type RemoteErasureScope =
  | { readonly kind: "owner"; readonly orgId: string; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

/** Commit dependency removal before deleting its parents; no remote work or replay. */
export const eraseRemoteOwnerData$ = command(
  async (
    { set },
    scope: RemoteErasureScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (scope.kind === "organization") {
      // Consume only disabled parent IDs. A concurrent new edge not visible in
      // this snapshot remains protected by its restrictive configuration FK.
      const disabled = db
        .$with("disabled_erased_custom_connectors")
        .as(
          db
            .update(orgCustomConnectors)
            .set({ enabled: false })
            .where(eq(orgCustomConnectors.orgId, scope.orgId))
            .returning({ id: orgCustomConnectors.id }),
        );
      await db
        .with(disabled)
        .delete(orgCustomConnectorCloudflareBindings)
        .where(
          and(
            eq(orgCustomConnectorCloudflareBindings.orgId, scope.orgId),
            exists(
              db
                .select({ id: disabled.id })
                .from(disabled)
                .where(
                  eq(
                    disabled.id,
                    orgCustomConnectorCloudflareBindings.connectorId,
                  ),
                ),
            ),
          ),
        );
      signal.throwIfAborted();
    }
    await db
      .delete(vncConnections)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(vncConnections.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : eq(vncConnections.userId, scope.userId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(vncCredentials)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(vncCredentials.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : eq(vncCredentials.userId, scope.userId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(sshConnections)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(sshConnections.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : eq(sshConnections.userId, scope.userId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(sshCredentials)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(sshCredentials.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : eq(sshCredentials.userId, scope.userId),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(cloudflareAccessConfigs)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(cloudflareAccessConfigs.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : and(
                eq(cloudflareAccessConfigs.scope, "personal"),
                eq(cloudflareAccessConfigs.userId, scope.userId),
              ),
        ),
      );
    signal.throwIfAborted();
    await db
      .delete(tailscaleConfigs)
      .where(
        and(
          scope.kind === "user"
            ? undefined
            : eq(tailscaleConfigs.orgId, scope.orgId),
          scope.kind === "organization"
            ? undefined
            : and(
                eq(tailscaleConfigs.scope, "personal"),
                eq(tailscaleConfigs.userId, scope.userId),
              ),
        ),
      );
    signal.throwIfAborted();
  },
);
