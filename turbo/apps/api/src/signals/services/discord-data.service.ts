import { command, computed, type Computed } from "ccstate";
import { and, count, eq, gte, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { agents } from "@okouai/db/schema/agent";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordUserDmPreferences } from "@okouai/db/schema/discord-user-dm-preference";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { discordSnowflakeSchema } from "../external/discord-client";
import type { ApiOrgRole } from "../../types/auth";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { nowDate } from "../../lib/time";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { publishDiscordChanged } from "./discord-realtime.service";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { getDiscordAppConfig } from "./discord-config";

import { discordMessageContentCapability } from "./discord-application-capability.service";

export interface DiscordVerifiedBinding {
  readonly connectionId: string;
  // OAuth origin for account lookups; live conversation access resolves its actual guild.
  readonly guildId: string;
  readonly guildName: string | null;
  readonly discordUserId: string;
  readonly botUserId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly userId: string;
}

const discordSnowflakeDecoder = zodDriverValueDecoder(discordSnowflakeSchema);

const bindingColumns = Object.freeze({
  connectionId: discordOrgConnections.id,
  guildId: sql`${discordOauthStates.verifiedGuildId}`.mapWith(
    discordSnowflakeDecoder,
  ),
  guildName: discordOauthStates.verifiedGuildName,
  discordUserId: discordOrgConnections.discordUserId,
  botUserId: sql`${discordOauthStates.verifiedBotUserId}`.mapWith(
    discordSnowflakeDecoder,
  ),
  orgId: discordOauthStates.orgId,
  userId: discordOrgConnections.userId,
});

function verifiedBindingReadPlan(where: SQL) {
  return {
    columns: bindingColumns,
    from: discordOrgConnections,
    join: discordOauthStates,
    joinCondition: eq(
      discordOauthStates.id,
      discordOrgConnections.oauthGrantId,
    ),
    where,
  };
}

export function discordUserBindingReadPlan(identity: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return verifiedBindingReadPlan(
    and(
      eq(discordOauthStates.orgId, identity.orgId),
      eq(discordOrgConnections.userId, identity.userId),
    )!,
  );
}

export function discordBindingFromMemberships(
  row: Omit<DiscordVerifiedBinding, "orgName">,
  members: readonly {
    readonly publicUserData?: { readonly userId: string } | null;
    readonly organization: { readonly name: string };
  }[],
): DiscordVerifiedBinding | null {
  const member = members.find((candidate) => {
    return candidate.publicUserData?.userId === row.userId;
  });
  return member ? { ...row, orgName: member.organization.name } : null;
}

/** Always ask the identity authority; a cached role cannot revive a binding. */
function discordMembership(
  input:
    | { readonly orgId: string; readonly userId: string }
    | Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  return computed(async (get) => {
    const binding = "read" in input ? get(input) : input;
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

export function discordMemberRole(
  args:
    | { readonly orgId: string; readonly userId: string }
    | Computed<{ readonly orgId: string; readonly userId: string }>,
): Computed<Promise<ApiOrgRole | null>> {
  const membership$ = discordMembership(args);
  return computed(async (get) => {
    const member = await get(membership$);
    return member ? (member.role === "org:admin" ? "admin" : "member") : null;
  });
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
    const readPlan = verifiedBindingReadPlan(where);
    const rows = await db
      .select(readPlan.columns)
      .from(readPlan.from)
      .innerJoin(readPlan.join, readPlan.joinCondition)
      .where(readPlan.where);
    const result: DiscordVerifiedBinding[] = [];
    for (const row of rows) {
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
      const binding = discordBindingFromMemberships(row, membership.value.data);
      if (binding) {
        result.push(binding);
      }
    }
    return result;
  });
}

/** A binding read connected before the owning graph is evaluated. */
export function createDiscordUserBinding(
  identity$: Computed<
    Promise<{ readonly orgId: string; readonly userId: string } | null>
  >,
): Computed<Promise<DiscordVerifiedBinding | null>> {
  const accountWhere$ = computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    return discordUserBindingReadPlan(identity).where;
  });
  const bindings$ = createVerifiedBindings(accountWhere$);
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

function discordSenderBindingWhere(discordUserId: string) {
  return eq(discordOrgConnections.discordUserId, discordUserId);
}

function discordSenderBindings(
  discordUserId$: Computed<Promise<string | null>>,
) {
  const where$ = computed(async (get) => {
    const discordUserId = await get(discordUserId$);
    return discordUserId === null
      ? null
      : discordSenderBindingWhere(discordUserId);
  });
  return createVerifiedBindings(where$);
}

/** Fresh action-time reads retain their callers' complete-read abort boundary. */
export const readDiscordSenderBindings$ = command(
  async ({ get }, discordUserId: string) => {
    const where = discordSenderBindingWhere(discordUserId);
    if (!getDiscordAppConfig()) {
      return [];
    }
    const db = get(db$);
    const readPlan = verifiedBindingReadPlan(where);
    const rows = await db
      .select(readPlan.columns)
      .from(readPlan.from)
      .innerJoin(readPlan.join, readPlan.joinCondition)
      .where(readPlan.where);
    const result: DiscordVerifiedBinding[] = [];
    for (const row of rows) {
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
      const binding = discordBindingFromMemberships(row, membership.value.data);
      if (binding) {
        result.push(binding);
      }
    }
    return result;
  },
);

/** Ingress treats missing app configuration as an outage, never as revocation. */
export const readDiscordIngressSenderBindings$ = command(
  async ({ set }, discordUserId: string) => {
    if (!getDiscordAppConfig()) {
      throw new DiscordIngressFailure(
        "discord:config_unavailable",
        true,
        0,
        "Discord is temporarily unavailable",
      );
    }
    return await set(readDiscordSenderBindings$, discordUserId);
  },
);

export type DiscordDmBindingResult =
  | { readonly kind: "connected"; readonly binding: DiscordVerifiedBinding }
  | { readonly kind: "not-connected" }
  | {
      readonly kind: "selection-required";
      readonly bindings: readonly DiscordVerifiedBinding[];
    };

function discordDmBindingFromChoice(
  bindings: DiscordVerifiedBinding[],
  choice: { readonly connectionId: string } | undefined,
): DiscordDmBindingResult {
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
}

function discordDmBinding(
  input: Computed<Promise<string | null>>,
): Computed<Promise<DiscordDmBindingResult>> {
  const bindings$ = discordSenderBindings(input);
  return computed(async (get): Promise<DiscordDmBindingResult> => {
    const discordUserId = await get(input);
    if (discordUserId === null) {
      return { kind: "not-connected" };
    }
    const bindings = await get(bindings$);
    if (bindings.length === 0) {
      return { kind: "not-connected" };
    }
    const [choice] = await get(db$)
      .select()
      .from(discordUserDmPreferences)
      .where(eq(discordUserDmPreferences.discordUserId, discordUserId));
    return discordDmBindingFromChoice(bindings, choice);
  });
}

export const readDiscordDmBinding$ = command(
  async (
    { get, set },
    discordUserId: string,
  ): Promise<DiscordDmBindingResult> => {
    const bindings = await set(readDiscordSenderBindings$, discordUserId);
    if (bindings.length === 0) {
      return { kind: "not-connected" };
    }
    const [choice] = await get(db$)
      .select()
      .from(discordUserDmPreferences)
      .where(eq(discordUserDmPreferences.discordUserId, discordUserId));
    return discordDmBindingFromChoice(bindings, choice);
  },
);

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
            discordOauthStates,
            eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
          )
          .where(
            and(
              eq(discordOrgConnections.id, binding.connectionId),
              eq(discordOrgConnections.discordUserId, binding.discordUserId),
              eq(discordOrgConnections.userId, binding.userId),
              eq(discordOauthStates.orgId, binding.orgId),
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
    { set },
    args: {
      readonly discordUserId: string;
      readonly connectionId: string;
      readonly userId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const bindings = await set(readDiscordSenderBindings$, args.discordUserId);
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
          connectionId: discordOrgConnections.id,
          userId: discordOrgConnections.userId,
          orgId: discordOauthStates.orgId,
        })
        .from(discordOrgConnections)
        .innerJoin(
          discordOauthStates,
          eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
        )
        .where(
          and(
            eq(discordOrgConnections.id, args.connectionId),
            eq(discordOrgConnections.discordUserId, args.discordUserId),
            args.orgId ? eq(discordOauthStates.orgId, args.orgId) : undefined,
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
            discordOrgConnections.id,
            db.select({ connectionId: candidate.connectionId }).from(candidate),
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

function discordDefaultAgentReadPlan(orgId: string) {
  return {
    columns: { defaultAgentId: orgMetadata.defaultAgentId },
    from: orgMetadata,
    where: eq(orgMetadata.orgId, orgId),
  };
}

function discordAccessibleAgentReadPlan(
  identity: { readonly orgId: string; readonly userId: string },
  agentId: string,
) {
  return {
    columns: {
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    },
    from: agents,
    where: and(
      eq(agents.id, agentId),
      eq(agents.orgId, identity.orgId),
      or(eq(agents.visibility, "public"), eq(agents.owner, identity.userId)),
    ),
  };
}

function discordEffectiveAgent(
  input: Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  return computed(async (get) => {
    const args = get(input);
    const db = get(db$);
    const metadataPlan = discordDefaultAgentReadPlan(args.orgId);
    const [metadata] = await db
      .select(metadataPlan.columns)
      .from(metadataPlan.from)
      .where(metadataPlan.where);
    const agentId = metadata?.defaultAgentId;
    if (!agentId) {
      return null;
    }
    const agentPlan = discordAccessibleAgentReadPlan(args, agentId);
    const [agent] = await db
      .select(agentPlan.columns)
      .from(agentPlan.from)
      .where(agentPlan.where);
    return agent ?? null;
  });
}

/** Fresh read; each semantic caller retains its complete-read abort boundary. */
export const readDiscordEffectiveAgent$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
  ) => {
    const db = get(db$);
    const metadataPlan = discordDefaultAgentReadPlan(args.orgId);
    const [metadata] = await db
      .select(metadataPlan.columns)
      .from(metadataPlan.from)
      .where(metadataPlan.where);
    const agentId = metadata?.defaultAgentId;
    if (!agentId) {
      return null;
    }
    const agentPlan = discordAccessibleAgentReadPlan(args, agentId);
    const [agent] = await db
      .select(agentPlan.columns)
      .from(agentPlan.from)
      .where(agentPlan.where);
    return agent ?? null;
  },
);

function discordStatusAgentFields(
  agent: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string | null;
  } | null,
): Pick<DiscordOrgStatus, "defaultAgentId" | "defaultAgentName"> {
  return {
    defaultAgentId: agent?.id ?? null,
    defaultAgentName: agent?.displayName ?? agent?.name ?? null,
  };
}

function discordStatusConnection(
  identity$: Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  return computed(async (get) => {
    const args = get(identity$);
    const [connection] = await get(db$)
      .select(bindingColumns)
      .from(discordOrgConnections)
      .innerJoin(
        discordOauthStates,
        eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
      )
      .where(
        and(
          eq(discordOauthStates.orgId, args.orgId),
          eq(discordOrgConnections.userId, args.userId),
        ),
      );
    return connection;
  });
}

export function discordOrgStatus(
  identity$: Computed<{
    readonly orgId: string;
    readonly userId: string;
    readonly orgRole?: ApiOrgRole;
  }>,
): Computed<Promise<DiscordOrgStatus>> {
  const capability$ = discordMessageContentCapability();
  const role$ = discordMemberRole(identity$);
  const agent$ = discordEffectiveAgent(identity$);
  const connection$ = discordStatusConnection(identity$);
  const discordUserId$ = computed(async (get) => {
    const connection = await get(connection$);
    return connection?.discordUserId ?? null;
  });
  const statusBindings$ = discordSenderBindings(discordUserId$);
  const dmBinding$ = discordDmBinding(discordUserId$);
  return computed(async (get): Promise<DiscordOrgStatus> => {
    const args = get(identity$);
    const config = getDiscordAppConfig();
    const status: DiscordOrgStatus = {
      isAvailable: config !== null,
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
    const role = await get(role$);
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
    const connection = await get(connection$);
    const agent = await get(agent$);
    if (!connection) {
      return {
        ...currentStatus,
        isAdmin: role === "admin",
        ...discordStatusAgentFields(agent),
      };
    }
    const bindings = (await get(statusBindings$)).filter((binding) => {
      return binding.userId === args.userId;
    });
    const resolution = await get(dmBinding$);
    const [savedChoice] =
      resolution.kind === "connected"
        ? await get(db$)
            .select({ connectionId: discordUserDmPreferences.connectionId })
            .from(discordUserDmPreferences)
            .where(
              eq(
                discordUserDmPreferences.discordUserId,
                connection.discordUserId,
              ),
            )
        : [];
    const choice =
      resolution.kind === "connected" &&
      savedChoice?.connectionId === resolution.binding.connectionId
        ? resolution.binding
        : null;
    return {
      ...currentStatus,
      isAdmin: role === "admin",
      isConnected: true,
      guildId: connection.guildId,
      guildName: connection.guildName,
      discordUserId: connection.discordUserId,
      ...discordStatusAgentFields(agent),
      dmSelectionConnectionId:
        choice?.userId === args.userId ? choice.connectionId : null,
      dmBindings: bindings.map(
        ({ connectionId, guildId, guildName, orgName }) => {
          return {
            connectionId,
            guildId,
            guildName,
            workspaceName: orgName,
          };
        },
      ),
    };
  });
}
