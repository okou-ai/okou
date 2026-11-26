import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomInt } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { githubOauthRoutes } from "../github-oauth";
import { integrationsGithubRoutes } from "../integrations-github";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { mockGitHubConnectorOAuth } from "./helpers/api-bdd-connectors";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const GITHUB_APP_SLUG = "okou-test";
const GITHUB_APP_ID = "123456";
const GITHUB_APP_CLIENT_ID = "github-app-client-id";
const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";
const GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
).toString("base64");

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const GITHUB_SETUP_ROUTES = Object.freeze([
  ...githubOauthRoutes,
  ...integrationsGithubRoutes,
]);

const context = testContext();
const oauthStart = setupApp({ context, routes: builtinConnectorsRoutes })(
  builtinConnectorOauthStartContract,
);
const oauthCallback = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);
const integrationsGithub = setupApp({
  context,
  routes: integrationsGithubRoutes,
})(integrationsGithubContract);

function signIn(actor: ApiTestUser): void {
  if (!actor.orgId) {
    throw new Error("Expected a workspace member");
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "GitHub",
    },
  ]);
}

async function connectGithub(
  actor: ApiTestUser,
  identity: { readonly userId: number; readonly login: string },
  account: ConnectorAccountMutationIntent,
): Promise<void> {
  mockGitHubConnectorOAuth(identity);
  signIn(actor);
  const started = await accept(
    oauthStart.start({
      headers: AUTH_HEADERS,
      params: { connectorSlug: "github" },
      body: { authMethod: "oauth", account },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected a GitHub authorization state");
  }
  const callback = await accept(
    oauthCallback.callback({
      headers: {},
      params: { connectorSlug: "github" },
      query: {
        code: `code-${identity.userId}`,
        state,
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(callback.body.status).toBe("success");
}

async function listGithubAccounts(actor: ApiTestUser) {
  signIn(actor);
  const response = await accept(
    accounts.connections({
      headers: AUTH_HEADERS,
      query: { kind: "builtin", connectorSlug: "github" },
    }),
    [200],
  );
  return response.body.connections;
}

async function readGithubInstallation(actor: ApiTestUser) {
  signIn(actor);
  const response = await accept(
    integrationsGithub.getInstallation({ headers: AUTH_HEADERS }),
    [200],
  );
  return response.body;
}

async function installGithubApp(
  app: ReturnType<typeof createAppWithRoutes>,
  actor: ApiTestUser,
): Promise<string> {
  if (!actor.orgId) {
    throw new Error("GitHub installs require an org-scoped actor");
  }
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY_BASE64);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);
  mockClerkMembership(context, actor, "org:admin");

  const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
  const targetId = String(randomInt(1_000_000_000, 9_999_999_999));
  const verificationCode = `verify-install-${installationId}`;
  const verificationAccessToken = `gho_bdd_${verificationCode}`;

  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json([]);
    }),
    http.get(
      `https://api.github.com/app/installations/${installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(installationId),
          app_id: Number(GITHUB_APP_ID),
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(targetId),
            login: `org-${installationId}`,
            type: "Organization",
          },
        });
      },
    ),
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () => {
        return HttpResponse.json(
          {
            token: `ghs_bdd_${installationId}`,
            expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      },
    ),
    http.post("https://github.com/login/oauth/access_token", async (info) => {
      const body = new URLSearchParams(await info.request.text());
      if (body.get("code") !== verificationCode) {
        return HttpResponse.json(
          { error: "bad_verification_code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: verificationAccessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({
        id: Number(targetId),
        login: `installer-${installationId}`,
        email: null,
      });
    }),
    http.get("https://api.github.com/user/memberships/orgs", () => {
      return HttpResponse.json([
        {
          state: "active",
          role: "admin",
          organization: { id: Number(targetId) },
        },
      ]);
    }),
  );

  signIn(actor);
  const installQuery = new URLSearchParams({
    userId: actor.userId,
    orgId: actor.orgId,
  }).toString();
  const installRes = await app.request(
    `https://api.okou.ai/api/github/oauth/install?${installQuery}`,
    { method: "GET", headers: AUTH_HEADERS },
  );
  const installLocation = installRes.headers.get("location");
  if (installRes.status !== 307 || !installLocation) {
    throw new Error(
      `Expected GitHub install redirect, got ${installRes.status}`,
    );
  }
  const state = new URL(installLocation).searchParams.get("state");
  if (!state) {
    throw new Error("Expected signed install state");
  }

  let callbackRes = await app.request(
    `https://api.okou.ai/api/github/app/setup/callback?${new URLSearchParams({
      installation_id: installationId,
      setup_action: "install",
      state,
    }).toString()}`,
    { method: "GET", headers: AUTH_HEADERS },
  );
  const firstLocation = callbackRes.headers.get("location");
  if (
    firstLocation &&
    new URL(firstLocation).pathname === "/api/github/app/setup/callback"
  ) {
    callbackRes = await app.request(firstLocation, {
      method: "GET",
      headers: AUTH_HEADERS,
    });
  }
  const secondLocation = callbackRes.headers.get("location");
  if (
    secondLocation &&
    new URL(secondLocation).pathname === "/login/oauth/authorize"
  ) {
    const authUrl = new URL(secondLocation);
    const continuationState = authUrl.searchParams.get("state");
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    if (!continuationState || !redirectUri) {
      throw new Error("Expected GitHub verification continuation state");
    }
    const callbackOrigin = new URL(redirectUri).origin;
    callbackRes = await app.request(
      `${callbackOrigin}/api/github/app/setup/callback?${new URLSearchParams({
        code: verificationCode,
        state: continuationState,
      }).toString()}`,
      { method: "GET", headers: AUTH_HEADERS },
    );
  }
  const finalLocation = callbackRes.headers.get("location");
  if (
    callbackRes.status !== 307 ||
    !finalLocation ||
    new URL(finalLocation).pathname !== "/workflows"
  ) {
    throw new Error(
      `Expected GitHub setup redirect to /workflows, got ${callbackRes.status} (${finalLocation ?? "no location"})`,
    );
  }
  return installationId;
}

async function startGithubOauthState(actor: ApiTestUser): Promise<string> {
  signIn(actor);
  const started = await accept(
    oauthStart.start({
      headers: AUTH_HEADERS,
      params: { connectorSlug: "github" },
      body: { authMethod: "oauth", account: { intent: "add" } },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected a GitHub authorization state");
  }
  return state;
}

async function setupTwoInstalledOrgsWithBothConnected() {
  const bdd = createBddApi(context);
  const first = bdd.user();
  const second = bdd.user();
  const setupAppInstance = createAppWithRoutes({
    signal: context.signal,
    routes: GITHUB_SETUP_ROUTES,
  });
  const firstInstallationId = await installGithubApp(setupAppInstance, first);
  const secondInstallationId = await installGithubApp(setupAppInstance, second);

  mockGitHubConnectorOAuth();
  server.use(
    http.get("https://api.github.com/user", (info) => {
      const auth = info.request.headers.get("authorization") ?? "";
      if (auth.includes("code-901")) {
        return HttpResponse.json({
          id: 901,
          login: "github-org-one",
          email: "github-org-one@example.test",
        });
      }
      return HttpResponse.json({
        id: 902,
        login: "github-org-two",
        email: "github-org-two@example.test",
      });
    }),
  );

  const firstState = await startGithubOauthState(first);
  const secondState = await startGithubOauthState(second);

  const [firstCallback, secondCallback] = await Promise.all([
    accept(
      oauthCallback.callback({
        headers: {},
        params: { connectorSlug: "github" },
        query: { code: "code-901", state: firstState, responseMode: "json" },
      }),
      [200],
    ),
    accept(
      oauthCallback.callback({
        headers: {},
        params: { connectorSlug: "github" },
        query: { code: "code-902", state: secondState, responseMode: "json" },
      }),
      [200],
    ),
  ]);
  expect(firstCallback.body.status).toBe("success");
  expect(secondCallback.body.status).toBe("success");

  return { first, second, firstInstallationId, secondInstallationId };
}

async function connectFirstAndSecond(member: ApiTestUser) {
  await connectGithub(
    member,
    { userId: 101, login: "github-first" },
    { intent: "add", displayName: "First" },
  );
  await connectGithub(
    member,
    { userId: 202, login: "github-second" },
    { intent: "add", displayName: "Second" },
  );
  const before = await listGithubAccounts(member);
  const first = before.find((account) => {
    return account.externalId === "101";
  });
  const second = before.find((account) => {
    return account.externalId === "202";
  });
  if (!first || !second) {
    throw new Error("Expected both initial GitHub accounts");
  }
  return { before, firstId: first.id, secondId: second.id };
}

test("github-oauth-account-mutations-005 keeps the same GitHub identity separate per workspace", async () => {
  const bdd = createBddApi(context);
  const first = bdd.user();
  const second = bdd.user();
  await connectGithub(
    first,
    { userId: 304, login: "github-shared" },
    { intent: "add", displayName: "First owner" },
  );
  await connectGithub(
    second,
    { userId: 304, login: "github-shared" },
    { intent: "add", displayName: "Second owner" },
  );

  const firstAccounts = await listGithubAccounts(first);
  const secondAccounts = await listGithubAccounts(second);

  expect(firstAccounts).toStrictEqual([
    expect.objectContaining({
      externalId: "304",
      displayName: "First owner",
      isDefault: true,
    }),
  ]);
  expect(secondAccounts).toStrictEqual([
    expect.objectContaining({
      externalId: "304",
      displayName: "Second owner",
      isDefault: true,
    }),
  ]);
  expect(secondAccounts[0]?.id).not.toBe(firstAccounts[0]?.id);
});

test("github-oauth-account-mutations-003 (1/2) lists both connected GitHub accounts before the refresh", async () => {
  const member = createBddApi(context).user();
  const { before } = await connectFirstAndSecond(member);

  expect(before).toHaveLength(2);
  expect(before).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ externalId: "101" }),
      expect.objectContaining({ externalId: "202" }),
    ]),
  );
});

test("github-oauth-account-mutations-003 (2/2) refreshes the existing sibling account on add", async () => {
  const member = createBddApi(context).user();
  const { firstId, secondId } = await connectFirstAndSecond(member);

  await connectGithub(
    member,
    { userId: 202, login: "github-second-updated" },
    { intent: "add", displayName: "Ignored on refresh" },
  );
  const after = await listGithubAccounts(member);

  expect(after).toHaveLength(2);
  expect(after).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstId,
        externalId: "101",
        displayName: "First",
        externalUsername: "github-first",
        isDefault: true,
      }),
      expect.objectContaining({
        id: secondId,
        externalId: "202",
        displayName: "Second",
        externalUsername: "github-second-updated",
        isDefault: false,
      }),
    ]),
  );
});

test("github-oauth-account-mutations-001 (1/3) links only the first organization's active installation on its callback", async () => {
  const bdd = createBddApi(context);
  const first = bdd.user();
  const second = bdd.user();
  const setupAppInstance = createAppWithRoutes({
    signal: context.signal,
    routes: GITHUB_SETUP_ROUTES,
  });
  const firstInstallationId = await installGithubApp(setupAppInstance, first);
  const secondInstallationId = await installGithubApp(setupAppInstance, second);

  await connectGithub(
    first,
    { userId: 901, login: "github-org-one" },
    { intent: "add" },
  );

  const firstRead = await readGithubInstallation(first);
  const secondRead = await readGithubInstallation(second);

  expect(firstRead).toStrictEqual(
    expect.objectContaining({
      isConnected: true,
      connectedGithubUserId: "901",
      installation: expect.objectContaining({
        installationId: firstInstallationId,
        status: "active",
      }),
    }),
  );
  expect(secondRead).toStrictEqual(
    expect.objectContaining({
      isConnected: false,
      connectedGithubUserId: null,
      installation: expect.objectContaining({
        installationId: secondInstallationId,
        status: "active",
      }),
    }),
  );
});

test("github-oauth-account-mutations-001 (2/3) links the second organization's active installation on its callback", async () => {
  const { second, secondInstallationId } =
    await setupTwoInstalledOrgsWithBothConnected();

  const secondRead = await readGithubInstallation(second);

  expect(secondRead).toStrictEqual(
    expect.objectContaining({
      isConnected: true,
      connectedGithubUserId: "902",
      installation: expect.objectContaining({
        installationId: secondInstallationId,
        status: "active",
      }),
    }),
  );
});

test("github-oauth-account-mutations-001 (3/3) preserves the first organization's active installation after the second connects", async () => {
  const { first, firstInstallationId } =
    await setupTwoInstalledOrgsWithBothConnected();

  const firstRead = await readGithubInstallation(first);

  expect(firstRead).toStrictEqual(
    expect.objectContaining({
      isConnected: true,
      connectedGithubUserId: "901",
      installation: expect.objectContaining({
        installationId: firstInstallationId,
        status: "active",
      }),
    }),
  );
});
