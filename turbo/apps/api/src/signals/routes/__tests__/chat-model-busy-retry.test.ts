import { randomUUID } from "node:crypto";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const callbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const BINGJIE_USER_ID = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";

async function setEnabled(actor: ApiTestUser, enabled: boolean) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches: { [FeatureSwitchKey.AutoContinueBusyChats]: enabled } },
    }),
    [200],
  );
}

async function setupFixture(userId = BINGJIE_USER_ID) {
  const cron = setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
    cronProcessBackgroundJobsContract,
  );
  mockNow(nowDate());
  const actor = bdd.user({ userId });
  callbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  callbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Busy retry agent",
    description: "Busy recovery test",
    visibility: "private",
  });
  const owned = publicRunOwner(context, actor, {
    beforeRuns: async () => {
      await setEnabled(actor, false);
    },
    afterRuns: async () => {
      await bdd.deleteAgent(actor, agent.agentId);
    },
  });
  async function runs(threadId: string) {
    const page = await chat.listThreadEvents(actor, threadId);
    return page.events.flatMap((event) => {
      return event.eventType === "input.prompt" && event.runId
        ? [event.runId]
        : [];
    });
  }
  async function send(threadId?: string) {
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        clientEventId: randomUUID(),
        prompt: threadId ? "Continue manually" : "Finish the task",
        model: "claude-fable-5-1",
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected an accepted input");
    }
    await flushWaitUntilForTest();
    return sent.body.threadId;
  }
  async function fail(
    runId: string,
    failureReason: RunFailureReasonToken = "provider_overloaded",
  ) {
    await api.heartbeatRunner(runnerGroup);
    const claim = await accept(
      api.requestClaimRunnerJob(true, runId, [200]),
      [200],
    );
    owned.rememberClaim(runId, claim.body.sandboxToken);
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 1,
        error: "This model is busy right now",
        failureReason,
      },
      { authorization: `Bearer ${claim.body.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  }
  async function tick(milliseconds = 0) {
    mockNow(nowDate().getTime() + milliseconds);
    await accept(
      cron.process({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }
  return { actor, runs, send, fail, tick };
}

async function latestRun(
  fixture: Awaited<ReturnType<typeof setupFixture>>,
  threadId: string,
) {
  const runId = (await fixture.runs(threadId)).at(-1);
  if (!runId) {
    throw new Error("Expected a launched chat run");
  }
  return runId;
}

describe("Automatic continuation after a busy model", () => {
  it("continues newly created chats once per failure with bounded 1, 3, 5 minute backoff", async () => {
    // The real cron sweeps jobs across tenants.
    await setupApp({
      context,
      routes: cronProcessBackgroundJobsRoutes,
      isolatePg: true,
    });
    const fixture = await setupFixture();
    const threadId = await fixture.send();
    for (const [index, delay] of [60_000, 180_000, 300_000].entries()) {
      await fixture.fail(await latestRun(fixture, threadId));
      await fixture.tick(delay - 1);
      await expect(fixture.runs(threadId)).resolves.toHaveLength(index + 1);
      await Promise.all([fixture.tick(1), fixture.tick()]);
      await expect(fixture.runs(threadId)).resolves.toHaveLength(index + 2);
      await fixture.tick();
      await expect(fixture.runs(threadId)).resolves.toHaveLength(index + 2);
    }
    await fixture.fail(await latestRun(fixture, threadId));
    await fixture.tick(600_000);
    await expect(fixture.runs(threadId)).resolves.toHaveLength(4);
    const page = await chat.listThreadEvents(fixture.actor, threadId);
    expect(
      page.events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.runId !== undefined &&
          chatEventDisplayText(event) === "continue"
        );
      }),
    ).toHaveLength(3);

    // The cap belongs to the incident, not the account or another new chat.
    const another = await fixture.send();
    await fixture.fail(await latestRun(fixture, another));
    await fixture.tick(60_000);
    await expect(fixture.runs(another)).resolves.toHaveLength(2);
  });

  it("cancels waiting retries when the owner disables the switch", async () => {
    // The real cron sweeps jobs across tenants.
    await setupApp({
      context,
      routes: cronProcessBackgroundJobsRoutes,
      isolatePg: true,
    });
    const fixture = await setupFixture();
    const threadId = await fixture.send();
    await fixture.fail(await latestRun(fixture, threadId));
    await setEnabled(fixture.actor, false);
    await fixture.tick(60_000);
    await expect(fixture.runs(threadId)).resolves.toHaveLength(1);
  });

  it("stays off for other users until they explicitly opt in", async () => {
    const actor = bdd.user();
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const features = setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
    const initial = await accept(
      features.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      initial.body.effectiveSwitches[FeatureSwitchKey.AutoContinueBusyChats],
    ).toBeFalsy();
    const enabled = await setEnabled(actor, true);
    expect(
      enabled.body.effectiveSwitches[FeatureSwitchKey.AutoContinueBusyChats],
    ).toBeTruthy();
  });

  it("leaves a manual continuation alone", async () => {
    // The real cron sweeps jobs across tenants.
    await setupApp({
      context,
      routes: cronProcessBackgroundJobsRoutes,
      isolatePg: true,
    });
    const fixture = await setupFixture();
    const threadId = await fixture.send();
    await fixture.fail(await latestRun(fixture, threadId));
    await fixture.send(threadId);
    await fixture.tick(60_000);
    await expect(fixture.runs(threadId)).resolves.toHaveLength(2);
    await fixture.fail(
      await latestRun(fixture, threadId),
      "invalid_credentials",
    );
    await fixture.tick(60_000);
    await expect(fixture.runs(threadId)).resolves.toHaveLength(2);
    const page = await chat.listThreadEvents(fixture.actor, threadId);
    expect(
      page.events.some((event) => {
        return (
          event.eventType === "input.prompt" &&
          chatEventDisplayText(event) === "continue"
        );
      }),
    ).toBeFalsy();
  });

  it("does not resume a chat the user archived", async () => {
    // The real cron sweeps jobs across tenants.
    await setupApp({
      context,
      routes: cronProcessBackgroundJobsRoutes,
      isolatePg: true,
    });
    const fixture = await setupFixture();
    const threadId = await fixture.send();
    await fixture.fail(await latestRun(fixture, threadId));
    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { [FeatureSwitchKey.ChatThreadArchiving]: true } },
      }),
      [200],
    );
    await chat.requestSetThreadArchived(fixture.actor, threadId, true, [204]);
    await fixture.tick(60_000);
    await expect(fixture.runs(threadId)).resolves.toHaveLength(1);
  });
});
