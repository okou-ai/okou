import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";

import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const claimedToken = createClaimedRunCredentials(context).okouToken;
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectOpenai(fixture: AuthenticatedFixture): Promise<string> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await accept(
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
  const connectionId = response.body.connectionId;
  onTestFinished(async () => {
    await deleteOpenai(fixture, connectionId, [200, 404]);
  });
  return connectionId;
}

async function deleteOpenai(
  fixture: AuthenticatedFixture,
  connectionId: string,
  statuses: readonly (200 | 404)[],
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  await accept(
    client.delete({
      headers: authHeaders(),
      params: { connectionId },
      body: { target: { kind: "builtin", connectorSlug: "openai" } },
    }),
    statuses,
  );
}

describe("GET /api/connector-accounts/:connectionId", () => {
  it("returns 401 when not authenticated", async () => {
    const connectionId = randomUUID();
    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const response = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "github" },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const connectionId = randomUUID();
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const response = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns a connector created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    const connectionId = await connectOpenai(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const response = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: connectionId,
      target: { kind: "builtin", connectorSlug: "openai" },
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("allows an exact account read with a claimed Runner credential", async () => {
    const fixture = seedAuthenticatedFixture();

    const token = await claimedToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    const connectionId = await connectOpenai(fixture);

    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const response = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.target).toStrictEqual({
      kind: "builtin",
      connectorSlug: "openai",
    });
  });

  it("keeps stored connector details scoped to the user, organization, and slug", async () => {
    const owner = seedAuthenticatedFixture();
    const connectionId = await connectOpenai(owner);
    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const own = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(own.body.id).toBe(connectionId);

    const wrongSlug = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "github" },
        headers: authHeaders(),
      }),
      [404],
    );
    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId);
    const otherUser = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );
    mocks.clerk.session(owner.userId, `org_${randomUUID()}`);
    const otherOrg = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherUser.body).toStrictEqual(wrongSlug.body);
    expect(otherOrg.body).toStrictEqual(wrongSlug.body);

    mocks.clerk.session(owner.userId, owner.orgId);
    const ownAgain = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(ownAgain.body).toStrictEqual(own.body);
  });

  it("reads current account details after rename, deletion, and a new connection", async () => {
    const owner = seedAuthenticatedFixture();
    const connectionId = await connectOpenai(owner);
    const client = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const original = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );
    const renamed = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).rename({
        headers: authHeaders(),
        params: { connectionId },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Renamed OpenAI account",
        },
      }),
      [200],
    );
    const afterRename = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(afterRename.body).toStrictEqual({
      ...original.body,
      displayName: "Renamed OpenAI account",
      updatedAt: renamed.body.updatedAt,
    });

    await deleteOpenai(owner, connectionId, [200]);
    const deleted = await accept(
      client.connection({
        params: { connectionId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(deleted.body.error.code).toBe("NOT_FOUND");

    const replacementId = await connectOpenai(owner);
    expect(replacementId).not.toBe(connectionId);
    const replacement = await accept(
      client.connection({
        params: { connectionId: replacementId },
        query: { kind: "builtin", connectorSlug: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(replacement.body).toMatchObject({
      id: replacementId,
      target: { kind: "builtin", connectorSlug: "openai" },
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });
});
