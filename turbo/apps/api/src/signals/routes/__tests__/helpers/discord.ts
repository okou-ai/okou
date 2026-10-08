import { randomBytes } from "node:crypto";
import { z } from "zod";
import { testDiscordStateContract } from "@okouai/api-contracts/contracts/test-discord-state";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { discordStatePreviewRoutes } from "../../discord-state-preview";
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

export async function seedDiscordFixture(
  context: TestContext,
  args: DiscordActor & {
    readonly guildId?: string;
    readonly guildName?: string;
    readonly botUserId?: string;
    readonly discordUserId?: string;
    readonly history?: {
      readonly chatThreadId: string;
      readonly channelId: string;
      readonly messageId: string;
      readonly messageText: string;
    };
  },
): Promise<DiscordFixture> {
  mockEnv("ENV", "development");
  createRouteMocks(context).clerk.session(
    args.userId,
    args.orgId,
    args.orgRole,
  );
  const fixture = {
    orgId: args.orgId,
    userId: args.userId,
    orgRole: args.orgRole,
    guildId: args.guildId ?? uniqueDiscordSnowflake(),
    guildName: args.guildName ?? "Discord test guild",
    botUserId: args.botUserId ?? "123456789012345678",
    discordUserId: args.discordUserId ?? uniqueDiscordSnowflake(),
  };
  const response = await accept(
    setupApp({ context, routes: discordStatePreviewRoutes })(
      testDiscordStateContract,
    ).post({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        guildId: fixture.guildId,
        guildName: fixture.guildName,
        botUserId: fixture.botUserId,
        discordUserId: fixture.discordUserId,
        ...(args.history ? { history: args.history } : {}),
      },
    }),
    [200],
  );
  return { ...fixture, connectionId: response.body.connectionId };
}

export async function deleteDiscordFixture(
  context: TestContext,
  fixture: DiscordFixture,
): Promise<void> {
  mockEnv("ENV", "development");
  createRouteMocks(context).clerk.session(
    fixture.userId,
    fixture.orgId,
    "org:admin",
  );
  await accept(
    setupApp({ context, routes: discordStatePreviewRoutes })(
      testDiscordStateContract,
    ).delete({
      headers: { authorization: "Bearer clerk-session" },
      query: { guildId: fixture.guildId },
    }),
    [200],
  );
}
