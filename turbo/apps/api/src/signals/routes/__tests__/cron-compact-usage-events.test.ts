import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { testUsageStateContract } from "@okouai/api-contracts/contracts/test-usage-state";
import { testUsageStateRoutes } from "../test-usage-state";
import { cronCompactUsageEventsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  holdUsageEventCompactionLockFixture,
  makeUsageBillingLegacyFixture,
  backfillUsageBillingFixture,
} from "../../../test-fixtures/usage-event-compaction";
import { nowDate } from "../../../lib/time";
import {
  attachUsageAllowance$,
  deleteUsageData$,
  deleteUsageStateFixture$,
  deleteRun$,
  insertUsageEvent$,
  materializeHourlyUsage$,
  readAllowanceWindowState$,
  readUsageCompactionStorageCounts$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedUsageOverflowGrain$,
  seedUsageStateFixture$,
  type UsageStateFixture,
} from "./helpers/usage-state";
import { cronCompactUsageEventsRoutes } from "../cron-compact-usage-events";

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-compact-usage-events-secret";
const RAW_SEED_LIMIT = 500;

function cronClient() {
  return setupApp({ context, routes: cronCompactUsageEventsRoutes })(
    cronCompactUsageEventsContract,
  );
}

async function seedFixture(): Promise<UsageStateFixture> {
  const fixture = await store.set(
    seedUsageStateFixture$,
    undefined,
    context.signal,
  );
  onTestFinished(async () => {
    await store.set(deleteUsageStateFixture$, fixture, context.signal);
  });
  return fixture;
}

async function compactOwnedUsage(fixture: UsageStateFixture) {
  return await accept(
    setupApp({ context, routes: testUsageStateRoutes })(
      testUsageStateContract,
    ).compact({ body: { orgId: fixture.orgId } }),
    [200],
  );
}

async function readStorage(fixture: UsageStateFixture) {
  return await store.set(
    readUsageCompactionStorageCounts$,
    { scope: "organization", id: fixture.orgId },
    context.signal,
  );
}

async function seedZeroUsageEvents(
  fixture: UsageStateFixture,
  args: {
    readonly processedAt: Date;
    readonly count: number;
  },
): Promise<void> {
  await store.set(
    insertUsageEvent$,
    {
      ...fixture,
      status: "processed",
      quantity: 0,
      creditsCharged: 0,
      processedAt: args.processedAt,
      count: args.count,
    },
    context.signal,
  );
}

type UsageCompactionLockFixture = Awaited<
  ReturnType<typeof holdUsageEventCompactionLockFixture>
>;

async function startUsageCompactionLockGate(): Promise<UsageCompactionLockFixture> {
  const gate = await holdUsageEventCompactionLockFixture(context.signal);
  onTestFinished(async () => {
    gate.release();
    await gate.done;
  });
  return gate;
}

async function waitForUsageCompactionLockWaiters(
  gate: UsageCompactionLockFixture,
  minimum: number,
): Promise<void> {
  await expect.poll(gate.waiterCount).toBeGreaterThanOrEqual(minimum);
}

async function releaseUsageCompactionLockGate(
  gate: UsageCompactionLockFixture,
): Promise<void> {
  gate.release();
  await gate.done;
}

async function seedRunContext(fixture: UsageStateFixture): Promise<{
  readonly runId: string;
  readonly chatThreadId: string;
}> {
  const compose = await store.set(seedCompose$, fixture, context.signal);
  const chatThreadId = await store.set(
    seedChatThread$,
    {
      userId: fixture.userId,
      composeId: compose.composeId,
      title: "Compaction browser fixture",
    },
    context.signal,
  );
  const run = await store.set(
    seedRun$,
    {
      ...fixture,
      composeId: compose.composeId,
      chatThreadId,
      status: "completed",
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      completedAt: new Date("2026-07-31T00:01:00.000Z"),
    },
    context.signal,
  );
  return { runId: run.runId, chatThreadId };
}

describe("usage event compaction cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().compact({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("rejects the wrong cron secret", async () => {
    const response = await accept(
      cronClient().compact({
        headers: { authorization: "Bearer wrong-cron-secret" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("atomically replaces an old processed grain and deletes its idempotency key", async () => {
    const fixture = await seedFixture();
    const idempotencyKey = randomUUID();
    const usageEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: null,
        idempotencyKey,
        status: "processed",
        quantity: 3,
        creditsCharged: 7,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    const response = await compactOwnedUsage(fixture);

    expect(response.body).toMatchObject({
      success: true,
      rawSeedLimit: RAW_SEED_LIMIT,
      seededRawRows: 1,
      selectedGrains: 1,
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 1,
      quantity: "3",
      creditsCharged: "7",
      allowanceUnits: "0",
      reconciled: true,
    });
    expect(Object.keys(response.body).sort()).toStrictEqual([
      "affectedShortWindows",
      "affectedWeeklyWindows",
      "allowanceUnits",
      "billingErrorHeldRows",
      "creditsCharged",
      "cutoff",
      "durationMs",
      "hasMore",
      "hourlyRowsDeleted",
      "hourlyRowsInserted",
      "lockWaitMs",
      "probedRawRows",
      "quantity",
      "rawRowsDeleted",
      "rawSeedLimit",
      "reconciled",
      "seededRawRows",
      "selectedGrains",
      "success",
    ]);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });
    await expect(
      store.set(
        insertUsageEvent$,
        { ...fixture, idempotencyKey },
        context.signal,
      ),
    ).resolves.not.toBe(usageEventId);
  });

  it("retains four days of processed events and explicit diagnostic holds", async () => {
    const fixture = await seedFixture();
    const startedHour = nowDate();
    startedHour.setUTCMinutes(0, 0, 0);
    const expectedCutoffAtStart = new Date(
      startedHour.getTime() - 4 * 24 * 60 * 60 * 1000,
    );
    const retainedProcessedAt = new Date(
      startedHour.getTime() - 3 * 24 * 60 * 60 * 1000,
    );
    const eligibleProcessedAt = new Date(
      startedHour.getTime() - 5 * 24 * 60 * 60 * 1000,
    );

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: eligibleProcessedAt,
        billingError: "missing_pricing",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "pending",
        processedAt: eligibleProcessedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: retainedProcessedAt,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        processedAt: eligibleProcessedAt,
      },
      context.signal,
    );
    const response = await compactOwnedUsage(fixture);
    const completedHour = nowDate();
    completedHour.setUTCMinutes(0, 0, 0);
    const expectedCutoffAtCompletion = new Date(
      completedHour.getTime() - 4 * 24 * 60 * 60 * 1000,
    );

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      billingErrorHeldRows: 1,
    });
    expect([
      expectedCutoffAtStart.toISOString(),
      expectedCutoffAtCompletion.toISOString(),
    ]).toContain(response.body.cutoff);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 3,
      processedRaw: 2,
      hourly: 1,
    });
  });

  it("compacts only the explicitly owned organization", async () => {
    const owned = await seedFixture();
    const foreign = await seedFixture();
    for (const fixture of [owned, foreign]) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          processedAt: new Date("2026-08-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }

    expect((await compactOwnedUsage(owned)).body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      hasMore: false,
    });
    await expect(readStorage(owned)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });
    await expect(readStorage(foreign)).resolves.toStrictEqual({
      raw: 1,
      processedRaw: 1,
      hourly: 0,
    });
  });

  it("expands a bounded seed to the complete physical grain", async () => {
    const fixture = await seedFixture();
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        count: RAW_SEED_LIMIT + 1,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        category: "later-grain",
        processedAt: new Date("2026-08-01T01:15:00.000Z"),
      },
      context.signal,
    );

    const response = await compactOwnedUsage(fixture);

    expect(response.body).toMatchObject({
      rawSeedLimit: RAW_SEED_LIMIT,
      seededRawRows: RAW_SEED_LIMIT,
      selectedGrains: 1,
      rawRowsDeleted: RAW_SEED_LIMIT + 1,
      hourlyRowsInserted: 1,
      quantity: String(RAW_SEED_LIMIT + 1),
      hasMore: true,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      processedRaw: 1,
      hourly: 1,
    });
  });

  it("leaves hourly-only segments idle and reconsolidates late data", async () => {
    const fixture = await seedFixture();
    for (const quantity of [2, 3]) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          quantity,
          creditsCharged: quantity,
          processedAt: new Date("2026-08-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }
    await expect(
      store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: null },
        context.signal,
      ),
    ).resolves.toBe(2);

    expect((await compactOwnedUsage(fixture)).body).toMatchObject({
      rawRowsDeleted: 0,
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 0,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 2,
    });

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 7,
        creditsCharged: 11,
        processedAt: new Date("2026-08-01T00:45:00.000Z"),
      },
      context.signal,
    );
    const late = await compactOwnedUsage(fixture);
    expect(late.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 2,
      hourlyRowsInserted: 1,
      quantity: "12",
      creditsCharged: "16",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });

    const retry = await compactOwnedUsage(fixture);
    expect(retry.body).toMatchObject({
      rawRowsDeleted: 0,
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 0,
      quantity: "0",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });
  });

  it("preserves distinct allowance window pairs and consumed units", async () => {
    const fixture = await seedFixture();
    const firstEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 2,
        creditsCharged: 3,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    const firstPair = await store.set(
      attachUsageAllowance$,
      {
        orgId: fixture.orgId,
        runId: null,
        usageEventId: firstEventId,
        unitsApplied: 5,
        consumedUnits: 11,
      },
      context.signal,
    );
    const secondEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 4,
        creditsCharged: 6,
        processedAt: new Date("2026-08-01T00:30:00.000Z"),
      },
      context.signal,
    );
    const secondPair = await store.set(
      attachUsageAllowance$,
      {
        orgId: fixture.orgId,
        runId: null,
        usageEventId: secondEventId,
        unitsApplied: 7,
        consumedUnits: 22,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 8,
        creditsCharged: 9,
        processedAt: new Date("2026-08-01T00:45:00.000Z"),
      },
      context.signal,
    );
    const response = await compactOwnedUsage(fixture);

    expect(response.body).toMatchObject({
      selectedGrains: 3,
      rawRowsDeleted: 3,
      hourlyRowsInserted: 3,
      quantity: "14",
      creditsCharged: "18",
      allowanceUnits: "12",
      affectedShortWindows: 2,
      affectedWeeklyWindows: 2,
      reconciled: true,
    });
    await expect(
      store.set(readAllowanceWindowState$, firstPair, context.signal),
    ).resolves.toStrictEqual({
      shortWindowConsumedUnits: "11",
      weeklyWindowConsumedUnits: "11",
      rawAllowanceUnits: "0",
      hourlyAllowanceUnits: "5",
      allocationCount: 0,
    });
    await expect(
      store.set(readAllowanceWindowState$, secondPair, context.signal),
    ).resolves.toStrictEqual({
      shortWindowConsumedUnits: "22",
      weeklyWindowConsumedUnits: "22",
      rawAllowanceUnits: "0",
      hourlyAllowanceUnits: "7",
      allocationCount: 0,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 3,
    });
  });

  it("reconsolidates facts after run deletion makes their run IDs null", async () => {
    const fixture = await seedFixture();
    const run = await seedRunContext(fixture);
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: run.runId,
        status: "processed",
        quantity: 2,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      materializeHourlyUsage$,
      { ...fixture, runId: run.runId },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: run.runId,
        status: "processed",
        quantity: 3,
        processedAt: new Date("2026-08-01T00:30:00.000Z"),
      },
      context.signal,
    );
    await store.set(deleteRun$, run.runId, context.signal);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      processedRaw: 1,
      hourly: 1,
    });
    const response = await compactOwnedUsage(fixture);

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: "5",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });
  });

  it("denies scoped test compaction in production", async () => {
    mockEnv("ENV", "production");
    const response = await accept(
      setupApp({ context, routes: testUsageStateRoutes })(
        testUsageStateContract,
      ).compact({ body: { orgId: randomUUID() } }),
      [404],
    );
    expect(response.status).toBe(404);
  });

  it("preserves different billing identities after their live runs are removed", async () => {
    const fixture = await seedFixture();
    const first = await seedRunContext(fixture);
    const second = await seedRunContext(fixture);
    const processedAt = new Date("2026-08-01T00:15:00.000Z");
    for (const run of [first, second]) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          runId: run.runId,
          status: "processed",
          quantity: 2,
          creditsCharged: 3,
          processedAt,
        },
        context.signal,
      );
      await store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: run.runId },
        context.signal,
      );
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          runId: run.runId,
          status: "processed",
          quantity: 5,
          creditsCharged: 7,
          processedAt,
        },
        context.signal,
      );
      await store.set(deleteRun$, run.runId, context.signal);
    }
    await seedZeroUsageEvents(fixture, {
      processedAt,
      count: 1,
    });
    const result = await compactOwnedUsage(fixture);
    expect(result.body).toMatchObject({
      rawRowsDeleted: 3,
      hourlyRowsDeleted: 2,
      hourlyRowsInserted: 3,
      quantity: "14",
      creditsCharged: "20",
      reconciled: true,
    });
    // Two original runs stay distinct; unlinked legacy events remain a third
    // truthful grain rather than being assigned to either deleted run.
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 3,
    });
    const retry = await compactOwnedUsage(fixture);
    expect(retry.body).toMatchObject({
      rawRowsDeleted: 0,
      hourlyRowsInserted: 0,
      reconciled: true,
    });
  });

  it.each(["before", "after"] as const)(
    "preserves mixed billing grains with backfill %s compaction",
    async (order) => {
      const fixture = await seedFixture();
      const run = await seedRunContext(fixture);
      const processedAt = new Date("2026-08-02T00:15:00.000Z");
      const insert = async (quantity: number, creditsCharged: number) => {
        await store.set(
          insertUsageEvent$,
          {
            ...fixture,
            runId: run.runId,
            status: "processed",
            quantity,
            creditsCharged,
            processedAt,
          },
          context.signal,
        );
      };
      await insert(2, 3);
      await store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: run.runId },
        context.signal,
      );
      await insert(5, 7);
      // The migration-only legacy shape has no production endpoint; the fixture
      // affects this owned org only. Both actions under test are real entry points.
      await makeUsageBillingLegacyFixture(fixture.orgId, context.signal);
      await insert(11, 13);
      if (order === "before") {
        await backfillUsageBillingFixture(fixture.orgId, context.signal);
      }
      const first = await compactOwnedUsage(fixture);
      expect(first.body).toMatchObject({
        rawRowsDeleted: 2,
        hourlyRowsDeleted: 1,
        hourlyRowsInserted: order === "before" ? 1 : 2,
        quantity: "18",
        creditsCharged: "23",
        allowanceUnits: "0",
        reconciled: true,
      });
      await backfillUsageBillingFixture(fixture.orgId, context.signal);
      await backfillUsageBillingFixture(fixture.orgId, context.signal);
      // Late usage reconsolidates the populated hourly grains in either ordering.
      await insert(1, 2);
      const late = await compactOwnedUsage(fixture);
      expect(late.body).toMatchObject({
        rawRowsDeleted: 1,
        hourlyRowsInserted: 1,
        quantity: "19",
        creditsCharged: "25",
        allowanceUnits: "0",
        reconciled: true,
      });
      await expect(readStorage(fixture)).resolves.toStrictEqual({
        raw: 0,
        processedRaw: 0,
        hourly: 1,
      });
      expect((await compactOwnedUsage(fixture)).body).toMatchObject({
        rawRowsDeleted: 0,
        hourlyRowsInserted: 0,
        reconciled: true,
      });
    },
  );

  it("serializes overlapping invocations without duplicating facts", async () => {
    const fixture = await seedFixture();
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        count: RAW_SEED_LIMIT,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity: 70_001,
        processedAt: new Date("2026-08-01T01:15:00.000Z"),
      },
      context.signal,
    );

    const responses = await Promise.all([
      compactOwnedUsage(fixture),
      compactOwnedUsage(fixture),
    ]);

    const outcomes = responses.map((response) => {
      return {
        rawRowsDeleted: response.body.rawRowsDeleted,
        quantity: response.body.quantity,
      };
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toStrictEqual(
      expect.arrayContaining([
        { rawRowsDeleted: RAW_SEED_LIMIT, quantity: String(RAW_SEED_LIMIT) },
        { rawRowsDeleted: 1, quantity: "70001" },
      ]),
    );
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 2,
    });
  });

  it("lets organization cleanup remove a batch aggregated ahead of it", async () => {
    const fixture = await seedFixture();
    const quantity = 8_000_000_000_000_123;
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    const gate = await startUsageCompactionLockGate();

    const compaction = compactOwnedUsage(fixture);
    await waitForUsageCompactionLockWaiters(gate, 1);
    const cleanup = createStore().set(
      deleteUsageData$,
      { scope: "organization", id: fixture.orgId },
      context.signal,
    );
    await waitForUsageCompactionLockWaiters(gate, 2);
    await releaseUsageCompactionLockGate(gate);
    const [response] = await Promise.all([compaction, cleanup]);

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: String(quantity),
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 0,
    });
  });

  it("keeps compaction from reviving usage deleted ahead of it", async () => {
    const fixture = await seedFixture();
    const survivingUserId = `user_${randomUUID()}`;
    onTestFinished(async () => {
      await store.set(
        deleteUsageData$,
        { scope: "user", id: survivingUserId },
        context.signal,
      );
    });
    const quantity = 7_000_000_000_000_321;
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        userId: survivingUserId,
        status: "processed",
        quantity: 1001,
        processedAt: new Date("2026-08-01T01:15:00.000Z"),
      },
      context.signal,
    );
    const gate = await startUsageCompactionLockGate();

    const cleanup = createStore().set(
      deleteUsageData$,
      { scope: "user", id: fixture.userId },
      context.signal,
    );
    await waitForUsageCompactionLockWaiters(gate, 1);
    const compaction = compactOwnedUsage(fixture);
    await waitForUsageCompactionLockWaiters(gate, 2);
    await releaseUsageCompactionLockGate(gate);
    const [, response] = await Promise.all([cleanup, compaction]);

    expect(response.body).toMatchObject({
      rawRowsDeleted: 1,
      hourlyRowsInserted: 1,
      quantity: "1001",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
    });
  });

  it("rolls back replacement and source deletion when the aggregate overflows bigint", async () => {
    const fixture = await seedFixture();
    await store.set(
      seedUsageOverflowGrain$,
      {
        ...fixture,
        processedAt: new Date("2026-08-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      processedRaw: 1,
      hourly: 1,
    });

    const app = createApp({
      signal: context.signal,
      routes: testUsageStateRoutes,
    });
    const response = await app.request(testUsageStateContract.compact.path, {
      method: testUsageStateContract.compact.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: fixture.orgId }),
    });

    expect(response.status).toBe(500);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 1,
      processedRaw: 1,
      hourly: 1,
    });
  });
});
