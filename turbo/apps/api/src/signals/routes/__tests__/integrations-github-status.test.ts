import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { webhookGithubContract } from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { githubOauthRoutes } from "../github-oauth";
import { integrationsGithubRoutes } from "../integrations-github";
import { webhooksGithubRoutes } from "../webhooks-github";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const GITHUB_APP_ID = "123456";
const GITHUB_APP_SLUG = "okou-test";
const GITHUB_APP_CLIENT_ID = "github-app-client-id";
const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";
const GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
).toString("base64");

const GITHUB_ROUTES = Object.freeze([
  ...githubOauthRoutes,
  ...integrationsGithubRoutes,
  ...webhooksGithubRoutes,
]);

interface GithubInstallationFixture {
  readonly installationId: string;
  readonly targetId: string;
  readonly login: string;
  readonly code: string;
  readonly githubUserId: string;
  readonly githubUsername: string;
  readonly accessToken: string;
}

function createGithubTestHarness() {
  const bdd = createBddApi(context);
  const routeMocks = createRouteMocks(context);
  const app = createApp({ signal: context.signal, routes: GITHUB_ROUTES });
  const githubClient = setupApp({ context, routes: integrationsGithubRoutes })(
    integrationsGithubContract,
  );
  const rawWebhookRequest = setupRawAppRequest({
    context,
    routes: webhooksGithubRoutes,
  });

  const webhookSecret = randomUUID();
  mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", webhookSecret);
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY_B64);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);

  const installationsById = new Map<string, GithubInstallationFixture>();
  const fixturesByCode = new Map<string, GithubInstallationFixture>();
  const fixturesByToken = new Map<string, GithubInstallationFixture>();

  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json([]);
    }),
    http.get(
      "https://api.github.com/app/installations/:installationId",
      ({ params }) => {
        const entry = installationsById.get(String(params.installationId));
        if (!entry) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json({
          id: Number(entry.installationId),
          app_id: Number(GITHUB_APP_ID),
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(entry.targetId),
            login: entry.login,
            type: "Organization",
          },
        });
      },
    ),
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      ({ params }) => {
        const entry = installationsById.get(String(params.installationId));
        if (!entry) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json(
          {
            token: `ghs_bdd_${entry.installationId}`,
            expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      },
    ),
    http.post("https://github.com/login/oauth/access_token", async (info) => {
      const params = new URLSearchParams(await info.request.text());
      const entry = fixturesByCode.get(params.get("code") ?? "");
      if (!entry) {
        return HttpResponse.json(
          { error: "bad_verification_code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: entry.accessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        "Bearer ",
        "",
      );
      const entry = fixturesByToken.get(token);
      if (!entry) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        id: Number(entry.githubUserId),
        login: entry.githubUsername,
        email: null,
      });
    }),
    http.get("https://api.github.com/user/memberships/orgs", ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        "Bearer ",
        "",
      );
      const entry = fixturesByToken.get(token);
      if (!entry) {
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }
      return HttpResponse.json([
        {
          state: "active",
          role: "admin",
          organization: { id: Number(entry.targetId) },
        },
      ]);
    }),
  );

  function authHeaders(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
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
    return { authorization: "Bearer clerk-session" };
  }

  async function installGithubApp(
    actor: ApiTestUser,
    options: {
      readonly code: string;
      readonly githubUserId: string;
      readonly githubUsername: string;
      readonly login?: string;
    },
  ) {
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    mockClerkMembership(context, actor, "org:admin");

    const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
    const targetId = String(randomInt(1_000_000_000, 9_999_999_999));
    const fixture: GithubInstallationFixture = {
      installationId,
      targetId,
      login: options.login ?? "bdd-org",
      code: options.code,
      githubUserId: options.githubUserId,
      githubUsername: options.githubUsername,
      accessToken: `gho_bdd_${options.code}`,
    };
    installationsById.set(installationId, fixture);
    fixturesByCode.set(fixture.code, fixture);
    fixturesByToken.set(fixture.accessToken, fixture);

    const apiOrigin = "http://localhost:3001";
    const installQuery = new URLSearchParams({
      userId: actor.userId,
      orgId: actor.orgId,
    }).toString();
    const installRes = await app.request(
      `${apiOrigin}/api/github/oauth/install?${installQuery}`,
      { method: "GET", headers: authHeaders(actor) },
    );
    const installLocation = installRes.headers.get("location");
    if (installRes.status !== 307 || !installLocation) {
      throw new Error(
        `Expected 307 install redirect, got ${installRes.status}`,
      );
    }
    const state = new URL(installLocation).searchParams.get("state");
    if (!state) {
      throw new Error("Expected signed install state");
    }

    const callbackQuery = new URLSearchParams({
      installation_id: installationId,
      setup_action: "install",
      state,
      code: fixture.code,
    }).toString();
    const callbackRes = await app.request(
      `${apiOrigin}/api/github/app/setup/callback?${callbackQuery}`,
      { method: "GET", headers: authHeaders(actor) },
    );
    const callbackLocation = callbackRes.headers.get("location");
    if (
      callbackRes.status !== 307 ||
      !callbackLocation ||
      new URL(callbackLocation).pathname !== "/workflows"
    ) {
      throw new Error(
        `Expected /workflows redirect, got ${callbackRes.status} (${callbackLocation ?? "none"})`,
      );
    }

    return fixture;
  }

  async function readInstallation<TStatus extends 200 | 404>(
    actor: ApiTestUser,
    statuses: readonly TStatus[],
  ) {
    return await accept(
      githubClient.getInstallation({ headers: authHeaders(actor) }),
      statuses,
    );
  }

  async function deliverInstallationWebhook(args: {
    readonly action: "created" | "suspend" | "deleted";
    readonly fixture: GithubInstallationFixture;
    readonly deliveryId?: string;
  }) {
    const body = JSON.stringify({
      action: args.action,
      installation: {
        id: Number(args.fixture.installationId),
        account: {
          id: Number(args.fixture.targetId),
          login: args.fixture.login,
          type: "Organization",
        },
      },
      sender: {
        id: Number(args.fixture.githubUserId),
        login: args.fixture.githubUsername,
      },
    });
    const response = await rawWebhookRequest(webhookGithubContract.post.path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": args.deliveryId ?? `delivery-${randomUUID()}`,
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret)
          .update(body)
          .digest("hex")}`,
      },
      body,
    });
    await flushWaitUntilForTest();
    return response;
  }

  return {
    bdd,
    installGithubApp,
    readInstallation,
    deliverInstallationWebhook,
  };
}

describe("GitHub installation status", () => {
  it("integrations-github-status-003 keeps linked account details scoped to the authenticated user and organization", async () => {
    const harness = createGithubTestHarness();
    const owner = harness.bdd.user({ orgRole: "org:admin" });
    const member = harness.bdd.user({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    const outsider = harness.bdd.user({ orgRole: "org:admin" });
    const installed = await harness.installGithubApp(owner, {
      code: `status-owner-${randomUUID()}`,
      githubUserId: "801",
      githubUsername: "github-status-owner",
    });

    const memberView = await harness.readInstallation(member, [200]);
    const ownerView = await harness.readInstallation(owner, [200]);
    const outsiderView = await harness.readInstallation(outsider, [404]);

    expect(memberView.body.installation.installationId).toBe(
      installed.installationId,
    );
    expect(memberView.body.installation.isAdmin).toBeFalsy();
    expect(memberView.body.isConnected).toBeFalsy();
    expect(memberView.body.connectedGithubUserId).toBeNull();
    expect(memberView.body.connectedGithubUsername).toBeNull();

    expect(ownerView.body.installation.installationId).toBe(
      installed.installationId,
    );
    expect(ownerView.body.installation.isAdmin).toBeTruthy();
    expect(ownerView.body.isConnected).toBeTruthy();
    expect(ownerView.body.connectedGithubUserId).toBe("801");
    expect(ownerView.body.connectedGithubUsername).toBe("github-status-owner");

    expect(outsiderView.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-github-status-001 (1/2) keeps both installations connected after created and suspend webhooks", async () => {
    const harness = createGithubTestHarness();
    const firstOwner = harness.bdd.user({ orgRole: "org:admin" });
    const secondOwner = harness.bdd.user({ orgRole: "org:admin" });
    const firstInstall = await harness.installGithubApp(firstOwner, {
      code: `first-owner-${randomUUID()}`,
      githubUserId: "901",
      githubUsername: "first-owner",
      login: "first-org",
    });
    const secondInstall = await harness.installGithubApp(secondOwner, {
      code: `second-owner-${randomUUID()}`,
      githubUserId: "902",
      githubUsername: "second-owner",
      login: "second-org",
    });

    const createdRes = await harness.deliverInstallationWebhook({
      action: "created",
      fixture: firstInstall,
    });
    expect(createdRes.status).toBe(200);
    const firstAfterCreated = await harness.readInstallation(firstOwner, [200]);
    const secondAfterCreated = await harness.readInstallation(
      secondOwner,
      [200],
    );
    expect(firstAfterCreated.body.installation.installationId).toBe(
      firstInstall.installationId,
    );
    expect(firstAfterCreated.body.isConnected).toBeTruthy();
    expect(secondAfterCreated.body.installation.installationId).toBe(
      secondInstall.installationId,
    );
    expect(secondAfterCreated.body.isConnected).toBeTruthy();

    const suspendRes = await harness.deliverInstallationWebhook({
      action: "suspend",
      fixture: firstInstall,
    });
    expect(suspendRes.status).toBe(200);
    const firstAfterSuspend = await harness.readInstallation(firstOwner, [200]);
    const secondAfterSuspend = await harness.readInstallation(
      secondOwner,
      [200],
    );
    expect(firstAfterSuspend.body.installation.installationId).toBe(
      firstInstall.installationId,
    );
    expect(firstAfterSuspend.body.isConnected).toBeTruthy();
    expect(secondAfterSuspend.body.installation.installationId).toBe(
      secondInstall.installationId,
    );
    expect(secondAfterSuspend.body.isConnected).toBeTruthy();
  });

  it("integrations-github-status-001 (2/2) removes only the deleted installation and accepts a replayed deleted webhook", async () => {
    const harness = createGithubTestHarness();
    const firstOwner = harness.bdd.user({ orgRole: "org:admin" });
    const secondOwner = harness.bdd.user({ orgRole: "org:admin" });
    const firstInstall = await harness.installGithubApp(firstOwner, {
      code: `first-owner-${randomUUID()}`,
      githubUserId: "901",
      githubUsername: "first-owner",
      login: "first-org",
    });
    const secondInstall = await harness.installGithubApp(secondOwner, {
      code: `second-owner-${randomUUID()}`,
      githubUserId: "902",
      githubUsername: "second-owner",
      login: "second-org",
    });
    const createdRes = await harness.deliverInstallationWebhook({
      action: "created",
      fixture: firstInstall,
    });
    expect(createdRes.status).toBe(200);
    const suspendRes = await harness.deliverInstallationWebhook({
      action: "suspend",
      fixture: firstInstall,
    });
    expect(suspendRes.status).toBe(200);

    const deletedDeliveryId = `delivery-${randomUUID()}`;
    const deletedRes = await harness.deliverInstallationWebhook({
      action: "deleted",
      fixture: firstInstall,
      deliveryId: deletedDeliveryId,
    });
    expect(deletedRes.status).toBe(200);
    const firstAfterDelete = await harness.readInstallation(firstOwner, [404]);
    const secondAfterDelete = await harness.readInstallation(
      secondOwner,
      [200],
    );
    expect(firstAfterDelete.body.error.code).toBe("NOT_FOUND");
    expect(secondAfterDelete.body.installation.installationId).toBe(
      secondInstall.installationId,
    );
    expect(secondAfterDelete.body.isConnected).toBeTruthy();

    const replayedDeleteRes = await harness.deliverInstallationWebhook({
      action: "deleted",
      fixture: firstInstall,
      deliveryId: deletedDeliveryId,
    });
    expect(replayedDeleteRes.status).toBe(200);
    const firstAfterReplay = await harness.readInstallation(firstOwner, [404]);
    const secondAfterReplay = await harness.readInstallation(
      secondOwner,
      [200],
    );
    expect(firstAfterReplay.body.error.code).toBe("NOT_FOUND");
    expect(secondAfterReplay.body.installation.installationId).toBe(
      secondInstall.installationId,
    );
    expect(secondAfterReplay.body.isConnected).toBeTruthy();
  });
});
