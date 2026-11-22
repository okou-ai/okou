import { cronSteerRunTimeBudgetContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronSteerRunTimeBudgetRoutes } from "../cron-steer-run-time-budget";
import { chatEventDisplayText } from "./helpers/chat-event";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  completeChatRunOk,
  cancelChatRun,
} = createChatEventsFixture(context);
const STEER_AT_MS = 115 * 60 * 1000;
const CRON_SECRET = "test-run-time-budget-steer-secret";

async function startBudgetRun() {
  const { actor, runnerGroup } = await entitledNativeChatActor();
  const active = await sendChatRun(actor, {
    prompt: "work until the runner's time-budget warning",
  });
  const execution = await runExecution(active.runId);
  const run = await api.readRun(actor, active.runId);
  if (!run.startedAt) {
    throw new Error("Expected the dispatched Run's public start time");
  }
  const startedAt = Date.parse(run.startedAt);
  return {
    actor,
    runnerGroup,
    active,
    receivedExecution: execution,
    startedAt,
    async requestBudgetHeartbeat() {
      await createWebhookCallbackApi(context).requestAgentHeartbeat(
        { runId: active.runId },
        execution.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    },
  };
}

async function startRunAtBudgetBoundary() {
  const started = await startBudgetRun();
  const {
    actor,
    active,
    receivedExecution,
    startedAt,
    requestBudgetHeartbeat,
  } = started;
  mockNow(startedAt + STEER_AT_MS - 1);
  await requestBudgetHeartbeat();
  expect(
    (await chat.listThreadEvents(actor, active.threadId)).events.filter(
      (event) => {
        return event.eventType === "input.budget";
      },
    ),
  ).toHaveLength(0);

  mockNow(startedAt + STEER_AT_MS);
  await requestBudgetHeartbeat();
  const budget = (
    await chat.listThreadEvents(actor, active.threadId)
  ).events.find((event) => {
    return event.eventType === "input.budget";
  });
  if (!budget || budget.eventType !== "input.budget") {
    throw new Error("Expected the heartbeat's run-targeted budget warning");
  }
  mockNow(startedAt + STEER_AT_MS + 1);
  await requestBudgetHeartbeat();
  expect(
    (await chat.listThreadEvents(actor, active.threadId)).events.filter(
      (event) => {
        return event.eventType === "input.budget";
      },
    ),
  ).toStrictEqual([budget]);
  expect(budget.runId).toBeUndefined();
  const prompt = chatEventDisplayText(budget);
  expect(prompt).toContain("leaving approximately 5 minutes");
  await expect(
    api.nextSteerableInput(
      receivedExecution.execution.sandboxToken,
      active.runId,
    ),
  ).resolves.toStrictEqual({ input: { eventId: budget.id, prompt } });
  return {
    ...started,
    budget,
    prompt,
    requestBudgetHeartbeat,
  };
}

describe("run-targeted time budget steering through HTTP", () => {
  it("the scheduled fallback warns active Runs and skips completed Runs", async () => {
    const app = await setupApp({
      context,
      routes: cronSteerRunTimeBudgetRoutes,
      isolatePg: true,
    });
    const { actor, active, receivedExecution, startedAt } =
      await startBudgetRun();
    const running = await startBudgetRun();
    await completeChatRunOk(active.runId, receivedExecution.sandboxHeaders);
    await flushWaitUntilForTest();
    mockNow(Math.max(startedAt, running.startedAt) + STEER_AT_MS);
    mockEnv("CRON_SECRET", CRON_SECRET);
    await accept(
      app(cronSteerRunTimeBudgetContract).steer({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    await expect(api.readRun(actor, active.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      (await chat.listThreadEvents(actor, active.threadId)).events.filter(
        (event) => {
          return event.eventType === "input.budget";
        },
      ),
    ).toHaveLength(0);
    expect(
      (await chat.listThreadEvents(running.actor, running.active.threadId))
        .events,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "input.budget" }),
      ]),
    );
    await cancelChatRun(
      running.actor,
      running.active.runId,
      running.receivedExecution.sandboxHeaders,
    );
  }, 90_000);

  it("consumes the warning once and retains its run identity on replay", async () => {
    const { actor, active, receivedExecution, budget } =
      await startRunAtBudgetBoundary();
    const token = receivedExecution.execution.sandboxToken;
    await expect(
      api.declareSteeredInput(token, active.runId, budget.id),
    ).resolves.toStrictEqual({ outcome: "steered" });
    await expect(
      api.declareSteeredInput(token, active.runId, budget.id),
    ).resolves.toStrictEqual({ outcome: "steered" });
    await expect(
      api.nextSteerableInput(token, active.runId),
    ).resolves.toStrictEqual({
      input: null,
    });
    const events = (await chat.listThreadEvents(actor, active.threadId)).events;
    const replacements = events.filter((event) => {
      return event.revokesEventId === budget.id;
    });
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      eventType: "input.budget",
      runId: active.runId,
      userMessage: budget.userMessage,
    });
    expect(
      events.filter((event) => {
        return event.eventType === "input.budget";
      }),
    ).toHaveLength(2);
    await cancelChatRun(actor, active.runId, receivedExecution.sandboxHeaders);
  }, 90_000);

  it("revokes an unsteered warning at completion and never gives it to the next run", async () => {
    const { actor, runnerGroup, active, receivedExecution, budget } =
      await startRunAtBudgetBoundary();
    await completeChatRunOk(active.runId, receivedExecution.sandboxHeaders);
    await flushWaitUntilForTest();
    const completed = (await chat.listThreadEvents(actor, active.threadId))
      .events;
    expect(
      completed.filter((event) => {
        return event.revokesEventId === budget.id;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        eventType: "control.revoke",
        runId: active.runId,
      }),
    ]);

    await createRunsApi(context).registerDirectRunner(runnerGroup);
    const successor = await sendChatRun(actor, {
      threadId: active.threadId,
      prompt: "continue after the prior run finished",
    });
    const successorExecution = await runExecution(successor.runId);
    await expect(
      api.nextSteerableInput(
        successorExecution.execution.sandboxToken,
        successor.runId,
      ),
    ).resolves.toStrictEqual({ input: null });
    await cancelChatRun(
      actor,
      successor.runId,
      successorExecution.sandboxHeaders,
    );
  }, 90_000);
  it("a Run heartbeat does not warn another owner's overdue Run", async () => {
    const first = await startBudgetRun();
    const other = await startBudgetRun();
    mockNow(Math.max(first.startedAt, other.startedAt) + STEER_AT_MS);
    await first.requestBudgetHeartbeat();
    expect(
      (await chat.listThreadEvents(first.actor, first.active.threadId)).events,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "input.budget" }),
      ]),
    );
    expect(
      (
        await chat.listThreadEvents(other.actor, other.active.threadId)
      ).events.filter((event) => {
        return event.eventType === "input.budget";
      }),
    ).toHaveLength(0);
    await other.requestBudgetHeartbeat();
    expect(
      (await chat.listThreadEvents(other.actor, other.active.threadId)).events,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "input.budget" }),
      ]),
    );
    await cancelChatRun(
      first.actor,
      first.active.runId,
      first.receivedExecution.sandboxHeaders,
    );
    await cancelChatRun(
      other.actor,
      other.active.runId,
      other.receivedExecution.sandboxHeaders,
    );
  }, 90_000);
  it("acknowledges a Run heartbeat while the budget notification provider is delayed", async () => {
    const started = await startBudgetRun();
    mockNow(started.startedAt + STEER_AT_MS);
    const notifying = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let released = false;
    let notified = false;
    function releaseNotification() {
      if (!released) {
        released = true;
        release.resolve();
      }
    }
    onTestFinished(releaseNotification);
    context.mocks.ably.publish.mockImplementation((name) => {
      if (name === "active-input") {
        if (!notified) {
          notified = true;
          notifying.resolve();
        }
        return release.promise;
      }
      return Promise.resolve();
    });
    const response = createWebhookCallbackApi(context).requestAgentHeartbeat(
      { runId: started.active.runId },
      started.receivedExecution.sandboxHeaders,
      [200],
    );
    await notifying.promise;
    expect((await response).status).toBe(200);
    releaseNotification();
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(started.actor, started.active.threadId))
        .events,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "input.budget" }),
      ]),
    );
    await cancelChatRun(
      started.actor,
      started.active.runId,
      started.receivedExecution.sandboxHeaders,
    );
  }, 90_000);
});
