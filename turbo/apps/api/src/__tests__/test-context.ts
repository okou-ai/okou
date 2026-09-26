import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";

import { closeDbPool } from "../lib/db";
import { clearMockedEnv } from "../lib/env";
import { clearMockListStripeInvoices } from "../signals/external/stripe-client";
import { clearAllDetached } from "../signals/utils";
import { getApiTestMocks, type ApiTestMocks } from "./mocks";

export interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: ApiTestMocks;
  readonly sessionHistoryBlobs: Map<string, Uint8Array>;
}

interface TestContextOptions {
  readonly connectorCatalog?: boolean;
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

export function testContext({
  connectorCatalog = false,
}: TestContextOptions = {}): TestContext {
  let controller = new AbortController();

  const context: TestContext = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    mocks: getApiTestMocks(),
    sessionHistoryBlobs: new Map<string, Uint8Array>(),
  };

  if (connectorCatalog) {
    beforeAll(async () => {
      const {
        installApiTestConnectorCatalog,
        mockApiTestConnectorProviderConfiguration,
      } = await import("../test-fixtures/connector-catalog");
      mockApiTestConnectorProviderConfiguration();
      await installApiTestConnectorCatalog();
    });

    beforeEach(async () => {
      const { mockApiTestConnectorProviderConfiguration } =
        await import("../test-fixtures/connector-catalog");
      mockApiTestConnectorProviderConfiguration();
    });
  }

  afterEach(async () => {
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
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
