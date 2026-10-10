import { command, computed, type Computed } from "ccstate";
import { and, count, eq, gte, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { agents } from "@okouai/db/schema/agent";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserDmPreferences } from "@okouai/db/schema/discord-user-dm-preference";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import type { ApiOrgRole } from "../../types/auth";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { nowDate } from "../../lib/time";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { publishDiscordChanged } from "./discord-realtime.service";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  discordIntegrationEnabledForOwner,
  discordIntegrationEnabledForOwner$,
  getDiscordAppConfig,
} from "./discord-config";

import { discordMessageContentCapability } from "./discord-application-capability.service";

import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";

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
  const where$ = computed(() => {
    return Promise.resolve(where);
  });
  return createVerifiedBindings(where$);
}

function createVerifiedBindings(
  where$: Computed<Promise<SQL | null>>,
): Computed<Promise<DiscordVerifiedBinding[]>> {
  return computed(async (get) => {
    const where = await get(where$);
    if (!where || !getDiscordAppConfig()) {
      return [];
    }
    const db = get(db$);
    const rows = await db
      .select(bindingColumns)
      .from(discordOrgConnections)
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(where);
    const result: DiscordVerifiedBinding[] = [];
    for (const row of rows) {
      const switches = await db
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(userFeatureSwitchRowCondition(row.orgId, row.userId));
      if (
        !isFeatureEnabled(
          FeatureSwitchKey.DiscordIntegration,
          featureSwitchContextFromRows(row.orgId, row.userId, switches),
        )
      ) {
        continue;
      }
      const membership = await settle(
        get(clerk$).organizations.getOrganizationMembershipList({
          organizationId: row.orgId,
          userId: [row.userId],
          limit: 1,
        }),
      );
      if (!membership.ok) {
        if (isClerkResourceNotFound(membership.error)) {
          continue;
        }
        throw membership.error;
      }
      if (
        membership.value.data.some((member) => {
          return member.publicUserData?.userId === row.userId;
        })
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
  const identity$ = computed(() => {
    return Promise.resolve(args);
  });
  return createDiscordUserBinding(identity$);
}

/** A binding read connected before the owning graph is evaluated. */
export function createDiscordUserBinding(
  identity$: Computed<
    Promise<{ readonly orgId: string; readonly userId: string } | null>
  >,
): Computed<Promise<DiscordVerifiedBinding | null>> {
  const guildUserWhere$ = computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const [row] = await get(db$)
      .select(bindingColumns)
      .from(discordOrgConnections)
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(
        and(
          eq(discordOrgInstallations.orgId, identity.orgId),
          eq(discordOrgConnections.userId, identity.userId),
        ),
      );
    return row
      ? and(
          eq(discordOrgConnections.guildId, row.guildId),
          eq(discordOrgConnections.discordUserId, row.discordUserId),
        )!
      : null;
  });
  const bindings$ = createVerifiedBindings(guildUserWhere$);
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const [binding] = await get(bindings$);
    return binding?.userId === identity.userId &&
      binding.orgId === identity.orgId
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

const commitDiscordDmSelection$ = command(
  async ({ set }, binding: DiscordVerifiedBinding, signal: AbortSignal) => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    return await db
      .insert(discordUserDmPreferences)
      .select(
        db
          .select({
            discordUserId: discordOrgConnections.discordUserId,
            connectionId: discordOrgConnections.id,
            userId: discordOrgConnections.userId,
            createdAt:
              sql`${sql.param(nowDate(), discordUserDmPreferences.createdAt)}`
                .mapWith(discordUserDmPreferences.createdAt)
                .as("created_at"),
            updatedAt:
              sql`${sql.param(nowDate(), discordUserDmPreferences.updatedAt)}`
                .mapWith(discordUserDmPreferences.updatedAt)
                .as("updated_at"),
          })
          .from(discordOrgConnections)
          .innerJoin(
            discordOrgInstallations,
            eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
          )
          .where(
            and(
              eq(discordOrgConnections.id, binding.connectionId),
              eq(discordOrgConnections.guildId, binding.guildId),
              eq(discordOrgConnections.discordUserId, binding.discordUserId),
              eq(discordOrgConnections.userId, binding.userId),
              eq(discordOrgInstallations.orgId, binding.orgId),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: discordUserDmPreferences.discordUserId,
        set: {
          connectionId: sql`excluded.connection_id`,
          userId: sql`excluded.user_id`,
          updatedAt: nowDate(),
        },
      })
      .returning({ userId: discordUserDmPreferences.userId });
  },
);

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
    const enabled = await set(
      discordIntegrationEnabledForOwner$,
      binding.orgId,
      binding.userId,
      signal,
    );
    if (!enabled) {
      return false;
    }
    const [selected] = await set(commitDiscordDmSelection$, binding, signal);
    if (selected) {
      // Committed preferences publish before observing post-commit cancellation.
      await publishDiscordChanged([
        selected.userId,
        ...bindings.map((candidate) => {
          return candidate.userId;
        }),
      ]);
    }
    signal.throwIfAborted();
    return selected !== undefined;
  },
);

interface DiscordBindingDisconnect {
  readonly connectionId: string;
  readonly discordUserId: string;
  readonly orgId?: string;
}

const commitDiscordBindingDisconnect$ = command(
  async ({ set }, args: DiscordBindingDisconnect, signal: AbortSignal) => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const candidate = db.$with("disconnect_discord_candidate").as(
      db
        .select({
          guildId: discordOrgConnections.guildId,
          userId: discordOrgConnections.userId,
          orgId: discordOrgInstallations.orgId,
        })
        .from(discordOrgConnections)
        .innerJoin(
          discordOrgInstallations,
          eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
        )
        .where(
          and(
            eq(discordOrgConnections.id, args.connectionId),
            eq(discordOrgConnections.discordUserId, args.discordUserId),
            args.orgId
              ? eq(discordOrgInstallations.orgId, args.orgId)
              : undefined,
          ),
        ),
    );
    const revoked = db.$with("cancelled_discord_disconnect_attempts").as(
      db
        .delete(discordOauthStates)
        .where(
          and(
            eq(
              discordOauthStates.userId,
              db.select({ userId: candidate.userId }).from(candidate),
            ),
            eq(
              discordOauthStates.orgId,
              db.select({ orgId: candidate.orgId }).from(candidate),
            ),
            isNotNull(discordOauthStates.completionTokenHash),
          ),
        )
        .returning({ id: discordOauthStates.id }),
    );
    // Consumed consent receipts are not pending attempts. Revoke only this exact
    // connection; the exclusion index releases ownership with that same DELETE.
    return await db
      .with(candidate, revoked)
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.id, args.connectionId),
          eq(discordOrgConnections.discordUserId, args.discordUserId),
          eq(
            discordOrgConnections.userId,
            db.select({ userId: candidate.userId }).from(candidate),
          ),
          eq(
            discordOrgConnections.guildId,
            db.select({ guildId: candidate.guildId }).from(candidate),
          ),
          gte(db.select({ count: count() }).from(revoked), 0),
        ),
      )
      .returning({ userId: discordOrgConnections.userId });
  },
);

export const disconnectDiscordBinding$ = command(
  async ({ set }, args: DiscordBindingDisconnect, signal: AbortSignal) => {
    const rows = await set(commitDiscordBindingDisconnect$, args, signal);
    // Committed changes publish before observing a post-commit cancellation.
    await publishDiscordChanged(
      rows.map((row) => {
        return row.userId;
      }),
    );
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

export function discordEffectiveAgent(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return computed(async (get) => {
    const db = get(db$);
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId));
    const agentId = metadata?.defaultAgentId;
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

export function discordOrgStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
}): Computed<Promise<DiscordOrgStatus>> {
  const capability$ = discordMessageContentCapability();
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
      contextMode: "unavailable",
      onboarding: "oauth",
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
    const capability = await get(capability$);
    const currentStatus: DiscordOrgStatus = {
      ...status,
      contextMode:
        capability.kind === "available"
          ? capability.enabled
            ? "full"
            : "mentions_only"
          : "unavailable",
    };
    const [installation] = await get(db$)
      .select()
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, args.orgId));
    if (!installation) {
      return { ...currentStatus, isAdmin: role === "admin" };
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
      ...currentStatus,
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
