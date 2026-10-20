import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  continuation,
  heartbeat,
  poll,
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

describe("independent finalizing resource source", () => {
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
        activeReuseProducers: [
          {
            runId: f.run.runId,
            reuseKey: `thread:${f.run.threadId}`,
            profile: "vm0/default",
          },
        ],
      });
      context.mocks.ably.publish.mockClear();
      const next = await continuation(f, "gpt-6-astra");
      const preference = {
        kind: "preference" as const,
        tier: "finalizingPredecessor" as const,
        finalizingSourceRunId: f.run.runId,
        runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
        expiresAt: new Date(
          f.clock + 2500 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      };
      const job = await poll(f, next.runId);
      expect(job?.historyGenerationRunId).toBeUndefined();
      expect(job?.runnerPreference).toStrictEqual(preference);
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "job",
        expect.objectContaining({
          runId: next.runId,
          runnerPreference: preference,
        }),
      );
      const claim = await f.owned.claimRunnerRun(next.runId, {
        runnerIdentity: preference.runnerIdentity,
        telemetry: {
          runnerPreference: preference,
          runnerPreferenceClaimState: "active",
        },
      });
      expect(claim.cliAgentType).toBe("codex");
      await f.owned.run(async () => {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId: next.runId, exitCode: 1 },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });
    },
  );

  it("finds a claimed failed source that never reported native initialization", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${f.run.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    const next = await continuation(f);
    const job = await poll(f, next.runId);
    expect(job?.historyGenerationRunId).toBeUndefined();
    expect(job?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      finalizingSourceRunId: f.run.runId,
    });
    const preference = job?.runnerPreference;
    const deadline =
      f.clock + 2500 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS;
    expect(preference).toMatchObject({
      expiresAt: new Date(deadline).toISOString(),
    });
    mockNow(deadline - 1);
    await heartbeat(f, {
      snapshotSequence: 3,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${f.run.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
      preference,
    );
    mockNow(deadline);
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("skips an intermediary attempt cancelled before any Runner claim", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 100);
    const unstarted = await continuation(f);
    await f.owned.run(() => {
      return f.api.requestCancelRun(f.actor, unstarted.runId, [200]);
    });
    mockNow(f.clock + 2500);
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${f.run.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    const next = await continuation(f);
    expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      finalizingSourceRunId: f.run.runId,
    });
  });

  it("selects the newest executed identity before checking producer eligibility", async () => {
    const f = await terminalPredecessor(context, "failed");
    mockNow(f.clock + 100);
    const newer = await continuation(f);
    const claimed = await f.owned.claimRunnerRun(newer.runId, {
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
    });
    await f.owned.run(async () => {
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId: newer.runId, exitCode: 1 },
        { authorization: `Bearer ${claimed.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
    });
    mockNow(f.clock + 3000);
    const producer = {
      reuseKey: `thread:${f.run.threadId}`,
      profile: "vm0/default",
    };
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [{ ...producer, runId: f.run.runId }],
    });
    const next = await continuation(f);
    const withoutLatestProducer = await poll(f, next.runId);
    expect(withoutLatestProducer?.historyGenerationRunId).toBe(f.run.runId);
    expect(withoutLatestProducer?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await heartbeat(f, {
      snapshotSequence: 3,
      activeReuseProducers: [{ ...producer, runId: newer.runId }],
    });
    const withLatestProducer = await poll(f, next.runId);
    expect(withLatestProducer?.historyGenerationRunId).toBe(f.run.runId);
    expect(withLatestProducer?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      finalizingSourceRunId: newer.runId,
    });
  });

  it("does not use another Chat's producer even when it advertises the target reuse key", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    const next = await f.owned.run(() => {
      return f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        prompt: "Start an unrelated Chat",
      });
    });
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${next.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it("keeps ready generic home lookup independent of missing source proof", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    await heartbeat(f, {
      snapshotSequence: 2,
      heldHomeStates: [
        {
          reuseKey: `thread:${f.run.threadId}`,
          lastCompletedAt: nowDate().toISOString(),
          homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
        },
      ],
    });
    const next = await continuation(f);
    expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
      tier: "homeCache",
    });
  });

  it("does not route a history-free successor to stale producer inventory", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${f.run.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    mockNow(f.clock + 31_000);
    const next = await continuation(f);
    expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it("prioritizes the selected producer's history-free job ahead of older unrelated work", async () => {
    const f = await terminalPredecessor(context, "failed", false);
    mockNow(f.clock + 2500);
    const unrelated = await f.owned.run(() => {
      return f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        prompt: "Older unrelated queued work",
      });
    });
    await heartbeat(f, {
      snapshotSequence: 2,
      activeReuseProducers: [
        {
          runId: f.run.runId,
          reuseKey: `thread:${f.run.threadId}`,
          profile: "vm0/default",
        },
      ],
    });
    mockNow(f.clock + 2501);
    const next = await continuation(f);
    const job = await poll(f, next.runId);
    expect(job?.historyGenerationRunId).toBeUndefined();
    expect(job?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      finalizingSourceRunId: f.run.runId,
    });
    const blankRunner = randomUUID();
    await heartbeat(f, { runnerId: blankRunner });
    const response = await f.owned.run(() => {
      return f.api.requestPollRunner(
        true,
        {
          runnerId: blankRunner,
          group: f.group,
          supportedProfiles: ["vm0/default"],
        },
        [200],
      );
    });
    expect(response.status === 200 && response.body.job?.runId).toBe(
      unrelated.runId,
    );
  });
});
