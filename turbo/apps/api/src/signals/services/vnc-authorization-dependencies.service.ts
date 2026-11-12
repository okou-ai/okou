import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  isNotNull,
  not,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { visibleVncNativeRole } from "./vnc-network-authority";

const dependency = alias(sshConnections, "authorization_vnc_ssh");
const override = alias(
  chatThreadSshAccessOverrides,
  "authorization_vnc_ssh_override",
);
const dependencyMatch = and(
  eq(dependency.orgId, vncConnections.orgId),
  eq(dependency.userId, vncConnections.userId),
  or(
    and(
      eq(vncConnections.transportType, "ssh"),
      eq(dependency.id, vncConnections.sshConnectionId),
    ),
    and(
      eq(vncConnections.kdcTransportType, "ssh"),
      eq(dependency.id, vncConnections.kdcSshConnectionId),
    ),
  ),
);
const dependencyNeedsRebind = or(
  and(
    eq(dependency.connectionMode, "cloudflare_access"),
    isNull(dependency.cloudflareAccessId),
  ),
  and(
    inArray(dependency.connectionMode, ["tailscale", "tailscale_ssh"]),
    isNull(dependency.tailscaleId),
  ),
);

function detachedNativeRoute(
  type: SQLWrapper,
  accessId: SQLWrapper,
  tailscaleId: SQLWrapper,
) {
  return and(
    isNotNull(type),
    or(
      and(eq(type, "cloudflare_access"), isNull(accessId)),
      and(eq(type, "tailscale"), isNull(tailscaleId)),
    ),
  );
}

/** VNC approval never grants its SSH dependencies implicitly. */
export function vncAuthorizationConditions(threadId: SQLWrapper) {
  const q = new QueryBuilder();
  const needsRebind = sql`${or(
    detachedNativeRoute(
      vncConnections.transportType,
      vncConnections.cloudflareAccessId,
      vncConnections.tailscaleId,
    ),
    detachedNativeRoute(
      vncConnections.kdcTransportType,
      vncConnections.kdcCloudflareAccessId,
      vncConnections.kdcTailscaleId,
    ),
    exists(
      q
        .select({ id: dependency.id })
        .from(dependency)
        .where(and(dependencyMatch, dependencyNeedsRebind)),
    ),
  )}`;
  const dependenciesAllowed = not(
    exists(
      q
        .select({ id: dependency.id })
        .from(dependency)
        .leftJoin(
          override,
          and(
            eq(override.connectionId, dependency.id),
            eq(override.chatThreadId, threadId),
          ),
        )
        .where(
          and(
            dependencyMatch,
            not(
              sql`coalesce(${override.enabled}, ${dependency.defaultEnabledForChats})`,
            ),
          ),
        ),
    ),
  );
  return {
    available: sql`${and(
      not(needsRebind),
      visibleVncNativeRole("rfb"),
      visibleVncNativeRole("kdc"),
    )}`,
    dependenciesAllowed,
  };
}

export const readVncSshDependencies$ = command(
  async (
    { get },
    owner: { readonly orgId: string; readonly userId: string },
    connectionId: string,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const rows = await get(db$)
      .select({
        connectionId: dependency.id,
        displayName: dependency.displayName,
        enabled:
          sql`coalesce(${override.enabled}, ${dependency.defaultEnabledForChats})`.mapWith(
            pgBooleanDecoder,
          ),
      })
      .from(vncConnections)
      .innerJoin(dependency, dependencyMatch)
      .leftJoin(
        override,
        and(
          eq(override.connectionId, dependency.id),
          eq(override.chatThreadId, threadId),
        ),
      )
      .where(
        and(
          eq(vncConnections.id, connectionId),
          eq(vncConnections.orgId, owner.orgId),
          eq(vncConnections.userId, owner.userId),
        ),
      )
      .orderBy(dependency.id);
    signal.throwIfAborted();
    return rows;
  },
);
