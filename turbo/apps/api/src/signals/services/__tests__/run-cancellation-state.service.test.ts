import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { cancelLockedRun } from "../agent-run-cancellation-transition.service";
import { cancelRun$, dispatchCancelSideEffects$ } from "../run-cancel.service";
import { readRunCancellationState } from "../run-cancellation-state.service";

const context = testContext();

// Narrow external-behavior exception: public cancellation has no hard/preserve
// parameter, cannot create legacy NULL recovery or partial claims, and cannot
// force rollback/closed-pool failures. This finite matrix verifies those actual
// PostgreSQL transitions. runner-cancellation.test.ts and the existing cron/chat
// route suites cover authentication, cancellation, cleanup, completion and erasure.
async function fixture(
  options: {
    status?: "running" | "cancelled";
    recovery?: boolean | null;
    mode?: RunnerCancellationMode | null;
    runnerId?: string | null;
    heartbeatGeneration?: number | null;
  } = {},
) {
  const auth = {
    userId: `user_cancel_${randomUUID()}`,
    orgId: `org_cancel_${randomUUID()}`,
    runId: randomUUID(),
  };
  const [session] = await db()
    .insert(agentSessions)
    .values({ userId: auth.userId, orgId: auth.orgId })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Session fixture was not inserted");
  }
  onTestFinished(async () => {
    await db().delete(agentSessions).where(eq(agentSessions.id, session.id));
  });
  const completedAt =
    options.status === "cancelled" ? new Date("2026-01-01T00:00:00Z") : null;
  await db()
    .insert(agentRuns)
    .values({
      id: auth.runId,
      userId: auth.userId,
      orgId: auth.orgId,
      sessionId: session.id,
      prompt: "internal cancellation lifecycle fixture",
      status: options.status ?? "running",
      cancellationRecoveryCompleted:
        options.recovery === undefined ? false : options.recovery,
      runnerCancellationMode: options.mode,
      completedAt,
      runnerGroup: "vm0/cancellation-test",
      runnerId: options.runnerId,
      runnerHeartbeatGeneration: options.heartbeatGeneration,
    });
  return {
    auth,
    completedAt,
    expected: {
      runnerGroup: "vm0/cancellation-test",
      runnerId: randomUUID(),
      heartbeatGeneration: 1,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cancel(
  f: Fixture,
  mode: RunnerCancellationMode,
  preserveExistingCancellation?: true,
) {
  const result = await createStore().set(
    cancelRun$,
    {
      ...f.auth,
      runnerCancellationMode: mode,
      ...(preserveExistingCancellation ? { preserveExistingCancellation } : {}),
    },
    context.signal,
  );
  if (!("alreadyCancelled" in result)) {
    throw new Error("Expected canonical cancellation result");
  }
  return result;
}

async function stored(f: Fixture) {
  const [run] = await db()
    .select({
      status: agentRuns.status,
      mode: agentRuns.runnerCancellationMode,
      completedAt: agentRuns.completedAt,
      recovery: agentRuns.cancellationRecoveryCompleted,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, f.auth.runId));
  if (!run) {
    throw new Error("Run fixture disappeared");
  }
  return run;
}

describe("canonical cancellation intent", () => {
  it("persists the historical effective hard mode before publication", async () => {
    const f = await fixture({ recovery: null });
    const result = await cancel(f, "cooperative");
    expect(result).toMatchObject({
      runnerCancellationMode: "hard",
      runnerCancellationChanged: true,
    });
    await expect(stored(f)).resolves.toMatchObject({
      status: "cancelled",
      mode: "hard",
      recovery: null,
    });
  });

  it("serializes racing cooperative and hard requests without downgrading", async () => {
    const f = await fixture();
    await Promise.all([cancel(f, "cooperative"), cancel(f, "hard")]);
    const terminal = await stored(f);
    expect(terminal).toMatchObject({
      status: "cancelled",
      mode: "hard",
      recovery: false,
    });
    await expect(cancel(f, "cooperative")).resolves.toMatchObject({
      runnerCancellationMode: "hard",
      runnerCancellationChanged: false,
    });
    await expect(stored(f)).resolves.toStrictEqual(terminal);
  });

  it("upgrades a genuine hard request without resetting the terminal/recovery state", async () => {
    const f = await fixture({ status: "cancelled", mode: "cooperative" });
    await expect(cancel(f, "hard")).resolves.toMatchObject({
      alreadyCancelled: true,
      runnerCancellationChanged: true,
      runnerCancellationMode: "hard",
    });
    await expect(stored(f)).resolves.toStrictEqual({
      status: "cancelled",
      mode: "hard",
      completedAt: f.completedAt,
      recovery: false,
    });
    await expect(cancel(f, "hard")).resolves.toMatchObject({
      runnerCancellationChanged: false,
    });
  });

  it.each(["cooperative", null] as const)(
    "preserves %s when cleanup redrives an already-cancelled row",
    async (mode) => {
      const f = await fixture({ status: "cancelled", mode });
      await expect(cancel(f, "hard", true)).resolves.toMatchObject({
        runnerCancellationMode: mode,
        runnerCancellationChanged: false,
      });
      await expect(stored(f)).resolves.toMatchObject({
        mode,
        completedAt: f.completedAt,
        recovery: false,
      });
    },
  );

  it("still hard-cancels active cleanup candidates under preserve-existing policy", async () => {
    const f = await fixture();
    await cancel(f, "hard", true);
    await expect(stored(f)).resolves.toMatchObject({
      status: "cancelled",
      mode: "hard",
    });
  });

  it("does not infer a mode when retrying an older cancelled row", async () => {
    const f = await fixture({ status: "cancelled", recovery: null });
    await expect(cancel(f, "cooperative")).resolves.toMatchObject({
      runnerCancellationMode: null,
      runnerCancellationChanged: false,
    });
    expect((await stored(f)).mode).toBeNull();
  });

  it("publishes a legacy hard upgrade without reviving terminal effects", async () => {
    const f = await fixture({ status: "cancelled", recovery: null });
    const result = await cancel(f, "hard");
    await createStore().set(dispatchCancelSideEffects$, result, context.signal);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: f.auth.runId,
      mode: "hard",
    });
    await expect(stored(f)).resolves.toStrictEqual({
      status: "cancelled",
      mode: "hard",
      completedAt: f.completedAt,
      recovery: null,
    });
  });

  it("rolls back the mode and terminal transition together", async () => {
    const f = await fixture();
    const rollback = new Error("stop decision rolled back");
    await expect(
      db().transaction(async (tx) => {
        await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.id, f.auth.runId))
          .for("update");
        await cancelLockedRun(tx, {
          runId: f.auth.runId,
          status: "running",
          completedAt: nowDate(),
          runnerCancellationMode: "hard",
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await expect(stored(f)).resolves.toMatchObject({
      status: "running",
      mode: null,
      completedAt: null,
    });
  });

  it("rejects an invalid stored mode without changing a legacy NULL row", async () => {
    const f = await fixture();
    await expect(
      db()
        .update(agentRuns)
        .set({ runnerCancellationMode: sql`'invalid-mode'` })
        .where(eq(agentRuns.id, f.auth.runId)),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "agent_runs_runner_cancellation_mode_check",
      },
    });
    expect((await stored(f)).mode).toBeNull();
  });
});

describe("authoritative Run lookup boundaries", () => {
  it("supports historical null attribution but distinguishes owner and partial-claim mismatch from absence", async () => {
    const f = await fixture();
    await expect(
      readRunCancellationState(db(), f.auth, f.expected, context.signal),
    ).resolves.toMatchObject({ state: "present", mode: null });
    for (const auth of [
      { ...f.auth, userId: "another-user" },
      { ...f.auth, orgId: "another-org" },
    ]) {
      await expect(
        readRunCancellationState(db(), auth, f.expected, context.signal),
      ).resolves.toMatchObject({ state: "unavailable" });
    }
    const partial = await fixture({
      runnerId: randomUUID(),
      heartbeatGeneration: null,
    });
    await expect(
      readRunCancellationState(
        db(),
        partial.auth,
        partial.expected,
        context.signal,
      ),
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("propagates database-client failure instead of returning gone", async () => {
    const pool = new Pool({ connectionString: env("DATABASE_URL") });
    const unavailableDb = drizzle(pool);
    await pool.end();
    const f = await fixture();
    await expect(
      readRunCancellationState(
        unavailableDb,
        f.auth,
        f.expected,
        context.signal,
      ),
    ).rejects.toMatchObject({
      cause: { message: "Cannot use a pool after calling end on the pool" },
    });
  });
});
