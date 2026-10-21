import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  continuation,
  heartbeat,
  poll,
  terminalPredecessor,
} from "./helpers/runner-finalizing";

const context = testContext();

describe("terminal predecessor reuse preference", () => {
  it.each(["cancelled", "failed"] as const)(
    "keeps the %s producer deadline identical in Ably and repeated polls",
    async (status) => {
      const f = await terminalPredecessor(context, status);
      const producer = {
        runId: f.run.runId,
        reuseKey: `thread:${f.run.threadId}`,
        profile: "vm0/default",
      };
      await heartbeat(f, {
        snapshotSequence: 2,
        activeReuseProducers: [producer],
      });
      context.mocks.ably.publish.mockClear();
      const next = await continuation(f);
      const preference = {
        kind: "preference",
        tier: "finalizingPredecessor",
        finalizingSourceRunId: f.run.runId,
        runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
        expiresAt: new Date(
          f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      };
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
        preference,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "job",
        expect.objectContaining({
          runId: next.runId,
          runnerPreference: preference,
        }),
      );
      mockNow(f.clock + 2500);
      await heartbeat(f, {
        snapshotSequence: 3,
        activeReuseProducers: [producer],
      });
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
        preference,
      );
      mockNow(f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS);
      await heartbeat(f, {
        snapshotSequence: 4,
        activeReuseProducers: [producer],
      });
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
        kind: "noPreference",
        reason: "expired",
      });
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "bounds the %s completion bridge without producer proof",
    async (status) => {
      const f = await terminalPredecessor(context, status);
      mockNow(f.clock + 500);
      const next = await continuation(f);
      expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
        tier: "finalizingPredecessor",
        expiresAt: new Date(f.clock + 1500).toISOString(),
      });
      mockNow(f.clock + 1500);
      expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );

  it.each([
    "generation",
    "profile",
    "reuse key",
    "runner",
    "draining",
  ] as const)(
    "rejects terminal producer evidence with a mismatched %s",
    async (mismatch) => {
      const f = await terminalPredecessor(context, "cancelled", false);
      mockNow(f.clock + 2000);
      await heartbeat(f, {
        ...(mismatch === "runner" ? { runnerId: randomUUID() } : {}),
        snapshotGeneration: mismatch === "generation" ? 8 : 7,
        snapshotSequence: 2,
        mode: mismatch === "draining" ? "draining" : "running",
        activeReuseProducers: [
          {
            runId: f.run.runId,
            reuseKey: `thread:${mismatch === "reuse key" ? randomUUID() : f.run.threadId}`,
            profile: mismatch === "profile" ? "vm0/large" : "vm0/default",
          },
        ],
      });
      const next = await continuation(f);
      const job = await poll(f, next.runId);
      expect(job?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );
});
