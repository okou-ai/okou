import { randomUUID } from "node:crypto";
import { connectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { holdBuiltinConnectorAccountFixture } from "../../../test-fixtures/builtin-connector-account-lock";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import { settleIncludingAbort } from "../../utils";
import { connectorsAutomaticRoutes } from "../connectors-automatic";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { installBuiltinAutomaticMcpCatalog } from "./helpers/builtin-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;
const routes = [
  ...connectorsAutomaticRoutes,
  ...connectorAccountRoutes,
] as const;

function automatic() {
  return setupApp({ context, routes })(connectorAutomaticContract);
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
  const catalog = await installBuiltinAutomaticMcpCatalog();
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
  it("keeps a newly reconnected sibling account valid while retiring its previous DCR client", async () => {
    const first = await fixture();
    const second = { ...first, userId: `user_${randomUUID()}` };
    onTestFinished(async () => {
      mocks.clerk.session(second.userId, second.orgId);
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", second.bucket);
      const list = await accept(
        accounts().connections({ headers, query: second.target }),
        [200],
      );
      for (const account of list.body.connections) {
        await accept(
          accounts().delete({
            headers,
            params: { connectionId: account.id },
            body: { target: second.target },
          }),
          [200],
        );
      }
    });
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      initialExpiresIn: 3600,
      authorizationCodeErrors: [null, null, "invalid_client", null],
    });
    const firstInitial = await oauthStart(first);
    await callback(firstInitial.state, provider.issuer);
    const firstAccount = await accept(
      receipt(first, firstInitial.attemptId),
      [200],
    );
    mocks.clerk.session(second.userId, second.orgId);
    const secondInitial = await oauthStart(second);
    await callback(secondInitial.state, provider.issuer);
    const secondAccount = await accept(
      receipt(second, secondInitial.attemptId),
      [200],
    );
    await installBuiltinAutomaticMcpCatalog({
      slug: first.slug,
      methodId: first.methodId,
      additionalAutomaticMethodId: "replacement-connect",
      isolateSource: false,
    });
    const replacement = await oauthStart(
      { ...second, methodId: "replacement-connect" },
      secondAccount.body.connectionId,
    );
    mocks.clerk.session(first.userId, first.orgId);
    const retiring = await oauthStart(first, firstAccount.body.connectionId);
    const held = await holdBuiltinConnectorAccountFixture(
      { ...second, connectorId: secondAccount.body.connectionId },
      context.signal,
    );
    const replacementResult = settleIncludingAbort(
      callback(replacement.state, provider.issuer),
    );
    const replacementBackend = await held.waitForBlocked();
    const retirementResult = settleIncludingAbort(
      callback(retiring.state, provider.issuer),
    );
    await waitForDeferredBlocker(replacementBackend);
    await held.release();
    await expect(replacementResult).resolves.toMatchObject({
      ok: true,
      value: { body: { status: "success" } },
    });
    await expect(retirementResult).resolves.toMatchObject({
      ok: true,
      value: { body: { status: "error" } },
    });
    mocks.clerk.session(second.userId, second.orgId);
    const retained = await accept(
      accounts().connection({
        headers,
        params: { connectionId: secondAccount.body.connectionId },
        query: second.target,
      }),
      [200],
    );
    expect(retained.body).toMatchObject({
      authMethod: "replacement-connect",
      connectionStatus: "connected",
      reconnectReason: null,
    });
  });

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

  it("allows only one completion for two reconnects based on the same account revision", async () => {
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
    const results = await Promise.all([
      callback(first.state, provider.issuer),
      callback(second.state, provider.issuer),
    ]);
    expect(
      results
        .map((result) => {
          return result.body.status;
        })
        .sort(),
    ).toStrictEqual(["error", "success"]);
    const receipts = await Promise.all([
      receipt(f, first.attemptId),
      receipt(f, second.attemptId),
    ]);
    expect(
      receipts
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 404]);
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
    await installBuiltinAutomaticMcpCatalog({
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
