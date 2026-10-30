import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { integrationsSlackUploadInitContract } from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const store = createStore();
const slackOrgs = createPublicSlackOrgApi(context);
const LARGE_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024 + 1;

describe("POST /api/integrations/slack/upload-file/init", () => {
  beforeEach(() => {
    mockSharedSlackConversations();
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/abc",
      file_id: "F-mock-file",
    });
  });

  async function seedWithInstallation(connected = true): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const installation = await slackOrgs.installForOrg({ orgId });
    if (connected) {
      await slackOrgs.connectMember({
        orgId,
        userId,
        slackWorkspaceId: installation.slackWorkspaceId,
      });
    }
    // The OAuth install authenticates its installing admin; restore the
    // member the Okou token authenticates as.
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    return { orgId, userId };
  }

  it("selects each request's installation across users and organizations", async () => {
    const scenario = createPublicComputerUseScenario(context);
    const first = scenario.user({ orgRole: "org:admin" });
    const member = scenario.user({ orgId: first.orgId, orgRole: "org:member" });
    const second = scenario.user({ orgRole: "org:admin" });
    const missing = scenario.user({ orgRole: "org:admin" });
    await scenario.run(async () => {
      for (const actor of [first, member, second, missing]) {
        await scenario.prepareActor(actor);
      }
      const a = await slackOrgs.installOrg({
        actor: first,
        withConnection: true,
      });
      scenario.beforeWorkspaceCleanup(() => {
        return slackOrgs.uninstallWorkspace(a.slackWorkspaceId);
      });
      const b = await slackOrgs.installOrg({
        actor: second,
        withConnection: true,
      });
      scenario.beforeWorkspaceCleanup(() => {
        return slackOrgs.uninstallWorkspace(b.slackWorkspaceId);
      });
      if (!first.orgId) {
        throw new Error("Expected the first actor's organization");
      }
      await slackOrgs.connectMember({
        orgId: first.orgId,
        userId: member.userId,
        slackWorkspaceId: a.slackWorkspaceId,
        run: scenario.run,
      });
      await flushWaitUntilForTest();
      const requests = [
        { actor: first, installation: a },
        { actor: member, installation: a },
        { actor: second, installation: b },
        { actor: missing, installation: undefined },
        { actor: first, installation: a },
      ];
      const client = setupApp({
        context,
        routes: integrationsSlackUploadInitRoutes,
      })(integrationsSlackUploadInitContract);
      for (const [index, request] of requests.entries()) {
        const claim = await scenario.claim(request.actor);
        await flushWaitUntilForTest();
        context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                role: request.actor.orgRole,
                organization: { id: request.actor.orgId },
                publicUserData: { userId: request.actor.userId },
              },
            ],
          },
        );
        const filename = `request-${String(index)}.csv`;
        const length = index + 1;
        const uploadUrl = `https://files.slack.com/upload/v1/graph-${String(index)}`;
        const fileId = `F_GRAPH_${String(index)}`;
        context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
          ok: true,
          upload_url: uploadUrl,
          file_id: fileId,
        });
        const clients = context.mocks.slack.createClient.mock.calls.length;
        const uploads =
          context.mocks.slack.files.getUploadURLExternal.mock.calls.length;
        const response = client.init({
          headers: { authorization: `Bearer ${claim.token}` },
          body: { filename, length },
        });
        if (!request.installation) {
          expect((await accept(response, [404])).body.error.code).toBe(
            "NOT_FOUND",
          );
          expect(
            context.mocks.slack.createClient.mock.calls.slice(clients),
          ).toStrictEqual([]);
          expect(
            context.mocks.slack.files.getUploadURLExternal.mock.calls.slice(
              uploads,
            ),
          ).toStrictEqual([]);
          continue;
        }
        expect((await accept(response, [200])).body).toStrictEqual({
          uploadUrl,
          fileId,
        });
        expect([
          ...new Set(
            context.mocks.slack.createClient.mock.calls
              .slice(clients)
              .map(([token]) => {
                return token;
              }),
          ),
        ]).toStrictEqual([request.installation.botToken]);
        expect(
          context.mocks.slack.files.getUploadURLExternal.mock.calls.slice(
            uploads,
          ),
        ).toStrictEqual([[{ filename, length }]]);
      }
    });
  });
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
    const token = await credentials.sandboxToken({ userId, orgId });

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

  it("denies bot upload allocation without the caller's verified Slack binding", async () => {
    const actor = await seedWithInstallation(false);
    const response = await accept(
      setupApp({ context, routes: integrationsSlackUploadInitRoutes })(
        integrationsSlackUploadInitContract,
      ).init({
        headers: {
          authorization: `Bearer ${await credentials.okouToken(actor)}`,
        },
        body: { filename: "private.txt", length: 42 },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns a Slack-issued upload URL and file id on the happy path", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

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
    const token = await credentials.okouToken({ userId, orgId });

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

  it("forwards Slack platform errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = await credentials.okouToken({ userId, orgId });

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
