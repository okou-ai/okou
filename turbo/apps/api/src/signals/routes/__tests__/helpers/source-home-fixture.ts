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

export const SOURCE_HOME_HOSTNAME = "shared-finalizing.example.test";

export async function sourceHomeFixture(
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
  const source = await owned.run(() => {
    return api.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Prepare a home before a rolling restart",
    });
  });
  const fixture = {
    api,
    pollClient,
    owned,
    source,
    clock,
    group: owned.runnerGroup,
    reuseKey: `thread:${source.threadId}`,
    sourceId: randomUUID(),
    receiverId: randomUUID(),
    sequences: new Map<string, number>(),
  };
  await sourceHomeHeartbeat(fixture, fixture.sourceId, { mode: "running" });
  const claim = await owned.claimRunnerRun(source.runId, {
    runnerIdentity: { runnerId: fixture.sourceId, heartbeatGeneration: 7 },
    ...(args.claimHostname === null
      ? {}
      : { runnerHostname: args.claimHostname ?? SOURCE_HOME_HOSTNAME }),
  });
  await owned.run(async () => {
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    const webhooks = createWebhookCallbackApi(context);
    if (args.failBeforeInit) {
      await webhooks.requestAgentComplete(
        { runId: source.runId, exitCode: 1 },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      return;
    }
    if (args.status === undefined || args.status === "completed") {
      await completePublicClaudeRun(context, source, headers, "Preserved work");
      return;
    }
    await webhooks.requestAgentEvents(
      {
        runId: source.runId,
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: source.threadId,
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
      await api.requestCancelRun(owned.actor, source.runId, [200]);
    }
    await webhooks.requestAgentComplete(
      {
        runId: source.runId,
        exitCode: args.status === "cancelled" ? 137 : 1,
        lastEventSequence: 1,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: source.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
  });
  await sourceHomeHeartbeat(fixture, fixture.sourceId);
  await sourceHomeHeartbeat(fixture, fixture.receiverId);
  return fixture;
}

type SourceHomeFixture = Awaited<ReturnType<typeof sourceHomeFixture>>;
type HeartbeatOptions = Parameters<
  SourceHomeFixture["api"]["requestHeartbeatRunner"]
>[2];

export async function sourceHomeHeartbeat(
  f: SourceHomeFixture,
  runnerId: string,
  changes: HeartbeatOptions = {},
): Promise<void> {
  const sequence = (f.sequences.get(runnerId) ?? 0) + 1;
  f.sequences.set(runnerId, sequence);
  await f.owned.run(() => {
    return f.api.requestHeartbeatRunner(true, [200], {
      runnerId,
      runnerHostname: SOURCE_HOME_HOSTNAME,
      group: f.group,
      snapshotGeneration: runnerId === f.sourceId ? 7 : 8,
      snapshotSequence: sequence,
      mode: runnerId === f.sourceId ? "draining" : "running",
      activeReuseProducers:
        runnerId === f.sourceId
          ? [
              {
                runId: f.source.runId,
                reuseKey: f.reuseKey,
                profile: "vm0/default",
              },
            ]
          : [],
      ...changes,
    });
  });
}

export async function sourceHomeContinuation(f: SourceHomeFixture) {
  return await f.owned.run(async () => {
    const next = await f.api.createThreadRun(f.owned.actor, {
      agentId: f.owned.agentId,
      threadId: f.source.threadId,
      prompt: "Continue while the other Runner publishes its home",
    });
    await flushWaitUntilForTest();
    return next;
  });
}

export async function sourceHomePoll(
  f: SourceHomeFixture,
  runnerId = f.receiverId,
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
