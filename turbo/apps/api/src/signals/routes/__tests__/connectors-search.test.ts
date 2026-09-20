import { randomUUID } from "node:crypto";

import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { builtinConnectorsRoutes } from "../connectors";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const store = createStore();

function featureSwitchesClient() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  await accept(
    featureSwitchesClient().delete({ headers: authHeaders() }),
    [200],
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/connectors/search", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];

  afterEach(async () => {
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await deleteFeatureSwitches(fixture.orgId, fixture.userId);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns connectors array with correct shape", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toBeInstanceOf(Array);
    expect(response.body.connectors.length).toBeGreaterThan(0);
    expect(response.body.connectors.length).toBeLessThanOrEqual(100);
    for (const connector of response.body.connectors) {
      expect(connector).toHaveProperty("slug");
      expect(connector).toHaveProperty("label");
      expect(connector).toHaveProperty("description");
      expect(connector).toHaveProperty("authMethods");
      expect(typeof connector.slug).toBe("string");
      expect(typeof connector.label).toBe("string");
      expect(typeof connector.description).toBe("string");
      expect(connector.authMethods).toBeInstanceOf(Array);
    }
  });

  it("filters connectors by keyword matching slug or label", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "GitHub" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
    for (const connector of response.body.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("github");
      const matchesSlug = connector.slug.toLowerCase().includes("github");
      expect(matchesLabel || matchesSlug).toBeTruthy();
    }
  });

  it("does not search connector descriptions", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "permission behavior" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
  });

  it("does not search connector tags", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "llm" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
  });

  it("returns empty array for non-matching keyword", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "zzz_no_match_zzz" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
  });

  it("performs case-insensitive keyword search", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );

    const lower = await accept(
      client.search({
        query: { keyword: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const upper = await accept(
      client.search({
        query: { keyword: "GITHUB" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(lower.body.connectors).toHaveLength(upper.body.connectors.length);
  });

  it("hides the test OAuth device connector when the test OAuth feature is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.slug === "test-oauth-device";
    });
    expect(connector).toBeUndefined();
  });

  it("shows the test OAuth device connector when the test OAuth feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.slug === "test-oauth-device";
    });
    expect(connector).toBeDefined();
    expect(connector?.authMethods).toStrictEqual(["oauth", "api"]);
  });

  it("applies accepted auth method visibility to connector search", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {});
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: { keyword: "cloudflare" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const cloudflare = response.body.connectors.find((connector) => {
      return connector.slug === "cloudflare";
    });
    expect(cloudflare?.authMethods).toStrictEqual(["oauth"]);
  });

  it("shows ungated api-token while hiding feature-gated oauth", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const neon = response.body.connectors.find((c) => {
      return c.slug === "neon";
    });
    expect(neon).toBeDefined();
    expect(neon?.authMethods).toContain("api-token");
    expect(neon?.authMethods).not.toContain("oauth");
  });

  it("exposes openai as api-token only", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const openai = response.body.connectors.find((c) => {
      return c.slug === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.authMethods).toStrictEqual(["api-token"]);
  });

  it("accepts an Okou run token carrying connector:read", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.connectors).toBeInstanceOf(Array);
    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("rejects an Okou run token missing connector:read with 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
