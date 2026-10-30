import { discordGatewayEnvelopeSchema } from "@okouai/api-contracts/contracts/discord-gateway";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { command } from "ccstate";
import { and, count, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";

import {
  discordMessageCreateSchema,
  isDiscordUserMessage,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { DiscordChannel } from "../external/discord-client";
import { getDiscordAppConfig } from "./discord-config";
import {
  resolveDiscordProviderAccess,
  type DiscordProviderSnapshot,
} from "./discord-provider-access";
import {
  discordChatThreadRouteWhere,
  ensureCanonicalDiscordChatThreadRoute$,
  findDiscordChatThreadRoute$,
  type DiscordChatThreadRouteBinding,
} from "./discord-chat-ingress.service";
import {
  readDiscordEffectiveAgent$,
  readDiscordIngressSenderBindings$,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { sendDiscordIngressNotice$ } from "./internal-discord-chat-run-callback.service";

const terminalIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly claimToken: string;
      readonly reason: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [updated] = await db
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
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

interface DiscordIngressClaim {
  readonly ingressId: string;
  readonly claimToken: string;
  /** The Gateway's verified binding, scoped to this immediate processing attempt. */
  readonly admittedBinding?: DiscordVerifiedBinding;
}

type DiscordIngress = typeof discordChatIngress.$inferSelect;

interface DiscordAdmissionSource {
  readonly binding: DiscordVerifiedBinding;
  readonly channel: DiscordChannel;
  readonly isDm: boolean;
  readonly isThread: boolean;
  readonly routeChannelId: string;
  readonly botToken: string;
  readonly applicationId: string;
  readonly snapshot: DiscordProviderSnapshot;
}

export interface PreparedDiscordIngress {
  readonly ingress: DiscordIngress;
  readonly message: DiscordMessageCreate;
  readonly source: DiscordAdmissionSource;
  readonly route: DiscordChatThreadRouteBinding;
}

interface DiscordAdmissionContext {
  readonly claim: DiscordIngressClaim;
  readonly ingress: DiscordIngress;
  readonly message: DiscordMessageCreate;
  readonly source: DiscordAdmissionSource;
}

const resolveDiscordAdmissionSource$ = command(
  async (
    { set },
    args: DiscordIngressClaim,
    ingress: DiscordIngress,
    message: DiscordMessageCreate,
    signal: AbortSignal,
  ): Promise<DiscordAdmissionSource | null> => {
    set(writeDb$);
    const binding =
      args.admittedBinding ??
      (await set(readDiscordIngressSenderBindings$, message.author.id)).find(
        (candidate) => {
          return candidate.connectionId === ingress.connectionId;
        },
      );
    signal.throwIfAborted();
    if (
      !binding ||
      binding.connectionId !== ingress.connectionId ||
      binding.discordUserId !== message.author.id
    ) {
      await set(
        terminalIngress$,
        { ...args, reason: "binding_revoked" },
        signal,
      );
      signal.throwIfAborted();
      return null;
    }
    const config = getDiscordAppConfig();
    if (!config) {
      throw new DiscordIngressFailure(
        "discord:config_unavailable",
        true,
        0,
        "Discord is temporarily unavailable",
      );
    }
    const sourceAccess = await resolveDiscordProviderAccess(
      {
        ...binding,
        botToken: config.botToken,
        guildId: message.guild_id,
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
      await set(
        terminalIngress$,
        { ...args, reason: "conversation_unavailable" },
        signal,
      );
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
      await set(
        terminalIngress$,
        { ...args, reason: "unsupported_channel" },
        signal,
      );
      signal.throwIfAborted();
      return null;
    }
    const routeChannelId = isThread ? channel.parent_id : channel.id;
    if (!routeChannelId) {
      throw new Error("Discord thread has no parent channel");
    }
    return {
      binding: { ...binding, guildId: channel.guild_id ?? binding.guildId },
      channel,
      isDm,
      isThread,
      routeChannelId,
      botToken: config.botToken,
      applicationId: config.applicationId,
      snapshot: sourceAccess.snapshot,
    };
  },
);

const terminalAgentUnavailable$ = command(
  async (
    { set },
    { claim, message, source: { binding } }: DiscordAdmissionContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const terminal = await set(
      terminalIngress$,
      { ...claim, reason: "agent_unavailable" },
      signal,
    );
    signal.throwIfAborted();
    if (terminal) {
      await set(
        sendDiscordIngressNotice$,
        {
          ingressId: claim.ingressId,
          connectionId: binding.connectionId,
          channelId: message.channel_id,
          content:
            "No accessible workspace default agent is configured. Ask a workspace admin to set one in Okou.",
        },
        signal,
      );
    }
  },
);

type DiscordRouteKey = Pick<
  DiscordChatThreadRouteBinding,
  "connectionId" | "userId" | "channelId" | "sessionKey"
>;

const createDiscordAdmissionRoute$ = command(
  async (
    { set },
    context: DiscordAdmissionContext,
    routeKey: DiscordRouteKey,
    preferences: {
      readonly effectiveAgent: { readonly id: string } | null;
    },
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    set(writeDb$);
    const { binding } = context.source;
    const { effectiveAgent } = preferences;
    const agent =
      effectiveAgent ?? (await set(readDiscordEffectiveAgent$, binding));
    signal.throwIfAborted();
    if (!agent) {
      await set(terminalAgentUnavailable$, context, signal);
      signal.throwIfAborted();
      return undefined;
    }
    const route = await set(
      ensureCanonicalDiscordChatThreadRoute$,
      {
        initialModel: await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: binding.orgId,
            userId: binding.userId,
            orgPlanCapabilities: undefined,
          },
          signal,
        ),
        ...routeKey,
        orgId: binding.orgId,
        agentId: agent.id,
        currentTime: context.ingress.createdAt,
        ...context.claim,
      },
      signal,
    );
    signal.throwIfAborted();
    return route;
  },
);

const resolveCanonicalDiscordRoute$ = command(
  async (
    { set },
    context: DiscordAdmissionContext,
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const { ingress, message, source } = context;
    const { binding, channel, isDm, isThread, routeChannelId } = source;
    const {
      ingress: assignedIngress,
      source: {
        binding: assignedBinding,
        routeChannelId: assignedRouteChannelId,
      },
    } = context;
    let assignedRoute: DiscordChatThreadRouteBinding | undefined;
    if (assignedIngress.routeId) {
      const [selectedAssignedRoute] = await db
        .select()
        .from(discordChatThreadRoutes)
        .where(
          and(
            eq(discordChatThreadRoutes.id, assignedIngress.routeId),
            eq(
              discordChatThreadRoutes.connectionId,
              assignedBinding.connectionId,
            ),
            eq(discordChatThreadRoutes.userId, assignedBinding.userId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!selectedAssignedRoute) {
        throw new Error("Discord ingress route ownership is inconsistent");
      }
      const route = selectedAssignedRoute;
      const channelId = assignedRouteChannelId;
      assignedRoute = route;
      if (
        route.sessionKey === INTEGRATION_DM_SESSION_KEY &&
        (route.channelId !== channelId ||
          (route.destinationChannelId !== null &&
            route.destinationChannelId !== channelId))
      ) {
        const [updated] = await db
          .update(discordChatThreadRoutes)
          .set({ channelId, destinationChannelId: channelId })
          .where(
            and(
              eq(discordChatThreadRoutes.id, route.id),
              discordChatThreadRouteWhere(route),
            ),
          )
          .returning({
            channelId: discordChatThreadRoutes.channelId,
            destinationChannelId: discordChatThreadRoutes.destinationChannelId,
          });
        signal.throwIfAborted();
        if (!updated) {
          throw new Error("Failed to update Discord DM route destination");
        }
        assignedRoute = { ...route, ...updated };
      }
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const effectiveAgent =
      isDm && !assignedRoute
        ? await set(readDiscordEffectiveAgent$, binding)
        : null;
    signal.throwIfAborted();
    if (isDm && !assignedRoute && !effectiveAgent) {
      await set(terminalAgentUnavailable$, context, signal);
      signal.throwIfAborted();
      return undefined;
    }
    const routeKey = assignedRoute ?? {
      connectionId: binding.connectionId,
      userId: binding.userId,
      channelId: routeChannelId,
      sessionKey: effectiveAgent
        ? INTEGRATION_DM_SESSION_KEY
        : isThread
          ? channel.id
          : message.id,
    };
    const route =
      assignedRoute ??
      (await set(findDiscordChatThreadRoute$, routeKey, signal));
    signal.throwIfAborted();
    if (!route) {
      return await set(
        createDiscordAdmissionRoute$,
        context,
        routeKey,
        { effectiveAgent },
        signal,
      );
    }
    if (!ingress.routeId) {
      const routeId = route.id;
      const { ingress: attachmentIngress, claim } = context;
      const [attached] = await db
        .update(discordChatIngress)
        .set({ routeId })
        .where(
          and(
            eq(discordChatIngress.id, attachmentIngress.id),
            eq(discordChatIngress.claimToken, claim.claimToken),
            eq(discordChatIngress.status, "processing"),
          ),
        )
        .returning({ id: discordChatIngress.id });
      signal.throwIfAborted();
      const routeAttached = Boolean(attached);
      if (!routeAttached) {
        return undefined;
      }
    }
    return route;
  },
);

const resolveDiscordAdmissionDestination$ = command(
  async (
    _context,
    context: DiscordAdmissionContext,
    route: DiscordChatThreadRouteBinding,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "deferred" }
    | { readonly kind: "ready"; readonly channelId: string }
  > => {
    const { source } = context;
    const { binding, channel, isDm, isThread } = source;
    let destinationChannelId = route.destinationChannelId;
    if (!destinationChannelId) {
      if (isDm || isThread) {
        destinationChannelId = channel.id;
      } else {
        const createAccess = await resolveDiscordProviderAccess(
          {
            ...binding,
            botToken: source.botToken,
            snapshot: source.snapshot,
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
        // Keep the route pending until there is actual content to deliver.
        // Discord gives a message-started thread the starter message's ID.
        return { kind: "deferred" };
      }
    }
    const destinationAccess = await resolveDiscordProviderAccess(
      {
        ...binding,
        guildId: isDm ? undefined : binding.guildId,
        botToken: source.botToken,
        snapshot: source.snapshot,
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
    return { kind: "ready", channelId: destinationChannelId };
  },
);

const persistDiscordAdmissionDestination$ = command(
  async (
    { set },
    args: DiscordIngressClaim,
    routeId: string,
    destinationChannelId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const claimWhere = and(
      eq(discordChatIngress.id, args.ingressId),
      eq(discordChatIngress.claimToken, args.claimToken),
      eq(discordChatIngress.status, "processing"),
    );
    // This read owns the prewrite cancellation checkpoint, not write authority.
    const [preflight] = await db
      .select({ id: discordChatIngress.id })
      .from(discordChatIngress)
      .where(claimWhere)
      .limit(1);
    signal.throwIfAborted();
    if (!preflight) {
      return false;
    }
    // Sample application time before the atomic write, including any lock wait.
    const updatedAt = nowDate();
    const claim = db
      .$with("discord_admission_claim")
      .as(
        db
          .select({ id: discordChatIngress.id })
          .from(discordChatIngress)
          .where(claimWhere)
          .for("update")
          .limit(1),
      );
    const exhaustedClaim = db
      .$with("discord_admission_claim_complete")
      .as(db.select({ count: count().as("count") }).from(claim));
    const updatedRoute = db.$with("discord_admission_route").as(
      db
        .update(discordChatThreadRoutes)
        .set({ destinationChannelId })
        .from(exhaustedClaim)
        .where(
          and(
            gt(exhaustedClaim.count, 0),
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
        .returning({ id: discordChatThreadRoutes.id }),
    );
    const exhaustedRoute = db
      .$with("discord_admission_route_complete")
      .as(db.select({ count: count().as("count") }).from(updatedRoute));
    const updatedIngress = db.$with("discord_admission_ingress").as(
      db
        .update(discordChatIngress)
        .set({ routeId, updatedAt })
        .from(exhaustedRoute)
        .where(
          and(
            gt(exhaustedRoute.count, 0),
            eq(discordChatIngress.id, args.ingressId),
          ),
        )
        .returning({ id: discordChatIngress.id }),
    );
    // Exhaust the mutation even when its row count is zero, as the old owner did.
    const exhaustedIngress = db
      .$with("discord_admission_ingress_complete")
      .as(db.select({ count: count().as("count") }).from(updatedIngress));
    const [completed] = await db
      .with(
        claim,
        exhaustedClaim,
        updatedRoute,
        exhaustedRoute,
        updatedIngress,
        exhaustedIngress,
      )
      .select({ claimId: claim.id, routeId: updatedRoute.id })
      .from(claim)
      .leftJoin(updatedRoute, sql`true`)
      .crossJoin(exhaustedIngress)
      .where(gte(exhaustedIngress.count, 0));
    signal.throwIfAborted();
    if (!completed) {
      return false;
    }
    if (!completed.routeId) {
      throw new Error("Discord route destination changed during admission");
    }
    return true;
  },
);

export const prepareCanonicalDiscordIngressRoute$ = command(
  async (
    { set },
    args: DiscordIngressClaim,
    signal: AbortSignal,
  ): Promise<PreparedDiscordIngress | null> => {
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
      return null;
    }
    const envelope = discordGatewayEnvelopeSchema.parse(
      JSON.parse(ingress.payload),
    );
    const message = discordMessageCreateSchema.parse(envelope.payload);
    if (
      envelope.eventType !== "MESSAGE_CREATE" ||
      message.id !== ingress.messageId ||
      !isDiscordUserMessage(message)
    ) {
      throw new Error(
        "Canonical Discord ingress message does not match its receipt",
      );
    }
    const source = await set(
      resolveDiscordAdmissionSource$,
      args,
      ingress,
      message,
      signal,
    );
    signal.throwIfAborted();
    if (!source) {
      return null;
    }
    const context = { claim: args, ingress, message, source };
    const route = await set(resolveCanonicalDiscordRoute$, context, signal);
    signal.throwIfAborted();
    if (!route) {
      return null;
    }
    const destination = await set(
      resolveDiscordAdmissionDestination$,
      context,
      route,
      signal,
    );
    signal.throwIfAborted();
    if (destination.kind === "deferred") {
      return { ingress, message, source, route };
    }
    const persisted = await set(
      persistDiscordAdmissionDestination$,
      args,
      route.id,
      destination.channelId,
      signal,
    );
    return persisted
      ? {
          ingress,
          message,
          source,
          route: { ...route, destinationChannelId: destination.channelId },
        }
      : null;
  },
);
