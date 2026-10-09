import { randomBytes } from "node:crypto";
import { z } from "zod";
import { http, HttpResponse } from "msw";

import type { TestContext } from "../../../../__tests__/test-context";
import { env, mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";

interface DiscordActor {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: "org:admin" | "org:member";
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
  mockDiscordApplication(0);
}

function mockDiscordApplication(flags: number, flagsNew?: string): void {
  server.use(
    http.get("https://discord.com/api/v10/applications/@me", () => {
      return HttpResponse.json({
        id: env("DISCORD_APPLICATION_ID"),
        flags,
        ...(flagsNew !== undefined && { flags_new: flagsNew }),
      });
    }),
  );
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
