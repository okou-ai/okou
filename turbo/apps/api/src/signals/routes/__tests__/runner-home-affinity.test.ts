import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();

async function setup() {
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const group = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Home affinity protocol",
    description: "Reader preparation",
    visibility: "private",
  });
  const run = await api.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Keep captured execution intact",
  });
  const runnerId = randomUUID();
  const reuseKey = `thread:${run.threadId}`;
  const heldHomeStates = [
    {
      reuseKey,
      lastCompletedAt: nowDate().toISOString(),
      homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 as const }],
    },
  ];
  return {
    api,
    actor,
    group,
    run,
    runnerId,
    reuseKey,
    heldHomeStates,
    agentId: agent.agentId,
    clock,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function heartbeat(
  f: Fixture,
  args: Parameters<Fixture["api"]["requestHeartbeatRunner"]>[2] = {},
) {
  await f.api.requestHeartbeatRunner(true, [200], {
    runnerId: f.runnerId,
    group: f.group,
    snapshotGeneration: 7,
    snapshotSequence: 1,
    heldHomeStates: f.heldHomeStates,
    ...args,
  });
}
async function poll(f: Fixture, runnerId = f.runnerId) {
  const response = await f.api.requestPollRunner(
    true,
    {
      runnerId,
      group: f.group,
      supportedProfiles: ["vm0/default"],
    },
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected authenticated poll");
  }
  expect(response.body.job?.runId).toBe(f.run.runId);
  return response.body.job;
}
async function cancel(f: Fixture) {
  await f.api.requestCancelRun(f.actor, f.run.runId, [200]);
}

// Construction and observations use normal chat, provider auth and official
// Runner heartbeat/poll/claim. No DB schemas, private services or fixture routes.
describe("canonical API home affinity", () => {
  it("keeps home affinity advisory when another canonical runner claims the job", async () => {
    const f = await setup();
    await heartbeat(f);
    const job = await poll(f);
    expect(job?.runnerPreference).toMatchObject({
      kind: "preference",
      tier: "homeCache",
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
    });
    const otherRunnerId = randomUUID();
    await heartbeat(f, {
      runnerId: otherRunnerId,
      heldHomeStates: [],
    });
    const otherPoll = await poll(f, otherRunnerId);
    expect(otherPoll?.runnerPreference).toMatchObject({ tier: "homeCache" });
    const claim = await f.api.requestClaimRunnerJob(true, f.run.runId, [200], {
      runnerIdentity: { runnerId: otherRunnerId, heartbeatGeneration: 7 },
      telemetry: { runnerPreference: job?.runnerPreference },
    });
    if (claim.status !== 200) {
      throw new Error("Expected compatible queued execution");
    }
    expect(claim.body).toMatchObject({
      runId: f.run.runId,
      prompt: "Keep captured execution intact",
    });
    expect(claim.body).not.toHaveProperty("runnerPreference");
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: f.run.runId, exitCode: 0 },
      { authorization: `Bearer ${claim.body.sandboxToken}` },
      [200],
    );
  });

  it("finds another holder and clears its preference after an accepted empty state", async () => {
    const f = await setup();
    await heartbeat(f);
    const reader = randomUUID();
    await heartbeat(f, { runnerId: reader, heldHomeStates: [] });
    expect((await poll(f, reader))?.runnerPreference).toMatchObject({
      kind: "preference",
      tier: "homeCache",
      runnerIdentity: { runnerId: f.runnerId },
    });
    await heartbeat(f, { snapshotSequence: 2, heldHomeStates: [] });
    expect((await poll(f, reader))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await cancel(f);
  });

  it.each(["wrong-group", "draining", "wrong-profile"] as const)(
    "keeps execution generic for %s evidence",
    async (scenario) => {
      const f = await setup();
      await heartbeat(f, {
        ...(scenario === "wrong-group" ? { group: "vm0/another-group" } : {}),
        ...(scenario === "draining" ? { mode: "draining" } : {}),
        ...(scenario === "wrong-profile"
          ? {
              heldHomeStates: [
                {
                  reuseKey: f.reuseKey,
                  lastCompletedAt: nowDate().toISOString(),
                  homeCaches: [
                    { profile: "vm0/large", homeAffinityVersion: 1 },
                  ],
                },
              ],
            }
          : {}),
      });
      const job = await poll(f);
      expect(job?.runnerPreference).toMatchObject({ kind: "noPreference" });
      await cancel(f);
    },
  );

  it("fences replayed snapshots and preserves the current holder generation after a reset", async () => {
    const f = await setup();
    await heartbeat(f, { snapshotSequence: 10 });
    for (const sequence of [9, 10]) {
      await heartbeat(f, {
        snapshotSequence: sequence,
        heldHomeStates: [],
      });
      expect((await poll(f))?.runnerPreference).toMatchObject({
        tier: "homeCache",
      });
    }
    await heartbeat(f, {
      snapshotGeneration: 8,
      snapshotSequence: 1,
      heldHomeStates: [],
    });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await heartbeat(f, { snapshotGeneration: 8, snapshotSequence: 2 });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 8 },
    });
    await heartbeat(f, {
      snapshotGeneration: 7,
      snapshotSequence: 99,
      heldHomeStates: [],
    });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
    });
    await cancel(f);
  });

  it("rejects an over-bound snapshot without replacing the accepted home observation", async () => {
    const f = await setup();
    await heartbeat(f, {
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: "2026-10-09T08:00:00+08:00",
          homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
        },
      ],
    });
    await f.api.requestHeartbeatRunner(true, [400], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotGeneration: 7,
      snapshotSequence: 2,
      heldHomeStates: Array.from({ length: 129 }, (_, index) => {
        return {
          reuseKey: `thread:${index}`,
          lastCompletedAt: nowDate().toISOString(),
          homeCaches: Array.from({ length: 8 }, () => {
            return {
              profile: "vm0/default",
              homeAffinityVersion: 1 as const,
            };
          }),
        };
      }),
    });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
    });
    await cancel(f);
  });

  it("publishes the same canonical home preference through Ably and poll", async () => {
    const f = await setup();
    await heartbeat(f);
    await cancel(f);
    context.mocks.ably.publish.mockClear();
    const run = await f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      threadId: f.run.threadId,
      prompt: "Broadcast carries canonical home affinity",
    });
    const next = { ...f, run };
    expect((await poll(next))?.runnerPreference).toMatchObject({
      tier: "homeCache",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: run.runId,
        runnerPreference: expect.objectContaining({
          kind: "preference",
          tier: "homeCache",
          runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
        }),
      }),
    );
    await cancel(next);
  });

  it("ranks a real reusable sandbox ahead of a home image", async () => {
    const f = await setup();
    await heartbeat(f, {
      heldSandboxStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: nowDate().toISOString(),
          reusableSandbox: { profile: "vm0/default" },
        },
      ],
    });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      tier: "reusableSandbox",
    });
    await cancel(f);
  });

  it("expires home preference without withholding the job", async () => {
    const f = await setup();
    await heartbeat(f);
    mockNow(f.clock + 2500);
    expect((await poll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
      reason: "expired",
    });
    await cancel(f);
  });

  it("does not use a stale holder for a newly queued job", async () => {
    const f = await setup();
    await heartbeat(f);
    await cancel(f);
    mockNow(f.clock + 31_000);
    const run = await f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      threadId: f.run.threadId,
      prompt: "Fresh queue, stale heartbeat",
    });
    const next = { ...f, run };
    expect((await poll(next))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await cancel(next);
  });

  it("does not accept official home inventory from a PAT heartbeat", async () => {
    const f = await setup();
    const pat = await f.api.createCliToken(f.actor);
    await f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotGeneration: 7,
      heldHomeStates: f.heldHomeStates,
    });
    expect((await poll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await cancel(f);
  });
});
