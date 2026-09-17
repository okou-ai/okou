import { describe, expect, it, onTestFinished } from "vitest";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createRouteMocks } from "./helpers/route-test";
import {
  seedPiInferenceFixture,
  transferPiFixtureAgentOwner,
  seedPiInferenceUsage,
  readPiInferenceUsage,
  erasePiInferenceScope,
  mismatchPiInferenceEpoch,
  retainPiInferenceSource,
  removePiInferenceFixture,
  expirePiInferenceFixture,
  corruptPiInferenceFixture,
  readPiInferenceFixture,
  probePiInferenceOwnership,
  finalizePiInferenceFixture,
  erasePiInferenceFixture,
  settlePiInferenceFixture,
  fixtureThreadAdmissionBlocked,
  withFixtureCapacityLock,
  type PiInferenceFixture,
} from "../../../test-fixtures/pi-inference-lifecycle";

const context = testContext();
const authorization = "Bearer clerk-session";
const app = () => {
  return setupApp({
    context,
    routes: [
      ...runsRoutes,
      ...runsCancelRoutes,
      ...testCronCleanupSandboxesStateRoutes,
    ],
  });
};

async function fixture(
  args: Parameters<typeof seedPiInferenceFixture>[0] = {},
) {
  const f = await seedPiInferenceFixture(args);
  onTestFinished(async () => {
    await removePiInferenceFixture(f);
  });
  createRouteMocks(context).clerk.session(f.userId, f.orgId);
  return f;
}

function read(f: PiInferenceFixture) {
  createRouteMocks(context).clerk.session(f.userId, f.orgId);
  return app()(runsByIdContract).getById({
    headers: { authorization },
    params: { id: f.runId },
  });
}

async function cancel(f: PiInferenceFixture) {
  createRouteMocks(context).clerk.session(f.userId, f.orgId);
  return await accept(
    app()(runsCancelContract).cancel({
      headers: { authorization },
      params: { id: f.runId },
    }),
    [200],
  );
}

async function cleanup(f: PiInferenceFixture, also?: PiInferenceFixture) {
  return await accept(
    app()(testCronCleanupSandboxesStateContract).cleanup({
      body: {
        runIds: also ? [f.runId, also.runId] : [f.runId],
        chatThreadIds: [f.threadId],
        orgIds: [f.orgId],
        exportJobIds: [],
      },
    }),
    [200],
  );
}

describe("default-off Pi inference lifecycle readers", () => {
  it("reads and cancels an API-only run without inventing a Sandbox", async () => {
    const f = await fixture();
    const result = await accept(read(f), [200]);
    expect(result.body).toMatchObject({ runId: f.runId, status: "pending" });
    expect(result.body.sandboxId).toBeUndefined();
    await cancel(f);
    expect((await accept(read(f), [200])).body.status).toBe("cancelled");
    // Infrastructure exception: verify cancellation's durable fence and retained
    // attempt identity, which have no public response fields or active producer.
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: {
        phase: "terminal",
        ownerEpoch: 2,
        providerAttemptState: "not-started",
      },
      intent: null,
      lease: null,
    });
    await cancel(f);
    await expect(probePiInferenceOwnership(f, 1)).resolves.toBe(0);
    await expect(
      finalizePiInferenceFixture(f, 1, context.signal),
    ).rejects.toThrow("current inference owner");
  });

  it("keeps a ten-minute handoff pending until its own queue expiry", async () => {
    const f = await fixture({ phase: "sandbox_waiting" });
    await cleanup(f);
    expect((await accept(read(f), [200])).body.status).toBe("pending");
    await expect(fixtureThreadAdmissionBlocked(f)).resolves.toBeTruthy();
    await expirePiInferenceFixture(f);
    await cleanup(f);
    expect((await accept(read(f), [200])).body.status).toBe("timeout");
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: { phase: "terminal" },
      intent: { state: "expired" },
      lease: null,
      apiStartedAt: f.apiStartedAt,
    });
  });

  it("uses the API ownership deadline and preserves uncertain provider effects", async () => {
    const f = await fixture({ phase: "provider" });
    await cleanup(f);
    expect((await accept(read(f), [200])).body.status).toBe("pending");
    await expirePiInferenceFixture(f);
    await cleanup(f);
    expect((await accept(read(f), [200])).body.status).toBe("timeout");
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: {
        providerAttemptState: "may-have-started",
        phase: "terminal",
        usageSettled: false,
      },
    });
    await expect(probePiInferenceOwnership(f, 1)).resolves.toBe(0);
    await expect(erasePiInferenceFixture(f)).rejects.toThrow(
      "awaits usage or Sandbox release evidence",
    );
  });

  it("fails explicitly when a new-mode run lacks its required owner", async () => {
    const f = await fixture();
    await corruptPiInferenceFixture(f);
    await expect(read(f)).rejects.toThrow("Unknown response status 500");
    await expect(readPiInferenceFixture(f)).rejects.toThrow(
      "missing required durable state",
    );
  });

  it("counts legacy and each unreleased lease once, excluding API and waiting work", async () => {
    const owner = await fixture();
    await fixture({ orgId: owner.orgId, legacy: true });
    await fixture({ orgId: owner.orgId, phase: "sandbox_waiting" });
    for (const state of [
      "reserved",
      "preparing",
      "ready",
      "claimed",
      "releasing",
      "released",
    ] as const) {
      await fixture({
        orgId: owner.orgId,
        phase: "terminal",
        leaseState: state,
      });
    }
    const claimed = await fixture({
      orgId: owner.orgId,
      phase: "sandbox_running",
    });
    createRouteMocks(context).clerk.session(owner.userId, owner.orgId);
    const queue = await accept(
      app()(runsQueueContract).getQueue({ headers: { authorization } }),
      [200],
    );
    expect(queue.body.concurrency.active).toBe(7);
    await cancel(claimed);
    createRouteMocks(context).clerk.session(owner.userId, owner.orgId);
    expect(
      (
        await accept(
          app()(runsQueueContract).getQueue({ headers: { authorization } }),
          [200],
        )
      ).body.concurrency.active,
    ).toBe(7);
  });

  it("fences a materializer on cancellation and retains its capacity until proven release", async () => {
    const f = await fixture({ phase: "sandbox_preparing" });
    await cancel(f);
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: { ownerEpoch: 2 },
      intent: { state: "cancelled", ownerEpoch: 2 },
      lease: { state: "releasing", ownerEpoch: 2, releaseEvidence: null },
    });
    await expect(erasePiInferenceFixture(f)).rejects.toThrow(
      "awaits usage or Sandbox release evidence",
    );
    await settlePiInferenceFixture(f);
    await erasePiInferenceFixture(f);
    expect((await read(f)).status).toBe(404);
  });

  it("finalizes settled API work only with the current epoch and no executable job", async () => {
    const f = await fixture({ phase: "publishing" });
    await expect(
      finalizePiInferenceFixture(f, 0, context.signal),
    ).rejects.toThrow("current unexpired execution owner");
    await finalizePiInferenceFixture(f, 1, context.signal);
    expect((await accept(read(f), [200])).body.status).toBe("failed");
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: { phase: "terminal", providerAttemptState: "settled" },
      intent: null,
      lease: null,
    });
  });

  it("completes a settled API result using its canonical checkpoint", async () => {
    const f = await fixture({ phase: "publishing" });
    await finalizePiInferenceFixture(f, 1, context.signal, true);
    expect((await accept(read(f), [200])).body.status).toBe("completed");
    await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
      inference: { phase: "terminal" },
      lease: null,
      intent: null,
    });
  });

  it("rejects a publication epoch different from the Sandbox owner", async () => {
    const f = await fixture({ phase: "sandbox_running" });
    await mismatchPiInferenceEpoch(f);
    await expect(readPiInferenceFixture(f)).rejects.toThrow(
      "inconsistent intent or lease ownership",
    );
  });

  it("reports corrupt state per run and still times out another expired owner", async () => {
    const corrupt = await fixture();
    const expired = await fixture();
    await corruptPiInferenceFixture(corrupt);
    await expirePiInferenceFixture(expired);
    const result = await cleanup(corrupt, expired);
    expect(result.body).toMatchObject({ errors: 1, cleaned: 1 });
    expect((await accept(read(expired), [200])).body.status).toBe("timeout");
  });

  it.each(["valid", "hash", "owner"] as const)(
    "retains H0 and validates its %s identity",
    async (kind) => {
      const f = await fixture();
      const source = await fixture({
        legacy: true,
        orgId: f.orgId,
        userId: kind === "owner" ? undefined : f.userId,
      });
      // Remove the referencing fixture before the referenced source at teardown.
      onTestFinished(async () => {
        await removePiInferenceFixture(f);
      });
      await retainPiInferenceSource(f, source, kind === "hash");
      if (kind === "valid") {
        expect((await accept(read(f), [200])).body.status).toBe("pending");
        await expect(erasePiInferenceFixture(source)).rejects.toThrow(
          "database operation failed",
        );
      } else {
        await expect(readPiInferenceFixture(f)).rejects.toThrow(
          "captured history or source identity",
        );
      }
    },
  );

  it.each(["user", "organization"] as const)(
    "fences %s deletion before removing unsettled usage evidence",
    async (kind) => {
      const f = await fixture({ phase: "provider" });
      await seedPiInferenceUsage(f);
      await expect(
        erasePiInferenceScope(f, kind, context.signal),
      ).rejects.toThrow("awaits usage or Sandbox release evidence");
      expect((await accept(read(f), [200])).body.status).toBe("cancelled");
      await expect(readPiInferenceUsage(f)).resolves.toStrictEqual([
        { quantity: 1 },
      ]);
      await expect(readPiInferenceFixture(f)).resolves.toMatchObject({
        inference: {
          phase: "terminal",
          providerAttemptState: "may-have-started",
          usageSettled: false,
        },
      });
    },
  );

  it("fences indirect owned-agent cascades before removing another run's evidence", async () => {
    const f = await fixture({ phase: "provider" });
    const owner = "erased-agent-owner";
    await transferPiFixtureAgentOwner(f, owner);
    await seedPiInferenceUsage(f);
    await expect(
      erasePiInferenceScope({ ...f, userId: owner }, "user", context.signal),
    ).rejects.toThrow("awaits usage or Sandbox release evidence");
    expect((await accept(read(f), [200])).body.status).toBe("cancelled");
    await expect(readPiInferenceUsage(f)).resolves.toStrictEqual([
      { quantity: 1 },
    ]);
  });

  it("does not take a Sandbox-capacity lock for a run-owner CAS", async () => {
    const f = await fixture();
    // Infrastructure exception: another connection holds the real capacity
    // advisory lock while the run-local conditional update completes.
    await expect(
      withFixtureCapacityLock(f, async () => {
        return await probePiInferenceOwnership(f, 1);
      }),
    ).resolves.toBe(1);
    await expect(probePiInferenceOwnership(f, 2)).resolves.toBe(0);
  });
});
