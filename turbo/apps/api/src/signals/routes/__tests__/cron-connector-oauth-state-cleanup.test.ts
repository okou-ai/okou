import { randomUUID } from "node:crypto";

import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createRouteMocks } from "./helpers/route-test";
import {
  type TestCronDeleteCleanupsStateActionBody,
  type TestCronDeleteCleanupsStateResponse,
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";
import { builtinConnectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);
const API_ORIGIN = "https://api.okou.ai";

function mockAuthenticatedSession(marker: string): void {
  mocks.clerk.session(marker, marker);
}

async function startGithubOauth(marker: string): Promise<string> {
  mockAuthenticatedSession(marker);
  const response = await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorOauthStartContract,
    ).start({
      params: { connectorSlug: "github" },
      headers: { authorization: "Bearer clerk-session" },
      body: { authMethod: "oauth", account: { intent: "add" } },
    }),
    [200],
  );
  const state = new URL(response.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("GitHub OAuth authorization URL must include state");
  }
  return state;
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

function createConnectorFixture(marker: string) {
  const owner = createFixtureOperationOwner(async () => {
    await requestFixture({ action: "delete-connector", marker });
  });
  return {
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
    startOauth: async () => {
      return await owner.run(async () => {
        return await startGithubOauth(marker);
      });
    },
  };
}

describe("connector OAuth state cleanup cron", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  });

  afterEach(() => {
    clearMockNow();
  });

  it("deletes expired states while preserving unexpired states", async () => {
    const fixture = createConnectorFixture(
      `connector-oauth-cleanup-${randomUUID()}`,
    );
    const unrelatedFixture = createConnectorFixture(
      `connector-oauth-cleanup-${randomUUID()}`,
    );

    mockNow(now() - 20 * 60 * 1000);
    const expiredState = await fixture.startOauth();
    const unrelatedExpiredState = await unrelatedFixture.startOauth();
    clearMockNow();
    const unexpiredState = await fixture.startOauth();

    await expect(fixture.cleanup()).resolves.toStrictEqual({
      ok: true,
      remaining: [],
      deleted: 1,
    });
    await expect(fixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: [unexpiredState],
    });
    await expect(unrelatedFixture.read()).resolves.toStrictEqual({
      ok: true,
      remaining: [unrelatedExpiredState],
    });

    expect(expiredState).not.toBe(unexpiredState);
  });
});
