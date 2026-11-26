import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { webhookGithubContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { githubOauthRoutes } from "../github-oauth";
import { logsRoutes } from "../logs";
import { webhooksGithubRoutes } from "../webhooks-github";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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

const GITHUB_INSTALL_ROUTES = Object.freeze([...githubOauthRoutes]);
const WORKFLOW_ROUTES = Object.freeze([
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
  ...logsRoutes,
]);

async function installWorkspaceGithubApp(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected org-scoped actor");
  }
  const routeMocks = createRouteMocks(context);
  routeMocks.clerk.session(actor.userId, actor.orgId, "org:admin");
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
  mockClerkMembership(context, actor, "org:admin");
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY_B64);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);

  const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
  const targetId = String(randomInt(1_000_000_000, 9_999_999_999));
  const code = `install-${randomUUID()}`;
  const accessToken = `gho_bdd_${code}`;

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
            login: "okou-ai",
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
    http.post("https://github.com/login/oauth/access_token", () => {
      return HttpResponse.json({
        access_token: accessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({
        id: 801,
        login: "trusted-user",
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

  const app = createApp({
    signal: context.signal,
    routes: GITHUB_INSTALL_ROUTES,
  });
  const authHeaders = { authorization: "Bearer clerk-session" };
  const installQuery = new URLSearchParams({
    userId: actor.userId,
    orgId: actor.orgId,
  }).toString();
  const installRes = await app.request(
    `http://localhost:3001/api/github/oauth/install?${installQuery}`,
    { method: "GET", headers: authHeaders },
  );
  const installLocation = installRes.headers.get("location");
  if (installRes.status !== 307 || !installLocation) {
    throw new Error(`Expected 307 install redirect, got ${installRes.status}`);
  }
  const state = new URL(installLocation).searchParams.get("state");
  if (!state) {
    throw new Error("Expected signed install state");
  }
  const callbackQuery = new URLSearchParams({
    installation_id: installationId,
    setup_action: "install",
    state,
    code,
  }).toString();
  const callbackRes = await app.request(
    `http://localhost:3001/api/github/app/setup/callback?${callbackQuery}`,
    { method: "GET", headers: authHeaders },
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
  return { installationId };
}

describe("POST /api/webhooks/github for workflow automations", () => {
  it("webhooks-github-workflow-010 rejects a workflow job event signed with another secret", async () => {
    createWebhookCallbackApi(context).configureGithubWebhookSecret();
    const body = JSON.stringify({ action: "queued", workflow_job: null });
    // A secret other than the configured webhook secret.
    const anotherSecret = randomUUID();
    const request = setupRawAppRequest({
      context,
      routes: webhooksGithubRoutes,
    });

    // The signature covers the exact raw bytes, which the typed client would
    // re-encode as a JSON string.
    const response = await request(webhookGithubContract.post.path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `delivery-${randomUUID()}`,
        "x-github-event": "workflow_job",
        "x-hub-signature-256": `sha256=${createHmac("sha256", anotherSecret)
          .update(body)
          .digest("hex")}`,
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Invalid signature" });
  });

  async function givenGithubIssueCommentAutomation() {
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:admin" });
    if (!member.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const webhookSecret = randomUUID();
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", webhookSecret);
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 1024,
      UploadId: randomUUID(),
      ETag: "fixture-etag",
    });

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      "org:admin",
    );
    const appFor = setupApp({ context, routes: WORKFLOW_ROUTES });
    const authHeaders = { authorization: "Bearer clerk-session" };
    const [{ installationId }, createdWorkflow] = await Promise.all([
      installWorkspaceGithubApp(member),
      accept(
        appFor(workflowsCollectionContract).create({
          headers: authHeaders,
          body: {
            name: `gh-comment-wf-${randomUUID().slice(0, 8)}`,
            visibility: "private",
          },
        }),
        [201],
      ),
    ]);

    await accept(
      appFor(workflowAutomationsContract).create({
        headers: authHeaders,
        params: { workflowId: createdWorkflow.body.id },
        body: {
          kind: "event",
          eventType: "github-issue-comment-created",
          eventConfig: {
            provider: "github",
            event: "issue_comment_created",
            filters: {
              repositories: ["okou-ai/okou"],
              subject: "pull_requests",
              trustedAuthors: ["TRUSTED-USER"],
              commentPrefixes: ["/verify"],
            },
          },
        },
      }),
      [201],
    );

    const payload = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Tighten webhook filters",
        body: "PR body",
        html_url: "https://github.com/okou-ai/okou/pull/42",
        labels: [],
        user: { id: 101, login: "pr-author", type: "User" },
        pull_request: {
          url: "https://api.github.com/repos/okou-ai/okou/pulls/42",
        },
      },
      comment: {
        id: 99_001,
        body: "/verify run checks",
        html_url: "https://github.com/okou-ai/okou/pull/42#issuecomment-99001",
        user: { id: 202, login: "outside-allowlist", type: "User" },
        author_association: "NONE",
      },
      repository: {
        id: 5001,
        full_name: "okou-ai/okou",
      },
      installation: {
        id: Number(installationId),
      },
      sender: {
        id: 202,
        login: "outside-allowlist",
        type: "User",
      },
    });

    async function deliverUntrustedComment() {
      const rawRequest = setupRawAppRequest({
        context,
        routes: webhooksGithubRoutes,
      });
      const response = await rawRequest(webhookGithubContract.post.path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": `delivery-${randomUUID()}`,
          "x-github-event": "issue_comment",
          "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret)
            .update(payload)
            .digest("hex")}`,
        },
        body: payload,
      });
      await flushWaitUntilForTest();
      return response;
    }

    return { appFor, authHeaders, deliverUntrustedComment };
  }

  it("webhooks-github-workflow-002 (1/2) acknowledges an issue comment from outside the trusted-author allowlist with HTTP 200 OK", async () => {
    const { deliverUntrustedComment } =
      await givenGithubIssueCommentAutomation();

    const response = await deliverUntrustedComment();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("webhooks-github-workflow-002 (2/2) leaves no pending or running runs after ignoring an untrusted issue comment", async () => {
    const { appFor, authHeaders, deliverUntrustedComment } =
      await givenGithubIssueCommentAutomation();

    await deliverUntrustedComment();

    const logs = await accept(
      appFor(logsListContract).list({
        headers: authHeaders,
        query: {},
      }),
      [200],
    );
    const activeRuns = logs.body.data.filter((item) => {
      return item.status === "pending" || item.status === "running";
    });
    expect(activeRuns).toStrictEqual([]);
  });
});
