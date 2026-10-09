import { createBddApi } from "./helpers/api-bdd";
import { configureDiscordApp } from "./helpers/discord";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRouteMocks } from "./helpers/route-test";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { integrationsDiscordRoutes } from "../integrations-discord";
const context = testContext();
function client() {
  return setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
}
async function expectDiscordChanges(userIds: readonly string[]): Promise<void> {
  await flushWaitUntilForTest();
  expect(
    [...channelsPublishedTo(context.mocks, "discord:changed")].sort(),
  ).toStrictEqual(
    userIds
      .map((userId) => {
        return `user:${userId}`;
      })
      .sort(),
  );
  expect(
    context.mocks.ably.publish.mock.calls
      .filter((call) => {
        return call[0] === "discord:changed";
      })
      .map((call) => {
        return call[1];
      }),
  ).toStrictEqual(
    userIds.map(() => {
      return null;
    }),
  );
}

describe("Discord integration settings before OAuth is available", () => {
  it("requires authenticated organization membership", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymousStatus = await accept(
      client().getStatus({ headers: {} }),
      [401],
    );
    expect(anonymousStatus.status).toBe(401);
    await accept(client().disconnect({ headers: {}, query: {} }), [401]);
    await accept(
      client().setDmSelection({
        headers: {},
        body: { connectionId: randomUUID() },
      }),
      [401],
    );

    createRouteMocks(context).clerk.session(`user_${randomUUID()}`, null);
    const withoutOrganization = await accept(
      client().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(withoutOrganization.status).toBe(401);
    await expectDiscordChanges([]);
  });
});

test("keeps Discord unavailable for an ordinary workspace before feature enrollment", async () => {
  configureDiscordApp();
  const actor = createBddApi(context).user();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  const status = await accept(
    client().getStatus({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  expect(status.body).toMatchObject({
    isAvailable: false,
    isInstalled: false,
    isConnected: false,
    guildId: null,
    discordUserId: null,
    contextMode: "unavailable",
    onboarding: "oauth_deferred",
    dmBindings: [],
  });
  await expectDiscordChanges([]);
});
