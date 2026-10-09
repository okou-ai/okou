import { randomUUID } from "node:crypto";

import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  configureDiscordApp,
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
  type DiscordActor,
} from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);

function actor(args: Partial<ApiTestUser> = {}) {
  const user = bdd.user(args);
  if (!user.orgId) {
    throw new Error("Discord lifecycle tests require an organization");
  }
  return { ...user, orgId: user.orgId, orgRole: "org:admin" as const };
}

function discordClient(user: DiscordActor) {
  mocks.clerk.session(user.userId, user.orgId, user.orgRole ?? "org:admin");
  return setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function enable(user: DiscordActor) {
  await updateFeatureSwitchesForUser(context, user, {
    [FeatureSwitchKey.DiscordIntegration]: true,
  });
}

test("removes a departed member's binding only in the affected organization", async () => {
  configureDiscordApp();
  const departing = actor();
  const peer = actor({ orgId: departing.orgId });
  const elsewhere = actor({ userId: departing.userId, email: departing.email });
  mockDiscordMemberships(context, [departing, peer, elsewhere]);
  await enable(departing);
  await enable(peer);
  await enable(elsewhere);
  const binding = await seedDiscordFixture(context, departing);
  const peerBinding = await seedDiscordFixture(context, {
    ...peer,
    guildId: binding.guildId,
    botUserId: binding.botUserId,
  });
  const otherBinding = await seedDiscordFixture(context, {
    ...elsewhere,
    discordUserId: binding.discordUserId,
  });
  onTestFinished(async () => {
    await deleteDiscordFixture(context, peerBinding);
    await deleteDiscordFixture(context, otherBinding);
  });
  await accept(
    discordClient(departing).setDmSelection({
      headers: authHeaders(),
      body: { connectionId: binding.connectionId },
    }),
    [200],
  );
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.deleted",
    data: {
      id: `orgmem_${randomUUID()}`,
      organization_id: departing.orgId,
      user_id: departing.userId,
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  const removed = await accept(
    discordClient(departing).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(removed.body).toMatchObject({
    isInstalled: true,
    isConnected: false,
    dmSelectionConnectionId: null,
  });
  const peerStatus = await accept(
    discordClient(peer).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(peerStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    discordUserId: peerBinding.discordUserId,
  });
  const elsewhereStatus = await accept(
    discordClient(elsewhere).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(elsewhereStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    dmSelectionConnectionId: null,
  });
  expect(elsewhereStatus.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: otherBinding.connectionId }),
  ]);
});
