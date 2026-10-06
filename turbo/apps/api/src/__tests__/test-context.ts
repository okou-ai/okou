import { randomUUID } from "node:crypto";

import { afterAll, afterEach, aroundEach, expect } from "vitest";

import { closeDbPool } from "../lib/db";
import { clearMockedEnv } from "../lib/env";
import { clearMockListStripeInvoices } from "../signals/external/stripe-client";
import { clearAllDetached } from "../signals/utils";
import {
  beginTestCaseCleanup,
  testCaseAbortController,
} from "../test-fixtures/case-owner";
import type { DbFixture } from "../test-fixtures/db-fixture";
import { getApiTestMocks, type ApiTestMocks } from "./mocks";

export interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: ApiTestMocks;
  readonly sessionHistoryBlobs: Map<string, Uint8Array>;
}

interface TestContextOptions {
  readonly dbFixtures?: readonly DbFixture[];
}

function formatBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body) ?? String(body);
}

export async function accept<
  TResponse extends { status: number; body: unknown },
  TStatus extends TResponse["status"] & number,
>(
  promise: Promise<TResponse>,
  statuses: readonly TStatus[],
): Promise<Extract<TResponse, { status: TStatus }>> {
  const result = await promise;
  if (!(statuses as readonly number[]).includes(result.status)) {
    expect(
      statuses,
      `Expected API response status to be one of ${statuses.join(
        ", ",
      )}, received ${result.status}. Body: ${formatBody(result.body)}`,
    ).toContain(result.status as TStatus);
  }

  return result as Extract<TResponse, { status: TStatus }>;
}

async function runWithDbFixtures(
  fixtures: readonly DbFixture[],
  scope: string,
  runTest: () => Promise<void>,
  index = 0,
): Promise<void> {
  const fixture = fixtures[index];
  if (!fixture) {
    await runTest();
    return;
  }

  await fixture(scope, async () => {
    await runWithDbFixtures(fixtures, scope, runTest, index + 1);
  });
}

export function testContext({
  dbFixtures = [],
}: TestContextOptions = {}): TestContext {
  let controller = new AbortController();

  const context: TestContext = {
    get signal(): AbortSignal {
      return testCaseAbortController()?.signal ?? controller.signal;
    },
    mocks: getApiTestMocks(),
    sessionHistoryBlobs: new Map<string, Uint8Array>(),
  };

  if (dbFixtures.length > 0) {
    aroundEach(async (runTest) => {
      await runWithDbFixtures(dbFixtures, randomUUID(), runTest);
    });
  }

  afterEach(async () => {
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    // Share the outer DB fixture's owner. Its teardown also handles setup
    // failures before this hook can run, without closing before native drainage.
    beginTestCaseCleanup(error);
    controller.abort(error);
    controller = new AbortController();

    await clearAllDetached();
    context.sessionHistoryBlobs.clear();
    clearMockedEnv();
    clearMockListStripeInvoices();
  });

  afterAll(async () => {
    await closeDbPool();
  });

  return context;
}
