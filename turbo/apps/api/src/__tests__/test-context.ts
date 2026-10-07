import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
} from "vitest";

import { closeDbPool } from "../lib/db";
import { clearMockedEnv } from "../lib/env";
import { clearMockListStripeInvoices } from "../signals/external/stripe-client";
import { clearAllDetached, settleIncludingAbort } from "../signals/utils";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { beginCaseDatabase } from "../test-fixtures/case-database";
import { getApiTestMocks, type ApiTestMocks } from "./mocks";

export interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: ApiTestMocks;
  readonly sessionHistoryBlobs: Map<string, Uint8Array>;
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

export function testContext(): TestContext {
  let controller = new AbortController();

  const context: TestContext = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    mocks: getApiTestMocks(),
    sessionHistoryBlobs: new Map<string, Uint8Array>(),
  };

  beforeEach(() => {
    const closeDatabase = beginCaseDatabase();
    // Vitest runs finished callbacks in reverse registration order. Register
    // first so case-owned API cleanup finishes before the database is closed.
    onTestFinished(async () => {
      controller.abort(new DOMException("Test case finished", "AbortError"));
      const detached = await settleIncludingAbort(clearAllDetached);
      const waiting = await settleIncludingAbort(flushWaitUntilForTest);
      const closed = await settleIncludingAbort(closeDatabase);
      const errors = [detached, waiting, closed].flatMap((result) => {
        return result.ok ? [] : [result.error];
      });
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Test cleanup failed");
      }
    });
    controller = new AbortController();
  });

  afterEach(async () => {
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    // Abort foreground work and give API-based cleanup its own live signal.
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
