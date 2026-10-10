import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";

import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
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

function fixture() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  const catalog = automaticMcpCatalogFixture();
  onTestFinished(async () => {
    mocks.clerk.session(actor.userId, actor.orgId);
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

async function callback(
  state: string,
  issuer: string,
  code = "authorized-code",
) {
  return await accept(
    automatic().callback({
      query: {
        state,
        iss: issuer,
        code,
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
    const f = fixture();
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
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      initialExpiresIn: 3600,
      authorizationCodeErrors: [null, null, null, "invalid_client", null],
    });
    const initial = await oauthStart(f);
    expect((await callback(initial.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const original = await accept(receipt(f, initial.attemptId), [200]);
    const siblingAttempt = await oauthStart(f);
    expect(
      (await callback(siblingAttempt.state, provider.issuer)).body.status,
    ).toBe("success");
    const sibling = await accept(receipt(f, siblingAttempt.attemptId), [200]);
    const otherOwner = fixture();
    const otherAttempt = await oauthStart(otherOwner);
    expect(
      (await callback(otherAttempt.state, provider.issuer)).body.status,
    ).toBe("success");
    const otherAccount = await accept(
      receipt(otherOwner, otherAttempt.attemptId),
      [200],
    );
    mocks.clerk.session(f.userId, f.orgId);
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
    const unavailableSibling = await accept(
      accounts().connection({
        headers,
        params: { connectionId: sibling.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(unavailableSibling.body.connectionStatus).toBe("reconnect-required");
    mocks.clerk.session(otherOwner.userId, otherOwner.orgId);
    const retainedOther = await accept(
      accounts().connection({
        headers,
        params: { connectionId: otherAccount.body.connectionId },
        query: otherOwner.target,
      }),
      [200],
    );
    expect(retainedOther.body.connectionStatus).toBe("connected");
    mocks.clerk.session(f.userId, f.orgId);
    const retry = await oauthStart(f, original.body.connectionId);
    expect((await callback(retry.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(
      (await accept(receipt(f, retry.attemptId), [200])).body.connectionId,
    ).toBe(original.body.connectionId);
    expect(provider.registrationBodies).toHaveLength(3);
  });

  it("keeps a rebound account connected when an older invalid-client callback finishes", async () => {
    const f = fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      initialExpiresIn: 3600,
    });
    const initial = await oauthStart(f);
    expect((await callback(initial.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const connectionId = (await accept(receipt(f, initial.attemptId), [200]))
      .body.connectionId;
    const older = await oauthStart(f, connectionId);
    const rejected = await oauthStart(f, connectionId);
    const olderExchange = createDeferredPromise<void>(context.signal);
    const releaseOlder = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(`${provider.issuer}/token`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get("code") === "older-invalid-client") {
          olderExchange.resolve();
          await releaseOlder.promise;
          return HttpResponse.json(
            { error: "invalid_client" },
            { status: 400 },
          );
        }
        if (body.get("code") === "current-invalid-client") {
          return HttpResponse.json(
            { error: "invalid_client" },
            { status: 400 },
          );
        }
        return HttpResponse.json({
          access_token: "rebound-access-token",
          refresh_token: "rebound-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );
    const olderCallback = callback(
      older.state,
      provider.issuer,
      "older-invalid-client",
    );
    await olderExchange.promise;
    expect(
      (
        await callback(
          rejected.state,
          provider.issuer,
          "current-invalid-client",
        )
      ).body.status,
    ).toBe("error");
    const rebound = await oauthStart(f, connectionId);
    expect((await callback(rebound.state, provider.issuer)).body.status).toBe(
      "success",
    );
    releaseOlder.resolve();
    expect((await olderCallback).body.status).toBe("error");
    await accept(receipt(f, older.attemptId), [404]);
    const retained = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(retained.body.connectionStatus).toBe("connected");
    expect(provider.registrationBodies).toHaveLength(2);
  });

  it.each(["unlinked", "linked"] as const)(
    "retires an expired %s DCR registration during authorization preparation",
    async (linkage) => {
      const f = fixture();
      const startedAt = now();
      mockNow(startedAt);
      const originalProvider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrClientIdIssuedAt: startedAt - 1000,
        dcrClientSecretExpiresAt: startedAt + 60_000,
        initialExpiresIn: 3600,
      });
      const initial = await oauthStart(f);
      let connectionId: string | undefined;
      if (linkage === "linked") {
        expect(
          (await callback(initial.state, originalProvider.issuer)).body.status,
        ).toBe("success");
        connectionId = (await accept(receipt(f, initial.attemptId), [200])).body
          .connectionId;
      }
      mockNow(startedAt + 61_000);
      const replacementProvider = mockAutomaticMcpOAuthProvider(context, {
        registration: "dcr",
        dcrClientIdIssuedAt: startedAt + 61_000,
        dcrClientSecretExpiresAt: startedAt + 120_000,
        initialExpiresIn: 3600,
      });
      const replacement = await oauthStart(f, connectionId);
      if (connectionId) {
        const retired = await accept(
          accounts().connection({
            headers,
            params: { connectionId },
            query: f.target,
          }),
          [200],
        );
        expect(retired.body.connectionStatus).toBe("reconnect-required");
      } else {
        expect(
          (await callback(initial.state, replacementProvider.issuer)).body
            .status,
        ).toBe("error");
        await accept(receipt(f, initial.attemptId), [404]);
      }
      expect(
        (await callback(replacement.state, replacementProvider.issuer)).body
          .status,
      ).toBe("success");
      const completed = await accept(receipt(f, replacement.attemptId), [200]);
      if (connectionId) {
        expect(completed.body.connectionId).toBe(connectionId);
      }
      const connected = await accept(
        accounts().connection({
          headers,
          params: { connectionId: completed.body.connectionId },
          query: f.target,
        }),
        [200],
      );
      expect(connected.body.connectionStatus).toBe("connected");
      expect(originalProvider.registrationBodies).toHaveLength(1);
      expect(replacementProvider.registrationBodies).toHaveLength(1);
    },
  );

  it("rejects reconnecting an account owned by another user or organization", async () => {
    const f = fixture();
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
    const f = fixture();
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
});
