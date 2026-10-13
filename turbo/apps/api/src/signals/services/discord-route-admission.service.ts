import { discordGatewayEnvelopeSchema } from "@okouai/api-contracts/contracts/discord-gateway";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { command } from "ccstate";
import { and, count, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";

import {
  discordMessageCreateSchema,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import type { DiscordChannel } from "../external/discord-client";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import {
  discordChatThreadRouteWhere,
  ensureCanonicalDiscordChatThreadRoute$,
  findDiscordChatThreadRoute,
  type DiscordChatThreadRouteBinding,
} from "./discord-chat-ingress.service";
import {
  discordEffectiveAgent,
  discordIngressSenderBindings,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { sendDiscordIngressNotice$ } from "./internal-discord-chat-run-callback.service";

async function terminalIngress(
  db: Db,
  args: {
    readonly ingressId: string;
    readonly claimToken: string;
    readonly reason: string;
  },
): Promise<boolean> {
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
  return updated !== undefined;
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
    const bindings = await get(discordIngressSenderBindings(message.author.id));
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

const terminalAgentUnavailable$ = command(
  async (
    { set },
    db: Db,
    { claim, message, source: { binding } }: DiscordAdmissionContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const terminal = await terminalIngress(db, {
      ...claim,
      reason: "agent_unavailable",
    });
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
    { get, set },
    context: DiscordAdmissionContext,
    routeKey: DiscordRouteKey,
    preferences: {
      readonly effectiveAgent: { readonly id: string } | null;
    },
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const { binding } = context.source;
    const { effectiveAgent } = preferences;
    const agent = effectiveAgent ?? (await get(discordEffectiveAgent(binding)));
    signal.throwIfAborted();
    if (!agent) {
      await set(terminalAgentUnavailable$, db, context, signal);
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
    { get, set },
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
      isDm && !assignedRoute ? await get(discordEffectiveAgent(binding)) : null;
    signal.throwIfAborted();
    if (isDm && !assignedRoute && !effectiveAgent) {
      await set(terminalAgentUnavailable$, db, context, signal);
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
      assignedRoute ?? (await findDiscordChatThreadRoute(db, routeKey));
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
    { set },
    context: DiscordAdmissionContext,
    route: DiscordChatThreadRouteBinding,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "deferred" }
    | { readonly kind: "ready"; readonly channelId: string }
    | { readonly kind: "unavailable" }
  > => {
    const db = set(writeDb$);
    const { claim, source } = context;
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
          return { kind: "unavailable" };
        }
        // Keep the route pending until there is actual content to deliver.
        // Discord gives a message-started thread the starter message's ID.
        return { kind: "deferred" };
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
      return { kind: "unavailable" };
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
    const destination = await set(
      resolveDiscordAdmissionDestination$,
      context,
      route,
      signal,
    );
    signal.throwIfAborted();
    if (destination.kind === "unavailable") {
      return false;
    }
    if (destination.kind === "deferred") {
      return true;
    }
    return await set(
      persistDiscordAdmissionDestination$,
      args,
      route.id,
      destination.channelId,
      signal,
    );
  },
);
