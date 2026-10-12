import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  configureDiscordApp,
  mockDiscordApplication,
  createPublicDiscordBinding,
  removePublicDiscordBinding,
  mockDiscordMemberships,
  uniqueDiscordSnowflake,
  type DiscordActor,
  type DiscordFixture,
} from "./helpers/discord";
import {
  DISCORD_TEST_APPLICATION_ID,
  DISCORD_TEST_GATEWAY_SECRET,
  postDiscordGatewayEnvelope,
  setupConnectedDiscordActor,
  mockDiscordProvider,
  discordMessageForTest,
  postDiscordMessage,
} from "./helpers/discord-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function actor(args: Partial<ApiTestUser> = {}) {
  const value = bdd.user(args);
  if (!value.orgId) {
    throw new Error("Discord account-erasure tests require an organization");
  }
  return { ...value, orgId: value.orgId, orgRole: args.orgRole ?? "org:admin" };
}
function client(user: DiscordActor) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
}

test("erases a non-installer across surviving guilds, preserves other bindings, and tolerates repeated delivery", async () => {
  configureDiscordApp();
  mockEnv("DISCORD_APPLICATION_ID", DISCORD_TEST_APPLICATION_ID);
  mockEnv("DISCORD_GATEWAY_SECRET", DISCORD_TEST_GATEWAY_SECRET);
  const firstOwner = actor();
  const secondOwner = actor();
  const unrelatedOwner = actor();
  const removed = actor({ orgId: firstOwner.orgId, orgRole: "org:member" });
  const removedElsewhere = actor({
    orgId: secondOwner.orgId,
    orgRole: "org:member",
    userId: removed.userId,
    email: removed.email,
  });
  const successor = actor({ orgId: firstOwner.orgId, orgRole: "org:member" });
  const survivors = [firstOwner, secondOwner, unrelatedOwner, successor];
  mockDiscordMemberships(context, [...survivors, removed, removedElsewhere]);
  for (const user of [...survivors, removed, removedElsewhere]) {
    await updateFeatureSwitchesForUser(context, user, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
  }
  const installations: DiscordFixture[] = [];
  for (const user of [firstOwner, secondOwner, unrelatedOwner]) {
    installations.push(
      await createPublicDiscordBinding(context, {
        ...user,
        flow: "install",
        botUserId: DISCORD_TEST_APPLICATION_ID,
      }),
    );
  }
  onTestFinished(async () => {
    mockDiscordMemberships(context, survivors);
    for (const binding of installations) {
      await removePublicDiscordBinding(context, binding);
    }
  });
  const first = await createPublicDiscordBinding(context, {
    ...removed,
    flow: "connect",
    guildId: installations[0]!.guildId,
    botUserId: DISCORD_TEST_APPLICATION_ID,
  });
  await createPublicDiscordBinding(context, {
    ...removedElsewhere,
    flow: "connect",
    guildId: installations[1]!.guildId,
    botUserId: DISCORD_TEST_APPLICATION_ID,
    discordUserId: first.discordUserId,
  });
  await accept(
    client(removed).setDmSelection({
      headers,
      body: { connectionId: first.connectionId },
    }),
    [200],
  );
  const before = await accept(client(removed).getStatus({ headers }), [200]);
  expect(before.body.dmBindings).toHaveLength(2);
  expect(before.body.dmSelectionConnectionId).toBe(first.connectionId);

  mockDiscordMemberships(context, survivors);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  async function erase() {
    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: removed.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
  }
  await erase();
  await erase();
  for (const [index, user] of [
    firstOwner,
    secondOwner,
    unrelatedOwner,
  ].entries()) {
    const status = await accept(client(user).getStatus({ headers }), [200]);
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      guildId: installations[index]!.guildId,
      discordUserId: installations[index]!.discordUserId,
    });
  }
  // The provider remains a legitimate caller after Okou account erasure.
  for (const installation of installations.slice(0, 2)) {
    const messageId = uniqueDiscordSnowflake();
    const response = await postDiscordGatewayEnvelope(context, {
      version: 1,
      applicationId: DISCORD_TEST_APPLICATION_ID,
      eventType: "MESSAGE_CREATE",
      eventId: `MESSAGE_CREATE:${messageId}`,
      payload: {
        id: messageId,
        channel_id: uniqueDiscordSnowflake(),
        guild_id: installation.guildId,
        author: { id: first.discordUserId, username: "member" },
        content: `<@${DISCORD_TEST_APPLICATION_ID}> erased account must have no ingress authority`,
        mentions: [{ id: DISCORD_TEST_APPLICATION_ID, username: "Okou" }],
        attachments: [],
        timestamp: new Date(now()).toISOString(),
        type: 0,
      },
    });
    expect(response.body).toMatchObject({
      outcome: "ignored",
      reason: "unbound-disabled-or-dm-selection-required",
    });
  }
  const reclaimed = await createPublicDiscordBinding(context, {
    ...successor,
    flow: "connect",
    guildId: first.guildId,
    botUserId: DISCORD_TEST_APPLICATION_ID,
    discordUserId: first.discordUserId,
  });
  const status = await accept(client(successor).getStatus({ headers }), [200]);
  expect(status.body.dmBindings).toStrictEqual([
    expect.objectContaining({ connectionId: reclaimed.connectionId }),
  ]);
  expect(status.body.dmSelectionConnectionId).toBeNull();
});

test("account erasure during provider context import revokes ingress and keeps the shared installation usable by a peer", async () => {
  const removed = await setupConnectedDiscordActor(context);
  const peer = actor({ orgId: removed.orgId });
  mockDiscordMemberships(context, [removed, peer]);
  await updateFeatureSwitchesForUser(context, peer, {
    [FeatureSwitchKey.DiscordIntegration]: true,
  });
  const peerBinding = await createPublicDiscordBinding(context, {
    ...peer,
    flow: "connect",
    guildId: removed.guildId,
    botUserId: removed.botUserId,
  });
  const reading = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve();
    }
    mockDiscordMemberships(context, [peer]);
    await removePublicDiscordBinding(context, peerBinding);
    await accept(
      client(peer).disconnect({
        headers,
        query: { action: "uninstall" },
      }),
      [200, 403, 404],
    );
  });
  const provider = mockDiscordProvider(removed);
  provider.state.historyResponse = async () => {
    reading.resolve();
    await release.promise;
    return undefined;
  };
  mockDiscordApplication(1 << 19);
  const message = discordMessageForTest(removed, {
    channelId: provider.guildChannelId,
    content: `<@${removed.botUserId}> revoke this context during account erasure`,
  });
  provider.messages.set(message.id, message);
  const admitted = await postDiscordMessage(context, message);
  expect(admitted.body.outcome).toBe("accepted");
  const processing = flushWaitUntilForTest();
  const result = await settleIncludingAbort(async () => {
    await Promise.race([
      reading.promise,
      processing.then(() => {
        if (!reading.settled()) {
          throw new Error("Ingress ended before the provider context read");
        }
      }),
    ]);
    mockDiscordMemberships(context, [peer]);
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: removed.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    // The earlier drain owns the blocked ingress; this one awaits the deletion.
    await flushWaitUntilForTest();
  });
  if (!release.settled()) {
    release.resolve();
  }
  await processing;
  if (!result.ok) {
    throw result.error;
  }
  const status = await accept(client(peer).getStatus({ headers }), [200]);
  expect(status.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    guildId: removed.guildId,
    discordUserId: peerBinding.discordUserId,
  });
  expect(provider.sentMessages).toHaveLength(0);
  const ignored = await postDiscordMessage(
    context,
    discordMessageForTest(removed, {
      channelId: provider.guildChannelId,
      content: `<@${removed.botUserId}> no post-erasure authority`,
    }),
  );
  expect(ignored.body.outcome).toBe("ignored");
});
