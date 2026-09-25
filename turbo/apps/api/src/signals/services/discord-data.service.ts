import { command, computed, type Computed } from "ccstate";
import { and, eq, or, type SQL } from "drizzle-orm";
import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { agents } from "@okouai/db/schema/agent";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserAgentPreferences } from "@okouai/db/schema/discord-user-agent-preference";
import { discordUserDmPreferences } from "@okouai/db/schema/discord-user-dm-preference";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import type { ApiOrgRole } from "../../types/auth";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { nowDate } from "../../lib/time";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { publishDiscordChanged } from "./discord-realtime.service";
import {
  discordIntegrationEnabledForOwner,
  discordIntegrationEnabledForOwnerInDb,
  getDiscordAppConfig,
  type DiscordAppConfig,
} from "./discord-config";

export interface DiscordVerifiedBinding {
  readonly connectionId: string;
  readonly guildId: string;
  readonly guildName: string | null;
  readonly discordUserId: string;
  readonly botUserId: string;
  readonly orgId: string;
  readonly userId: string;
}

const bindingColumns = Object.freeze({
  connectionId: discordOrgConnections.id,
  guildId: discordOrgInstallations.guildId,
  guildName: discordOrgInstallations.guildName,
  discordUserId: discordOrgConnections.discordUserId,
  botUserId: discordOrgInstallations.botUserId,
  orgId: discordOrgInstallations.orgId,
  userId: discordOrgConnections.userId,
});

function bindingRows(where: SQL) {
  return computed(async (get) => {
    return await get(db$)
      .select(bindingColumns)
      .from(discordOrgConnections)
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(where);
  });
}

/** Always ask the identity authority; a cached role cannot revive a binding. */
function discordMembership(binding: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return computed(async (get) => {
    const result = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: binding.orgId,
        userId: [binding.userId],
        limit: 1,
      }),
    );
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return null;
      }
      throw result.error;
    }
    return (
      result.value.data.find((member) => {
        return member.publicUserData?.userId === binding.userId;
      }) ?? null
    );
  });
}

export function discordMemberRole(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ApiOrgRole | null>> {
  return computed(async (get) => {
    const member = await get(discordMembership(args));
    return member ? (member.role === "org:admin" ? "admin" : "member") : null;
  });
}

function verifiedBindings(
  where: SQL,
): Computed<Promise<DiscordVerifiedBinding[]>> {
  return computed(async (get) => {
    if (!getDiscordAppConfig()) {
      return [];
    }
    const rows = await get(bindingRows(where));
    const result: DiscordVerifiedBinding[] = [];
    for (const row of rows) {
      if (
        (await get(discordIntegrationEnabledForOwner(row.orgId, row.userId))) &&
        (await get(discordMembership(row)))
      ) {
        result.push(row);
      }
    }
    return result;
  });
}

export function discordUserBinding(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<DiscordVerifiedBinding | null>> {
  return computed(async (get) => {
    const [row] = await get(
      bindingRows(
        and(
          eq(discordOrgInstallations.orgId, args.orgId),
          eq(discordOrgConnections.userId, args.userId),
        )!,
      ),
    );
    if (!row) {
      return null;
    }
    const binding = await get(discordGuildUserBinding(row));
    return binding?.userId === args.userId && binding.orgId === args.orgId
      ? binding
      : null;
  });
}

/** A cheap pre-filter before the per-sender identity checks below. */
export function discordGuildBotUserId(
  guildId: string,
): Computed<Promise<string | null>> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({ botUserId: discordOrgInstallations.botUserId })
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.guildId, guildId))
      .limit(1);
    return row?.botUserId ?? null;
  });
}

export function discordGuildUserBinding(args: {
  readonly guildId: string;
  readonly discordUserId: string;
}): Computed<Promise<DiscordVerifiedBinding | null>> {
  return computed(async (get) => {
    const rows = await get(
      verifiedBindings(
        and(
          eq(discordOrgConnections.guildId, args.guildId),
          eq(discordOrgConnections.discordUserId, args.discordUserId),
        )!,
      ),
    );
    return rows[0] ?? null;
  });
}

export function discordSenderBindings(discordUserId: string) {
  return verifiedBindings(
    eq(discordOrgConnections.discordUserId, discordUserId),
  );
}

/** Ingress treats missing app configuration as an outage, never as revocation. */
export function discordIngressSenderBindings(discordUserId: string) {
  return computed(async (get) => {
    if (!getDiscordAppConfig()) {
      throw new DiscordIngressFailure(
        "discord:config_unavailable",
        true,
        0,
        "Discord is temporarily unavailable",
      );
    }
    return await get(discordSenderBindings(discordUserId));
  });
}

export type DiscordDmBindingResult =
  | { readonly kind: "connected"; readonly binding: DiscordVerifiedBinding }
  | { readonly kind: "not-connected" }
  | {
      readonly kind: "selection-required";
      readonly bindings: readonly DiscordVerifiedBinding[];
    };

export function discordDmBinding(
  discordUserId: string,
): Computed<Promise<DiscordDmBindingResult>> {
  return computed(async (get): Promise<DiscordDmBindingResult> => {
    const bindings = await get(discordSenderBindings(discordUserId));
    if (bindings.length === 0) {
      return { kind: "not-connected" };
    }
    const [choice] = await get(db$)
      .select()
      .from(discordUserDmPreferences)
      .where(eq(discordUserDmPreferences.discordUserId, discordUserId));
    const selected = bindings.find((binding) => {
      return binding.connectionId === choice?.connectionId;
    });
    if (selected) {
      return { kind: "connected", binding: selected };
    }
    if (bindings.length === 1) {
      return { kind: "connected", binding: bindings[0]! };
    }
    return { kind: "selection-required", bindings };
  });
}

function savedDiscordDmBinding(discordUserId: string) {
  return computed(async (get) => {
    const resolution = await get(discordDmBinding(discordUserId));
    if (resolution.kind !== "connected") {
      return null;
    }
    const [choice] = await get(db$)
      .select({ connectionId: discordUserDmPreferences.connectionId })
      .from(discordUserDmPreferences)
      .where(eq(discordUserDmPreferences.discordUserId, discordUserId));
    return choice?.connectionId === resolution.binding.connectionId
      ? resolution.binding
      : null;
  });
}

async function selectDiscordDmBinding(
  db: Db,
  binding: DiscordVerifiedBinding,
  discordUserId: string,
  userIds: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    // Match guild uninstall's installation -> connection lock order.
    const [installation] = await tx
      .select({ guildId: discordOrgInstallations.guildId })
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.guildId, binding.guildId))
      .for("share");
    signal.throwIfAborted();
    if (!installation) {
      return false;
    }
    const [current] = await tx
      .select(bindingColumns)
      .from(discordOrgConnections)
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(
        and(
          eq(discordOrgConnections.id, binding.connectionId),
          eq(discordOrgConnections.discordUserId, discordUserId),
          eq(discordOrgConnections.userId, binding.userId),
          eq(discordOrgInstallations.orgId, binding.orgId),
        ),
      )
      .for("share");
    signal.throwIfAborted();
    if (!current) {
      return false;
    }
    const enabled = await discordIntegrationEnabledForOwnerInDb(
      tx,
      binding.orgId,
      binding.userId,
    );
    signal.throwIfAborted();
    if (!enabled) {
      return false;
    }
    await tx
      .insert(discordUserDmPreferences)
      .values({
        discordUserId: discordUserId,
        connectionId: binding.connectionId,
        userId: binding.userId,
        createdAt: nowDate(),
        updatedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: discordUserDmPreferences.discordUserId,
        set: {
          connectionId: binding.connectionId,
          userId: binding.userId,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();
    return true;
  });
  if (result) {
    await publishDiscordChanged(userIds);
  }
  signal.throwIfAborted();
  return result;
}

export const selectDiscordDmBinding$ = command(
  async (
    { get, set },
    args: {
      readonly discordUserId: string;
      readonly connectionId: string;
      readonly userId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const bindings = await get(discordSenderBindings(args.discordUserId));
    signal.throwIfAborted();
    const binding = bindings.find((candidate) => {
      return (
        candidate.connectionId === args.connectionId &&
        (args.userId === undefined || candidate.userId === args.userId)
      );
    });
    if (!binding) {
      return false;
    }
    return await selectDiscordDmBinding(
      set(writeDb$),
      binding,
      args.discordUserId,
      bindings.map((candidate) => {
        return candidate.userId;
      }),
      signal,
    );
  },
);

async function deleteDiscordBinding(
  db: Db,
  args: {
    readonly connectionId: string;
    readonly discordUserId: string;
    readonly orgId?: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    signal.throwIfAborted();
    const removed = await tx
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.id, args.connectionId),
          eq(discordOrgConnections.discordUserId, args.discordUserId),
          args.orgId
            ? eq(
                discordOrgConnections.guildId,
                tx
                  .select({ guildId: discordOrgInstallations.guildId })
                  .from(discordOrgInstallations)
                  .where(eq(discordOrgInstallations.orgId, args.orgId)),
              )
            : undefined,
        ),
      )
      .returning({ userId: discordOrgConnections.userId });
    signal.throwIfAborted();
    return removed;
  });
  await publishDiscordChanged(
    rows.map((row) => {
      return row.userId;
    }),
  );
  signal.throwIfAborted();
  return rows.length > 0;
}

export const disconnectDiscordBinding$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly discordUserId: string;
      readonly orgId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await deleteDiscordBinding(set(writeDb$), args, signal);
  },
);

export function discordEffectiveAgent(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return computed(async (get) => {
    const db = get(db$);
    const [preference] = await db
      .select()
      .from(discordUserAgentPreferences)
      .where(
        and(
          eq(discordUserAgentPreferences.orgId, args.orgId),
          eq(discordUserAgentPreferences.userId, args.userId),
        ),
      );
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId));
    const agentId = preference?.selectedAgentId ?? metadata?.defaultAgentId;
    if (!agentId) {
      return null;
    }
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
      })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.orgId, args.orgId),
          or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
        ),
      );
    return agent ?? null;
  });
}

async function updateDiscordAgentPreference(
  db: Db,
  binding: DiscordVerifiedBinding,
  agentId: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(discordOrgConnections)
      .where(eq(discordOrgConnections.id, binding.connectionId))
      .for("share");
    signal.throwIfAborted();
    if (!connection) {
      return false;
    }
    const enabled = await discordIntegrationEnabledForOwnerInDb(
      tx,
      binding.orgId,
      binding.userId,
    );
    signal.throwIfAborted();
    if (!enabled) {
      return false;
    }
    if (agentId) {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.orgId, binding.orgId),
            or(
              eq(agents.visibility, "public"),
              eq(agents.owner, binding.userId),
            ),
          ),
        );
      signal.throwIfAborted();
      if (!agent) {
        return false;
      }
    }
    await tx
      .insert(discordUserAgentPreferences)
      .values({
        userId: binding.userId,
        orgId: binding.orgId,
        connectionId: binding.connectionId,
        selectedAgentId: agentId,
        createdAt: nowDate(),
        updatedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: [
          discordUserAgentPreferences.userId,
          discordUserAgentPreferences.orgId,
        ],
        set: {
          connectionId: binding.connectionId,
          selectedAgentId: agentId,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();
    return true;
  });
  if (result) {
    await publishDiscordChanged([binding.userId]);
  }
  signal.throwIfAborted();
  return result;
}

export const setDiscordAgentPreference$ = command(
  async (
    { get, set },
    args: {
      readonly connectionId: string;
      readonly discordUserId: string;
      readonly agentId: string | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const bindings = await get(discordSenderBindings(args.discordUserId));
    signal.throwIfAborted();
    const binding = bindings.find((candidate) => {
      return candidate.connectionId === args.connectionId;
    });
    if (!binding) {
      return false;
    }
    return await updateDiscordAgentPreference(
      set(writeDb$),
      binding,
      args.agentId,
      signal,
    );
  },
);

function discordContextMode(
  config: DiscordAppConfig | null,
): DiscordOrgStatus["contextMode"] {
  if (!config) {
    return "unavailable";
  }
  return config.messageContentEnabled ? "full" : "mentions_only";
}

export function discordOrgStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
}): Computed<Promise<DiscordOrgStatus>> {
  return computed(async (get): Promise<DiscordOrgStatus> => {
    const enabled = await get(
      discordIntegrationEnabledForOwner(args.orgId, args.userId),
    );
    const config = getDiscordAppConfig();
    const status: DiscordOrgStatus = {
      isAvailable: enabled && config !== null,
      isInstalled: false,
      isConnected: false,
      isAdmin: args.orgRole === "admin",
      guildId: null,
      guildName: null,
      discordUserId: null,
      defaultAgentId: null,
      defaultAgentName: null,
      contextMode: discordContextMode(enabled ? config : null),
      onboarding: "oauth_deferred",
      dmSelectionConnectionId: null,
      dmBindings: [],
    };
    if (!enabled) {
      return status;
    }
    const role = await get(discordMemberRole(args));
    if (!role) {
      return {
        ...status,
        isAvailable: false,
        isAdmin: false,
        contextMode: "unavailable",
      };
    }
    const [installation] = await get(db$)
      .select()
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, args.orgId));
    if (!installation) {
      return { ...status, isAdmin: role === "admin" };
    }
    const [connection] = await get(
      bindingRows(
        and(
          eq(discordOrgConnections.guildId, installation.guildId),
          eq(discordOrgConnections.userId, args.userId),
        )!,
      ),
    );
    const agent = await get(discordEffectiveAgent(args));
    const bindings = connection
      ? (await get(discordSenderBindings(connection.discordUserId))).filter(
          (binding) => {
            return binding.userId === args.userId;
          },
        )
      : [];
    const choice = connection
      ? await get(savedDiscordDmBinding(connection.discordUserId))
      : null;
    return {
      ...status,
      isAdmin: role === "admin",
      isInstalled: true,
      isConnected: connection !== undefined,
      guildId: installation.guildId,
      guildName: installation.guildName,
      discordUserId: connection?.discordUserId ?? null,
      defaultAgentId: agent?.id ?? null,
      defaultAgentName: agent?.displayName ?? agent?.name ?? null,
      dmSelectionConnectionId:
        choice?.userId === args.userId ? choice.connectionId : null,
      dmBindings: bindings.map(({ connectionId, guildId, guildName }) => {
        return {
          connectionId,
          guildId,
          guildName,
        };
      }),
    };
  });
}
