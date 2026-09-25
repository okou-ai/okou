import { command, type Command } from "ccstate";
import type { z } from "zod";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { and, eq } from "drizzle-orm";
import { testDiscordStateContract } from "@okouai/api-contracts/contracts/test-discord-state";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordChatDeliveries } from "@okouai/db/schema/discord-chat-delivery";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { discordUserAgentPreferences } from "@okouai/db/schema/discord-user-agent-preference";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { isPreviewEndpointAllowed } from "./preview-endpoint-access";

function conflict() {
  return {
    status: 409 as const,
    body: {
      error: { code: "CONFLICT", message: "Discord identity is already bound" },
    },
  };
}

type DiscordHistoryFixture = NonNullable<
  z.infer<typeof testDiscordStateContract.post.body>["history"]
>;

async function seedDiscordHistory(
  tx: Tx,
  args: {
    readonly connectionId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly guildId: string;
    readonly botUserId: string;
    readonly discordUserId: string;
    readonly history: DiscordHistoryFixture;
  },
  signal: AbortSignal,
): Promise<void> {
  const createdAt = nowDate();
  // The ingress endpoints are implemented in the following slice. Until
  // then this guarded preview fixture constructs retained delivery state
  // for schema, export and erasure verification using an owned public chat.
  const [route] = await tx
    .insert(discordChatThreadRoutes)
    .values({
      connectionId: args.connectionId,
      channelId: args.history.channelId,
      sessionKey: args.history.messageId,
      userId: args.userId,
      chatThreadId: args.history.chatThreadId,
      destinationChannelId: args.history.channelId,
      createdAt,
    })
    .returning({ id: discordChatThreadRoutes.id });
  signal.throwIfAborted();
  if (!route) {
    throw new Error("Discord preview route creation failed");
  }
  const ingress = await tx
    .insert(discordChatIngress)
    .values([
      {
        connectionId: args.connectionId,
        routeId: route.id,
        eventId: args.history.messageId,
        messageId: args.history.messageId,
        payload: args.history.messageText,
        createdAt,
        updatedAt: createdAt,
      },
      {
        connectionId: args.connectionId,
        eventId: `${args.history.messageId}-pending`,
        messageId: `${args.history.messageId}-pending`,
        payload: "Accepted before route creation",
        createdAt,
        updatedAt: createdAt,
      },
    ])
    .returning({ id: discordChatIngress.id });
  signal.throwIfAborted();
  const pendingIngress = ingress[1];
  if (!pendingIngress) {
    throw new Error("Discord preview ingress creation failed");
  }
  // An admission notice that Discord refused keeps provider diagnostics.
  await tx.insert(discordChatDeliveries).values({
    connectionId: args.connectionId,
    ingressId: pendingIngress.id,
    orgId: args.orgId,
    userId: args.userId,
    channelId: args.history.channelId,
    content: "Okou could not start this Discord task",
    status: "failed",
    attempts: 5,
    lastAttemptAt: createdAt,
    lastError: "Discord API 403: Missing Access",
    createdAt,
  });
  signal.throwIfAborted();
  await tx.insert(chatDiscordContext).values({
    connectionId: args.connectionId,
    routeId: route.id,
    chatThreadId: args.history.chatThreadId,
    guildId: args.guildId,
    channelId: args.history.channelId,
    messageId: args.history.messageId,
    botUserId: args.botUserId,
    messageText: args.history.messageText,
    senderUserId: args.discordUserId,
    channelType: "channel",
    destinationChannelId: args.history.channelId,
    createdAt,
  });
  signal.throwIfAborted();
  await tx
    .insert(discordUserAgentPreferences)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      connectionId: args.connectionId,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
}

const seedDiscordState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(testDiscordStateContract.post));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const response = await set(writeDb$).transaction(async (tx) => {
    const createdAt = nowDate();
    if (body.history) {
      const [thread] = await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(chatThreads.id, body.history.chatThreadId),
            eq(chatThreads.userId, auth.userId),
            eq(agents.orgId, auth.orgId),
          ),
        );
      signal.throwIfAborted();
      if (!thread) {
        return {
          status: 404 as const,
          body: {
            error: { code: "NOT_FOUND", message: "Chat thread not found" },
          },
        };
      }
    }
    await tx
      .insert(discordOrgInstallations)
      .values({
        guildId: body.guildId,
        guildName: body.guildName,
        botUserId: body.botUserId,
        orgId: auth.orgId,
        installedByUserId: auth.userId,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [installation] = await tx
      .select()
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.guildId, body.guildId))
      .for("share");
    signal.throwIfAborted();
    if (
      installation?.orgId !== auth.orgId ||
      installation.botUserId !== body.botUserId
    ) {
      return conflict();
    }
    await tx
      .insert(discordOrgConnections)
      .values({
        guildId: body.guildId,
        userId: auth.userId,
        discordUserId: body.discordUserId,
        createdAt,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [connection] = await tx
      .select({ id: discordOrgConnections.id })
      .from(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.guildId, body.guildId),
          eq(discordOrgConnections.discordUserId, body.discordUserId),
          eq(discordOrgConnections.userId, auth.userId),
        ),
      );
    signal.throwIfAborted();
    if (!connection) {
      return conflict();
    }
    if (body.history) {
      await seedDiscordHistory(
        tx,
        {
          connectionId: connection.id,
          userId: auth.userId,
          orgId: auth.orgId,
          guildId: body.guildId,
          botUserId: body.botUserId,
          discordUserId: body.discordUserId,
          history: body.history,
        },
        signal,
      );
    }
    return { status: 200 as const, body: { connectionId: connection.id } };
  });
  signal.throwIfAborted();
  return response;
});

const deleteDiscordState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(testDiscordStateContract.delete));
    await set(writeDb$).transaction(async (tx) => {
      signal.throwIfAborted();
      await tx
        .delete(discordOrgInstallations)
        .where(
          and(
            eq(discordOrgInstallations.guildId, query.guildId),
            eq(discordOrgInstallations.orgId, auth.orgId),
          ),
        );
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

function previewDiscordRoute<T>(handler: Command<T, [AbortSignal]>) {
  const authenticated = authRoute(
    {
      requireOrganization: true,
      missingOrganizationStatus: 401,
      accept: ["session", "pat", "oauth"],
    },
    command(async ({ get, set }, signal: AbortSignal) => {
      if (get(organizationAuthContext$).orgRole !== "admin") {
        return {
          status: 403 as const,
          body: {
            error: { code: "FORBIDDEN", message: "Admin access required" },
          },
        };
      }
      return await set(handler, signal);
    }),
  );
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!isPreviewEndpointAllowed(get(request$))) {
      return notFound("Not found");
    }
    return await set(authenticated, signal);
  });
}

export const discordStatePreviewRoutes: readonly RouteEntry[] = [
  {
    route: testDiscordStateContract.post,
    handler: previewDiscordRoute(seedDiscordState$),
  },
  {
    route: testDiscordStateContract.delete,
    handler: previewDiscordRoute(deleteDiscordState$),
  },
];
