import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import { installAutomaticMcpCatalog } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...connectorAccountRoutes,
]);

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
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", catalog.bucket);
    mocks.clerk.session(actor.userId, actor.orgId);
    const existing = await accept(
      accounts().connections({ headers, query: catalog.target }),
      [200],
    );
    for (const account of existing.body.connections) {
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
  return { ...catalog, ...actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function begin(f: Fixture, connectionId?: string) {
  return await accept(
    automatic().start({
      headers,
      params: { connectorSlug: f.slug },
      body: {
        authMethod: f.methodId,
        account: connectionId
          ? { intent: "reconnect", connectionId }
          : { intent: "add" },
      },
    }),
    [200],
  );
}

async function beginOAuth(f: Fixture, connectionId?: string) {
  const response = await begin(f, connectionId);
  if (response.body.result !== "authorization") {
    throw new Error("Expected authorization handoff");
  }
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected authorization state");
  }
  return { ...response.body, url, state };
}

async function callback(state: string, issuer: string) {
  return await accept(
    automatic().callback({
      query: {
        state,
        code: "authorized-code",
        iss: issuer,
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

describe("builtin MCP automatic authentication", () => {
  it("connects and reconnects accepted no-auth with its exact catalog method", async () => {
    const f = await fixture();
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
    });
    const connected = await begin(f);
    if (connected.body.result !== "connected") {
      throw new Error("Expected immediate no-auth completion");
    }
    const connectionId = connected.body.connectedAccountId;
    expect(connected.body).toStrictEqual({
      result: "connected",
      connectedAccountId: connectionId,
    });
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      authMethod: "smart-connect",
      connectionStatus: "connected",
      tokenExpiresAt: null,
      reconnectReason: null,
    });
    expect((await begin(f, connectionId)).body).toStrictEqual(connected.body);
  });

  it("completes CIMD OAuth through the fixed callback and exact receipt", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const started = await beginOAuth(f);
    expect(started.url.searchParams.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/automatic/callback",
    );
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    await accept(receipt(f, started.oauthAttemptId), [404]);
    expect((await callback(started.state, provider.issuer)).body).toStrictEqual(
      {
        status: "success",
        username: null,
      },
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const account = await accept(
      accounts().connection({
        headers,
        params: { connectionId: completed.body.connectionId },
        query: f.target,
      }),
      [200],
    );
    expect(account.body).toMatchObject({
      authMethod: f.methodId,
      connectionStatus: "connected",
    });
    expect(provider.tokenBodies[0]?.get("redirect_uri")).toBe(
      "https://api.okou.ai/api/connectors/automatic/callback",
    );
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    mocks.clerk.session(`user_${randomUUID()}`, f.orgId);
    await accept(receipt(f, started.oauthAttemptId), [404]);
    mocks.clerk.session(f.userId, f.orgId);
  });

  it("keeps DCR clients bound and rejects an OAuth issuer mismatch", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
    });
    const rejected = await beginOAuth(f);
    expect(
      (await callback(rejected.state, "https://other.example.test")).body
        .status,
    ).toBe("error");
    await accept(receipt(f, rejected.oauthAttemptId), [404]);
    const started = await beginOAuth(f);
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "success",
    );
    const completed = await accept(receipt(f, started.oauthAttemptId), [200]);
    const reconnect = await beginOAuth(f, completed.body.connectionId);
    expect((await callback(reconnect.state, provider.issuer)).body.status).toBe(
      "success",
    );
    expect(
      (await accept(receipt(f, reconnect.oauthAttemptId), [200])).body,
    ).toStrictEqual(completed.body);
    expect(provider.registrationBodies).toHaveLength(1);
  });

  it("rejects an in-flight callback when its catalog storage contract changes", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const started = await beginOAuth(f);
    await installAutomaticMcpCatalog({
      slug: f.slug,
      methodId: f.methodId,
      storageVersion: 2,
      isolateSource: false,
    });
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, started.oauthAttemptId), [404]);
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("does not resurrect a deleted reconnect account", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const initial = await beginOAuth(f);
    await callback(initial.state, provider.issuer);
    const receiptResult = await accept(
      receipt(f, initial.oauthAttemptId),
      [200],
    );
    const connectionId = receiptResult.body.connectionId;
    const reconnect = await beginOAuth(f, connectionId);
    await accept(
      accounts().delete({
        headers,
        params: { connectionId },
        body: { target: f.target },
      }),
      [200],
    );
    expect((await callback(reconnect.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, reconnect.oauthAttemptId), [404]);
    expect(
      (
        await accept(
          accounts().connections({ headers, query: f.target }),
          [200],
        )
      ).body.connections,
    ).toStrictEqual([]);
  });

  it("consumes cancellation without accepting a subsequent authorization code", async () => {
    const f = await fixture();
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
    });
    const started = await beginOAuth(f);
    const cancelled = await accept(
      automatic().callback({
        query: {
          state: started.state,
          error: "access_denied",
          responseMode: "json",
        },
      }),
      [200],
    );
    expect(cancelled.body.status).toBe("error");
    expect((await callback(started.state, provider.issuer)).body.status).toBe(
      "error",
    );
    await accept(receipt(f, started.oauthAttemptId), [404]);
  });
});
