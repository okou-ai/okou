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
  removePublicDiscordBinding,
  mockDiscordMemberships,
  createPublicDiscordBinding,
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
  return { ...user, orgId: user.orgId, orgRole: args.orgRole ?? "org:admin" };
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
  const peer = actor({ orgId: departing.orgId, orgRole: "org:member" });
  const elsewhere = actor({ userId: departing.userId, email: departing.email });
  mockDiscordMemberships(context, [departing, peer, elsewhere]);
  await enable(departing);
  await enable(peer);
  await enable(elsewhere);
  const binding = await createPublicDiscordBinding(context, {
    ...departing,
    flow: "install",
  });
  const peerBinding = await createPublicDiscordBinding(context, {
    ...peer,
    flow: "connect",
    guildId: binding.guildId,
    botUserId: binding.botUserId,
  });
  const otherBinding = await createPublicDiscordBinding(context, {
    ...elsewhere,
    flow: "install",
    discordUserId: binding.discordUserId,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [peer, elsewhere]);
    await removePublicDiscordBinding(context, peerBinding);
    await removePublicDiscordBinding(context, otherBinding);
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
  // The departed member is no longer a current-org observer. Surviving
  // members and the same user's other membership can verify isolation.
  mockDiscordMemberships(context, [peer, elsewhere]);
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

test("preserves a shared OAuth installation and peers after installer account erasure while releasing the erased sender", async () => {
  configureDiscordApp();
  const installer = actor();
  const peer = actor({ orgId: installer.orgId });
  const claimant = actor({ orgId: installer.orgId, orgRole: "org:member" });
  mockDiscordMemberships(context, [installer, peer, claimant]);
  for (const user of [installer, peer, claimant]) {
    await enable(user);
  }
  const binding = await createPublicDiscordBinding(context, {
    ...installer,
    flow: "install",
  });
  const peerBinding = await createPublicDiscordBinding(context, {
    ...peer,
    flow: "connect",
    guildId: binding.guildId,
    botUserId: binding.botUserId,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [peer, claimant]);
    await removePublicDiscordBinding(context, peerBinding);
    await accept(
      discordClient(peer).disconnect({
        headers: authHeaders(),
        query: { action: "uninstall" },
      }),
      [200, 404],
    );
  });
  // Provider membership now contains only the real surviving users. Do not
  // restore the erased account merely to obtain a post-erasure observer.
  mockDiscordMemberships(context, [peer, claimant]);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "user.deleted",
    data: { id: installer.userId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  const peerStatus = await accept(
    discordClient(peer).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(peerStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    guildId: binding.guildId,
    discordUserId: peerBinding.discordUserId,
  });
  expect(peerStatus.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: peerBinding.connectionId }),
  ]);
  const reclaimed = await createPublicDiscordBinding(context, {
    ...claimant,
    flow: "connect",
    guildId: binding.guildId,
    botUserId: binding.botUserId,
    discordUserId: binding.discordUserId,
  });
  const reclaimedStatus = await accept(
    discordClient(claimant).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(reclaimedStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    discordUserId: binding.discordUserId,
  });
  expect(reclaimedStatus.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: reclaimed.connectionId }),
  ]);
});

test("releases an erased organization's guild and sender through the provider lifecycle without removing another organization", async () => {
  configureDiscordApp();
  const removed = actor();
  const elsewhere = actor({ userId: removed.userId, email: removed.email });
  const successor = actor();
  mockDiscordMemberships(context, [removed, elsewhere, successor]);
  for (const user of [removed, elsewhere, successor]) {
    await enable(user);
  }
  const binding = await createPublicDiscordBinding(context, {
    ...removed,
    flow: "install",
  });
  const otherBinding = await createPublicDiscordBinding(context, {
    ...elsewhere,
    flow: "install",
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [elsewhere, successor]);
    await removePublicDiscordBinding(context, otherBinding);
    await accept(
      discordClient(successor).disconnect({
        headers: authHeaders(),
        query: { action: "uninstall" },
      }),
      [200, 404],
    );
  });
  mockDiscordMemberships(context, [elsewhere, successor]);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: removed.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  const otherStatus = await accept(
    discordClient(elsewhere).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(otherStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    guildId: otherBinding.guildId,
    discordUserId: otherBinding.discordUserId,
  });
  expect(otherStatus.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: otherBinding.connectionId }),
  ]);
  const replacement = await createPublicDiscordBinding(context, {
    ...successor,
    flow: "install",
    guildId: binding.guildId,
    botUserId: binding.botUserId,
    discordUserId: binding.discordUserId,
  });
  const replacementStatus = await accept(
    discordClient(successor).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(replacementStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    guildId: binding.guildId,
    discordUserId: binding.discordUserId,
  });
  expect(replacementStatus.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: replacement.connectionId }),
  ]);
});
