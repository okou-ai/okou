import { integrationsSlackDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { integrationsSlackRoutes } from "../integrations-slack";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";
import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface SlackFileServed {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly channels?: readonly string[];
  readonly groups?: readonly string[];
  readonly bytes: string;
}

/** Slack's file info and file download for the files this case owns. */
function serveSlackFiles(files: readonly SlackFileServed[]) {
  const infoRequests: { fileId: string | null; token: string | null }[] = [];
  const fetches: { path: string; token: string | null }[] = [];
  server.use(
    http.get("https://slack.com/api/files.info", ({ request }) => {
      const fileId = new URL(request.url).searchParams.get("file");
      infoRequests.push({
        fileId,
        token: request.headers.get("authorization"),
      });
      const file = files.find((candidate) => {
        return candidate.id === fileId;
      });
      if (!file) {
        return HttpResponse.json({ ok: false, error: "file_not_found" });
      }
      return HttpResponse.json({
        ok: true,
        file: {
          id: file.id,
          name: file.name,
          mimetype: file.mimetype,
          size: file.size,
          url_private_download: `https://files.slack.com/files-pri/${file.id}/${file.name}`,
          channels: file.channels ?? [],
          groups: file.groups ?? [],
          ims: [],
        },
      });
    }),
  );
  context.mocks.slack.fetchFile.mockImplementation((...args: unknown[]) => {
    const [url, token] = args;
    if (typeof url !== "string") {
      throw new Error("Expected a Slack download URL");
    }
    const path = new URL(url).pathname;
    fetches.push({ path, token: typeof token === "string" ? token : null });
    const file = files.find((candidate) => {
      return path.startsWith(`/files-pri/${candidate.id}/`);
    });
    if (!file) {
      throw new Error(`Unexpected Slack file download ${url}`);
    }
    const body = new TextEncoder().encode(file.bytes);
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": file.mimetype,
          "content-length": String(body.byteLength),
        },
      }),
    );
  });
  return { infoRequests, fetches };
}

function downloadClient() {
  return setupApp({ context, routes: integrationsSlackRoutes })(
    integrationsSlackDownloadFileContract,
  );
}

/** The member downloads with a Clerk session whose active org is its own. */
async function downloadAs(actor: ApiTestUser, fileId: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return await accept(
    downloadClient().download({
      headers: { authorization: "Bearer clerk-session" },
      query: { file_id: fileId },
    }),
    [200, 404, 413],
  );
}

function asRole(
  actor: ApiTestUser,
  orgRole: "org:admin" | "org:member",
): ApiTestUser {
  return { ...actor, orgRole };
}

const PNG_FILE: SlackFileServed = Object.freeze({
  id: "F-OK",
  name: "pic.png",
  mimetype: "image/png",
  size: 18,
  channels: ["C123"],
  bytes: "real file contents",
});

describe("GET /api/integrations/slack", () => {
  it("integrations-slack-003 offers install and connect links to an unconnected admin", async () => {
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    const org = await slack.installOrg();

    const status = await integrations.requestSlackIntegrationStatus(
      org.actor,
      [200],
    );

    expect(status.body).toMatchObject({
      isConnected: false,
      isInstalled: true,
      isAdmin: true,
    });
    expect(status.body).toHaveProperty("installUrl");
    expect(status.body).toHaveProperty("connectUrl");
    expect(status.body).toHaveProperty("scopeMismatch");
    expect(status.body).toHaveProperty("reinstallUrl");
    expect(status.body).not.toHaveProperty("workspaceName");
  });

  it("integrations-slack-002 hides admin-only fields from the same user as a member", async () => {
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    const org = await slack.installOrg({ withConnection: true });

    const status = await integrations.requestSlackIntegrationStatus(
      asRole(org.actor, "org:member"),
      [200],
    );

    expect(status.body).toMatchObject({ isAdmin: false });
    expect(status.body).not.toHaveProperty("scopeMismatch");
    expect(status.body).not.toHaveProperty("reinstallUrl");
    expect(status.body).not.toHaveProperty("installUrl");
    expect(status.body).not.toHaveProperty("connectUrl");
  });

  it("integrations-slack-001 shows an installing admin as installed, connected and admin", async () => {
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    const org = await slack.installOrg({ withConnection: true });

    const status = await integrations.requestSlackIntegrationStatus(
      asRole(org.actor, "org:admin"),
      [200],
    );

    expect(status.body).toMatchObject({
      isAdmin: true,
      isConnected: true,
      isInstalled: true,
      workspaceName: `BDD Slack App ${org.slackWorkspaceId}`,
    });
    expect(status.body).toHaveProperty("scopeMismatch");
    expect(status.body).toHaveProperty("reinstallUrl");
    expect(status.body).not.toHaveProperty("installUrl");
    expect(status.body).not.toHaveProperty("connectUrl");
  });

  it("integrations-slack-004 shows the workspace to a member who connected their Slack user", async () => {
    const bdd = createBddApi(context);
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    // Slack answers the connection welcome messages like the real Web API.
    integrations.configureSlackAppMocks();
    const admin = bdd.user({ orgRole: "org:admin" });
    const orgId = admin.orgId ?? "";
    const installed = await slack.installForOrg({ orgId, installer: admin });
    const member = bdd.user({ orgId, orgRole: "org:admin" });
    await slack.connectMember({
      orgId,
      userId: member.userId,
      slackWorkspaceId: installed.slackWorkspaceId,
    });

    const status = await integrations.requestSlackIntegrationStatus(
      member,
      [200],
    );

    expect(status.body).toMatchObject({ isConnected: true, isInstalled: true });
    expect("workspaceName" in status.body && status.body.workspaceName).toMatch(
      /\S/,
    );
  });
});

describe("DELETE /api/integrations/slack?action=uninstall", () => {
  it("integrations-slack-008 refuses a member's uninstall and leaves everyone connected", async () => {
    const bdd = createBddApi(context);
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const member = bdd.user({ orgId: org.orgId, orgRole: "org:member" });
    await slack.connectMember({
      orgId: org.orgId,
      userId: member.userId,
      slackWorkspaceId: org.slackWorkspaceId,
    });
    context.mocks.ably.publish.mockClear();

    const refused = await integrations.requestSlackDisconnect(
      member,
      "uninstall",
      [403],
    );

    expect(refused.body).toStrictEqual({
      error: { code: "FORBIDDEN", message: "Admin access required" },
    });
    for (const actor of [org.actor, member]) {
      const status = await integrations.requestSlackIntegrationStatus(
        actor,
        [200],
      );
      expect(status.body).toMatchObject({
        isInstalled: true,
        isConnected: true,
      });
    }
    expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
    expect(channelsPublishedTo(context.mocks, "slack:changed")).toStrictEqual(
      [],
    );
  });

  it("integrations-slack-009 uninstalls with App Home notices while members keep their connections", async () => {
    const bdd = createBddApi(context);
    const slack = createPublicSlackOrgApi(context);
    const integrations = createBddIntegrationApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const member = bdd.user({ orgId: org.orgId, orgRole: "org:member" });
    const { slackUserId: memberSlackUserId } = await slack.connectMember({
      orgId: org.orgId,
      userId: member.userId,
      slackWorkspaceId: org.slackWorkspaceId,
    });
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();

    const uninstalled = await integrations.requestSlackDisconnect(
      org.actor,
      "uninstall",
      [200],
    );

    expect(uninstalled.body).toStrictEqual({ ok: true });
    const homes = context.mocks.slack.views.publish.mock.calls.map((call) => {
      return call[0] as { user_id: string; view: unknown };
    });
    expect(
      homes
        .map((home) => {
          return home.user_id;
        })
        .sort(),
    ).toStrictEqual([org.slackUserId, memberSlackUserId].sort());
    for (const home of homes) {
      expect(JSON.stringify(home.view)).toContain(
        JSON.stringify({ type: "plain_text", text: "Open Okou Settings" }),
      );
      expect(JSON.stringify(home.view)).toContain(
        '"url":"https://app.okou.test/settings/slack"',
      );
    }
    for (const actor of [org.actor, member]) {
      const status = await integrations.requestSlackIntegrationStatus(
        actor,
        [200],
      );
      expect(status.body).toMatchObject({
        isInstalled: false,
        isConnected: true,
      });
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${actor.userId}`,
          topic: "slack:changed",
        }),
      ).toBeGreaterThan(0);
    }

    await integrations.requestSlackDisconnect(org.actor, undefined, [200]);
    const adminAfter = await integrations.requestSlackIntegrationStatus(
      org.actor,
      [200],
    );
    const memberAfter = await integrations.requestSlackIntegrationStatus(
      member,
      [200],
    );
    expect(adminAfter.body).toMatchObject({ isConnected: false });
    expect(memberAfter.body).toMatchObject({ isConnected: true });

    const homesBeforeRepeat =
      context.mocks.slack.views.publish.mock.calls.length;
    const notificationsBeforeRepeat = channelsPublishedTo(
      context.mocks,
      "slack:changed",
    ).length;
    const repeatedUninstall = await integrations.requestSlackDisconnect(
      org.actor,
      "uninstall",
      [404],
    );
    const repeatedDisconnect = await integrations.requestSlackDisconnect(
      org.actor,
      undefined,
      [404],
    );

    expect(
      "error" in repeatedUninstall.body && repeatedUninstall.body.error.message,
    ).toBe("No Slack installation found");
    expect(
      "error" in repeatedDisconnect.body &&
        repeatedDisconnect.body.error.message,
    ).toBe("No Slack connection found");
    expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(
      homesBeforeRepeat,
    );
    expect(channelsPublishedTo(context.mocks, "slack:changed")).toHaveLength(
      notificationsBeforeRepeat,
    );
  });
});

describe("GET /api/integrations/slack/download-file", () => {
  it("integrations-slack-012 resolves each request's own organization installation", async () => {
    const bdd = createBddApi(context);
    const slack = createPublicSlackOrgApi(context);
    const first = await slack.installOrg({ withConnection: true });
    const secondAdmin = bdd.user({ orgRole: "org:admin" });
    mockSharedSlackConversations();
    const provider = serveSlackFiles(
      [0, 1, 2].map((n) => {
        return { ...PNG_FILE, id: `F_GRAPH_${n}`, channels: ["C_GRAPH_0"] };
      }),
    );

    const firstDownload = await downloadAs(first.actor, "F_GRAPH_0");
    const secondDownload = await downloadAs(secondAdmin, "F_GRAPH_1");
    const againDownload = await downloadAs(first.actor, "F_GRAPH_2");

    expect(firstDownload.status).toBe(200);
    expect(firstDownload.headers.get("x-file-name")).toBe("pic.png");
    expect(againDownload.status).toBe(200);
    expect(againDownload.headers.get("x-file-name")).toBe("pic.png");
    expect(secondDownload.status).toBe(404);
    expect(secondDownload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const bearer = `Bearer ${first.botToken}`;
    expect(provider.infoRequests).toStrictEqual([
      { fileId: "F_GRAPH_0", token: bearer },
      { fileId: "F_GRAPH_2", token: bearer },
    ]);
    expect(provider.fetches).toStrictEqual([
      { path: "/files-pri/F_GRAPH_0/pic.png", token: first.botToken },
      { path: "/files-pri/F_GRAPH_2/pic.png", token: first.botToken },
    ]);
  });

  it("integrations-slack-014 does not download a file only shared in another user's private group", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    mockSharedSlackConversations();
    const provider = serveSlackFiles([
      { ...PNG_FILE, channels: [], groups: ["G_OTHER_USER"] },
    ]);

    const response = await downloadAs(org.actor, "F-OK");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(provider.fetches).toStrictEqual([]);
  });

  it("integrations-slack-017 rejects a file larger than 100MB", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    mockSharedSlackConversations();
    serveSlackFiles([{ ...PNG_FILE, id: "F-BIG", size: 200 * 1024 * 1024 }]);

    const response = await downloadAs(org.actor, "F-BIG");

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("integrations-slack-021 streams Slack file bytes with file metadata headers", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    mockSharedSlackConversations();
    serveSlackFiles([PNG_FILE]);

    const response = await downloadAs(org.actor, "F-OK");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("pic.png");
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode("real file contents").byteLength),
    );
    const body = response.body;
    if (!(body instanceof Blob)) {
      throw new Error("Expected the downloaded file bytes");
    }
    await expect(body.text()).resolves.toBe("real file contents");
  });

  it("integrations-slack-022 accepts a Clerk session with an active organization", async () => {
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    mockSharedSlackConversations();
    serveSlackFiles([PNG_FILE]);

    const response = await downloadAs(asRole(org.actor, "org:member"), "F-OK");

    expect(response.status).toBe(200);
  });
});
