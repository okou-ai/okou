import { randomUUID } from "node:crypto";
import { runnersPollContract } from "@okouai/api-contracts/contracts/runners";
import { setupApp } from "../../../../__tests__/test-helpers";
import { runnersRoutes } from "../../runners";
import { expect, onTestFinished } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { publicChatActor } from "./public-chat-actor";
import { completePublicClaudeRun } from "./public-native-run";

export const PREDECESSOR_HOSTNAME = "shared-finalizing.example.test";

export async function predecessorHomeFixture(
  context: TestContext,
  args: {
    readonly status?: "completed" | "cancelled" | "failed";
    readonly claimHostname?: string | null;
    readonly failBeforeInit?: true;
  } = {},
) {
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const pollClient = setupApp({ context, routes: runnersRoutes })(
    runnersPollContract,
  );
  const owned = await publicChatActor(context, {
    clockTime: now,
  });
  const api = createRunsApi(context);
  const predecessorRun = await owned.run(() => {
    return api.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Prepare a home before a rolling restart",
    });
  });
  const fixture = {
    api,
    pollClient,
    owned,
    predecessorRun,
    clock,
    group: owned.runnerGroup,
    reuseKey: `thread:${predecessorRun.threadId}`,
    predecessorRunnerId: randomUUID(),
    receiverRunnerId: randomUUID(),
    sequences: new Map<string, number>(),
  };
  await predecessorHomeHeartbeat(fixture, fixture.predecessorRunnerId, {
    mode: "running",
  });
  const claim = await owned.claimRunnerRun(predecessorRun.runId, {
    runnerIdentity: {
      runnerId: fixture.predecessorRunnerId,
      heartbeatGeneration: 7,
    },
    ...(args.claimHostname === null
      ? {}
      : { runnerHostname: args.claimHostname ?? PREDECESSOR_HOSTNAME }),
  });
  await owned.run(async () => {
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const webhooks = createWebhookCallbackApi(context);
    if (args.failBeforeInit) {
      await webhooks.requestAgentComplete(
        { runId: predecessorRun.runId, exitCode: 1 },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      return;
    }
    if (args.status === undefined || args.status === "completed") {
      await completePublicClaudeRun(
        context,
        predecessorRun,
        headers,
        "Preserved work",
      );
      return;
    }
    await webhooks.requestAgentEvents(
      {
        runId: predecessorRun.runId,
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: predecessorRun.threadId,
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
    if (args.status === "cancelled") {
      await api.requestCancelRun(owned.actor, predecessorRun.runId, [200]);
    }
    await webhooks.requestAgentComplete(
      {
        runId: predecessorRun.runId,
        exitCode: args.status === "cancelled" ? 137 : 1,
        lastEventSequence: 1,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: predecessorRun.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
  });
  await predecessorHomeHeartbeat(fixture, fixture.predecessorRunnerId);
  await predecessorHomeHeartbeat(fixture, fixture.receiverRunnerId);
  return fixture;
}

type PredecessorHomeFixture = Awaited<
  ReturnType<typeof predecessorHomeFixture>
>;
type HeartbeatOptions = Parameters<
  PredecessorHomeFixture["api"]["requestHeartbeatRunner"]
>[2];

export async function predecessorHomeHeartbeat(
  f: PredecessorHomeFixture,
  runnerId: string,
  changes: HeartbeatOptions = {},
): Promise<void> {
  const sequence = (f.sequences.get(runnerId) ?? 0) + 1;
  f.sequences.set(runnerId, sequence);
  await f.owned.run(() => {
    return f.api.requestHeartbeatRunner(true, [200], {
      runnerId,
      runnerHostname: PREDECESSOR_HOSTNAME,
      group: f.group,
      snapshotGeneration: runnerId === f.predecessorRunnerId ? 7 : 8,
      snapshotSequence: sequence,
      mode: runnerId === f.predecessorRunnerId ? "draining" : "running",
      activeReuseProducers:
        runnerId === f.predecessorRunnerId
          ? [
              {
                runId: f.predecessorRun.runId,
                reuseKey: f.reuseKey,
                profile: "vm0/default",
              },
            ]
          : [],
      ...changes,
    });
  });
}

export async function predecessorHomeContinuation(f: PredecessorHomeFixture) {
  return await f.owned.run(async () => {
    const next = await f.api.createThreadRun(f.owned.actor, {
      agentId: f.owned.agentId,
      threadId: f.predecessorRun.threadId,
      prompt: "Continue while the other Runner publishes its home",
    });
    await flushWaitUntilForTest();
    return next;
  });
}

export async function predecessorHomePoll(
  f: PredecessorHomeFixture,
  runnerId = f.receiverRunnerId,
) {
  return await f.owned.run(async () => {
    const response = await accept(
      f.pollClient.poll({
        headers: {
          authorization:
            "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        body: { runnerId, group: f.group, supportedProfiles: ["vm0/default"] },
      }),
      [200],
    );
    if (response.status !== 200) {
      throw new Error("Expected authenticated Runner poll");
    }
    expect(response.body.job).not.toBeNull();
    return response.body.job;
  });
}
