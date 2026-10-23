import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  integrationsGithubDownloadFileContract,
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsGithubDownloadFileRoutes } from "../integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "../integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../integrations-github-upload-init";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...integrationsGithubDownloadFileRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
]);

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const claimedToken = credentials.okouToken;
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
   * Creates a real run for the fixture agent through the Thread entry. Run
   * admission needs org credits, granted through the Stripe webhook product
   * path.
   */
  async function seedRunForFixture(fixture: GitHubFileFixture) {
    let restoreAccepted = captureConnectorExternalState(context);
    const owner = publicRunOwner(context, fixture.actor, {
      restoreEnvironment: () => {
        restoreAccepted();
      },
    });
    return await owner.run(async () => {
      bdd.acceptAgentStorageWrites();
      await api.grantProEntitlement(fixture.actor);
      await api.ensurePersonalSubscriptionModel(fixture.actor);
      api.acceptStorageDownloads();
      api.acceptTelemetryIngest();
      const runnerGroup = api.configureRunnerGroup();
      const run = await api.createThreadRun(fixture.actor, {
        agentId: fixture.composeId,
        prompt: "deliver github file",
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await owner.claim(run.runId);
      restoreAccepted = captureConnectorExternalState(context);
      const token = claim.platformEnvironment?.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected a claimed GitHub caller");
      }
      return { ...run, token };
    });
  }

  it.each([
    {
      url: "https://raw.githubusercontent.com/okou-ai/okou/main/report%20final.csv",
      filename: "report final.csv",
      contentType: "text/csv",
    },
    {
      url: "https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef",
      filename: "github-file",
      contentType: "application/octet-stream",
    },
  ])(
    "returns validated GitHub URL metadata without fetching bytes: $filename",
    async ({ url, filename, contentType }) => {
      const fixture = await seedFixture();
      let providerDownloads = 0;
      server.use(
        http.get(url, () => {
          providerDownloads += 1;
          return new HttpResponse("not downloaded");
        }),
      );
      const client = setupApp({
        context,
        routes: integrationsGithubDownloadFileRoutes,
      })(integrationsGithubDownloadFileContract);

      const response = await accept(
        client.fileUrl({
          query: { url },
          headers: { authorization: `Bearer ${await claimedToken(fixture)}` },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        downloadUrl: url,
        filename,
        contentType,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(providerDownloads).toBe(0);
    },
  );

  it("preserves signed GitHub URLs while sanitizing filename hints", async () => {
    const fixture = await seedFixture();
    const url =
      "https://private-user-images.githubusercontent.com/123/file?jwt=signed!";
    const client = setupApp({
      context,
      routes: integrationsGithubDownloadFileRoutes,
    })(integrationsGithubDownloadFileContract);

    const response = await accept(
      client.fileUrl({
        query: { url, filename: "../report.pdf" },
        headers: { authorization: `Bearer ${await claimedToken(fixture)}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      downloadUrl: url,
      filename: ".._report.pdf",
      contentType: "application/pdf",
    });
  });

  it("requires GitHub read capability before returning a download URL", async () => {
    const fixture = await seedFixture();
    const { sandboxToken } = await credentials.claim(fixture);
    const client = setupApp({
      context,
      routes: integrationsGithubDownloadFileRoutes,
    })(integrationsGithubDownloadFileContract);

    const response = await accept(
      client.fileUrl({
        query: { url: "https://github.com/user-attachments/assets/abc123" },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );

    expect(response.body.error.message).toContain("github:read");
  });

  it("rejects embedded credentials before handing off a GitHub URL", async () => {
    const fixture = await seedFixture();
    const client = setupApp({
      context,
      routes: integrationsGithubDownloadFileRoutes,
    })(integrationsGithubDownloadFileContract);

    const response = await accept(
      client.fileUrl({
        query: {
          url: "https://user:secret@github.com/user-attachments/assets/abc123",
        },
        headers: { authorization: `Bearer ${await claimedToken(fixture)}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

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
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
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
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
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
          authorization: `Bearer ${await claimedToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
        },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns a presigned upload URL for GitHub file delivery", async () => {
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    mocks.s3.listObjects([]);
    const fixture = await seedFixture();
    const token = await claimedToken(fixture);
    context.mocks.s3.getSignedUrl.mockClear();
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
          authorization: `Bearer ${token}`,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://r2.example.com/upload?sig=test",
      filename: "daily_report.pdf",
      contentType: "application/pdf",
      size: 1234,
      uploadHeaders: { "x-amz-meta-artifact-id": response.body.uploadId },
    });
    expect(response.body.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body.fileUrl).toMatch(
      /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.pdf$/u,
    );
    expect(response.body.fileUrl).not.toContain(fixture.userId);

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1];
    expect(command).toHaveProperty("input.Bucket", "test-private-artifacts");
    expect(command).toHaveProperty(
      "input.Key",
      `private-artifacts/${response.body.uploadId}/daily_report.pdf`,
    );
    expect(command).toHaveProperty("input.Metadata", {
      "artifact-id": response.body.uploadId,
    });
  });

  it("posts an uploaded file URL to GitHub and records the run artifact", async () => {
    const fixture = await seedFixture();
    const run = await seedRunForFixture(fixture);
    setupGitHubTokenMock(fixture.remoteInstallationId);

    installSharedThreadStorage(context);
    const upload = await accept(
      setupApp({ context, routes: integrationsGithubUploadInitRoutes })(
        integrationsGithubUploadInitContract,
      ).init({
        headers: { authorization: `Bearer ${run.token}` },
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 1234,
        },
      }),
      [200],
    );
    const { uploadId, fileUrl } = upload.body;
    expect(
      (
        await fetch(upload.body.uploadUrl, {
          method: "PUT",
          headers: upload.body.uploadHeaders,
          body: "x".repeat(1234),
        })
      ).status,
    ).toBe(200);

    let capturedCommentBody: string | undefined;
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ request, params }) => {
          expect(params.owner).toBe("okou-ai");
          expect(params.repo).toBe("okou");
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
          authorization: `Bearer ${run.token}`,
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
