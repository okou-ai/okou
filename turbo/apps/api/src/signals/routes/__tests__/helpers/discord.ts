import { randomBytes, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { discordOauthRoutes } from "../../discord-oauth";
import { integrationsDiscordRoutes } from "../../integrations-discord";
import { createRouteMocks } from "./route-test";

export interface DiscordActor {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: "org:admin" | "org:member";
}

export interface DiscordFixture extends DiscordActor {
  readonly guildId: string;
  readonly guildName: string;
  readonly botUserId: string;
  readonly discordUserId: string;
  readonly connectionId: string;
  readonly flow: "install" | "connect";
}

export function uniqueDiscordSnowflake(): string {
  return (
    1_000_000_000_000_000_000n +
    (BigInt(`0x${randomBytes(8).toString("hex")}`) % 1_000_000_000_000_000_000n)
  ).toString();
}

export function configureDiscordApp(): void {
  mockEnv("DISCORD_APPLICATION_ID", "123456789012345678");
  mockEnv("DISCORD_BOT_TOKEN", "discord-test-bot-token");
  mockEnv("DISCORD_PUBLIC_KEY", "a".repeat(64));
  mockEnv("DISCORD_GATEWAY_SECRET", "discord-gateway-test-secret-32-bytes");
  mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "false");
}

export function mockDiscordMemberships(
  context: TestContext,
  actors: readonly DiscordActor[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = z
        .object({
          organizationId: z.string(),
          userId: z.array(z.string()).optional(),
        })
        .parse(input);
      const matches = actors.filter((actor) => {
        return (
          actor.orgId === params.organizationId &&
          (params.userId === undefined || params.userId.includes(actor.userId))
        );
      });
      return Promise.resolve({
        data: matches.map((actor) => {
          return {
            id: `orgmem_${actor.orgId}_${actor.userId}`,
            publicUserData: { userId: actor.userId },
            role: actor.orgRole ?? "org:admin",
            createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
            organization: { id: actor.orgId, name: "Discord test workspace" },
          };
        }),
        totalCount: matches.length,
      });
    },
  );
}

/** IDs configure Discord's external responses, never proof sent to Okou. */
export function createPublicDiscordBinding(
  context: TestContext,
  args: DiscordActor & {
    readonly flow: "install" | "connect";
    readonly guildId?: string;
    readonly guildName?: string;
    readonly botUserId?: string;
    readonly discordUserId?: string;
  },
): Promise<DiscordFixture> {
  createRouteMocks(context).clerk.session(
    args.userId,
    args.orgId,
    args.orgRole,
  );
  mockEnv("DISCORD_OAUTH_CLIENT_SECRET", "discord-test-client-secret");
  const identity = {
    orgId: args.orgId,
    userId: args.userId,
    orgRole: args.orgRole,
    flow: args.flow,
    guildId: args.guildId ?? uniqueDiscordSnowflake(),
    guildName: args.guildName ?? "Discord test guild",
    botUserId: args.botUserId ?? "123456789012345678",
    discordUserId: args.discordUserId ?? uniqueDiscordSnowflake(),
  };
  const applicationId = env("DISCORD_APPLICATION_ID") ?? identity.botUserId;
  const botAuthorization = `Bot ${env("DISCORD_BOT_TOKEN")}`;
  const dmChannelId = uniqueDiscordSnowflake();
  const code = randomUUID();
  const accessToken = `discord-access-${randomUUID()}`;
  const base = "https://discord.com/api/v10";
  let active = true;
  const oauthResponses = new Set(["token", "authorization", "user"]);
  // Grant/identity responses are one-use for this exact code/bearer identity.
  // Bot responses remain live for final revalidation and welcome delivery.
  // These handlers own only this finite OAuth exchange. They fall through for
  // unrelated bearer identities and all later native bot requests. Central
  // test-context cleanup resets registration after the case.
  server.use(
    http.post(`${base}/oauth2/token`, async ({ request }) => {
      if (!active) {
        return;
      }
      const body = new URLSearchParams(await request.text());
      if (body.get("code") !== code || !oauthResponses.delete("token")) {
        return;
      }
      return HttpResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `discord-refresh-${randomUUID()}`,
        scope:
          args.flow === "install"
            ? "identify guilds bot applications.commands"
            : "identify guilds",
        guild: { id: identity.guildId, name: identity.guildName },
      });
    }),
    http.get(`${base}/oauth2/@me`, ({ request }) => {
      if (
        !active ||
        request.headers.get("authorization") !== `Bearer ${accessToken}` ||
        !oauthResponses.delete("authorization")
      ) {
        return;
      }
      return HttpResponse.json({
        application: { id: applicationId },
        scopes:
          args.flow === "install"
            ? ["identify", "guilds", "bot", "applications.commands"]
            : ["identify", "guilds"],
        expires: new Date(now() + 3_600_000).toISOString(),
        user: { id: identity.discordUserId, username: "member", bot: false },
      });
    }),
    http.get(`${base}/oauth2/applications/@me`, ({ request }) => {
      if (
        !active ||
        request.headers.get("authorization") !== botAuthorization
      ) {
        return;
      }
      return HttpResponse.json({
        id: applicationId,
        bot: { id: identity.botUserId, username: "Okou", bot: true },
      });
    }),
    http.get(`${base}/users/@me`, ({ request }) => {
      if (!active) {
        return;
      }
      const authorization = request.headers.get("authorization");
      if (
        authorization === `Bearer ${accessToken}` &&
        oauthResponses.delete("user")
      ) {
        return HttpResponse.json({
          id: identity.discordUserId,
          username: "member",
        });
      }
      if (authorization === botAuthorization) {
        return HttpResponse.json({
          id: identity.botUserId,
          username: "Okou",
          bot: true,
        });
      }
    }),
    http.get(`${base}/users/@me/guilds`, ({ request }) => {
      if (
        !active ||
        request.headers.get("authorization") !== `Bearer ${accessToken}`
      ) {
        return;
      }
      const after = new URL(request.url).searchParams.get("after");
      return HttpResponse.json(
        after && after !== "0"
          ? []
          : [
              {
                id: identity.guildId,
                name: identity.guildName,
                owner: args.flow === "install",
                permissions: args.flow === "install" ? "8" : "0",
                features: [],
              },
            ],
      );
    }),
    http.post(`${base}/users/@me/channels`, async ({ request }) => {
      if (!active) {
        return;
      }
      const body = z
        .object({ recipient_id: z.string() })
        .parse(await request.json());
      if (body.recipient_id !== identity.discordUserId) {
        return;
      }
      return HttpResponse.json({
        id: dmChannelId,
        type: 1,
        recipients: [{ id: identity.discordUserId, username: "member" }],
      });
    }),
    http.get(`${base}/channels/${dmChannelId}`, () => {
      if (!active) {
        return;
      }
      return HttpResponse.json({
        id: dmChannelId,
        type: 1,
        recipients: [{ id: identity.discordUserId, username: "member" }],
      });
    }),
    http.post(
      `${base}/channels/${dmChannelId}/messages`,
      async ({ request }) => {
        if (!active) {
          return;
        }
        const body = z
          .object({ content: z.string() })
          .parse(await request.json());
        return HttpResponse.json({
          id: uniqueDiscordSnowflake(),
          channel_id: dmChannelId,
          author: { id: identity.botUserId, username: "Okou", bot: true },
          content: body.content,
          timestamp: new Date(now()).toISOString(),
          attachments: [],
        });
      },
    ),
    http.get(`${base}/guilds/${identity.guildId}/roles`, () => {
      if (!active) {
        return;
      }
      return HttpResponse.json([
        { id: identity.guildId, name: "@everyone", permissions: "8" },
      ]);
    }),
    http.get(`${base}/guilds/${identity.guildId}`, () => {
      if (!active) {
        return;
      }
      return HttpResponse.json({
        id: identity.guildId,
        name: identity.guildName,
        owner_id: identity.discordUserId,
      });
    }),
    http.get(
      `${base}/guilds/${identity.guildId}/members/:userId`,
      ({ params }) => {
        if (!active) {
          return;
        }
        const id = String(params.userId);
        if (id !== identity.discordUserId && id !== identity.botUserId) {
          return;
        }
        return HttpResponse.json({
          user: { id, username: "member", bot: id === identity.botUserId },
          roles: [],
        });
      },
    ),
  );
  async function completeBinding(): Promise<DiscordFixture> {
    const oauth = setupApp({ context, routes: discordOauthRoutes })(
      discordOauthContract,
    );
    const started = await accept(
      oauth.start({
        headers: { authorization: "Bearer clerk-session" },
        body: { flow: args.flow, guildId: identity.guildId },
      }),
      [200],
    );
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Discord OAuth start did not issue state");
    }
    const completionToken = started.body.completionToken;
    const callback = await accept(
      oauth.callback({
        query: {
          code,
          state,
          ...(args.flow === "install" ? { guild_id: identity.guildId } : {}),
        },
      }),
      [307],
    );
    const location = callback.headers.get("location");
    if (!location) {
      throw new Error(
        "Discord OAuth callback did not return its approval landing",
      );
    }
    const landing = new URL(location);
    const fragment = new URLSearchParams(landing.hash.slice(1));
    const approvalProof = fragment.get("approval_proof");
    if (
      landing.origin !== new URL(env("APP_URL")).origin ||
      landing.pathname !== "/works" ||
      landing.searchParams.get("discord") !== "pending" ||
      fragment.get("discord_oauth") !== "approve" ||
      fragment.get("state") !== state ||
      !approvalProof
    ) {
      // Never log the fragment: the consent browser alone owns this proof.
      throw new Error(
        "Discord OAuth callback did not reach the approval landing",
      );
    }
    // Consent browser and opener authenticate independently as the real owner.
    // The consent proof is never passed to the opener's complete request.
    createRouteMocks(context).clerk.session(
      args.userId,
      args.orgId,
      args.orgRole,
    );
    await accept(
      oauth.approve({
        headers: { authorization: "Bearer clerk-session" },
        body: { state, approvalProof },
      }),
      [200],
    );
    createRouteMocks(context).clerk.session(
      args.userId,
      args.orgId,
      args.orgRole,
    );
    const completed = await accept(
      oauth.complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { state, completionToken },
      }),
      [200],
    );
    if (
      completed.body.status !==
      (args.flow === "install" ? "installed" : "connected")
    ) {
      throw new Error(
        "Discord OAuth completion returned the wrong flow status",
      );
    }
    const status = await accept(
      setupApp({ context, routes: integrationsDiscordRoutes })(
        integrationsDiscordContract,
      ).getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const connection = status.body.dmBindings.find((binding) => {
      return binding.guildId === identity.guildId;
    });
    if (
      !status.body.isConnected ||
      status.body.discordUserId !== identity.discordUserId ||
      status.body.guildId !== identity.guildId ||
      status.body.guildName === null ||
      !connection
    ) {
      throw new Error(
        `Discord OAuth did not expose the connected binding: ${JSON.stringify(status.body)}`,
      );
    }
    return {
      ...identity,
      guildId: status.body.guildId,
      guildName: status.body.guildName,
      discordUserId: status.body.discordUserId,
      connectionId: connection.connectionId,
    };
  }
  return completeBinding().finally(() => {
    active = false;
  });
}

/** Disconnect as the actual member; only the installer may uninstall. */
export async function removePublicDiscordBinding(
  context: TestContext,
  fixture: DiscordFixture,
): Promise<void> {
  createRouteMocks(context).clerk.session(
    fixture.userId,
    fixture.orgId,
    fixture.orgRole,
  );
  const client = setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  await accept(
    client.disconnect({ headers, query: { action: "disconnect" } }),
    [200, 403, 404],
  );
  if (fixture.flow === "install") {
    await accept(
      client.disconnect({ headers, query: { action: "uninstall" } }),
      [200, 403, 404],
    );
  }
}
