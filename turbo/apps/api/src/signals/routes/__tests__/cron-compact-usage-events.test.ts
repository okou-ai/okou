import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { testUsageStateContract } from "@okouai/api-contracts/contracts/test-usage-state";
import { testUsageStateRoutes } from "../test-usage-state";
import { cronCompactUsageEventsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { usageEventCompactionDbFixture } from "../../../test-fixtures/db-fixture";
import { nowDate } from "../../../lib/time";
import {
  attachUsageAllowance$,
  deleteUsageStateFixture$,
  deleteRun$,
  insertUsageEvent$,
  materializeHourlyUsage$,
  readAllowanceWindowState$,
  readUsageCompactionStorageCounts$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedUsageStateFixture$,
  type UsageStateFixture,
} from "./helpers/usage-state";
import { cronCompactUsageEventsRoutes } from "../cron-compact-usage-events";

const context = testContext({
  dbFixtures: [usageEventCompactionDbFixture],
});
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

  it("limits each commit even when one physical grain exceeds the batch", async () => {
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
      rawRowsDeleted: RAW_SEED_LIMIT,
      hourlyRowsInserted: 1,
      quantity: String(RAW_SEED_LIMIT),
      hasMore: true,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 2,
      processedRaw: 2,
      hourly: 1,
    });
  });

  it("retains hourly fragments and compacts only newly settled data", async () => {
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
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 1,
      quantity: "7",
      creditsCharged: "11",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 3,
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
      hourly: 3,
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

  it("compacts new facts after run deletion without rewriting old fragments", async () => {
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
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 1,
      quantity: "3",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 2,
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
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 3,
      quantity: "10",
      creditsCharged: "14",
      reconciled: true,
    });
    // Two original runs stay distinct; unlinked legacy events remain a third
    // truthful grain rather than being assigned to either deleted run.
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 5,
    });
    const retry = await compactOwnedUsage(fixture);
    expect(retry.body).toMatchObject({
      rawRowsDeleted: 0,
      hourlyRowsInserted: 0,
      reconciled: true,
    });
  });

  it("does not recreate hourly facts after owned usage cleanup", async () => {
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
    await Promise.all([
      compactOwnedUsage(fixture),
      store.set(deleteUsageStateFixture$, fixture, context.signal),
    ]);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 0,
    });
  });

  it("processes overlapping invocations without duplicating facts", async () => {
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

    // A competing snapshot may consume zero rows. The next ordinary cron
    // visit processes what remains, rather than retrying the lost batch.
    const nextVisit = await compactOwnedUsage(fixture);
    const visits = [...responses, nextVisit];
    for (const response of visits) {
      expect(response.body.reconciled).toBeTruthy();
      expect(response.body.rawRowsDeleted).toBeLessThanOrEqual(RAW_SEED_LIMIT);
    }
    expect(
      visits.reduce((total, response) => {
        return total + response.body.rawRowsDeleted;
      }, 0),
    ).toBe(RAW_SEED_LIMIT + 1);
    expect(
      visits.reduce((total, response) => {
        return total + Number(response.body.quantity);
      }, 0),
    ).toBe(RAW_SEED_LIMIT + 70_001);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 2,
    });
  });
});
