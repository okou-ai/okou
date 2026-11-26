import { Buffer } from "node:buffer";
import { githubAppSetupCallbackQuerySchema } from "@okouai/api-contracts/contracts/github-oauth-callback";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { githubOauthContract } from "@okouai/api-contracts/contracts/github-oauth";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { githubOauthRoutes } from "../github-oauth";
import { integrationsGithubRoutes } from "../integrations-github";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi, newGithubUserId } from "./helpers/api-bdd-github";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const github = createGithubBddApi(context);
const directory = createStore();

const API_ORIGIN = "https://api.okou.ai";
/** One generated GitHub App key per file; RSA generation dominates otherwise. */
const GITHUB_APP_PRIVATE_KEY = Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
).toString("base64");
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

type CallbackQuery = ReturnType<typeof githubAppSetupCallbackQuerySchema.parse>;

function oauthClient() {
  return setupApp({ context, routes: githubOauthRoutes, baseUrl: API_ORIGIN })(
    githubOauthContract,
  );
}

function integrationClient() {
  return setupApp({ context, routes: integrationsGithubRoutes })(
    integrationsGithubContract,
  );
}

async function signIn(actor: ApiTestUser): Promise<typeof SESSION> {
  if (actor.orgId) {
    await directory.set(
      seedOrgMembership$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        role: actor.orgRole === "org:member" ? "member" : "admin",
      },
      context.signal,
    );
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return SESSION;
}

function signOut(): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
}

/** A signed-in workspace admin with the GitHub App configured. */
async function configuredAdmin(): Promise<ApiTestUser> {
  mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
  mockOptionalEnv("GITHUB_APP_SLUG", "okou-test");
  mockOptionalEnv("GITHUB_APP_ID", "123456");
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", "github-app-client-id");
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", `client-${randomUUID()}`);
  const admin = bdd.user();
  await signIn(admin);
  return admin;
}

function locationOf(response: { readonly headers: Headers }): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location");
  }
  return new URL(location);
}

function stateOf(url: URL): string {
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected a signed state");
  }
  return state;
}

async function startInstall(admin: ApiTestUser): Promise<string> {
  if (!admin.orgId) {
    throw new Error("GitHub installs require an organization");
  }
  const response = await accept(
    oauthClient().install({
      query: { userId: admin.userId, orgId: admin.orgId },
      extraHeaders: await signIn(admin),
    }),
    [307],
  );
  return stateOf(locationOf(response));
}

async function callback(query: CallbackQuery, actor: ApiTestUser | null) {
  const response = await accept(
    oauthClient().setupCallback({
      query,
      ...(actor ? { extraHeaders: await signIn(actor) } : {}),
    }),
    [307],
  );
  return locationOf(response);
}

async function jsonCallback(
  query: CallbackQuery,
  headers: Record<string, string>,
) {
  return await accept(
    oauthClient().setupCallback({
      query: { ...query, responseMode: "json" },
      extraHeaders: headers,
    }),
    [200, 401],
  );
}

async function readInstallation(actor: ApiTestUser) {
  const response = await accept(
    integrationClient().getInstallation({ headers: await signIn(actor) }),
    [200],
  );
  return response.body;
}

async function installationStatus(actor: ApiTestUser): Promise<number> {
  const response = await accept(
    integrationClient().getInstallation({ headers: await signIn(actor) }),
    [200, 404],
  );
  return response.status;
}

/** GitHub reports a personal installation owned by the verified account. */
function personalInstallation(code: string) {
  const installationId = newGithubUserId();
  const githubUserId = newGithubUserId();
  github.mockInstallation({
    installationId,
    targetId: githubUserId,
    login: "octocat",
    type: "User",
  });
  github.mockUserAuthorization({ code, githubUserId });
  return { installationId, githubUserId };
}

describe("GitHub installation authorization", () => {
  it("github-install-authorization-003 requires an organization administrator to install", async () => {
    const admin = await configuredAdmin();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });

    const response = await accept(
      oauthClient().install({ query: {}, extraHeaders: await signIn(member) }),
      [307],
    );

    expect(locationOf(response).searchParams.get("error")).toContain(
      "Only organization admins",
    );
  });

  it("github-install-authorization-002 rejects another administrator naming the victim's principal", async () => {
    const victim = await configuredAdmin();
    const attacker = bdd.user();
    if (!victim.orgId) {
      throw new Error("Expected an organization");
    }

    const response = await accept(
      oauthClient().install({
        query: { userId: victim.userId, orgId: victim.orgId },
        extraHeaders: await signIn(attacker),
      }),
      [307],
    );

    expect(locationOf(response).searchParams.get("error")).toContain(
      "different account or organization",
    );
    await expect(installationStatus(victim)).resolves.toBe(404);
    await expect(installationStatus(attacker)).resolves.toBe(404);
  });

  it("github-install-authorization-005 rejects a callback after the signed-in actor switches", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });

    const location = await callback(
      {
        state,
        code: "switched-actor-code",
        installation_id: newGithubUserId(),
        setup_action: "install",
      },
      member,
    );

    expect(location.searchParams.get("error")).toContain(
      "active account or organization changed",
    );
    await expect(installationStatus(admin)).resolves.toBe(404);
  });

  it("github-install-authorization-004 checks GitHub organization administration before associating", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const installationId = newGithubUserId();
    const organizationId = newGithubUserId();
    github.mockInstallation({
      installationId,
      targetId: organizationId,
      login: "foreign-org",
      type: "Organization",
    });
    github.mockUserAuthorization({
      code: "foreign-member-code",
      githubUserId: newGithubUserId(),
      organizationId,
      organizationRole: "member",
    });

    const location = await callback(
      {
        state,
        code: "foreign-member-code",
        installation_id: installationId,
        setup_action: "install",
      },
      admin,
    );

    expect(location.searchParams.get("error")).toContain(
      "active organization administrator",
    );
    await expect(installationStatus(admin)).resolves.toBe(404);
  });

  it("github-install-authorization-008 rejects a personal installation owned by another GitHub account", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const installationId = newGithubUserId();
    github.mockInstallation({
      installationId,
      targetId: newGithubUserId(),
      login: "someone-else",
      type: "User",
    });
    github.mockUserAuthorization({
      code: "other-owner-code",
      githubUserId: newGithubUserId(),
    });

    const location = await callback(
      {
        state,
        code: "other-owner-code",
        installation_id: installationId,
      },
      admin,
    );

    expect(location.searchParams.get("error")).toContain(
      "GitHub account owner",
    );
    await expect(installationStatus(admin)).resolves.toBe(404);
  });

  it("github-install-authorization-006 links the verified account and rejects state replay", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const installationId = newGithubUserId();
    const organizationId = newGithubUserId();
    const githubUserId = newGithubUserId();
    github.mockInstallation({
      installationId,
      targetId: organizationId,
      login: "verified-org",
      type: "Organization",
    });
    github.mockUserAuthorization({
      code: "verified-admin-code",
      githubUserId,
      organizationId,
    });
    const query = {
      state,
      code: "verified-admin-code",
      installation_id: installationId,
      setup_action: "install",
    };

    await callback(query, admin);
    const installed = await readInstallation(admin);
    const replay = await callback(query, admin);

    expect(installed).toMatchObject({
      isConnected: true,
      connectedGithubUserId: githubUserId,
      installation: { installationId },
    });
    expect(replay.searchParams.get("error")).toContain(
      "expired or was already used",
    );
    await expect(readInstallation(admin)).resolves.toStrictEqual(installed);
  });

  it("github-install-authorization-007 accepts a personal installation for its verified owner", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const { installationId, githubUserId } = personalInstallation(
      "personal-owner-code",
    );

    await callback(
      {
        state,
        code: "personal-owner-code",
        installation_id: installationId,
        setup_action: "install",
      },
      admin,
    );

    await expect(readInstallation(admin)).resolves.toMatchObject({
      connectedGithubUserId: githubUserId,
      installation: { installationId, targetType: "User" },
    });
  });

  it("github-install-authorization-010 recovers an existing installation only after verifying its administrator", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const installationId = newGithubUserId();
    const organizationId = newGithubUserId();
    github.mockInstallation({
      installationId,
      targetId: organizationId,
      login: "verified-org",
      type: "Organization",
    });
    github.mockUserAuthorization({
      code: "verify-existing-installation",
      githubUserId: newGithubUserId(),
      organizationId,
    });

    const authorize = await callback(
      { state, installation_id: installationId, setup_action: "update" },
      admin,
    );
    const statusBeforeVerification = await installationStatus(admin);
    const completed = await callback(
      { state: stateOf(authorize), code: "verify-existing-installation" },
      admin,
    );

    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(statusBeforeVerification).toBe(404);
    expect(completed.pathname).toBe("/workflows");
    await expect(readInstallation(admin)).resolves.toMatchObject({
      isConnected: false,
      installation: { installationId, targetName: "verified-org" },
    });
  });

  it("github-install-authorization-012 requires a signed-in completing actor when the browser has no session", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const { installationId, githubUserId } = personalInstallation(
      "missing-session-code",
    );
    const query = {
      state,
      code: "missing-session-code",
      installation_id: installationId,
      setup_action: "install",
    };

    const landing = await callback(query, null);
    const statusAfterLanding = await installationStatus(admin);
    signOut();
    const anonymous = await jsonCallback(query, {});
    const statusAfterAnonymous = await installationStatus(admin);
    const signedIn = await callback(query, admin);

    expect(landing.searchParams.get("integration")).toBe("github");
    expect(statusAfterLanding).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(statusAfterAnonymous).toBe(404);
    expect(signedIn.searchParams.has("error")).toBeFalsy();
    await expect(readInstallation(admin)).resolves.toMatchObject({
      isConnected: true,
      connectedGithubUserId: githubUserId,
    });
  });

  it("github-install-authorization-014 completes the installation with the admin's own session cookie", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const { installationId, githubUserId } = personalInstallation(
      "matching-cookie-code",
    );
    const query = {
      state,
      code: "matching-cookie-code",
      installation_id: installationId,
      setup_action: "install",
    };

    const landing = await callback(query, null);
    const statusAfterLanding = await installationStatus(admin);
    await signIn(admin);
    const completion = await jsonCallback(query, {
      cookie: "__session=clerk-session",
    });

    expect(landing.searchParams.get("integration")).toBe("github");
    expect(statusAfterLanding).toBe(404);
    if (completion.status !== 200) {
      throw new Error("Expected the JSON completion to succeed");
    }
    expect(
      new URL(completion.body.redirectUrl).searchParams.has("error"),
    ).toBeFalsy();
    await expect(readInstallation(admin)).resolves.toMatchObject({
      isConnected: true,
      connectedGithubUserId: githubUserId,
      installation: { installationId },
    });
  });

  it("github-install-authorization-018 protects the no-code continuation from a browser without a session", async () => {
    const admin = await configuredAdmin();
    const state = await startInstall(admin);
    const { installationId } = personalInstallation("continuation-code");

    const authorize = await callback(
      { state, installation_id: installationId, setup_action: "install" },
      admin,
    );
    const statusAfterAuthorize = await installationStatus(admin);
    const continuation = {
      state: stateOf(authorize),
      code: "continuation-code",
    };
    signOut();
    const anonymous = await jsonCallback(continuation, {});
    const statusAfterAnonymous = await installationStatus(admin);
    const signedIn = await jsonCallback(continuation, await signIn(admin));

    expect(authorize.pathname).toBe("/login/oauth/authorize");
    expect(statusAfterAuthorize).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(statusAfterAnonymous).toBe(404);
    if (signedIn.status !== 200) {
      throw new Error("Expected the signed-in completion to succeed");
    }
    expect(
      new URL(signedIn.body.redirectUrl).searchParams.has("error"),
    ).toBeFalsy();
    await expect(readInstallation(admin)).resolves.toMatchObject({
      isConnected: false,
      installation: { installationId },
    });
  });

  it("github-install-authorization-001 requires sign-in before accepting a named administrator", async () => {
    const admin = await configuredAdmin();
    if (!admin.orgId) {
      throw new Error("Expected an organization");
    }
    signOut();

    const response = await accept(
      oauthClient().install({
        query: { userId: admin.userId, orgId: admin.orgId },
      }),
      [307],
    );

    expect(locationOf(response).pathname).toBe("/sign-in");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(installationStatus(admin)).resolves.toBe(404);
  });

  it("github-install-authorization-020 keeps GitHub update without valid state read only (undefined)", async () => {
    const admin = await configuredAdmin();
    signOut();

    const location = await callback(
      { setup_action: "update", installation_id: "988000" },
      null,
    );

    expect(location.pathname).toBe("/workflows");
    await expect(installationStatus(admin)).resolves.toBe(404);
  });
});
