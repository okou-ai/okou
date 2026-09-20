import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { integrationsGithubUploadCompleteRoutes } from "../integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../integrations-github-upload-init";
import { integrationsGithubDownloadFileRoutes } from "../integrations-github-download-file";

const TEST_APP_ROUTES = Object.freeze([
  ...integrationsGithubDownloadFileRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const github = createGithubBddApi(context);
const bdd = createBddApi(context);
const api = createRunsApi(context);

interface GitHubFileFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly actor: ApiTestUser;
  readonly composeId: string;
  readonly remoteInstallationId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities: readonly ("github:read" | "github:write")[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function setupGitHubTokenMock(installationId: string): void {
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      ({ request }) => {
        expect(request.headers.get("authorization")).toMatch(/^Bearer /u);
        return HttpResponse.json({
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

describe("GitHub file integration routes", () => {
  async function seedFixture(): Promise<GitHubFileFixture> {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("GitHub file fixtures require an org-scoped actor");
    }
    const agent = await bdd.createAgent(actor, {
      displayName: "GitHub Files Agent",
      visibility: "private",
    });
    const install = await github.installGithubApp(actor, agent.agentId, {
      targetLogin: "bdd-files-org",
    });
    return {
      orgId: actor.orgId,
      userId: actor.userId,
      actor,
      composeId: agent.agentId,
      remoteInstallationId: install.remoteInstallationId,
    };
  }

  /**
   * Creates a real run for the fixture agent through the test-only adapter.
   * Run admission needs org credits, granted through the Stripe webhook
   * product path. A provider-only fixture admits the run without selecting a
   * model and without reading legacy Compose content.
   */
  async function seedRunForFixture(
    fixture: GitHubFileFixture,
  ): Promise<{ readonly runId: string }> {
    bdd.acceptAgentStorageWrites();
    await api.grantProEntitlement(fixture.actor);
    await api.createOrgModelProvider(fixture.actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const run = await api.createRun(fixture.actor, {
      agentId: fixture.composeId,
      prompt: "deliver github file",
      modelProvider: "openrouter-api-key",
    });
    return { runId: run.runId };
  }

  it("streams a GitHub context file from an allowed URL", async () => {
    const fixture = await seedFixture();
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    server.use(
      http.get(fileUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new HttpResponse("png-bytes", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "9",
          },
        });
      }),
    );

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const query = new URLSearchParams({
      url: fileUrl,
      filename: "screenshot.png",
    });
    const response = await app.request(
      `/api/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("screenshot.png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    await expect(response.text()).resolves.toBe("png-bytes");
  });

  it("uses the GitHub URL filename when no filename hint is provided", async () => {
    const fixture = await seedFixture();
    const fileUrl =
      "https://raw.githubusercontent.com/okou-ai/okou/main/github-file.png";
    server.use(
      http.get(fileUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new HttpResponse("artifact-bytes", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "14",
          },
        });
      }),
    );

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const query = new URLSearchParams({ url: fileUrl });
    const response = await app.request(
      `/api/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("github-file.png");
    await expect(response.text()).resolves.toBe("artifact-bytes");
  });

  it("rejects non-GitHub file URLs", async () => {
    const fixture = await seedFixture();

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const query = new URLSearchParams({
      url: "https://example.com/file.png",
    });
    const response = await app.request(
      `/api/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("requires github read capability for context file downloads", async () => {
    const fixture = await seedFixture();
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const query = new URLSearchParams({
      url: "https://github.com/user-attachments/assets/abc123",
    });

    const response = await app.request(
      `/api/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:write"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("returns a presigned upload URL for GitHub file delivery", async () => {
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    mocks.s3.listObjects([]);
    const fixture = await seedFixture();
    const client = setupApp({
      context,
      routes: integrationsGithubUploadInitRoutes,
    })(integrationsGithubUploadInitContract);

    const response = await accept(
      client.init({
        body: {
          filename: "daily report.pdf",
          contentType: "application/pdf",
          length: 1234,
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:write"],
          })}`,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://r2.example.com/upload?sig=test",
      filename: "daily_report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    expect(response.body.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body.fileUrl).toMatch(
      /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.pdf$/u,
    );
    expect(response.body.fileUrl).not.toContain(fixture.userId);

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1];
    expect(command).toHaveProperty("input.Bucket", "test-user-artifacts");
    expect(command).toHaveProperty(
      "input.Key",
      `artifacts${new URL(response.body.fileUrl).pathname}`,
    );
  });

  it("posts an uploaded file URL to GitHub and records the run artifact", async () => {
    const fixture = await seedFixture();
    const run = await seedRunForFixture(fixture);
    setupGitHubTokenMock(fixture.remoteInstallationId);

    const uploadId = randomUUID();
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    const fileUrl = `https://cdn.vm7.io/artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
    ]);

    let capturedCommentBody: string | undefined;
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ request, params }) => {
          expect(params.owner).toBe("okou-ai");
          expect(params.repo).toBe("vm0");
          expect(params.issueNumber).toBe("42");
          expect(request.headers.get("authorization")).toBe(
            "Bearer ghs_test_token",
          );
          const body = (await request.json()) as Record<string, unknown>;
          capturedCommentBody =
            typeof body.body === "string" ? body.body : undefined;
          return HttpResponse.json({ id: 98_765 });
        },
      ),
    );

    const client = setupApp({
      context,
      routes: integrationsGithubUploadCompleteRoutes,
    })(integrationsGithubUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          repo: "okou-ai/okou",
          issueNumber: 42,
          contentType: "application/pdf",
          caption: "Daily report",
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: run.runId,
            capabilities: ["github:write"],
          })}`,
        },
      }),
      [200],
    );

    expect(capturedCommentBody).toBe(
      `Daily report\n\n[report.pdf](${fileUrl})`,
    );
    expect(response.body).toMatchObject({
      commentId: "98765",
      repo: "okou-ai/okou",
      issueNumber: 42,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: fileUrl,
    });
  });
});
