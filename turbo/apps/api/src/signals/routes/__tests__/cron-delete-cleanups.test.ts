import { randomUUID } from "node:crypto";

import { cronTelegramCleanupContract } from "@okouai/api-contracts/contracts/cron";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import {
  type TestCronDeleteCleanupsStateActionBody,
  type TestCronDeleteCleanupsStateResponse,
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";
import { cronTelegramCleanupRoutes } from "../cron-telegram-cleanup";

const context = testContext();
const CRON_SECRET = "test-delete-cleanups-secret";
const CONNECTOR_EXPIRED_COUNT = 11;
// One more than the test delete batch size, so the cleanup loop runs a full
// batch followed by a short batch exactly as the production batch size does.
const TELEGRAM_EXPIRED_COUNT = 3;
const CUTOFF_MS = Date.parse("1950-01-31T00:00:00.000Z");
const TELEGRAM_CUTOFF_MS = Date.parse("1950-04-20T00:00:00.000Z");
const TELEGRAM_NOW_MS = Date.parse("1950-05-20T00:00:00.000Z");

function connectorState(marker: string, kind: string): string {
  return `${marker}:${kind}`;
}

async function requestFixture(
  body: TestCronDeleteCleanupsStateActionBody,
): Promise<TestCronDeleteCleanupsStateResponse> {
  const response = await accept(
    setupApp({ context, routes: testCronDeleteCleanupsStateRoutes })(
      testCronDeleteCleanupsStateContract,
    ).action({ body }),
    [200],
  );
  return response.body;
}

async function seedConnectorFixture(expiredCount: number) {
  const marker = `connector-cleanup-${randomUUID()}`;
  const owner = createFixtureOperationOwner(async () => {
    await requestFixture({ action: "delete-connector", marker });
  });
  await owner.run(async () => {
    await requestFixture({
      action: "seed-connector",
      marker,
      cutoff: new Date(CUTOFF_MS).toISOString(),
      expiredCount,
    });
  });
  return {
    marker,
    cleanup: async () => {
      return await owner.run(async () => {
        return await requestFixture({ action: "cleanup-connector", marker });
      });
    },
    read: async () => {
      return await owner.run(async () => {
        return await requestFixture({ action: "read-connector", marker });
      });
    },
  };
}

async function seedTelegramFixture(expiredCount: number) {
  const marker = `telegram-cleanup-${randomUUID()}`;
  const owner = createFixtureOperationOwner(async () => {
    await requestFixture({ action: "delete-telegram", marker });
  });
  await owner.run(async () => {
    await requestFixture({
      action: "seed-telegram",
      marker,
      cutoff: new Date(TELEGRAM_CUTOFF_MS).toISOString(),
      expiredCount,
    });
  });
  return {
    marker,
    cleanup: async () => {
      return await owner.run(async () => {
        return await requestFixture({ action: "cleanup-telegram", marker });
      });
    },
    read: async () => {
      return await owner.run(async () => {
        return await requestFixture({ action: "read-telegram", marker });
      });
    },
  };
}

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

async function cleanupTelegramMessages() {
  return await accept(
    setupApp({ context, routes: cronTelegramCleanupRoutes })(
      cronTelegramCleanupContract,
    ).cleanup({
      headers: cronHeaders(),
    }),
    [200],
  );
}

describe("complete delete cleanup crons", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  afterEach(() => {
    clearMockNow();
    stubTestTimezone("UTC");
  });

  it("caps connector cleanup at ten batches and preserves the UTC cutoff outside UTC", async () => {
    stubTestTimezone("Asia/Shanghai");
    mockNow(CUTOFF_MS);
    const fixture = await seedConnectorFixture(CONNECTOR_EXPIRED_COUNT);
    const unrelatedFixture = await seedConnectorFixture(1);

    const first = await fixture.cleanup();
    expect(first.deleted).toBe(10);
    await expect(fixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: [
        connectorState(fixture.marker, "equal"),
        connectorState(fixture.marker, "expired-10"),
        connectorState(fixture.marker, "future"),
      ],
    });
    await expect(unrelatedFixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: [
        connectorState(unrelatedFixture.marker, "equal"),
        connectorState(unrelatedFixture.marker, "expired-0"),
        connectorState(unrelatedFixture.marker, "future"),
      ],
    });

    const second = await fixture.cleanup();
    expect(second.deleted).toBe(2);
    await expect(fixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: [connectorState(fixture.marker, "future")],
    });

    const empty = await fixture.cleanup();
    expect(empty.deleted).toBe(0);
  });

  it("runs full and short telegram batches across a non-UTC daylight-saving boundary", async () => {
    stubTestTimezone("America/New_York");
    mockNow(TELEGRAM_NOW_MS);
    const fixture = await seedTelegramFixture(TELEGRAM_EXPIRED_COUNT);

    const cleanup = await fixture.cleanup();
    expect(cleanup.deleted).toBe(TELEGRAM_EXPIRED_COUNT);
    await expect(fixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: ["equal", "future"],
    });

    const empty = await fixture.cleanup();
    expect(empty.deleted).toBe(0);
  });

  it("preserves the strict telegram cutoff in UTC", async () => {
    stubTestTimezone("UTC");
    mockNow(TELEGRAM_NOW_MS);
    const fixture = await seedTelegramFixture(1);

    const cleanup = await cleanupTelegramMessages();
    expect(cleanup.body.deleted).toBe(1);
    await expect(fixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: ["equal", "future"],
    });
  });
});
