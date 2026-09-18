import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";
import {
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const githubTarget = { kind: "builtin", connectorSlug: "github" } as const;

function accountClient(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function state(start: { readonly authorizationUrl: string }): string {
  const value = new URL(start.authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Expected OAuth state");
  }
  return value;
}

async function receipt(
  actor: ApiTestUser,
  id: string,
  target: ConnectorAccountTarget = githubTarget,
) {
  return await accept(
    accountClient(actor).oauthCompletion({
      headers: authHeaders(),
      params: { attemptId: id },
      query: target,
    }),
    [200, 404],
  );
}

async function createGithubAccount(actor: ApiTestUser) {
  mockGitHubConnectorOAuth({ userId: 32_503, login: "completion-account" });
  const start = await connectors.startOauth(actor, "github", "oauth");
  const completed = await connectors.completeOauthCallbackResult("github", {
    code: "create",
    state: state(start),
  });
  expect(completed.body.status).toBe("success");
  const result = await receipt(actor, start.oauthAttemptId);
  expect(result.status).toBe(200);
  if (result.status !== 200) {
    throw new Error("Expected completed GitHub account");
  }
  return { start, connectionId: result.body.connectionId };
}

test("exposes a receipt only to its owner and exact current connector target", async () => {
  await installApiTestConnectorCatalog();
  const actor = bdd.user();
  const { start, connectionId } = await createGithubAccount(actor);
  const id = start.oauthAttemptId;
  const completed = await receipt(actor, id);
  expect(completed.body).toStrictEqual({ connectionId });
  expect(completed.headers.get("cache-control")).toBe("no-store");

  const wrongTarget = await receipt(actor, id, {
    kind: "builtin",
    connectorSlug: "linear",
  });
  const wrongOrg = await receipt(bdd.user({ userId: actor.userId }), id);
  const wrongUser = await receipt(bdd.user({ orgId: actor.orgId }), id);
  const missing = await receipt(actor, randomUUID());
  for (const unavailable of [wrongTarget, wrongOrg, wrongUser, missing]) {
    expect(unavailable.status).toBe(404);
    expect(unavailable.body).toStrictEqual(missing.body);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  }
  const anonymous = await accountClient(actor).oauthCompletion({
    params: { attemptId: id },
    query: githubTarget,
  });
  expect(anonymous.status).toBe(401);

  await connectors.deleteBuiltinConnectorAccount(actor, "github", connectionId);
  expect((await receipt(actor, id)).status).toBe(404);
});

test("does not complete a denied reconnect after rename or default-account changes and allows retry", async () => {
  await installApiTestConnectorCatalog();
  const actor = bdd.user();
  const { connectionId } = await createGithubAccount(actor);
  const account = { intent: "reconnect", connectionId } as const;
  const cancelled = await connectors.startOauth(
    actor,
    "github",
    "oauth",
    undefined,
    account,
  );
  await accept(
    accountClient(actor).rename({
      headers: authHeaders(),
      params: { connectionId },
      body: { target: githubTarget, displayName: "Renamed during consent" },
    }),
    [200],
  );
  await connectors.setDefaultBuiltinConnectorAccount(
    actor,
    "github",
    connectionId,
  );
  expect((await receipt(actor, cancelled.oauthAttemptId)).status).toBe(404);
  const denied = await connectors.completeOauthCallbackResult("github", {
    error: "access_denied",
    state: state(cancelled),
  });
  expect(denied.body.status).toBe("error");
  expect((await receipt(actor, cancelled.oauthAttemptId)).status).toBe(404);

  const retry = await connectors.startOauth(
    actor,
    "github",
    "oauth",
    undefined,
    account,
  );
  await connectors.completeOauthCallbackResult("github", {
    code: "retry",
    state: state(retry),
  });
  expect((await receipt(actor, retry.oauthAttemptId)).body).toStrictEqual({
    connectionId,
  });
  expect((await receipt(actor, cancelled.oauthAttemptId)).status).toBe(404);
  const replay = await connectors.completeOauthCallbackResult("github", {
    code: "replay",
    state: state(cancelled),
  });
  expect(replay.body.status).toBe("error");
  expect((await receipt(actor, cancelled.oauthAttemptId)).status).toBe(404);
});

test("retains independent receipts for overlapping GitHub adds that reuse the same account", async () => {
  await installApiTestConnectorCatalog();
  const actor = bdd.user();
  const { connectionId } = await createGithubAccount(actor);
  const first = await connectors.startOauth(actor, "github", "oauth");
  const second = await connectors.startOauth(actor, "github", "oauth");
  await connectors.completeOauthCallbackResult("github", {
    code: "second",
    state: state(second),
  });
  expect((await receipt(actor, first.oauthAttemptId)).status).toBe(404);
  await connectors.completeOauthCallbackResult("github", {
    code: "first",
    state: state(first),
  });
  for (const start of [first, second]) {
    expect(start.connectionId).not.toBe(connectionId);
    expect((await receipt(actor, start.oauthAttemptId)).body).toStrictEqual({
      connectionId,
    });
  }
});

test("expires completed attempts without expiring their connector account", async () => {
  await installApiTestConnectorCatalog();
  const actor = bdd.user();
  const { start, connectionId } = await createGithubAccount(actor);
  await withMockNowForTest(now() + 16 * 60 * 1000, async () => {
    expect((await receipt(actor, start.oauthAttemptId)).status).toBe(404);
    const account = await accept(
      accountClient(actor).connection({
        headers: authHeaders(),
        params: { connectionId },
        query: githubTarget,
      }),
      [200],
    );
    expect(account.body.id).toBe(connectionId);
  });
});

test("cleans expired receipts in bounded batches without deleting current receipts or accounts", async () => {
  await installApiTestConnectorCatalog();
  const marker = `oauth-completion-cleanup-${randomUUID()}`;
  const actor = bdd.user({ userId: marker, orgId: marker });
  const expired = await withMockNowForTest(now() - 20 * 60 * 1000, async () => {
    const first = await createGithubAccount(actor);
    const second = await createGithubAccount(actor);
    return [first, second];
  });
  const current = await createGithubAccount(actor);
  const cleanup = await accept(
    setupApp({ context, routes: testCronDeleteCleanupsStateRoutes })(
      testCronDeleteCleanupsStateContract,
    ).action({
      body: { action: "cleanup-connector", marker },
    }),
    [200],
  );
  expect(cleanup.body.deleted).toBe(2);
  for (const previous of expired) {
    expect((await receipt(actor, previous.start.oauthAttemptId)).status).toBe(
      404,
    );
  }
  expect(
    (await receipt(actor, current.start.oauthAttemptId)).body,
  ).toStrictEqual({
    connectionId: current.connectionId,
  });
  await connectors.deleteBuiltinConnectorAccount(
    actor,
    "github",
    current.connectionId,
  );
});

test.each(["http", "mcp"] as const)(
  "tracks successful and cancelled custom %s OAuth attempts independently",
  async (kind) => {
    const actor = bdd.user();
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialScope: "read",
    });
    const definition = {
      displayName: `OAuth completion ${randomUUID()}`,
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth" as const,
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId: "completion-client",
        clientSecret: "completion-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "none" as const,
        scopes: ["read"],
        authorizationParams: {},
      },
    };
    const connector = await connectors.createCustomConnector(
      actor,
      kind === "http"
        ? {
            ...definition,
            kind,
            prefixTemplates: [`https://${randomUUID()}.example.test/api/`],
          }
        : {
            ...definition,
            kind,
            endpoint: `https://${randomUUID()}.example.test/mcp`,
            transport: "streamable-http",
          },
    );
    const target = { kind: "custom", customConnectorId: connector.id } as const;
    const started = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [200],
    );
    if (started.status !== 200 || started.body.result !== "authorization") {
      throw new Error("Expected custom OAuth authorization");
    }
    expect(
      (await receipt(actor, started.body.oauthAttemptId, target)).status,
    ).toBe(404);
    const completed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "custom-success",
        state: state(started.body),
      });
    expect(completed.body.status).toBe("success");
    const connected = await receipt(actor, started.body.oauthAttemptId, target);
    if (connected.status !== 200) {
      throw new Error("Expected a completed custom account");
    }
    const connectionId = connected.body.connectionId;
    const cancelled = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [200],
      undefined,
      { intent: "reconnect", connectionId },
    );
    if (cancelled.status !== 200 || cancelled.body.result !== "authorization") {
      throw new Error("Expected custom OAuth reconnect");
    }
    await accept(
      accountClient(actor).rename({
        headers: authHeaders(),
        params: { connectionId },
        body: { target, displayName: "Renamed" },
      }),
      [200],
    );
    const denied = await connectors.completeCustomConnectorOAuth2CallbackResult(
      { error: "access_denied", state: state(cancelled.body) },
    );
    expect(denied.body.status).toBe("error");
    expect(
      (await receipt(actor, cancelled.body.oauthAttemptId, target)).status,
    ).toBe(404);
    expect(
      (await receipt(actor, started.body.oauthAttemptId, target)).body,
    ).toStrictEqual({ connectionId });
    await connectors.deleteCustomConnector(actor, connector.id);
  },
);
