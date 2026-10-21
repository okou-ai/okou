import { randomUUID } from "node:crypto";
import { expect, onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { publicChatActor } from "./public-chat-actor";

export async function terminalPredecessor(
  context: TestContext,
  status: "completed" | "cancelled" | "failed",
  initialize = true,
) {
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const owned = await publicChatActor(context, { clockTime: now });
  const api = createRunsApi(context);
  const { actor, agentId, runnerGroup: group } = owned;
  const run = await owned.run(() => {
    return api.createThreadRun(actor, {
      agentId,
      prompt: "Preserve terminal home state",
    });
  });
  const runnerId = randomUUID();
  const fixture = { api, owned, actor, agentId, group, run, runnerId, clock };
  await heartbeat(fixture);
  const claimed = await owned.claimRunnerRun(run.runId, {
    runnerIdentity: { runnerId, heartbeatGeneration: 7 },
  });
  await owned.run(async () => {
    const webhooks = createWebhookCallbackApi(context);
    const headers = { authorization: `Bearer ${claimed.sandboxToken}` };
    if (initialize) {
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: run.threadId,
              sequenceNumber: 0,
            },
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: "Partial work" }] },
            },
          ],
        },
        headers,
        [200],
      );
    }
    if (status === "cancelled") {
      await api.requestCancelRun(actor, run.runId, [200]);
    }
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: status === "cancelled" ? 137 : status === "failed" ? 1 : 0,
        ...(initialize
          ? {
              lastEventSequence: 1,
              completion: {
                cliAgentType: "claude-code" as const,
                cliAgentSessionId: run.threadId,
                cliAgentSessionHistoryDisposition: "native_only" as const,
              },
            }
          : {}),
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
  });
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof terminalPredecessor>>;

export async function heartbeat(
  f: Pick<Fixture, "api" | "owned" | "group" | "runnerId">,
  args: Parameters<Fixture["api"]["requestHeartbeatRunner"]>[2] = {},
) {
  await f.owned.run(() => {
    return f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotGeneration: 7,
      snapshotSequence: 1,
      heldHomeStates: [],
      heldSandboxStates: [],
      ...args,
    });
  });
}

export async function continuation(f: Fixture, model?: string) {
  return await f.owned.run(() => {
    return f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      threadId: f.run.threadId,
      prompt: "Continue after terminal cleanup",
      ...(model === undefined ? {} : { model }),
    });
  });
}

export async function poll(f: Fixture, runId: string) {
  return await f.owned.run(async () => {
    const response = await f.api.requestPollRunner(
      true,
      {
        runnerId: f.runnerId,
        group: f.group,
        supportedProfiles: ["vm0/default"],
      },
      [200],
    );
    if (response.status !== 200) {
      throw new Error("Expected authenticated Runner poll");
    }
    expect(response.body.job?.runId).toBe(runId);
    return response.body.job;
  });
}
