import { randomUUID } from "node:crypto";

import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { expect, test, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  configureDiscordApp,
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
  uniqueDiscordSnowflake,
  type DiscordActor,
} from "./helpers/discord";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
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

async function exportWork(
  user: ApiTestUser,
  jobId: string,
  action: "run" | "delete",
) {
  return await accept(
    setupApp({ context, routes: testUserExportWorkRoutes })(
      testUserExportWorkContract,
    ).action({ body: { userId: user.userId, jobId, action, maxSteps: 200 } }),
    [200],
  );
}

test("exports every owned Discord record, including pre-route ingress, without another member's data", async () => {
  configureDiscordApp();
  const owner = actor();
  const peer = actor({ orgId: owner.orgId });
  mockDiscordMemberships(context, [owner, peer]);
  await enable(owner);
  await enable(peer);
  const storage = installDurableUserExportStorage(context);
  await createRunsApi(context).ensureOrgModelProvider(owner);
  const ownerAgent = await bdd.createAgent(owner, {
    displayName: "Export owner",
  });
  const peerAgent = await bdd.createAgent(peer, { displayName: "Export peer" });
  const chat = createChatFilesBddApi(context);
  const ownerThread = await chat.createThread(owner, {
    agentId: ownerAgent.agentId,
  });
  const peerThread = await chat.createThread(peer, {
    agentId: peerAgent.agentId,
  });
  const owned = await seedDiscordFixture(context, {
    ...owner,
    history: {
      chatThreadId: ownerThread.id,
      channelId: uniqueDiscordSnowflake(),
      messageId: uniqueDiscordSnowflake(),
      messageText: "The export owner's Discord message",
    },
  });
  onTestFinished(async () => {
    await deleteDiscordFixture(context, owned);
  });
  const unrelated = await seedDiscordFixture(context, {
    ...peer,
    guildId: owned.guildId,
    botUserId: owned.botUserId,
    history: {
      chatThreadId: peerThread.id,
      channelId: uniqueDiscordSnowflake(),
      messageId: uniqueDiscordSnowflake(),
      messageText: "Another member's private Discord message",
    },
  });
  await accept(
    discordClient(owner).setDmSelection({
      headers: authHeaders(),
      body: { connectionId: owned.connectionId },
    }),
    [200],
  );

  const api = createOpsLogsApi(context);
  const started = await api.requestPostUserExport(owner, [202]);
  onTestFinished(async () => {
    await exportWork(owner, started.body.jobId, "delete");
    const outbox = createEmailOutboxStateApi(context);
    const emails = await outbox.findItems({
      toAddress: owner.email,
      subject: "Your data export is ready",
    });
    if (emails.length > 0) {
      await outbox.deleteItems(
        emails.map((email) => {
          return email.id;
        }),
      );
    }
  });
  await flushWaitUntilForTest();
  await exportWork(owner, started.body.jobId, "run");
  const status = await api.requestGetUserExport(owner, [200]);
  expect(status.body.job).toMatchObject({ status: "completed", error: null });
  if (!status.body.job?.downloadUrl) {
    throw new Error("Expected completed Discord export download");
  }
  const zip = new AdmZip(storage.download(status.body.job.downloadUrl));
  const entries = zip.getEntries().filter((entry) => {
    return entry.entryName.startsWith("integrations/discord/");
  });
  const counts = Object.fromEntries(
    [
      "installations",
      "connections",
      "agent-preferences",
      "dm-preferences",
      "routes",
      "ingress",
      "contexts",
    ].map((kind) => {
      return [
        kind,
        entries.filter((entry) => {
          return entry.entryName.startsWith(`integrations/discord/${kind}/`);
        }).length,
      ];
    }),
  );
  expect(counts).toStrictEqual({
    installations: 1,
    connections: 1,
    "agent-preferences": 1,
    "dm-preferences": 1,
    routes: 1,
    ingress: 2,
    contexts: 1,
  });
  const exported = entries
    .map((entry) => {
      return entry.getData().toString("utf8");
    })
    .join("\n");
  expect(exported).toContain(owned.connectionId);
  expect(exported).toContain("The export owner's Discord message");
  expect(exported).toContain("Accepted before route creation");
  expect(exported).not.toContain(unrelated.connectionId);
  expect(exported).not.toContain(unrelated.discordUserId);
  expect(exported).not.toContain("Another member's private Discord message");
  expect(exported).not.toContain("claimToken");
});

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

test("holds user bindings across a concurrent guild uninstall and preserves another guild's members", async () => {
  configureDiscordApp();
  mocks.s3.listObjects([]);
  const departing = actor();
  const admin = actor({ orgId: departing.orgId });
  const elsewhere = actor({ userId: departing.userId, email: departing.email });
  const survivor = actor({ orgId: elsewhere.orgId });
  mockDiscordMemberships(context, [departing, admin, elsewhere, survivor]);
  for (const user of [departing, admin, elsewhere, survivor]) {
    await enable(user);
  }
  const binding = await seedDiscordFixture(context, departing);
  onTestFinished(async () => {
    await deleteDiscordFixture(context, { ...binding, ...admin });
  });
  await seedDiscordFixture(context, {
    ...admin,
    guildId: binding.guildId,
    botUserId: binding.botUserId,
  });
  const otherBinding = await seedDiscordFixture(context, {
    ...elsewhere,
    discordUserId: binding.discordUserId,
  });
  onTestFinished(async () => {
    await deleteDiscordFixture(context, { ...otherBinding, ...survivor });
  });
  const survivingBinding = await seedDiscordFixture(context, {
    ...survivor,
    guildId: otherBinding.guildId,
    botUserId: otherBinding.botUserId,
  });
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "user.deleted",
    data: { id: departing.userId, deleted: true },
  });

  // The user-deletion hold does not enter Discord owner cleanup. It must not
  // block a distinct guild uninstall or touch another guild's member rows.
  const [acknowledged, uninstalledGuild] = await Promise.all([
    webhooks.requestClerkWebhook("{}", {}, [200]),
    accept(
      discordClient(admin).disconnect({
        headers: authHeaders(),
        query: { action: "uninstall" },
      }),
      [200],
    ),
  ]);
  expect(acknowledged.status).toBe(200);
  expect(uninstalledGuild.body).toStrictEqual({ ok: true });
  await flushWaitUntilForTest();

  const uninstalled = await accept(
    discordClient(admin).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(uninstalled.body).toMatchObject({
    isAvailable: true,
    isInstalled: false,
    isConnected: false,
  });
  // The user's second binding remains pending, while the other guild and
  // surviving member remain usable.
  const removed = await accept(
    discordClient(elsewhere).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(removed.body).toMatchObject({
    isAvailable: true,
    isInstalled: true,
    guildId: otherBinding.guildId,
    isConnected: true,
    discordUserId: otherBinding.discordUserId,
    dmBindings: [
      expect.objectContaining({ connectionId: otherBinding.connectionId }),
    ],
  });
  const preserved = await accept(
    discordClient(survivor).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(preserved.body).toMatchObject({
    isAvailable: true,
    isInstalled: true,
    isConnected: true,
    guildId: otherBinding.guildId,
    discordUserId: survivingBinding.discordUserId,
  });
});
