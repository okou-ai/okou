import { randomBytes, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
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
            organization: { id: actor.orgId, name: "Discord test workspace" },
          };
        }),
        totalCount: matches.length,
      });
    },
  );
}

/** IDs configure Discord's external responses, never proof sent to Okou. */
export async function createPublicDiscordBinding(
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
  const code = randomUUID();
  const accessToken = `discord-access-${randomUUID()}`;
  const base = "https://discord.com/api/v10";
  let active = true;
  // These handlers own only this finite OAuth exchange. They fall through for
  // unrelated bearer identities and all later native bot requests. Central
  // test-context cleanup resets registration after the case.
  server.use(
    http.post(`${base}/oauth2/token`, async ({ request }) => {
      if (!active) {
        return;
      }
      const body = new URLSearchParams(await request.text());
      if (body.get("code") !== code) {
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
    http.get(`${base}/users/@me`, ({ request }) => {
      if (!active) {
        return;
      }
      const authorization = request.headers.get("authorization");
      if (authorization === `Bearer ${accessToken}`) {
        return HttpResponse.json({
          id: identity.discordUserId,
          username: "member",
        });
      }
      if (authorization?.startsWith("Bot ")) {
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
        after
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
        return HttpResponse.json({
          user: { id, username: "member", bot: id === identity.botUserId },
          roles: [],
        });
      },
    ),
  );
  try {
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
    const cookie = started.headers.get("set-cookie")?.split(";")[0];
    await accept(
      oauth.callback({
        headers: cookie ? { cookie } : {},
        query: {
          code,
          state,
          ...(args.flow === "install" ? { guild_id: identity.guildId } : {}),
        },
      }),
      [307],
    );
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
      !connection
    ) {
      throw new Error(
        `Discord OAuth did not expose the connected binding: ${JSON.stringify(status.body)}`,
      );
    }
    return { ...identity, connectionId: connection.connectionId };
  } finally {
    active = false;
  }
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
