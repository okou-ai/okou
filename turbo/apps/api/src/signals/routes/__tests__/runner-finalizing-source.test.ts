import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, now, nowDate } from "../../../lib/time";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  continuation,
  heartbeat,
  terminalPredecessor,
} from "./helpers/runner-finalizing";

const context = testContext();
function codexAuthJson() {
  const exp = Math.floor(now() / 1000) + 7200;
  const jwt = (payload: Record<string, unknown>) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.bdd-signature`;
  };
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ exp }),
      refresh_token: "rt_bdd_independent_finalizing_source",
      account_id: "bdd_finalizing_account",
      id_token: jwt({
        exp,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "bdd_finalizing_account",
          chatgpt_plan_type: "plus",
        },
      }),
    },
  });
}

type Fixture = Awaited<ReturnType<typeof terminalPredecessor>>;
async function expectOwner(
  f: Fixture,
  runId: string,
  runnerId: string,
  generation = 7,
) {
  await f.owned.run(async () => {
    const owner = await f.api.requestRunRunner(f.actor, runId, [200]);
    expect(owner.body).toMatchObject({
      runnerId,
      runnerHeartbeatGeneration: generation,
    });
  });
}
function producer(f: Fixture) {
  return {
    runId: f.run.runId,
    reuseKey: `thread:${f.run.threadId}`,
    profile: "vm0/default",
  };
}

describe("Independent finalizing resource dispatch", () => {
  it.each(["sandbox", "home", "other-profile-home"] as const)(
    "routes previous-Run %s independently of native history",
    async (resource) => {
      const f = await terminalPredecessor(context, "failed", false);
      mockNow(f.clock + 2500);
      const reuseKey = `thread:${f.run.threadId}`;
      const unrelatedSource = randomUUID();
      await heartbeat(f, {
        snapshotSequence: 2,
        activeReuseProducers: resource === "sandbox" ? [producer(f)] : [],
        heldSandboxStates: [
          {
            reuseKey,
            lastCompletedAt: nowDate().toISOString(),
            reusableSandbox: {
              profile: "vm0/default",
              sourceRunId: unrelatedSource,
            },
          },
        ],
      });
      const ready = await f.owned.run(() => {
        return f.api.registerDirectRunner(f.group, {
          runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 7 },
          heartbeat: {
            heldSandboxStates:
              resource === "sandbox"
                ? [
                    {
                      reuseKey,
                      lastCompletedAt: nowDate().toISOString(),
                      reusableSandbox: {
                        profile: "vm0/default",
                        sourceRunId: f.run.runId,
                      },
                    },
                  ]
                : [],
            heldHomeStates:
              resource === "sandbox"
                ? []
                : [
                    {
                      reuseKey,
                      lastCompletedAt: nowDate().toISOString(),
                      homeCaches: [
                        {
                          profile: "vm0/default",
                          homeAffinityVersion: 1,
                          sourceRunId:
                            resource === "home" ? f.run.runId : unrelatedSource,
                        },
                        {
                          profile: "vm0/large",
                          homeAffinityVersion: 1,
                          sourceRunId: f.run.runId,
                        },
                      ],
                    },
                  ],
          },
        });
      });
      const next = await continuation(f);
      await expectOwner(
        f,
        next.runId,
        resource === "other-profile-home" ? f.runnerId : ready.runnerId,
      );
      const input = await f.owned.executionInput(next.runId);
      expect(input.nativeContinuation).toMatchObject({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir /tmp/okou-chat-history",
        ),
      });
    },
  );

  it.each(["completed", "cancelled", "failed"] as const)(
    "keeps the %s Claude source after a native Codex framework switch",
    async (status) => {
      const f = await terminalPredecessor(context, status);
      await f.owned.run(() => {
        return f.api.createPersonalModelProvider(f.actor, {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: codexAuthJson() },
        });
      });
      mockNow(f.clock + 2500);
      await heartbeat(f, {
        snapshotSequence: 2,
        activeReuseProducers: [producer(f)],
      });
      await f.owned.run(() => {
        return f.api.registerDirectRunner(f.group, {
          maxConcurrent: 8,
          heartbeat: { totalVcpu: 32, totalMemoryMb: 65_536 },
        });
      });
      const next = await continuation(f, "gpt-6-astra");
      await expectOwner(f, next.runId, f.runnerId);
      const input = await f.owned.executionInput(next.runId);
      expect(input.cliAgentType).toBe("codex");
    },
  );

  it("dispatches to a failed producer that never reported native initialization", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [producer(f)],
    });
    await f.owned.run(() => {
      return f.api.registerDirectRunner(f.group, {
        maxConcurrent: 8,
        heartbeat: { totalVcpu: 32, totalMemoryMb: 65_536 },
      });
    });
    const next = await continuation(f);
    await expectOwner(f, next.runId, f.runnerId);
    const input = await f.owned.executionInput(next.runId);
    expect(input.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
    });
  });

  it("routes to a same-host replacement while its predecessor drains", async () => {
    const f = await terminalPredecessor(context, "completed");
    await heartbeat(f, {
      snapshotSequence: 2,
      mode: "draining",
      activeReuseProducers: [producer(f)],
    });
    const receiver = await f.owned.run(() => {
      return f.api.registerDirectRunner(f.group, {
        runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 8 },
        hostname: `runner-${f.runnerId}.okou.app`,
        maxConcurrent: 1,
      });
    });
    await f.owned.run(() => {
      return f.api.registerDirectRunner(f.group, {
        maxConcurrent: 8,
        heartbeat: { totalVcpu: 32, totalMemoryMb: 65_536 },
      });
    });
    mockNow(f.clock + 2000);
    const next = await continuation(f);
    expect(next.status).toBe("running");
    await expectOwner(
      f,
      next.runId,
      receiver.runnerId,
      receiver.heartbeatGeneration,
    );
  });

  it("keeps another Chat's producer out of a new Thread's placement", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    await f.owned.run(async () => {
      const chat = createChatFilesBddApi(context);
      const thread = await chat.createThread(f.actor, {
        agentId: f.agentId,
        title: "Independent Chat",
      });
      await heartbeat(f, {
        snapshotSequence: 2,
        activeReuseProducers: [
          {
            runId: f.run.runId,
            reuseKey: `thread:${thread.id}`,
            profile: "vm0/default",
          },
        ],
      });
      const other = await f.api.registerDirectRunner(f.group, {
        maxConcurrent: 8,
        heartbeat: { totalVcpu: 32, totalMemoryMb: 65_536 },
      });
      const next = await f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        threadId: thread.id,
        prompt: "Start independent work",
      });
      await expectOwner(
        f,
        next.runId,
        other.runnerId,
        other.heartbeatGeneration,
      );
      expect(
        (await f.owned.executionInput(next.runId)).isFirstRun,
      ).toBeTruthy();
    });
  });

  it("selects an advertised Home at the snapshot bound and clears it after an empty snapshot", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    const [firstThread, secondThread] = await f.owned.run(async () => {
      const chat = createChatFilesBddApi(context);
      const first = await chat.createThread(f.actor, {
        agentId: f.agentId,
        title: "Home snapshot bound",
      });
      const second = await chat.createThread(f.actor, {
        agentId: f.agentId,
        title: "Empty Home snapshot",
      });
      return [first, second] as const;
    });
    await heartbeat(f, {
      snapshotSequence: 2,
      heldHomeStates: Array.from({ length: 4096 }, (_entry, index) => {
        return {
          reuseKey: `thread:${index === 4095 ? firstThread.id : index === 4094 ? secondThread.id : randomUUID()}`,
          lastCompletedAt: nowDate().toISOString(),
          homeCaches: [
            {
              profile: "vm0/default",
              sourceRunId: randomUUID(),
              homeAffinityVersion: 1,
            },
          ],
        };
      }),
    });
    await heartbeat(f, { snapshotSequence: 1, heldHomeStates: [] });
    const alternative = await f.owned.run(() => {
      return f.api.registerDirectRunner(f.group, {
        maxConcurrent: 8,
        heartbeat: { totalVcpu: 32, totalMemoryMb: 65_536 },
      });
    });
    const next = await f.owned.run(() => {
      return f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        threadId: firstThread.id,
        prompt: "Use the Home at the end of the accepted inventory",
      });
    });
    await expectOwner(f, next.runId, f.runnerId);
    const input = await f.owned.executionInput(next.runId);
    expect(next.status).toBe("running");
    await f.owned.run(async () => {
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId: next.runId, exitCode: 1 },
        { authorization: `Bearer ${input.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
    });
    mockNow(f.clock + 5000);
    await heartbeat(f, { snapshotSequence: 3, heldHomeStates: [] });
    const cleared = await f.owned.run(() => {
      return f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        threadId: secondThread.id,
        prompt: "Start after the advertised Home was removed",
      });
    });
    expect(cleared.status).toBe("running");
    await expectOwner(
      f,
      cleared.runId,
      alternative.runnerId,
      alternative.heartbeatGeneration,
    );
  });
});
