import { cronSteerRunTimeBudgetContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronSteerRunTimeBudgetRoutes } from "../cron-steer-run-time-budget";
import { chatEventDisplayText } from "./helpers/chat-event";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

// The real cron scans the whole database, so each case owns an isolated copy.
const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  completeChatRunOk,
  cancelChatRun,
} = createChatEventsFixture(context);
const STEER_AT_MS = 115 * 60 * 1000;
const CRON_SECRET = "test-run-time-budget-steer-secret";

async function startBudgetRun(app: Awaited<ReturnType<typeof setupApp>>) {
  const client = app(cronSteerRunTimeBudgetContract);
  async function requestBudgetSweep() {
    mockEnv("CRON_SECRET", CRON_SECRET);
    return await accept(
      client.steer({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
  }

  const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
  const active = await sendChatRun(actor, {
    agentId,
    prompt: "work until the runner's time-budget warning",
  });
  const claimed = await claimChatRun(runnerGroup, active.runId);
  const run = await api.readRun(actor, active.runId);
  if (!run.startedAt) {
    throw new Error("Expected the claimed run's public start time");
  }
  const startedAt = Date.parse(run.startedAt);
  return {
    actor,
    agentId,
    runnerGroup,
    active,
    claimed,
    startedAt,
    requestBudgetSweep,
  };
}

async function startRunAtBudgetBoundary(
  app: Awaited<ReturnType<typeof setupApp>>,
) {
  const started = await startBudgetRun(app);
  const { actor, active, claimed, startedAt, requestBudgetSweep } = started;
  mockNow(startedAt + STEER_AT_MS - 1);
  await requestBudgetSweep();
  expect(
    (await chat.listThreadEvents(actor, active.threadId)).events.filter(
      (event) => {
        return event.eventType === "input.budget";
      },
    ),
  ).toHaveLength(0);

  mockNow(startedAt + STEER_AT_MS);
  await requestBudgetSweep();
  const budget = (
    await chat.listThreadEvents(actor, active.threadId)
  ).events.find((event) => {
    return event.eventType === "input.budget";
  });
  if (!budget || budget.eventType !== "input.budget") {
    throw new Error("Expected the cron's run-targeted budget warning");
  }
  mockNow(startedAt + STEER_AT_MS + 1);
  await requestBudgetSweep();
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
    api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
  ).resolves.toStrictEqual({ input: { eventId: budget.id, prompt } });
  return {
    ...started,
    budget,
    prompt,
    requestBudgetSweep,
  };
}

describe("run-targeted time budget steering through HTTP", () => {
  it("does not append a late warning after the runner completed", async () => {
    const app = await setupApp({
      context,
      routes: cronSteerRunTimeBudgetRoutes,
      isolatePg: true,
    });
    const { actor, active, claimed, startedAt, requestBudgetSweep } =
      await startBudgetRun(app);
    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    mockNow(startedAt + STEER_AT_MS);
    await requestBudgetSweep();
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
  }, 90_000);

  it("consumes the warning once and retains its run identity on replay", async () => {
    const app = await setupApp({
      context,
      routes: cronSteerRunTimeBudgetRoutes,
      isolatePg: true,
    });
    const { actor, active, claimed, budget } =
      await startRunAtBudgetBoundary(app);
    const token = claimed.claim.sandboxToken;
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
    await cancelChatRun(actor, active.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("revokes an unsteered warning at completion and never gives it to the next run", async () => {
    const app = await setupApp({
      context,
      routes: cronSteerRunTimeBudgetRoutes,
      isolatePg: true,
    });
    const { actor, agentId, runnerGroup, active, claimed, budget } =
      await startRunAtBudgetBoundary(app);
    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
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

    await api.heartbeatRunner(runnerGroup);
    const successor = await sendChatRun(actor, {
      agentId,
      threadId: active.threadId,
      prompt: "continue after the prior run finished",
    });
    const successorClaim = await claimChatRun(runnerGroup, successor.runId);
    await expect(
      api.nextSteerableInput(
        successorClaim.claim.sandboxToken,
        successor.runId,
      ),
    ).resolves.toStrictEqual({ input: null });
    await cancelChatRun(actor, successor.runId, successorClaim.sandboxHeaders);
  }, 90_000);
});
