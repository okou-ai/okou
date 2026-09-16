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

const TEST_APP_ROUTES = Object.freeze([...cronCompactUsageEventsRoutes]);

const context = testContext();
const store = createStore();
const CRON_SECRET = "test-compact-usage-events-secret";
const RAW_SEED_LIMIT = 500;

function cronClient() {
  return setupApp({ context, routes: cronCompactUsageEventsRoutes })(
    cronCompactUsageEventsContract,
  );
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
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

async function compactUsage() {
  return await accept(cronClient().compact({ headers: cronHeaders() }), [200]);
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

async function seedCompactionBatch(
  processedAt: Date,
  quantity: number,
): Promise<void> {
  const fixture = await seedFixture();
  await store.set(
    insertUsageEvent$,
    {
      ...fixture,
      status: "processed",
      quantity,
      processedAt,
    },
    context.signal,
  );
  await seedZeroUsageEvents(fixture, {
    processedAt,
    count: RAW_SEED_LIMIT - 1,
  });
}

// Fill the global cron seed so parallel test files cannot contribute rows.
async function seedZeroUsageEvents(
  fixture: UsageStateFixture,
  args: {
    readonly processedAt: Date;
    readonly count: number;
    readonly runId?: string | null;
    readonly provider?: string;
    readonly category?: string;
  },
): Promise<void> {
  await store.set(
    insertUsageEvent$,
    {
      ...fixture,
      runId: args.runId,
      provider: args.provider,
      category: args.category,
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
      createdAt: new Date("0500-01-01T00:00:00.000Z"),
      completedAt: new Date("0500-01-01T00:01:00.000Z"),
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
        processedAt: new Date("1800-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      processedAt: new Date("1800-01-01T00:15:00.000Z"),
      count: RAW_SEED_LIMIT - 1,
    });
    const response = await compactUsage();

    expect(response.body).toMatchObject({
      success: true,
      rawSeedLimit: RAW_SEED_LIMIT,
      seededRawRows: RAW_SEED_LIMIT,
      selectedGrains: 1,
      rawRowsDeleted: RAW_SEED_LIMIT,
      hourlyRowsDeleted: 0,
      hourlyRowsInserted: 1,
      quantity: "3",
      nonDeduplicatedQuantity: "0",
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
      "nonDeduplicatedQuantity",
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
    const heldFixture = await seedFixture();
    const startedHour = nowDate();
    startedHour.setUTCMinutes(0, 0, 0);
    const expectedCutoffAtStart = new Date(
      startedHour.getTime() - 4 * 24 * 60 * 60 * 1000,
    );
    const retainedProcessedAt = new Date(
      startedHour.getTime() - 3 * 24 * 60 * 60 * 1000,
    );
    const eligibleProcessedAt = new Date("0400-01-01T00:30:00.000Z");

    await store.set(
      insertUsageEvent$,
      {
        ...heldFixture,
        status: "processed",
        processedAt: new Date("0399-01-01T00:15:00.000Z"),
        billingError: "missing_pricing",
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...heldFixture,
        status: "pending",
        processedAt: new Date("0400-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...heldFixture,
        status: "processed",
        processedAt: retainedProcessedAt,
      },
      context.signal,
    );
    const eligibleFixture = await seedFixture();
    await store.set(
      insertUsageEvent$,
      {
        ...eligibleFixture,
        status: "processed",
        processedAt: eligibleProcessedAt,
      },
      context.signal,
    );
    await seedZeroUsageEvents(eligibleFixture, {
      processedAt: eligibleProcessedAt,
      count: RAW_SEED_LIMIT - 1,
    });

    const response = await compactUsage();
    const completedHour = nowDate();
    completedHour.setUTCMinutes(0, 0, 0);
    const expectedCutoffAtCompletion = new Date(
      completedHour.getTime() - 4 * 24 * 60 * 60 * 1000,
    );

    expect(response.body).toMatchObject({
      rawRowsDeleted: RAW_SEED_LIMIT,
      hourlyRowsInserted: 1,
      billingErrorHeldRows: 1,
    });
    expect([
      expectedCutoffAtStart.toISOString(),
      expectedCutoffAtCompletion.toISOString(),
    ]).toContain(response.body.cutoff);
    await expect(readStorage(heldFixture)).resolves.toStrictEqual({
      raw: 3,
      processedRaw: 2,
      hourly: 0,
    });
    await expect(readStorage(eligibleFixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
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
        processedAt: new Date("0200-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        category: "later-grain",
        processedAt: new Date("0200-01-01T01:15:00.000Z"),
      },
      context.signal,
    );

    const response = await compactUsage();

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
          processedAt: new Date("0100-01-01T00:15:00.000Z"),
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

    await seedCompactionBatch(new Date("0100-01-01T00:30:00.000Z"), 10_000);
    await compactUsage();
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
        processedAt: new Date("0100-01-01T00:45:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      processedAt: new Date("0100-01-01T00:45:00.000Z"),
      count: RAW_SEED_LIMIT - 1,
    });
    const late = await compactUsage();
    expect(late.body).toMatchObject({
      rawRowsDeleted: RAW_SEED_LIMIT,
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

    await seedCompactionBatch(new Date("0100-01-01T01:15:00.000Z"), 10_001);
    const retry = await compactUsage();
    expect(retry.body).toMatchObject({
      rawRowsDeleted: RAW_SEED_LIMIT,
      quantity: "10001",
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
        processedAt: new Date("0900-01-01T00:15:00.000Z"),
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
        processedAt: new Date("0900-01-01T00:30:00.000Z"),
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
        processedAt: new Date("0900-01-01T00:45:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      processedAt: new Date("0900-01-01T00:45:00.000Z"),
      count: RAW_SEED_LIMIT - 3,
    });

    const response = await compactUsage();

    expect(response.body).toMatchObject({
      selectedGrains: 3,
      rawRowsDeleted: RAW_SEED_LIMIT,
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
        processedAt: new Date("0800-01-01T00:15:00.000Z"),
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
        processedAt: new Date("0800-01-01T00:30:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      runId: run.runId,
      processedAt: new Date("0800-01-01T00:30:00.000Z"),
      count: RAW_SEED_LIMIT - 1,
    });

    await store.set(deleteRun$, run.runId, context.signal);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: RAW_SEED_LIMIT,
      processedRaw: RAW_SEED_LIMIT,
      hourly: 1,
    });
    const response = await compactUsage();

    expect(response.body).toMatchObject({
      rawRowsDeleted: RAW_SEED_LIMIT,
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
    for (let index = 0; index < 10; index += 1) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          status: "processed",
          processedAt: new Date("0700-01-01T00:15:00.000Z"),
        },
        context.signal,
      );
    }
    await seedZeroUsageEvents(fixture, {
      processedAt: new Date("0700-01-01T00:15:00.000Z"),
      count: RAW_SEED_LIMIT - 10,
    });
    await seedCompactionBatch(new Date("0700-01-01T01:15:00.000Z"), 70_001);

    const responses = await Promise.all([compactUsage(), compactUsage()]);

    const outcomes = responses.map((response) => {
      return {
        rawRowsDeleted: response.body.rawRowsDeleted,
        quantity: response.body.quantity,
      };
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toStrictEqual(
      expect.arrayContaining([
        { rawRowsDeleted: RAW_SEED_LIMIT, quantity: "10" },
        { rawRowsDeleted: RAW_SEED_LIMIT, quantity: "70001" },
      ]),
    );
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 1,
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
        processedAt: new Date("0001-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      processedAt: new Date("0001-01-01T00:15:00.000Z"),
      count: RAW_SEED_LIMIT - 1,
    });
    const gate = await startUsageCompactionLockGate();

    const compaction = compactUsage();
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
      rawRowsDeleted: RAW_SEED_LIMIT,
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
    const quantity = 7_000_000_000_000_321;
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        status: "processed",
        quantity,
        processedAt: new Date("0001-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await seedCompactionBatch(new Date("0001-01-01T01:15:00.000Z"), 1001);
    const gate = await startUsageCompactionLockGate();

    const cleanup = createStore().set(
      deleteUsageData$,
      { scope: "user", id: fixture.userId },
      context.signal,
    );
    await waitForUsageCompactionLockWaiters(gate, 1);
    const compaction = compactUsage();
    await waitForUsageCompactionLockWaiters(gate, 2);
    await releaseUsageCompactionLockGate(gate);
    const [, response] = await Promise.all([cleanup, compaction]);

    expect(response.body).toMatchObject({
      rawRowsDeleted: RAW_SEED_LIMIT,
      quantity: "1001",
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: 0,
      processedRaw: 0,
      hourly: 0,
    });
  });

  it("rolls back replacement and source deletion when the aggregate overflows bigint", async () => {
    const fixture = await seedFixture();
    await store.set(
      seedUsageOverflowGrain$,
      {
        ...fixture,
        processedAt: new Date("0600-01-01T00:15:00.000Z"),
      },
      context.signal,
    );
    await seedZeroUsageEvents(fixture, {
      provider: "overflow-fixture",
      category: "call",
      processedAt: new Date("0600-01-01T00:15:00.000Z"),
      count: RAW_SEED_LIMIT - 1,
    });
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: RAW_SEED_LIMIT,
      processedRaw: RAW_SEED_LIMIT,
      hourly: 1,
    });

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      cronCompactUsageEventsContract.compact.path,
      {
        method: cronCompactUsageEventsContract.compact.method,
        headers: cronHeaders(),
      },
    );

    expect(response.status).toBe(500);
    await expect(readStorage(fixture)).resolves.toStrictEqual({
      raw: RAW_SEED_LIMIT,
      processedRaw: RAW_SEED_LIMIT,
      hourly: 1,
    });
  });
});
