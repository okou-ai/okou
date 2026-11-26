import { randomUUID } from "node:crypto";

import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPreferencesContract,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import {
  MY_OKOU_WELCOME_THREAD_ASSETS,
  WELCOME_THREAD_ASSETS,
} from "@okouai/core/welcome-thread-assets";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";
import { userPreferencesRoutes } from "../user-preferences";
import { welcomeChatThreadRoutes } from "../welcome-chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };
const appUrl = "https://pr-33252-app.omby.ai";
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const providers = createAuthDeviceSupportApi(context);

interface Member {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole?: ApiTestUser["orgRole"];
}

function newMember(): Member {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(member: Member) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole ?? "org:member",
  );
  return setupApp({
    context,
    routes: [
      ...welcomeChatThreadRoutes,
      ...chatThreadRoutes,
      ...chatThreadConnectorSelectionRoutes,
      ...chatThreadModelSelectionRoutes,
      ...userPreferencesRoutes,
    ],
  });
}

async function createWelcome(member: Member) {
  const created = await accept(
    signIn(member)(welcomeChatThreadsContract).create({
      headers,
      body: { clientThreadId: randomUUID() },
    }),
    [201],
  );
  return created.body.id;
}

async function eventRows(member: Member, threadId: string) {
  const rows = await accept(
    signIn(member)(chatThreadEventsContract).rows({
      headers,
      params: { threadId },
      query: { sinceSeqId: 0 },
    }),
    [200],
  );
  return rows.body.rows;
}

async function selectedModel(member: Member, threadId: string) {
  const read = await accept(
    signIn(member)(chatThreadMetadataContract).get({
      headers,
      params: { id: threadId },
    }),
    [200],
  );
  return read.body.selectedModel;
}

/** Create a welcome thread for a new member who chose this locale. */
async function localizedWelcomeRows(locale: UserLocale) {
  mockEnv("APP_URL", appUrl);
  const member = newMember();
  await accept(
    signIn(member)(userPreferencesContract).initialize({
      headers,
      body: { locale },
    }),
    [200],
  );

  const threadId = await createWelcome(member);

  return await eventRows(member, threadId);
}

function expectMyOkouWelcome(row: unknown) {
  const content = JSON.stringify(row);
  expect(content).toContain("Instructions");
  expect(content).toContain("Workflow");
  expect(content).toContain(`${appUrl}/?settings=my-okou&focus=instructions)`);
  expect(content).toContain(`${appUrl}/?settings=people`);
  expect(content).toContain(
    "https://pr-33252-www.omby.ai/en/workflow-automation-examples",
  );
  expect(content).not.toContain("{{");
  for (const url of [
    WELCOME_THREAD_ASSETS.campaignVisualUrl,
    WELCOME_THREAD_ASSETS.presentationArtifactUrl,
    WELCOME_THREAD_ASSETS.websiteArtifactUrl,
    WELCOME_THREAD_ASSETS.slackSceneUrl,
    WELCOME_THREAD_ASSETS.telegramSceneUrl,
    ...Object.values(MY_OKOU_WELCOME_THREAD_ASSETS),
  ]) {
    expect(content).toContain(url);
  }
}

describe("POST /api/welcome-chat-threads", () => {
  it("welcome-chat-threads-006 delivers the My Okou welcome in en-US", async () => {
    const rows = await localizedWelcomeRows("en-US");

    expect(rows).toHaveLength(1);
    expectMyOkouWelcome(rows[0]);
  });

  it("welcome-chat-threads-007 delivers the My Okou welcome in pt-BR", async () => {
    const rows = await localizedWelcomeRows("pt-BR");

    expect(rows).toHaveLength(1);
    expectMyOkouWelcome(rows[0]);
  });

  it("welcome-chat-threads-008 delivers the My Okou welcome in ja-JP", async () => {
    const rows = await localizedWelcomeRows("ja-JP");

    expect(rows).toHaveLength(1);
    expectMyOkouWelcome(rows[0]);
  });

  it("welcome-chat-threads-015 delivers the My Okou welcome in hi-IN", async () => {
    const rows = await localizedWelcomeRows("hi-IN");

    expect(rows).toHaveLength(1);
    expectMyOkouWelcome(rows[0]);
  });

  it("welcome-chat-threads-016 delivers the My Okou welcome in zh-Hans", async () => {
    const rows = await localizedWelcomeRows("zh-Hans");

    expect(rows).toHaveLength(1);
    expectMyOkouWelcome(rows[0]);
  });

  it("welcome-chat-threads-018 inherits the member's chat model at creation", async () => {
    const member = bdd.user();
    bdd.acceptStorageWrites();
    await runs.ensurePersonalSubscriptionModel(member, {
      model: "claude-fable-5-1",
    });

    const threadId = await createWelcome(member);

    await expect(selectedModel(member, threadId)).resolves.toBe(
      "claude-fable-5-1",
    );
  });

  it("welcome-chat-threads-005 falls back to the fixed default model without generation credits", async () => {
    const member = bdd.user();
    bdd.acceptStorageWrites();
    await bdd.completeOnboarding(member);
    await publicPlanLifecycle(context, member, "pro").update("canceled");
    await runs.ensurePersonalSubscriptionModel(member);
    const deleted = await providers.deletePersonalModelProvider(
      member,
      "claude-code-oauth-token",
      [204],
    );
    expect(deleted.status).toBe(204);

    const threadId = await createWelcome(member);

    await expect(selectedModel(member, threadId)).resolves.toBe("auto");
    await expect(runs.readBillingStatus(member)).resolves.toMatchObject({
      credits: 0,
    });
    const rows = await eventRows(member, threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "output.message",
      runId: null,
    });
  });
});
