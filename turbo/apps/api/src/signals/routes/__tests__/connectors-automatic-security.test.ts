import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const store = createStore();
const automatic = setupApp({
  context,
  routes: builtinConnectorsAutomaticRoutes,
})(builtinConnectorAutomaticContract);
const accountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);

/** A member with a real membership in `orgId`. */
async function memberOf(userId: string, orgId: string): Promise<ApiTestUser> {
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "member" },
    context.signal,
  );
  return {
    userId,
    orgId,
    orgRole: "org:member",
    email: `${userId}@example.test`,
  };
}

async function startAutomatic(
  actor: ApiTestUser,
  connectorSlug: string,
  account:
    | { readonly intent: "add" }
    | { readonly intent: "reconnect"; readonly connectionId: string },
  statuses: readonly (200 | 409)[],
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(
    automatic.start({
      headers: { authorization: "Bearer clerk-session" },
      params: { connectorSlug },
      body: { authMethod: "smart-connect", account },
    }),
    statuses,
  );
}

async function startAutomaticAuthorization(
  actor: ApiTestUser,
  connectorSlug: string,
  account:
    | { readonly intent: "add" }
    | { readonly intent: "reconnect"; readonly connectionId: string },
) {
  const started = await startAutomatic(actor, connectorSlug, account, [200]);
  if (!("result" in started.body) || started.body.result !== "authorization") {
    throw new Error("Expected an OAuth authorization redirect");
  }
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state in authorization URL");
  }
  return { state, attemptId: started.body.oauthAttemptId };
}

async function completeAutomaticCallback(state: string, issuer: string) {
  return await accept(
    automatic.callback({
      query: {
        state,
        code: `code-${randomUUID()}`,
        iss: issuer,
        responseMode: "json",
      },
    }),
    [200],
  );
}

async function readOAuthCompletion(
  actor: ApiTestUser,
  connectorSlug: string,
  attemptId: string,
  statuses: readonly (200 | 404)[],
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(
    accountsApi.oauthCompletion({
      headers: { authorization: "Bearer clerk-session" },
      params: { attemptId },
      query: { kind: "builtin", connectorSlug },
    }),
    statuses,
  );
}

async function connectDcrAccount(
  actor: ApiTestUser,
  connectorSlug: string,
  issuer: string,
) {
  const { state, attemptId } = await startAutomaticAuthorization(
    actor,
    connectorSlug,
    { intent: "add" },
  );
  const callback = await completeAutomaticCallback(state, issuer);
  expect(callback.body.status).toBe("success");
  const receipt = await readOAuthCompletion(
    actor,
    connectorSlug,
    attemptId,
    [200],
  );
  if (!("connectionId" in receipt.body)) {
    throw new Error("Expected a completed connection ID");
  }
  return { callback, connectionId: receipt.body.connectionId };
}

describe("builtin Automatic account and consent ownership", () => {
  it("connectors-automatic-security-006 rejects reconnecting an account owned by another user or organization", async () => {
    const fixture = automaticMcpCatalogFixture("none");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "none",
      authentication: "none",
      endpoint: fixture.endpoint,
    });
    const workspaceId = `org_${randomUUID()}`;
    const owner = await memberOf(`user_${randomUUID()}`, workspaceId);
    const connected = await startAutomatic(
      owner,
      fixture.slug,
      { intent: "add" },
      [200],
    );
    if (
      !("result" in connected.body) ||
      connected.body.result !== "connected"
    ) {
      throw new Error("Expected the account to connect immediately");
    }
    const reconnect = {
      intent: "reconnect",
      connectionId: connected.body.connectionId,
    } as const;
    const peer = await memberOf(`user_${randomUUID()}`, workspaceId);
    const ownerElsewhere = await memberOf(owner.userId, `org_${randomUUID()}`);

    const peerAttempt = await startAutomatic(
      peer,
      fixture.slug,
      reconnect,
      [409],
    );
    const elsewhereAttempt = await startAutomatic(
      ownerElsewhere,
      fixture.slug,
      reconnect,
      [409],
    );

    expect(peerAttempt.status).toBe(409);
    expect(elsewhereAttempt.status).toBe(409);
    const account = await connectors.readBuiltinConnectorAccount(
      owner,
      fixture.slug,
      connected.body.connectionId,
    );
    expect(account.connectionStatus).toBe("connected");
  });

  it("connectors-automatic-security-001 (1/2) preserves an existing account after a temporary callback failure", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer: `https://dcr-temp-1-${randomUUID().slice(0, 8)}.example.test`,
      authorizationCodeErrors: [null, "temporarily_unavailable", null],
    });
    const member = await memberOf(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );

    const initial = await connectDcrAccount(
      member,
      fixture.slug,
      provider.issuer,
    );
    const failedStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: initial.connectionId },
    );
    const failedCallback = await completeAutomaticCallback(
      failedStart.state,
      provider.issuer,
    );
    const failedReceipt = await readOAuthCompletion(
      member,
      fixture.slug,
      failedStart.attemptId,
      [404],
    );
    const account = await connectors.readBuiltinConnectorAccount(
      member,
      fixture.slug,
      initial.connectionId,
    );

    expect(initial.callback.body.status).toBe("success");
    expect(failedCallback.body.status).toBe("error");
    expect(failedReceipt.status).toBe(404);
    expect(account.id).toBe(initial.connectionId);
    expect(account.connectionStatus).toBe("connected");
  });

  it("connectors-automatic-security-001 (2/2) retries reconnect with the same connection ID and one client registration", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer: `https://dcr-temp-2-${randomUUID().slice(0, 8)}.example.test`,
      authorizationCodeErrors: [null, "temporarily_unavailable", null],
    });
    const member = await memberOf(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    const initial = await connectDcrAccount(
      member,
      fixture.slug,
      provider.issuer,
    );
    const failedStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: initial.connectionId },
    );
    const failedCallback = await completeAutomaticCallback(
      failedStart.state,
      provider.issuer,
    );
    expect(failedCallback.body.status).toBe("error");

    const retryStart = await startAutomaticAuthorization(member, fixture.slug, {
      intent: "reconnect",
      connectionId: initial.connectionId,
    });
    const retryCallback = await completeAutomaticCallback(
      retryStart.state,
      provider.issuer,
    );
    const retryReceipt = await readOAuthCompletion(
      member,
      fixture.slug,
      retryStart.attemptId,
      [200],
    );

    expect(retryCallback.body.status).toBe("success");
    expect(retryReceipt.body).toStrictEqual({
      connectionId: initial.connectionId,
    });
    expect(provider.registrationBodies).toHaveLength(1);
  });

  it("connectors-automatic-security-005 retires an expired linked DCR registration during authorization preparation", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const issuer = `https://dcr-exp-${randomUUID().slice(0, 8)}.example.test`;
    const baseMs = now();
    mockNow(baseMs);
    const initialProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer,
      dcrClientSecretExpiresAt: Math.floor(baseMs / 1000) + 60,
    });
    const member = await memberOf(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    const initial = await connectDcrAccount(
      member,
      fixture.slug,
      initialProvider.issuer,
    );

    mockNow(baseMs + 61_000);
    const replacementProvider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer,
    });
    const reconnectStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: initial.connectionId },
    );
    const whilePreparing = await connectors.readBuiltinConnectorAccount(
      member,
      fixture.slug,
      initial.connectionId,
    );
    const reconnectCallback = await completeAutomaticCallback(
      reconnectStart.state,
      replacementProvider.issuer,
    );
    const reconnectReceipt = await readOAuthCompletion(
      member,
      fixture.slug,
      reconnectStart.attemptId,
      [200],
    );
    const afterReconnect = await connectors.readBuiltinConnectorAccount(
      member,
      fixture.slug,
      initial.connectionId,
    );

    expect(whilePreparing.connectionStatus).toBe("reconnect-required");
    expect(reconnectCallback.body.status).toBe("success");
    expect(reconnectReceipt.body).toStrictEqual({
      connectionId: initial.connectionId,
    });
    expect(afterReconnect.connectionStatus).toBe("connected");
    expect(initialProvider.registrationBodies).toHaveLength(1);
    expect(replacementProvider.registrationBodies).toHaveLength(1);
  });

  it("connectors-automatic-security-002 (1/3) retires a rejected DCR client and marks the member's accounts reconnect-required", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer: `https://dcr-inv-1-${randomUUID().slice(0, 8)}.example.test`,
      authorizationCodeErrors: [null, null, "invalid_client", null],
    });
    const member = await memberOf(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    const firstStart = await startAutomaticAuthorization(member, fixture.slug, {
      intent: "add",
    });
    const [, secondStart] = await Promise.all([
      completeAutomaticCallback(firstStart.state, provider.issuer),
      startAutomaticAuthorization(member, fixture.slug, { intent: "add" }),
    ]);
    const [firstReceipt] = await Promise.all([
      readOAuthCompletion(member, fixture.slug, firstStart.attemptId, [200]),
      completeAutomaticCallback(secondStart.state, provider.issuer),
    ]);
    if (!("connectionId" in firstReceipt.body)) {
      throw new Error("Expected a completed connection ID");
    }

    const rejectedStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: firstReceipt.body.connectionId },
    );
    const rejectedCallback = await completeAutomaticCallback(
      rejectedStart.state,
      provider.issuer,
    );
    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const [rejectedReceipt, listed] = await Promise.all([
      accept(
        accountsApi.oauthCompletion({
          headers: { authorization: "Bearer clerk-session" },
          params: { attemptId: rejectedStart.attemptId },
          query: { kind: "builtin", connectorSlug: fixture.slug },
        }),
        [404],
      ),
      accept(
        accountsApi.connections({
          headers: { authorization: "Bearer clerk-session" },
          query: { kind: "builtin", connectorSlug: fixture.slug },
        }),
        [200],
      ),
    ]);

    expect(rejectedCallback.body.status).toBe("error");
    expect(rejectedReceipt.status).toBe(404);
    expect(listed.body.connections).toHaveLength(2);
    for (const account of listed.body.connections) {
      expect(account.connectionStatus).toBe("reconnect-required");
    }
  });

  it("connectors-automatic-security-002 (2/3) keeps another workspace owner's account connected after DCR retirement", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer: `https://dcr-inv-2-${randomUUID().slice(0, 8)}.example.test`,
      authorizationCodeErrors: [null, null, null, "invalid_client", null],
    });
    const [member, otherOwner] = await Promise.all([
      memberOf(`user_${randomUUID()}`, `org_${randomUUID()}`),
      memberOf(`user_${randomUUID()}`, `org_${randomUUID()}`),
    ]);
    const firstStart = await startAutomaticAuthorization(member, fixture.slug, {
      intent: "add",
    });
    const [, secondStart] = await Promise.all([
      completeAutomaticCallback(firstStart.state, provider.issuer),
      startAutomaticAuthorization(member, fixture.slug, { intent: "add" }),
    ]);
    const [foreignStart] = await Promise.all([
      startAutomaticAuthorization(otherOwner, fixture.slug, { intent: "add" }),
      completeAutomaticCallback(secondStart.state, provider.issuer),
    ]);
    const [firstReceipt] = await Promise.all([
      readOAuthCompletion(member, fixture.slug, firstStart.attemptId, [200]),
      completeAutomaticCallback(foreignStart.state, provider.issuer),
    ]);
    if (!("connectionId" in firstReceipt.body)) {
      throw new Error("Expected a completed connection ID");
    }

    const rejectedStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: firstReceipt.body.connectionId },
    );
    const rejectedCallback = await completeAutomaticCallback(
      rejectedStart.state,
      provider.issuer,
    );
    createRouteMocks(context).clerk.session(
      otherOwner.userId,
      otherOwner.orgId,
      otherOwner.orgRole,
    );
    const foreignListed = await accept(
      accountsApi.connections({
        headers: { authorization: "Bearer clerk-session" },
        query: { kind: "builtin", connectorSlug: fixture.slug },
      }),
      [200],
    );

    expect(rejectedCallback.body.status).toBe("error");
    expect(foreignListed.body.connections).toHaveLength(1);
    expect(foreignListed.body.connections[0]?.connectionStatus).toBe(
      "connected",
    );
  });

  it("connectors-automatic-security-002 (3/3) registers a new client on retry reconnect after invalid_client retirement", async () => {
    const fixture = automaticMcpCatalogFixture("oauth");
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "dcr",
      authentication: "oauth",
      endpoint: fixture.endpoint,
      issuer: `https://dcr-inv-3-${randomUUID().slice(0, 8)}.example.test`,
      authorizationCodeErrors: [null, null, null, "invalid_client", null],
    });
    const [member, otherOwner] = await Promise.all([
      memberOf(`user_${randomUUID()}`, `org_${randomUUID()}`),
      memberOf(`user_${randomUUID()}`, `org_${randomUUID()}`),
    ]);
    const firstStart = await startAutomaticAuthorization(member, fixture.slug, {
      intent: "add",
    });
    const [, secondStart] = await Promise.all([
      completeAutomaticCallback(firstStart.state, provider.issuer),
      startAutomaticAuthorization(member, fixture.slug, { intent: "add" }),
    ]);
    const [foreignStart] = await Promise.all([
      startAutomaticAuthorization(otherOwner, fixture.slug, { intent: "add" }),
      completeAutomaticCallback(secondStart.state, provider.issuer),
    ]);
    const [firstReceipt] = await Promise.all([
      readOAuthCompletion(member, fixture.slug, firstStart.attemptId, [200]),
      completeAutomaticCallback(foreignStart.state, provider.issuer),
    ]);
    if (!("connectionId" in firstReceipt.body)) {
      throw new Error("Expected a completed connection ID");
    }
    const firstConnectionId = firstReceipt.body.connectionId;
    const rejectedStart = await startAutomaticAuthorization(
      member,
      fixture.slug,
      { intent: "reconnect", connectionId: firstConnectionId },
    );
    const rejectedCallback = await completeAutomaticCallback(
      rejectedStart.state,
      provider.issuer,
    );
    expect(rejectedCallback.body.status).toBe("error");

    const retryStart = await startAutomaticAuthorization(member, fixture.slug, {
      intent: "reconnect",
      connectionId: firstConnectionId,
    });
    const retryCallback = await completeAutomaticCallback(
      retryStart.state,
      provider.issuer,
    );
    const retryReceipt = await readOAuthCompletion(
      member,
      fixture.slug,
      retryStart.attemptId,
      [200],
    );

    expect(retryCallback.body.status).toBe("success");
    expect(retryReceipt.body).toStrictEqual({
      connectionId: firstConnectionId,
    });
    expect(provider.registrationBodies).toHaveLength(3);
  });
});
