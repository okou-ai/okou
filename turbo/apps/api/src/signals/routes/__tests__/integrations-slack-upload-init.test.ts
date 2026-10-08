import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { integrationsSlackUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";

const context = testContext();
const store = createStore();
const slackOrgs = createPublicSlackOrgApi(context);
const LARGE_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024 + 1;

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["slack:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("POST /api/integrations/slack/upload-file/init", () => {
  beforeEach(() => {
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/abc",
      file_id: "F-mock-file",
    });
  });

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await slackOrgs.installForOrg({ orgId });
    // The OAuth install authenticates its installing admin; restore the
    // member the Okou token authenticates as.
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    return { orgId, userId };
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid request bodies", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "", length: 0 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns a Slack-issued upload URL and file id on the happy path", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "quarterly.csv", length: 4096 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://files.slack.com/upload/v1/abc",
      fileId: "F-mock-file",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenLastCalledWith({ filename: "quarterly.csv", length: 4096 });
  });

  it("rejects large canonical uploads after asset graduation", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: {
          filename: "legacy-archive.zip",
          length: LARGE_DIRECT_UPLOAD_BYTES,
          canonical: {
            operationId: randomUUID(),
            contentType: "application/zip",
            checksumSha256: "a".repeat(64),
            channel: "C_LEGACY_DIRECT",
          },
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "File too large (max 100 MB)",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("forwards Slack non-ok upload URL responses as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: false,
      error: "invalid_length",
    });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "bad.csv", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("invalid_length");
  });

  it("forwards malformed Slack upload URL responses as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      file_id: "F-missing-upload-url",
    });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "missing-url.csv", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("unknown error");
  });

  it("forwards Slack platform errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockRejectedValueOnce(
      Object.assign(new Error("invalid_filename"), {
        data: { ok: false, error: "invalid_filename" },
      }),
    );

    const client = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "../bad.exe", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("invalid_filename");
  });
});
