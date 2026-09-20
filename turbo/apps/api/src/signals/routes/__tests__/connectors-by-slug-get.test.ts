import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorsBySlugContract,
} from "@okouai/api-contracts/contracts/connectors";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  invalidateApiTestConnectorCatalogCompatibility,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedConnectorStorageRow } from "./helpers/connector-credential-storage-state";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function seedSandboxJwtFixture(): Promise<AuthenticatedFixture> {
  const fixture = await store.set(
    seedOrgMembership$,
    { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectOpenai(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
        values: { apiKey: "sk-test-token" },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function deleteOpenai(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  const accounts = await accept(
    client.connections({
      headers: authHeaders(),
      query: { kind: "builtin", connectorSlug: "openai" },
    }),
    [200, 404],
  );
  if (accounts.status === 404) {
    return;
  }
  for (const account of accounts.body.connections) {
    await accept(
      client.delete({
        headers: authHeaders(),
        params: { connectionId: account.id },
        body: { target: { kind: "builtin", connectorSlug: "openai" } },
      }),
      [200],
    );
  }
}

describe("GET /api/connectors/:connectorSlug", () => {
  const seededFixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOpenai(fixture);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({ params: { connectorSlug: "github" }, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when no connector with that slug exists", async () => {
    const fixture = seedAuthenticatedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "github" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns a connector created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectOpenai(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      slug: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("returns 404 when the stored connector runtime method is unavailable", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      authMethod: "unavailable-method",
      storageVersion: 1,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the external catalog is unavailable", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectOpenai(fixture);
    mockOptionalEnv("DROPBOX_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("allows access with a sandbox JWT carrying connector:read capability", async () => {
    const fixture = await seedSandboxJwtFixture();
    seededFixtures.push(fixture);
    await connectOpenai(fixture);

    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsBySlugContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: "openai" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.slug).toBe("openai");
  });
});
