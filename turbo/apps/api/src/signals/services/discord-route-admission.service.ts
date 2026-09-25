import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { discordGatewayEnvelopeSchema } from "@okouai/api-contracts/contracts/discord-gateway";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";

import {
  discordMessageCreateSchema,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { integrationDmSessionKey } from "../../lib/integration-dm-session";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  discordClient,
  type DiscordApiResult,
  type DiscordChannel,
} from "../external/discord-client";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import {
  ensureCanonicalDiscordChatThreadRoute,
  findDiscordChatThreadRoute,
  type DiscordChatThreadRouteBinding,
} from "./discord-chat-ingress.service";
import {
  discordEffectiveAgent,
  discordSenderBindings,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import {
  dispatchDiscordChatDeliveryOnce,
  enqueueDiscordIngressFailure,
} from "./internal-discord-chat-run-callback.service";

function requireDiscordResult<T>(result: DiscordApiResult<T>): T {
  if (result.kind === "ok") {
    return result.data;
  }
  if (result.kind === "unavailable") {
    throw new DiscordIngressFailure(
      "destination_unavailable",
      false,
      0,
      "Discord conversation is unavailable",
    );
  }
  throw new DiscordIngressFailure(
    "discord_provider",
    result.status === 429 || result.status >= 500,
    result.retryAfterMs ?? 0,
    "Discord could not prepare the conversation",
  );
}

async function resolvePhysicalThread(
  args: {
    readonly botToken: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly messageId: string;
  },
  signal: AbortSignal,
): Promise<DiscordChannel> {
  function matchingThread(channel: DiscordChannel): DiscordChannel {
    if (
      channel.id !== args.messageId ||
      channel.parent_id !== args.channelId ||
      channel.guild_id !== args.guildId ||
      ![10, 11, 12].includes(channel.type)
    ) {
      throw new Error("Discord thread does not match its starter message");
    }
    return channel;
  }
  // Discord's message-created thread has the starter message's ID. Looking it
  // up first recovers a successful create whose HTTP response was lost.
  const existing = await discordClient.fetchDiscordChannel(
    {
      botToken: args.botToken,
      channelId: args.messageId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (existing.kind === "ok") {
    return matchingThread(existing.data);
  }
  if (existing.kind !== "unavailable" || existing.status !== 404) {
    return requireDiscordResult(existing);
  }
  const created = await discordClient.createDiscordThreadFromMessage(
    {
      botToken: args.botToken,
      channelId: args.channelId,
      messageId: args.messageId,
      name: "Okou conversation",
    },
    signal,
  );
  signal.throwIfAborted();
  if (created.kind === "ok") {
    return matchingThread(created.data);
  }
  if (created.kind === "discord-error" && created.status === 429) {
    // Retry through the durable ingress claim so binding and permissions are
    // rechecked after Discord's rate-limit window.
    return requireDiscordResult(created);
  }
  // Another message/replay worker may have created this same physical thread.
  const reconciled = await discordClient.fetchDiscordChannel(
    {
      botToken: args.botToken,
      channelId: args.messageId,
    },
    signal,
  );
  signal.throwIfAborted();
  return matchingThread(
    requireDiscordResult(reconciled.kind === "ok" ? reconciled : created),
  );
}

async function terminalIngress(
  db: Db,
  args: {
    readonly ingressId: string;
    readonly claimToken: string;
    readonly reason: string;
    readonly notice?: {
      readonly connectionId: string;
      readonly channelId: string;
      readonly content: string;
    };
  },
): Promise<string | null> {
  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(discordChatIngress)
      .set({
        status: "terminal",
        claimToken: null,
        claimedAt: null,
        retryAt: null,
        lastErrorClass: args.reason,
        lastError: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(discordChatIngress.id, args.ingressId),
          eq(discordChatIngress.claimToken, args.claimToken),
          eq(discordChatIngress.status, "processing"),
        ),
      )
      .returning({ id: discordChatIngress.id });
    if (updated && args.notice) {
      return await enqueueDiscordIngressFailure(tx, {
        ingressId: args.ingressId,
        ...args.notice,
      });
    }
    return null;
  });
}

interface DiscordIngressClaim {
  readonly ingressId: string;
  readonly claimToken: string;
}

type DiscordIngress = typeof discordChatIngress.$inferSelect;

interface DiscordAdmissionSource {
  readonly binding: DiscordVerifiedBinding;
  readonly channel: DiscordChannel;
  readonly isDm: boolean;
  readonly isThread: boolean;
  readonly routeChannelId: string;
}

interface DiscordAdmissionContext {
  readonly claim: DiscordIngressClaim;
  readonly ingress: DiscordIngress;
  readonly message: DiscordMessageCreate;
  readonly source: DiscordAdmissionSource;
}

const resolveDiscordAdmissionSource$ = command(
  async (
    { get, set },
    args: DiscordIngressClaim,
    ingress: DiscordIngress,
    message: DiscordMessageCreate,
    signal: AbortSignal,
  ): Promise<DiscordAdmissionSource | null> => {
    const db = set(writeDb$);
    const bindings = await get(discordSenderBindings(message.author.id));
    signal.throwIfAborted();
    const binding = bindings.find((candidate) => {
      return candidate.connectionId === ingress.connectionId;
    });
    if (!binding) {
      await terminalIngress(db, { ...args, reason: "binding_revoked" });
      signal.throwIfAborted();
      return null;
    }
    const sourceAccess = await set(
      requireDiscordConversationAccess$,
      {
        orgId: binding.orgId,
        userId: binding.userId,
        guildId: binding.guildId,
        channelId: message.channel_id,
        mode: "write",
      },
      signal,
    );
    signal.throwIfAborted();
    if (sourceAccess.kind === "denied") {
      if (sourceAccess.response.status >= 429) {
        throw new DiscordIngressFailure(
          "discord_access",
          true,
          (sourceAccess.response.body.error.retryAfterSeconds ?? 0) * 1000,
          "Discord access could not be verified",
        );
      }
      await terminalIngress(db, {
        ...args,
        reason: "conversation_unavailable",
      });
      signal.throwIfAborted();
      return null;
    }
    if (sourceAccess.binding.connectionId !== binding.connectionId) {
      await terminalIngress(db, { ...args, reason: "binding_changed" });
      signal.throwIfAborted();
      return null;
    }
    const channel = sourceAccess.channel;
    const isDm = channel.type === 1;
    const isThread = [10, 11, 12].includes(channel.type);
    if (
      (isDm && message.guild_id) ||
      (!isDm && channel.guild_id !== message.guild_id) ||
      (!isDm && !isThread && ![0, 5].includes(channel.type))
    ) {
      await terminalIngress(db, { ...args, reason: "unsupported_channel" });
      signal.throwIfAborted();
      return null;
    }
    const routeChannelId = isThread ? channel.parent_id : channel.id;
    if (!routeChannelId) {
      throw new Error("Discord thread has no parent channel");
    }
    return { binding, channel, isDm, isThread, routeChannelId };
  },
);

async function loadAssignedDiscordRoute(
  db: Db,
  { ingress, source: { binding } }: DiscordAdmissionContext,
  signal: AbortSignal,
): Promise<DiscordChatThreadRouteBinding | undefined> {
  if (!ingress.routeId) {
    return undefined;
  }
  const [assignedRoute] = await db
    .select()
    .from(discordChatThreadRoutes)
    .where(
      and(
        eq(discordChatThreadRoutes.id, ingress.routeId),
        eq(discordChatThreadRoutes.connectionId, binding.connectionId),
        eq(discordChatThreadRoutes.userId, binding.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!assignedRoute) {
    throw new Error("Discord ingress route ownership is inconsistent");
  }
  return assignedRoute;
}

async function terminalAgentUnavailable(
  db: Db,
  { claim, message, source: { binding } }: DiscordAdmissionContext,
): Promise<void> {
  await terminalIngress(db, {
    ...claim,
    reason: "agent_unavailable",
    notice: {
      connectionId: binding.connectionId,
      channelId: message.channel_id,
      content:
        "No accessible agent is configured. Use /okou switch to choose an agent.",
    },
  });
}

/**
 * A new guild-channel route always starts a public thread. Check that both
 * parties may create one before a route or canonical chat exists, so a denied
 * mention leaves no empty chat and gets an actionable notice.
 */
const requirePublicThreadCreation$ = command(
  async (
    { set },
    { claim, message, source }: DiscordAdmissionContext,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { binding, channel } = source;
    const access = await set(
      requireDiscordConversationAccess$,
      {
        orgId: binding.orgId,
        userId: binding.userId,
        guildId: binding.guildId,
        channelId: channel.id,
        mode: "write",
        createPublicThread: true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (access.kind === "allowed") {
      if (access.binding.connectionId === binding.connectionId) {
        return true;
      }
      await terminalIngress(set(writeDb$), {
        ...claim,
        reason: "binding_changed",
      });
      signal.throwIfAborted();
      return false;
    }
    if (access.response.status >= 429) {
      throw new DiscordIngressFailure(
        "thread_creation_unavailable",
        true,
        (access.response.body.error.retryAfterSeconds ?? 0) * 1000,
        "Discord thread creation could not be verified",
      );
    }
    const db = set(writeDb$);
    const deliveryId = await terminalIngress(db, {
      ...claim,
      reason: "thread_creation_denied",
      notice: {
        connectionId: binding.connectionId,
        channelId: message.channel_id,
        content:
          "I can't start a thread for this request here. You and Okou both need the Create Public Threads permission in this channel.",
      },
    });
    signal.throwIfAborted();
    if (deliveryId) {
      await dispatchDiscordChatDeliveryOnce(db, deliveryId, signal);
    }
    return false;
  },
);

type DiscordRouteKey = Pick<
  DiscordChatThreadRouteBinding,
  "connectionId" | "userId" | "channelId" | "sessionKey"
>;

const createDiscordAdmissionRoute$ = command(
  async (
    { get, set },
    context: DiscordAdmissionContext,
    routeKey: DiscordRouteKey,
    preferences: {
      readonly effectiveAgent: { readonly id: string } | null;
      readonly modelRoute: IntegrationModelRoutePin | undefined;
    },
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const { binding, isDm, isThread } = context.source;
    if (
      !isDm &&
      !isThread &&
      !(await set(requirePublicThreadCreation$, context, signal))
    ) {
      return undefined;
    }
    const { effectiveAgent, modelRoute } = preferences;
    const agent = effectiveAgent ?? (await get(discordEffectiveAgent(binding)));
    signal.throwIfAborted();
    if (!agent) {
      await terminalAgentUnavailable(db, context);
      signal.throwIfAborted();
      return undefined;
    }
    const pin =
      modelRoute ??
      (await set(resolveIntegrationModelRouteForUser$, binding, signal));
    signal.throwIfAborted();
    const route = await ensureCanonicalDiscordChatThreadRoute(db, {
      ...routeKey,
      orgId: binding.orgId,
      agentId: agent.id,
      selectedModel: pin?.selectedModel ?? null,
      serviceTier: pin?.serviceTier ?? null,
      currentTime: context.ingress.createdAt,
      ...context.claim,
    });
    signal.throwIfAborted();
    return route;
  },
);

async function attachDiscordAdmissionRoute(
  db: Db,
  { ingress, claim }: DiscordAdmissionContext,
  routeId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [attached] = await db
    .update(discordChatIngress)
    .set({ routeId })
    .where(
      and(
        eq(discordChatIngress.id, ingress.id),
        eq(discordChatIngress.claimToken, claim.claimToken),
        eq(discordChatIngress.status, "processing"),
      ),
    )
    .returning({ id: discordChatIngress.id });
  signal.throwIfAborted();
  return Boolean(attached);
}

const resolveCanonicalDiscordRoute$ = command(
  async (
    { get, set },
    context: DiscordAdmissionContext,
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const { ingress, message, source } = context;
    const { binding, channel, isDm, isThread, routeChannelId } = source;
    const assignedRoute = await loadAssignedDiscordRoute(db, context, signal);
    signal.throwIfAborted();
    const effectiveAgent =
      isDm && !assignedRoute ? await get(discordEffectiveAgent(binding)) : null;
    signal.throwIfAborted();
    const modelRoute =
      isDm && !assignedRoute
        ? await set(resolveIntegrationModelRouteForUser$, binding, signal)
        : undefined;
    signal.throwIfAborted();
    if (isDm && !assignedRoute && !effectiveAgent) {
      await terminalAgentUnavailable(db, context);
      signal.throwIfAborted();
      return undefined;
    }
    const routeKey = assignedRoute ?? {
      connectionId: binding.connectionId,
      userId: binding.userId,
      channelId: routeChannelId,
      sessionKey: effectiveAgent
        ? integrationDmSessionKey({
            agentId: effectiveAgent.id,
            selectedModel: modelRoute?.selectedModel ?? null,
            serviceTier: modelRoute?.serviceTier ?? null,
          })
        : isThread
          ? channel.id
          : message.id,
    };
    const route =
      assignedRoute ?? (await findDiscordChatThreadRoute(db, routeKey));
    signal.throwIfAborted();
    if (!route) {
      return await set(
        createDiscordAdmissionRoute$,
        context,
        routeKey,
        { effectiveAgent, modelRoute },
        signal,
      );
    }
    if (
      !ingress.routeId &&
      !(await attachDiscordAdmissionRoute(db, context, route.id, signal))
    ) {
      return undefined;
    }
    return route;
  },
);

const resolveDiscordAdmissionDestination$ = command(
  async (
    { set },
    context: DiscordAdmissionContext,
    route: DiscordChatThreadRouteBinding,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { claim, message, source } = context;
    const { binding, channel, isDm, isThread } = source;
    let destinationChannelId = route.destinationChannelId;
    if (!destinationChannelId) {
      if (isDm || isThread) {
        destinationChannelId = channel.id;
      } else {
        const createAccess = await set(
          requireDiscordConversationAccess$,
          {
            orgId: binding.orgId,
            userId: binding.userId,
            guildId: binding.guildId,
            channelId: channel.id,
            mode: "write",
            createPublicThread: true,
          },
          signal,
        );
        signal.throwIfAborted();
        if (createAccess.kind === "denied") {
          throw new DiscordIngressFailure(
            "thread_creation_unavailable",
            createAccess.response.status >= 429,
            (createAccess.response.body.error.retryAfterSeconds ?? 0) * 1000,
            "Discord thread creation is unavailable",
          );
        }
        if (createAccess.binding.connectionId !== binding.connectionId) {
          await terminalIngress(db, { ...claim, reason: "binding_changed" });
          signal.throwIfAborted();
          return null;
        }
        const thread = await resolvePhysicalThread(
          {
            botToken: createAccess.botToken,
            guildId: binding.guildId,
            channelId: channel.id,
            messageId: message.id,
          },
          signal,
        );
        signal.throwIfAborted();
        destinationChannelId = thread.id;
      }
    }
    const destinationAccess = await set(
      requireDiscordConversationAccess$,
      {
        orgId: binding.orgId,
        userId: binding.userId,
        guildId: binding.guildId,
        channelId: destinationChannelId,
        mode: "write",
      },
      signal,
    );
    signal.throwIfAborted();
    if (destinationAccess.kind === "denied") {
      throw new DiscordIngressFailure(
        "destination_unavailable",
        destinationAccess.response.status >= 429,
        (destinationAccess.response.body.error.retryAfterSeconds ?? 0) * 1000,
        "Discord destination is unavailable",
      );
    }
    if (destinationAccess.binding.connectionId !== binding.connectionId) {
      await terminalIngress(db, { ...claim, reason: "binding_changed" });
      signal.throwIfAborted();
      return null;
    }
    return destinationChannelId;
  },
);

async function persistDiscordAdmissionDestination(
  db: Db,
  args: DiscordIngressClaim,
  routeId: string,
  destinationChannelId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [claim] = await tx
      .select({ id: discordChatIngress.id })
      .from(discordChatIngress)
      .where(
        and(
          eq(discordChatIngress.id, args.ingressId),
          eq(discordChatIngress.claimToken, args.claimToken),
          eq(discordChatIngress.status, "processing"),
        ),
      )
      .for("update")
      .limit(1);
    signal.throwIfAborted();
    if (!claim) {
      return false;
    }
    const [updatedRoute] = await tx
      .update(discordChatThreadRoutes)
      .set({ destinationChannelId })
      .where(
        and(
          eq(discordChatThreadRoutes.id, routeId),
          or(
            isNull(discordChatThreadRoutes.destinationChannelId),
            eq(
              discordChatThreadRoutes.destinationChannelId,
              destinationChannelId,
            ),
          ),
        ),
      )
      .returning({ id: discordChatThreadRoutes.id });
    signal.throwIfAborted();
    if (!updatedRoute) {
      throw new Error("Discord route destination changed during admission");
    }
    await tx
      .update(discordChatIngress)
      .set({ routeId, updatedAt: nowDate() })
      .where(eq(discordChatIngress.id, args.ingressId));
    signal.throwIfAborted();
    return true;
  });
}

export const prepareCanonicalDiscordIngressRoute$ = command(
  async (
    { set },
    args: DiscordIngressClaim,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [ingress] = await db
      .select()
      .from(discordChatIngress)
      .where(
        and(
          eq(discordChatIngress.id, args.ingressId),
          eq(discordChatIngress.claimToken, args.claimToken),
          eq(discordChatIngress.status, "processing"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!ingress) {
      return false;
    }
    const envelope = discordGatewayEnvelopeSchema.parse(
      JSON.parse(ingress.payload),
    );
    const message = discordMessageCreateSchema.parse(envelope.payload);
    const source = await set(
      resolveDiscordAdmissionSource$,
      args,
      ingress,
      message,
      signal,
    );
    signal.throwIfAborted();
    if (!source) {
      return false;
    }
    const context = { claim: args, ingress, message, source };
    const route = await set(resolveCanonicalDiscordRoute$, context, signal);
    signal.throwIfAborted();
    if (!route) {
      return false;
    }
    const destinationChannelId = await set(
      resolveDiscordAdmissionDestination$,
      context,
      route,
      signal,
    );
    signal.throwIfAborted();
    if (!destinationChannelId) {
      return false;
    }
    return await persistDiscordAdmissionDestination(
      db,
      args,
      route.id,
      destinationChannelId,
      signal,
    );
  },
);
