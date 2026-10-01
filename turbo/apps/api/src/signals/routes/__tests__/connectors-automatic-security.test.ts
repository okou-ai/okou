import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { installAutomaticMcpCatalog } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;
const routes = [
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
] as const;

function automatic() {
  return setupApp({ context, routes })(builtinConnectorAutomaticContract);
}

function accounts() {
  return setupApp({ context, routes })(connectorAccountsContract);
}

async function fixture() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  const catalog = await installAutomaticMcpCatalog();
  onTestFinished(async () => {
    mocks.clerk.session(actor.userId, actor.orgId);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", catalog.bucket);
    const result = await accept(
      accounts().connections({ headers, query: catalog.target }),
      [200],
    );
    for (const account of result.body.connections) {
      await accept(
        accounts().delete({
          headers,
          params: { connectionId: account.id },
          body: { target: catalog.target },
        }),
        [200],
      );
    }
  });
  return { ...actor, ...catalog };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function start(f: Fixture, connectionId?: string) {
  return automatic().start({
    headers,
    params: { connectorSlug: f.slug },
    body: {
      authMethod: f.methodId,
      account: connectionId
        ? { intent: "reconnect", connectionId }
        : { intent: "add" },
    },
  });
}

async function oauthStart(f: Fixture, connectionId?: string) {
  const response = await accept(start(f, connectionId), [200]);
  if (response.body.result !== "authorization") {
    throw new Error("Expected OAuth authorization");
  }
  const state = new URL(response.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return { state, attemptId: response.body.oauthAttemptId };
}

async function callback(state: string, issuer: string) {
  return await accept(
    automatic().callback({
      query: {
        state,
        iss: issuer,
        code: "authorized-code",
        responseMode: "json",
      },
    }),
    [200],
  );
}

function receipt(f: Fixture, attemptId: string) {
  return accounts().oauthCompletion({
    headers,
    params: { attemptId },
    query: f.target,
  });
}

describe("builtin Automatic account and consent ownership", () => {
  it("preserves an existing account and DCR client after a temporary callback failure", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      initialExpiresIn: 3600,
      authorizationCodeErrors: [null, "temporarily_unavailable", null],
    });
    const initial = await oauthStart(f);
    expect((await callback(initial.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const original = await accept(receipt(f, initial.attemptId), [200]);
    const interrupted = await oauthStart(f, original.body.connectionId);
    expect(
      (await callback(interrupted.state, provider.issuer)).body.status,
    ).toBe("error");
    await accept(receipt(f, interrupted.attemptId), [404]);
    const retained = await accept(
      accounts().connection({
        headers,
        params: { connectionId: original.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(retained.body.connectionStatus).toBe("connected");
    const retry = await oauthStart(f, original.body.connectionId);
    expect((await callback(retry.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(
      (await accept(receipt(f, retry.attemptId), [200])).body.connectionId,
    ).toBe(original.body.connectionId);
    expect(provider.registrationBodies).toHaveLength(1);
  });

  it("retires a rejected DCR client during callback and registers a new client on reconnect", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      initialExpiresIn: 3600,
      authorizationCodeErrors: [null, "invalid_client", null],
    });
    const initial = await oauthStart(f);
    expect((await callback(initial.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const original = await accept(receipt(f, initial.attemptId), [200]);
    const rejected = await oauthStart(f, original.body.connectionId);
    expect((await callback(rejected.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, rejected.attemptId), [404]);
    const unavailable = await accept(
      accounts().connection({
        headers,
        params: { connectionId: original.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(unavailable.body.connectionStatus).toBe("reconnect-required");
    const retry = await oauthStart(f, original.body.connectionId);
    expect((await callback(retry.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(
      (await accept(receipt(f, retry.attemptId), [200])).body.connectionId,
    ).toBe(original.body.connectionId);
    expect(provider.registrationBodies).toHaveLength(2);
  });

  it("rejects reconnecting an account owned by another user or organization", async () => {
    const f = await fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const connected = await accept(start(f), [200]);
    if (connected.body.result !== "connected") {
      throw new Error("Expected immediate no-auth connection");
    }
    const accountId = connected.body.connectedAccountId;
    for (const actor of [
      { userId: `user_${randomUUID()}`, orgId: f.orgId },
      { userId: f.userId, orgId: `org_${randomUUID()}` },
    ]) {
      mocks.clerk.session(actor.userId, actor.orgId);
      await accept(start(f, accountId), [409]);
    }
    mocks.clerk.session(f.userId, f.orgId);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: accountId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body.connectionStatus).toBe("connected");
  });

  it("leaves the account connected after two overlapping reconnects", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      initialExpiresIn: 3600,
    });
    const initial = await oauthStart(f);
    expect((await callback(initial.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const original = await accept(receipt(f, initial.attemptId), [200]);
    const first = await oauthStart(f, original.body.connectionId);
    const second = await oauthStart(f, original.body.connectionId);
    await Promise.all([
      callback(first.state, provider.issuer),
      callback(second.state, provider.issuer),
    ]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: original.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      authMethod: f.methodId,
      connectionStatus: "connected",
    });
  });

  it("rejects consent frozen for an endpoint that changes without a storage version change", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const started = await oauthStart(f);
    await installAutomaticMcpCatalog({
      slug: f.slug,
      methodId: f.methodId,
      endpoint: "https://replacement.example.test/mcp",
      isolateSource: false,
    });
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, started.attemptId), [404]);
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });
});
