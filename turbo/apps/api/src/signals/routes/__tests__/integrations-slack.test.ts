import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { SlackFileFetchError } from "../../external/slack-file-fetcher";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/integrations-slack";
import { integrationsSlackRoutes } from "../integrations-slack";

const context = testContext();
const store = createStore();

const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);

function uniqueSlackUserId(): string {
  return `U_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

interface PublicSlackInstall {
  readonly actor: ApiTestUser;
  readonly teamId: string;
  readonly installerSlackUserId: string;
}

/**
 * Installs the Slack app for an onboarded org through the production OAuth
 * install flow; the installing admin's Slack user is connected by it.
 */
async function installPublicSlack(): Promise<PublicSlackInstall> {
  integrations.configureSlackAppMocks();
  context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  const actor = bdd.user({ orgRole: "org:admin" });
  await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Slack Bot",
  });
  const installerSlackUserId = uniqueSlackUserId();
  const install = await integrations.installSlackWorkspace(actor, {
    installerSlackUserId,
  });
  return { actor, teamId: install.teamId, installerSlackUserId };
}

/** Connects another org member's Slack user through the production flow. */
async function connectSecondMember(install: PublicSlackInstall): Promise<{
  readonly member: ApiTestUser;
  readonly slackUserId: string;
}> {
  const member = bdd.user({
    orgId: install.actor.orgId,
    orgRole: "org:member",
  });
  const slackUserId = uniqueSlackUserId();
  await integrations.connectSlackUser(member, {
    workspaceId: install.teamId,
    slackUserId,
    channelId: "C_BDD_SECOND_MEMBER",
  });
  return { member, slackUserId };
}

function slackClient() {
  return setupApp({ context, routes: integrationsSlackRoutes })(
    integrationsSlackContract,
  );
}

/** The public Slack integration status as `actor` with `orgRole`. */
async function readSlackStatus(
  actor: ApiTestUser,
  orgRole: "org:admin" | "org:member",
) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { userId: actor.userId, orgId: actor.orgId, orgRole };
    },
  });
  return (
    await accept(
      slackClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    )
  ).body;
}

describe("GET /api/integrations/slack", () => {
  let install: PublicSlackInstall;

  beforeEach(async () => {
    install = await installPublicSlack();
  });

  it("returns isAdmin: true for admin users", async () => {
    const status = await readSlackStatus(install.actor, "org:admin");

    expect(status.isAdmin).toBeTruthy();
    expect(status.isConnected).toBeTruthy();
    expect(status.isInstalled).toBeTruthy();
    expect(status.workspaceName).toBe(`BDD Slack App ${install.teamId}`);
    // The workspace default agent keeps its locked production name.
    expect(status.defaultAgentName).toBe("Okou");
    // Admin + connected: scope fields should be present
    expect(status).toHaveProperty("scopeMismatch");
    expect(status).toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(status).not.toHaveProperty("installUrl");
    expect(status).not.toHaveProperty("connectUrl");
  });

  it("returns isAdmin: false for non-admin users", async () => {
    const status = await readSlackStatus(install.actor, "org:member");

    expect(status.isAdmin).toBeFalsy();
    // Non-admin + connected: scope fields should NOT be present
    expect(status).not.toHaveProperty("scopeMismatch");
    expect(status).not.toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(status).not.toHaveProperty("installUrl");
    expect(status).not.toHaveProperty("connectUrl");
  });

  it("returns isConnected: false when user has no connection", async () => {
    // A member of the installed org who never connected Slack.
    const member = bdd.user({
      orgId: install.actor.orgId,
      orgRole: "org:admin",
    });
    const status = await readSlackStatus(member, "org:admin");

    expect(status.isConnected).toBeFalsy();
    expect(status.isInstalled).toBeTruthy();
    expect(status.isAdmin).toBeTruthy();
    // Not connected: install/connect URLs should be present
    expect(status).toHaveProperty("installUrl");
    expect(status).toHaveProperty("connectUrl");
    // Admin + installed: scope fields should be present
    expect(status).toHaveProperty("scopeMismatch");
    expect(status).toHaveProperty("reinstallUrl");
    // Not connected: workspace fields should NOT be present
    expect(status).not.toHaveProperty("workspaceName");
    expect(status).not.toHaveProperty("defaultAgentName");
  });

  it("returns connected workspace and default agent for a connected user", async () => {
    const { member } = await connectSecondMember(install);
    const status = await readSlackStatus(member, "org:admin");

    expect(status.isConnected).toBeTruthy();
    expect(status.isInstalled).toBeTruthy();
    expect(status.workspaceName).toBeTruthy();
    // The workspace default agent keeps its locked production name.
    expect(status.defaultAgentName).toBe("Okou");
  });
});

describe("DELETE /api/integrations/slack", () => {
  const mocks = createRouteMocks(context);

  it("returns 404 when the user has no Slack connection", async () => {
    const install = await installPublicSlack();
    const unconnected = bdd.user({
      orgId: install.actor.orgId,
      orgRole: "org:member",
    });
    mocks.clerk.session(unconnected.userId, unconnected.orgId);

    const response = await accept(
      slackClient().disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("No Slack connection found");
  });

  it("deletes only the current user's connection and refreshes App Home", async () => {
    const install = await installPublicSlack();
    const other = await connectSecondMember(install);
    context.mocks.slack.views.publish.mockClear();
    context.mocks.ably.publish.mockClear();
    mocks.clerk.session(install.actor.userId, install.actor.orgId);

    const response = await accept(
      slackClient().disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    await expect(
      readSlackStatus(install.actor, "org:admin"),
    ).resolves.toMatchObject({ isConnected: false, isInstalled: true });
    await expect(
      readSlackStatus(other.member, "org:member"),
    ).resolves.toMatchObject({ isConnected: true });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: install.installerSlackUserId,
        view: expect.objectContaining({
          type: "home",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "actions",
              elements: expect.arrayContaining([
                expect.objectContaining({ action_id: "home_login_prompt" }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "slack:changed",
      null,
    );
  });
});

describe("DELETE /api/integrations/slack?action=uninstall", () => {
  const mocks = createRouteMocks(context);

  it("returns 403 when a non-admin tries to uninstall", async () => {
    const install = await installPublicSlack();
    const other = await connectSecondMember(install);
    mocks.clerk.session(other.member.userId, other.member.orgId, "org:member");

    const response = await accept(
      slackClient().disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe("Admin access required");
  });

  it("publishes uninstalled App Home then deletes installation and connections", async () => {
    const install = await installPublicSlack();
    const other = await connectSecondMember(install);
    const orgId = install.actor.orgId;
    if (!orgId) {
      throw new Error("Expected the Slack installer to belong to an org");
    }
    await store.set(
      seedOrgMembership$,
      {
        orgId,
        userId: install.actor.userId,
        role: "admin",
      },
      context.signal,
    );
    context.mocks.slack.views.publish.mockClear();
    context.mocks.ably.publish.mockClear();
    mocks.clerk.session(install.actor.userId, orgId, "org:admin");

    const response = await accept(
      slackClient().disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(2);
    for (const slackUserId of [
      install.installerSlackUserId,
      other.slackUserId,
    ]) {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: slackUserId,
          view: expect.objectContaining({
            type: "home",
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: "actions",
                elements: expect.arrayContaining([
                  expect.objectContaining({ action_id: "home_open_settings" }),
                ]),
              }),
            ]),
          }),
        }),
      );
    }
    // The installation and every member connection are gone.
    await expect(
      readSlackStatus(install.actor, "org:admin"),
    ).resolves.toMatchObject({ isInstalled: false, isConnected: false });
    await expect(
      readSlackStatus(other.member, "org:member"),
    ).resolves.toMatchObject({ isInstalled: false, isConnected: false });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "slack:changed",
      null,
    );
  });
});

type SlackFileMetadata = {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url_private_download?: string;
  readonly url_private?: string;
};

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ("slack:write" | "file:read")[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function mockSlackFilesInfo(
  response:
    | { readonly ok: true; readonly file: SlackFileMetadata }
    | { readonly ok: false; readonly error: string },
): void {
  server.use(
    http.get("https://slack.com/api/files.info", () => {
      return HttpResponse.json(response);
    }),
  );
}

function defaultSlackFile(
  overrides: Partial<SlackFileMetadata> = {},
): SlackFileMetadata {
  return {
    id: "F-OK",
    name: "pic.png",
    mimetype: "image/png",
    size: 19,
    url_private_download:
      "https://files.slack.com/files-pri/T1-F-OK/download/pic.png",
    ...overrides,
  };
}

function requestDownloadFile(
  query: string,
  authorization?: string,
): Promise<Response> {
  const app = createApp({
    signal: context.signal,
    routes: integrationsSlackRoutes,
  });
  const headers: Record<string, string> = authorization
    ? { authorization }
    : {};
  return Promise.resolve(
    app.request(`/api/integrations/slack/download-file${query}`, {
      method: "GET",
      headers,
    }),
  );
}

async function expectErrorResponse(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string };
  };
  expect(body.error?.code).toBe(code);
}

describe("GET /api/integrations/slack/download-file", () => {
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const mocks = createRouteMocks(context);

  async function seedDownloadContext(
    args: {
      readonly withInstallation?: boolean;
    } = {},
  ): Promise<{ readonly token: string }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    if (args.withInstallation !== false) {
      await trackSlackFixture(
        store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
      );
    }

    return {
      token: okouToken({ userId, orgId, capabilities: ["slack:write"] }),
    };
  }

  it("rejects an agent token without slack:write capability", async () => {
    expect.hasAssertions();
    const token = okouToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["file:read"],
    });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 403, "FORBIDDEN");
  });

  it("returns 400 when file_id query param is missing", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();

    const response = await requestDownloadFile("", `Bearer ${token}`);

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext({ withInstallation: false });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 404 when Slack reports file not found", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: false, error: "file_not_found" });

    const response = await requestDownloadFile(
      "?file_id=F-MISSING",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 404 when the Slack file has no downloadable URL", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    const file = defaultSlackFile();
    mockSlackFilesInfo({
      ok: true,
      file: {
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
      },
    });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 400 for disallowed download hostnames", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({
      ok: true,
      file: defaultSlackFile({
        url_private_download: "https://evil.example.com/steal.png",
      }),
    });
    context.mocks.slack.fetchFile.mockRejectedValue(
      new SlackFileFetchError("invalid-url", "Invalid Slack download URL"),
    );

    const response = await requestDownloadFile(
      "?file_id=F-BAD",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 413 when file metadata exceeds the 100MB limit", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({
      ok: true,
      file: defaultSlackFile({ size: 200 * 1024 * 1024 }),
    });

    const response = await requestDownloadFile(
      "?file_id=F-BIG",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 413, "PAYLOAD_TOO_LARGE");
  });

  it("returns 502 when Slack file download fails", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockRejectedValue(
      new SlackFileFetchError(
        "download-failed",
        "Failed to download Slack file",
        503,
      ),
    );

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 502, "BAD_GATEWAY");
  });

  it("returns 502 when Slack returns an HTML response", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response("<html><body>Login</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 502, "BAD_GATEWAY");
  });

  it("returns 400 when Slack files.info returns a platform error", async () => {
    expect.hasAssertions();
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: false, error: "invalid_auth" });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 400, "SLACK_ERROR");
  });

  it("streams file bytes from Slack with file metadata headers", async () => {
    const { token } = await seedDownloadContext();
    const fileBytes = Buffer.from("real file contents");
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(fileBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(fileBytes.length),
        },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F-OK",
      `Bearer ${token}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("pic.png");
    expect(response.headers.get("content-length")).toBe(
      String(fileBytes.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("accepts a Clerk session with an active organization", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(Buffer.from("ok"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F-OK",
      "Bearer clerk-session",
    );

    expect(response.status).toBe(200);
  });
});
