import { randomUUID } from "node:crypto";
import {
  jobSchema,
  type RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  predecessorHomeFixture,
  predecessorHomeHeartbeat,
  predecessorHomeContinuation,
  predecessorHomePoll,
} from "./helpers/predecessor-home-fixture";
import {
  continuation,
  heartbeat,
  poll,
  terminalPredecessor,
} from "./helpers/runner-finalizing";

const context = testContext();

describe("Runner notification reuse after durable launch", () => {
  it("starts exact advice after delayed first delivery", async () => {
    const f = await terminalPredecessor(context, "completed");
    mockNow(f.clock + 2000);
    const heldSandboxStates = [
      {
        reuseKey: `thread:${f.run.threadId}`,
        lastCompletedAt: new Date(f.clock).toISOString(),
        reusableSandbox: { profile: "vm0/default", sourceRunId: f.run.runId },
      },
    ];
    await heartbeat(f, { snapshotSequence: 2, heldSandboxStates });
    let deliveryDelayed = false;
    context.mocks.ably.publish.mockImplementation((topic) => {
      if (topic === "desktopShellAuthorizationChanged" && !deliveryDelayed) {
        deliveryDelayed = true;
        mockNow(f.clock + 20_000);
      }
      return Promise.resolve();
    });

    const next = await continuation(f);
    mockNow(f.clock + 20_000);
    expect(deliveryDelayed).toBeTruthy();
    const preference = {
      kind: "preference",
      tier: "exactSandbox",
      predecessorRunId: f.run.runId,
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
      expiresAt: new Date(f.clock + 21_000).toISOString(),
    };
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: preference,
      }),
    );
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
      preference,
    );
  });

  // User invalidations are best effort: the producer report can commit on
  // either side of discovery. Only the subsequent poll is ordered after it.
  it("keeps source Home advice bounded while its producer report races notification", async () => {
    const f = await predecessorHomeFixture(context);
    mockNow(f.clock + 2000);
    let updated = false;
    let published: RunnerPreference | undefined;
    context.mocks.ably.publish.mockImplementation(async (topic, payload) => {
      if (topic === "job") {
        published = jobSchema
          .pick({ runnerPreference: true })
          .parse(payload).runnerPreference;
      }
      if (topic === "desktopShellAuthorizationChanged" && !updated) {
        updated = true;
        await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
          snapshotGeneration: 9,
          activeReuseProducers: [],
        });
      }
    });
    const next = await predecessorHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "predecessorHome",
      predecessorRunId: f.predecessorRun.runId,
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 8 },
      home: { evidence: "location" },
      expiresAt: new Date(f.clock + 4000).toISOString(),
    };
    expect(updated).toBeTruthy();
    expect(published).toMatchObject({
      ...preference,
      home: expect.objectContaining({
        evidence: expect.stringMatching(/^(expected|location)$/),
      }),
    });
    expect(
      (
        await f.owned.run(() => {
          return f.api.readRun(f.owned.actor, next.runId);
        })
      ).status,
    ).toBe("pending");
    expect((await predecessorHomePoll(f))?.runnerPreference).toStrictEqual(
      preference,
    );
  });

  it.each(["restart", "resource loss", "draining"] as const)(
    "reconciles %s inventory reported concurrently with a durable job notification",
    async (change) => {
      const f = await terminalPredecessor(context, "completed");
      mockNow(f.clock + 2000);
      const heldSandboxStates = [
        {
          reuseKey: `thread:${f.run.threadId}`,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: { profile: "vm0/default", sourceRunId: f.run.runId },
        },
      ];
      await heartbeat(f, { snapshotSequence: 2, heldSandboxStates });
      let updated = false;
      let published: RunnerPreference | undefined;
      context.mocks.ably.publish.mockImplementation(async (topic, payload) => {
        if (topic === "job") {
          published = jobSchema
            .pick({ runnerPreference: true })
            .parse(payload).runnerPreference;
        }
        if (topic === "desktopShellAuthorizationChanged" && !updated) {
          updated = true;
          await heartbeat(f, {
            snapshotGeneration: change === "restart" ? 8 : 7,
            snapshotSequence: 3,
            heldSandboxStates:
              change === "resource loss" ? [] : heldSandboxStates,
            mode: change === "draining" ? "draining" : "running",
          });
        }
      });
      const next = await continuation(f);
      expect(updated).toBeTruthy();
      const preference =
        change === "restart"
          ? {
              kind: "preference",
              tier: "exactSandbox",
              predecessorRunId: f.run.runId,
              runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 8 },
              expiresAt: new Date(f.clock + 3000).toISOString(),
            }
          : { kind: "noPreference", reason: "noViableHolder" };
      const priorPreference = {
        kind: "preference",
        tier: "exactSandbox",
        predecessorRunId: f.run.runId,
        runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
        expiresAt: new Date(f.clock + 3000).toISOString(),
      };
      expect([priorPreference, preference]).toContainEqual(published);
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
        preference,
      );
    },
  );

  it("keeps one canonical deadline when poll and notification race discovery", async () => {
    const f = await terminalPredecessor(context, "completed");
    mockNow(f.clock + 2000);
    await heartbeat(f, {
      snapshotSequence: 2,
      heldSandboxStates: [
        {
          reuseKey: `thread:${f.run.threadId}`,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: { profile: "vm0/default", sourceRunId: f.run.runId },
        },
      ],
    });
    let discoveredRunId: string | undefined;
    const reader = randomUUID();
    context.mocks.ably.publish.mockImplementation(async (topic) => {
      if (
        topic === "desktopShellAuthorizationChanged" &&
        discoveredRunId === undefined
      ) {
        await f.owned.run(async () => {
          const response = await f.api.requestPollRunner(
            true,
            {
              runnerId: reader,
              group: f.group,
              supportedProfiles: ["vm0/default"],
            },
            [200],
          );
          if (response.status !== 200 || !response.body.job) {
            throw new Error("Expected the committed job before notification");
          }
          discoveredRunId = response.body.job.runId;
          expect(response.body.job.runnerPreference).toMatchObject({
            tier: "exactSandbox",
          });
        });
      }
    });
    const next = await continuation(f);
    expect(discoveredRunId).toBe(next.runId);
    const job = await poll(f, next.runId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: job?.runnerPreference,
      }),
    );
    mockNow(f.clock + 3000);
    expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
      tier: "reusableSandbox",
    });
    mockNow(f.clock + 4000);
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("keeps the first deadline when publication fails and poll later delivers the job", async () => {
    const f = await terminalPredecessor(context, "completed");
    mockNow(f.clock + 2000);
    await heartbeat(f, {
      snapshotSequence: 2,
      heldSandboxStates: [
        {
          reuseKey: `thread:${f.run.threadId}`,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: { profile: "vm0/default", sourceRunId: f.run.runId },
        },
      ],
    });
    context.mocks.ably.publish.mockImplementation((topic) => {
      return topic === "job"
        ? Promise.reject(new Error("Ably publication rejected"))
        : Promise.resolve();
    });
    const next = await continuation(f);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: expect.objectContaining({
          tier: "exactSandbox",
          expiresAt: new Date(f.clock + 3000).toISOString(),
        }),
      }),
    );
    mockNow(f.clock + 3250);
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
      kind: "preference",
      tier: "reusableSandbox",
      runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
      expiresAt: new Date(f.clock + 4000).toISOString(),
    });
    mockNow(f.clock + 4000);
    expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("keeps a single claim when a poll recipient claims during notification", async () => {
    const f = await terminalPredecessor(context, "completed");
    mockNow(f.clock + 2000);
    await heartbeat(f, {
      snapshotSequence: 2,
      heldSandboxStates: [
        {
          reuseKey: `thread:${f.run.threadId}`,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: { profile: "vm0/default", sourceRunId: f.run.runId },
        },
      ],
    });
    let claimedRunId: string | undefined;
    context.mocks.ably.publish.mockImplementation(async (topic) => {
      if (
        topic === "desktopShellAuthorizationChanged" &&
        claimedRunId === undefined
      ) {
        await f.owned.run(async () => {
          const response = await f.api.requestPollRunner(
            true,
            {
              runnerId: f.runnerId,
              group: f.group,
              supportedProfiles: ["vm0/default"],
            },
            [200],
          );
          if (response.status !== 200 || !response.body.job) {
            throw new Error("Expected the committed job before notification");
          }
          claimedRunId = response.body.job.runId;
          await f.owned.claimRunnerRun(claimedRunId);
        });
      }
    });
    const next = await continuation(f);
    expect(claimedRunId).toBe(next.runId);
    expect(
      (
        await f.owned.run(() => {
          return f.api.readRun(f.actor, next.runId);
        })
      ).status,
    ).toBe("running");
    const noJob = await f.owned.run(() => {
      return f.api.requestPollRunner(
        true,
        {
          runnerId: f.runnerId,
          group: f.group,
          supportedProfiles: ["vm0/default"],
        },
        [200],
      );
    });
    expect(noJob.body).toMatchObject({ job: null });
    await f.owned.run(() => {
      return f.api.requestClaimRunnerJob(true, next.runId, [404]);
    });
  });
});
