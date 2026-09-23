import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import type {
  TestSlackStatePostBody,
  TestSlackStatePostResponse,
  TestSlackStateResponse,
} from "@okouai/api-contracts/contracts/test-slack-state";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { SlackFileFetchError } from "../../external/slack-file-fetcher";
import { testSlackStateRoutes } from "../slack-state-preview";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/integrations-slack";
import { integrationsSlackRoutes } from "../integrations-slack";

const context = testContext();
const store = createStore();
const SLACK_STATE_ROUTE = "/api/test/slack-state";

interface SlackFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly workspaceId: string;
}

function slackStateApp() {
  return createApp({ signal: context.signal, routes: testSlackStateRoutes });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postSlackState(
  body: TestSlackStatePostBody,
): Promise<TestSlackStatePostResponse> {
  const response = await slackStateApp().request(SLACK_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expectOk(response, "post Slack test state");
  return await readJson<TestSlackStatePostResponse>(response);
}

async function getSlackState(
  workspaceId: string,
): Promise<TestSlackStateResponse> {
  const response = await slackStateApp().request(
    `${SLACK_STATE_ROUTE}?${new URLSearchParams({
      team_id: workspaceId,
    }).toString()}`,
  );
  expectOk(response, "get Slack test state");
  return await readJson<TestSlackStateResponse>(response);
}

async function seedSlackFixture(
  overrides: { readonly withConnection?: boolean } = {},
): Promise<SlackFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const workspaceId = `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  const seeded = await postSlackState({
    team_id: workspaceId,
    slack_user_id: "U_USER123",
    org_id: orgId,
    user_id: userId,
    workspace_name: "Test Workspace",
    bot_user_id: "U_BOT123",
    bot_scopes: null,
    seed_connection: overrides.withConnection !== false,
    seed_default_agent: true,
    default_agent_name: "slack-bot",
    default_agent_display_name: "Slack Bot",
    org_name: "Test Org",
  });

  if (!seeded.default_agent_id) {
    throw new Error("Expected Slack fixture to include a default agent");
  }
  return {
    userId: seeded.user_id,
    orgId: seeded.org_id,
    composeId: seeded.default_agent_id,
    workspaceId: seeded.team_id,
  };
}

async function cleanupSlackFixture(fixture: SlackFixture): Promise<void> {
  const response = await slackStateApp().request(
    `${SLACK_STATE_ROUTE}?${new URLSearchParams({
      team_id: fixture.workspaceId,
      org_id: fixture.orgId,
    }).toString()}`,
    { method: "DELETE" },
  );
  expectOk(response, "delete Slack fixture");
}

async function deleteSlackConnection(fixture: SlackFixture): Promise<void> {
  await postSlackState({
    team_id: fixture.workspaceId,
    org_id: fixture.orgId,
    user_id: fixture.userId,
    delete_connection: true,
  });
}

describe("GET /api/integrations/slack", () => {
  let fixture: SlackFixture;

  beforeEach(async () => {
    fixture = await seedSlackFixture();
  });

  afterEach(async () => {
    await cleanupSlackFixture(fixture);
  });

  it("returns isAdmin: true for admin users", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
        };
      },
    });

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
    expect(response.body.isConnected).toBeTruthy();
    expect(response.body.isInstalled).toBeTruthy();
    expect(response.body.workspaceName).toBe("Test Workspace");
    expect(response.body.defaultAgentName).toBe("Slack Bot");
    // Admin + connected: scope fields should be present (botScopes null → mismatch)
    expect(response.body).toHaveProperty("scopeMismatch");
    expect(response.body).toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(response.body).not.toHaveProperty("installUrl");
    expect(response.body).not.toHaveProperty("connectUrl");
  });

  it("returns isAdmin: false for non-admin users", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:member",
        };
      },
    });

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
    // Non-admin + connected: scope fields should NOT be present
    expect(response.body).not.toHaveProperty("scopeMismatch");
    expect(response.body).not.toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(response.body).not.toHaveProperty("installUrl");
    expect(response.body).not.toHaveProperty("connectUrl");
  });

  it("returns isConnected: false when user has no connection", async () => {
    await deleteSlackConnection(fixture);

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
        };
      },
    });

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
    expect(response.body.isInstalled).toBeTruthy();
    expect(response.body.isAdmin).toBeTruthy();
    // Not connected: install/connect URLs should be present
    expect(response.body).toHaveProperty("installUrl");
    expect(response.body).toHaveProperty("connectUrl");
    // Admin + installed: scope fields should be present (botScopes null → mismatch)
    expect(response.body).toHaveProperty("scopeMismatch");
    expect(response.body).toHaveProperty("reinstallUrl");
    // Not connected: workspace/environment fields should NOT be present
    expect(response.body).not.toHaveProperty("workspaceName");
    expect(response.body).not.toHaveProperty("defaultAgentName");
    expect(response.body).not.toHaveProperty("environment");
  });

  it("returns connected status without agent environment details", async () => {
    await postSlackState({
      org_id: fixture.orgId,
      user_id: fixture.userId,
      seed_default_agent: true,
      default_agent_name: "slack-bot",
      default_agent_display_name: "Slack Bot",
    });

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
        };
      },
    });

    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeTruthy();
    expect(response.body.defaultAgentName).toBe("Slack Bot");
    expect(response.body).not.toHaveProperty("environment");
  });
});

async function findSlackConnection(args: {
  readonly workspaceId: string;
  readonly userId: string;
}): Promise<TestSlackStateResponse["connections"][number] | undefined> {
  const state = await getSlackState(args.workspaceId);
  return state.connections.find((connection) => {
    return connection.userId === args.userId;
  });
}

async function findSlackInstallation(
  workspaceId: string,
): Promise<TestSlackStateResponse["installation"] | undefined> {
  const state = await getSlackState(workspaceId);
  return state.installation ?? undefined;
}

async function listWorkspaceSlackConnections(
  workspaceId: string,
): Promise<readonly TestSlackStateResponse["connections"][number][]> {
  const state = await getSlackState(workspaceId);
  return state.connections;
}

describe("DELETE /api/integrations/slack", () => {
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const mocks = createRouteMocks(context);

  beforeEach(() => {
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  });

  async function seedDeleteContext(
    args: {
      readonly userId?: string;
      readonly orgId?: string;
      readonly withConnection?: boolean;
    } = {},
  ): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly workspaceId: string;
    readonly slackUserId: string | null;
  }> {
    const orgId = args.orgId ?? `org_${randomUUID()}`;
    const userId = args.userId ?? `user_${randomUUID()}`;
    const fixture = await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    const connection =
      args.withConnection === false
        ? null
        : await store.set(
            seedSlackOrgConnection$,
            {
              slackWorkspaceId: fixture.slackWorkspaceId,
              userId: userId,
            },
            context.signal,
          );

    return {
      orgId,
      userId,
      workspaceId: fixture.slackWorkspaceId,
      slackUserId: connection?.slackUserId ?? null,
    };
  }

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({ headers: {}, query: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the user has no Slack connection", async () => {
    const seeded = await seedDeleteContext({ withConnection: false });
    mocks.clerk.session(seeded.userId, seeded.orgId);
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("No Slack connection found");
  });

  it("deletes only the current user's connection and refreshes App Home", async () => {
    const seeded = await seedDeleteContext();
    const otherUserId = `user_${randomUUID()}`;
    const otherConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: seeded.workspaceId,
        userId: otherUserId,
      },
      context.signal,
    );
    mocks.clerk.session(seeded.userId, seeded.orgId);
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    await expect(
      findSlackConnection({
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      findSlackConnection({
        workspaceId: seeded.workspaceId,
        userId: otherUserId,
      }),
    ).resolves.toMatchObject({ slackUserId: otherConnection.slackUserId });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: seeded.slackUserId,
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
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const mocks = createRouteMocks(context);

  beforeEach(() => {
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  });

  async function seedUninstallContext(
    args: {
      readonly orgId?: string;
      readonly userId?: string;
      readonly withInstallation?: boolean;
    } = {},
  ): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly workspaceId: string | null;
    readonly slackUserIds: readonly string[];
  }> {
    const orgId = args.orgId ?? `org_${randomUUID()}`;
    const userId = args.userId ?? `user_${randomUUID()}`;
    if (args.withInstallation === false) {
      return { orgId, userId, workspaceId: null, slackUserIds: [] };
    }

    const fixture = await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    const firstConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        userId: userId,
      },
      context.signal,
    );
    const secondConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        userId: `user_${randomUUID()}`,
      },
      context.signal,
    );

    return {
      orgId,
      userId,
      workspaceId: fixture.slackWorkspaceId,
      slackUserIds: [firstConnection.slackUserId, secondConnection.slackUserId],
    };
  }

  it("returns 403 when a non-admin tries to uninstall", async () => {
    const seeded = await seedUninstallContext();
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:member");
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe("Admin access required");
  });

  it("returns 404 when no installation exists", async () => {
    const seeded = await seedUninstallContext({ withInstallation: false });
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:admin");
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("No Slack installation found");
  });

  it("publishes uninstalled App Home then deletes installation and connections", async () => {
    const seeded = await seedUninstallContext();
    await store.set(
      seedOrgMembership$,
      {
        orgId: seeded.orgId,
        userId: seeded.userId,
        role: "admin",
      },
      context.signal,
    );
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:admin");
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(2);
    for (const slackUserId of seeded.slackUserIds) {
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
    const workspaceId = seeded.workspaceId;
    expect(workspaceId).not.toBeNull();
    if (workspaceId === null) {
      throw new Error("workspaceId should be present for uninstall test");
    }
    await expect(findSlackInstallation(workspaceId)).resolves.toBeUndefined();
    await expect(
      listWorkspaceSlackConnections(workspaceId),
    ).resolves.toStrictEqual([]);
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

  it("returns 401 when the request is unauthenticated", async () => {
    expect.hasAssertions();
    const response = await requestDownloadFile("?file_id=F1");

    await expectErrorResponse(response, 401, "UNAUTHORIZED");
  });

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
