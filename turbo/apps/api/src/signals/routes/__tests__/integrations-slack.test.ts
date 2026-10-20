import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { SlackFileFetchError } from "../../external/slack-file-fetcher";
import { integrationsSlackRoutes } from "../integrations-slack";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { settleIncludingAbort } from "../../utils";

// Connecting a Slack user resolves the built-in Slack connector OAuth method.
const context = testContext();
const claimedToken = createClaimedRunCredentials(context).okouToken;
const store = createStore();

const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);
const slackOrgs = createPublicSlackOrgApi(context);

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
  // The connect notification refreshes App Home in owned background work.
  await flushWaitUntilForTest();
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

function createDeleteFixture() {
  const installations: string[] = [];
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = createFixtureOperationOwner(
    async () => {
      const errors: unknown[] = [];
      async function cleanup(operation: () => Promise<unknown>) {
        const result = await settleIncludingAbort(operation);
        if (!result.ok) {
          errors.push(result.error);
        }
      }
      await cleanup(flushWaitUntilForTest);
      for (const teamId of installations) {
        await cleanup(() => {
          return slackOrgs.uninstallWorkspace(teamId);
        });
      }
      await cleanup(flushWaitUntilForTest);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Slack DELETE fixture cleanup failed");
      }
    },
    {
      continueAcceptedOperations: true,
      beforeDrain: () => {
        previous ??= captureConnectorExternalState(context);
        accepted();
      },
    },
  );
  function user(options: Parameters<typeof bdd.user>[0] = {}) {
    return bdd.user(options);
  }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(async () => {
      const result = await settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(context);
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
  }
  return {
    run,
    user,
    install() {
      return run(async () => {
        integrations.configureSlackAppMocks();
        context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
        const actor = user({ orgRole: "org:admin" });
        await bdd.bootstrapLimitedFreeOnboarding(actor, {
          displayName: "Slack Bot",
        });
        const installation = await integrations.installSlackWorkspace(actor);
        installations.push(installation.teamId);
        await flushWaitUntilForTest();
        return { actor, ...installation };
      });
    },
    connect(install: PublicSlackInstall) {
      return run(async () => {
        const member = user({
          orgId: install.actor.orgId,
          orgRole: "org:member",
        });
        await bdd.readMe(member);
        const slackUserId = uniqueSlackUserId();
        await integrations.connectSlackUser(member, {
          workspaceId: install.teamId,
          slackUserId,
          channelId: "C_BDD_SECOND_MEMBER",
        });
        await flushWaitUntilForTest();
        return { member, slackUserId };
      });
    },
  };
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
    const fixture = createDeleteFixture();
    await fixture.run(async () => {
      const install = await fixture.install();
      const unconnected = fixture.user({
        orgId: install.actor.orgId,
        orgRole: "org:member",
      });
      await bdd.readMe(unconnected);
      await flushWaitUntilForTest();
      context.mocks.slack.views.publish.mockClear();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      mocks.clerk.session(unconnected.userId, unconnected.orgId, "org:member");

      const response = await accept(
        slackClient().disconnect({
          headers: { authorization: "Bearer clerk-session" },
          query: {},
        }),
        [404],
      );

      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body.error.message).toBe("No Slack connection found");
      await expect(
        readSlackStatus(install.actor, "org:admin"),
      ).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
      });
      await flushWaitUntilForTest();
      expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    });
  });

  it("deletes only the current user's connection and refreshes App Home", async () => {
    const fixture = createDeleteFixture();
    await fixture.run(async () => {
      const install = await fixture.install();
      const other = await fixture.connect(install);
      context.mocks.slack.views.publish.mockClear();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
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
      ).resolves.toMatchObject({ isConnected: true, isInstalled: true });
      await flushWaitUntilForTest();
      expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(1);
      expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: install.installerSlackUserId,
          view: expect.objectContaining({
            type: "home",
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: "actions",
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    action_id: "home_login_prompt",
                    text: { type: "plain_text", text: "Connect" },
                    url: `${env("APP_URL")}/settings/slack?w=${install.teamId}&u=${install.installerSlackUserId}`,
                  }),
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
      expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `user:${install.actor.userId}`,
      );
      expect(context.mocks.ably.channelGet).not.toHaveBeenCalledWith(
        `user:${other.member.userId}`,
      );
    });
  });
  it.each(["unauthenticated", "without an organization"])(
    "returns 401 for a session that is %s",
    async (session) => {
      const fixture = createDeleteFixture();
      await fixture.run(async () => {
        const actor = fixture.user({ orgId: null });
        if (session === "unauthenticated") {
          context.mocks.clerk.authenticateRequest.mockResolvedValue({
            isAuthenticated: false,
          });
        } else {
          mocks.clerk.session(actor.userId, null);
        }
        const response = await accept(
          slackClient().disconnect({
            headers:
              session === "unauthenticated"
                ? {}
                : { authorization: "Bearer clerk-session" },
            query: {},
          }),
          [401],
        );
        expect(response.body.error.code).toBe("UNAUTHORIZED");
        await flushWaitUntilForTest();
        expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
        expect(context.mocks.ably.publish).not.toHaveBeenCalled();
      });
    },
  );
});

describe("DELETE /api/integrations/slack?action=uninstall", () => {
  const mocks = createRouteMocks(context);

  it("returns 403 when a non-admin tries to uninstall", async () => {
    const fixture = createDeleteFixture();
    await fixture.run(async () => {
      const install = await fixture.install();
      const other = await fixture.connect(install);
      context.mocks.slack.views.publish.mockClear();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      mocks.clerk.session(
        other.member.userId,
        other.member.orgId,
        "org:member",
      );

      const response = await accept(
        slackClient().disconnect({
          headers: { authorization: "Bearer clerk-session" },
          query: { action: "uninstall" },
        }),
        [403],
      );

      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(response.body.error.message).toBe("Admin access required");
      for (const actor of [install.actor, other.member]) {
        await expect(
          readSlackStatus(
            actor,
            actor.orgRole === "org:admin" ? "org:admin" : "org:member",
          ),
        ).resolves.toMatchObject({
          isInstalled: true,
          isConnected: true,
        });
      }
      await flushWaitUntilForTest();
      expect(context.mocks.slack.views.publish).not.toHaveBeenCalled();
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    });
  });

  it("publishes uninstalled App Home then deletes installation and connections", async () => {
    const fixture = createDeleteFixture();
    await fixture.run(async () => {
      const install = await fixture.install();
      const other = await fixture.connect(install);
      const orgId = install.actor.orgId;
      if (!orgId) {
        throw new Error("Expected the Slack installer to belong to an org");
      }
      await bdd.readMe(install.actor);
      context.mocks.slack.views.publish.mockClear();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
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
                    expect.objectContaining({
                      action_id: "home_open_settings",
                      text: {
                        type: "plain_text",
                        text: "Open Okou Settings",
                      },
                      url: `${env("APP_URL")}/settings/slack`,
                    }),
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
      for (const actor of [install.actor, other.member]) {
        expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
          `user:${actor.userId}`,
        );
      }

      await flushWaitUntilForTest();
      const viewCount = context.mocks.slack.views.publish.mock.calls.length;
      const notificationCount = context.mocks.ably.publish.mock.calls.length;
      mocks.clerk.session(install.actor.userId, orgId, "org:admin");
      for (const action of ["uninstall", undefined]) {
        const missing = await accept(
          slackClient().disconnect({
            headers: { authorization: "Bearer clerk-session" },
            query: { action },
          }),
          [404],
        );
        expect(missing.body.error).toMatchObject({
          code: "NOT_FOUND",
          message:
            action === "uninstall"
              ? "No Slack installation found"
              : "No Slack connection found",
        });
      }
      await flushWaitUntilForTest();
      expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(
        viewCount,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledTimes(
        notificationCount,
      );
    });
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
  it.each([
    "users in the same organization",
    "organizations",
    "an uninstalled organization",
  ])(
    "selects each request's installation across %s and restores the first",
    async (boundary) => {
      const scenario = createPublicComputerUseScenario(context);
      const first = scenario.user({ orgRole: "org:admin" });
      const other = scenario.user(
        boundary === "users in the same organization"
          ? { orgId: first.orgId, orgRole: "org:member" }
          : { orgRole: "org:admin" },
      );
      await scenario.run(async () => {
        for (const actor of [first, other]) {
          await scenario.prepareActor(actor);
        }
        const a = await slackOrgs.installOrg({
          actor: first,
          withConnection: true,
        });
        scenario.beforeWorkspaceCleanup(() => {
          return slackOrgs.uninstallWorkspace(a.slackWorkspaceId);
        });
        const b =
          boundary === "organizations"
            ? await slackOrgs.installOrg({
                actor: other,
                withConnection: true,
              })
            : undefined;
        if (b) {
          scenario.beforeWorkspaceCleanup(() => {
            return slackOrgs.uninstallWorkspace(b.slackWorkspaceId);
          });
        }
        await flushWaitUntilForTest();
        const requests = [
          { actor: first, installation: a },
          {
            actor: other,
            installation: boundary === "users in the same organization" ? a : b,
          },
          { actor: first, installation: a },
        ];
        const infoRequests: {
          authorization: string | null;
          file: string | null;
        }[] = [];
        server.use(
          http.get("https://slack.com/api/files.info", ({ request }) => {
            const fileId = new URL(request.url).searchParams.get("file");
            infoRequests.push({
              authorization: request.headers.get("authorization"),
              file: fileId,
            });
            return HttpResponse.json({
              ok: true,
              file: defaultSlackFile({
                id: fileId ?? "",
                name: `${fileId}.txt`,
                mimetype: "text/plain",
                url_private_download: `https://files.slack.com/files-pri/${fileId}/download.txt`,
              }),
            });
          }),
        );
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
          const fileId = `F_GRAPH_${String(index)}`;
          const bytes = `file ${String(index)}`;
          context.mocks.slack.fetchFile.mockResolvedValue(
            new Response(bytes, {
              headers: {
                "Content-Type": "text/plain",
                "Content-Length": String(bytes.length),
              },
            }),
          );
          const infos = infoRequests.length;
          const fetches = context.mocks.slack.fetchFile.mock.calls.length;
          const response = await requestDownloadFile(
            `?file_id=${fileId}`,
            `Bearer ${claim.token}`,
          );
          if (!request.installation) {
            await expectErrorResponse(response, 404, "NOT_FOUND");
            expect(infoRequests.slice(infos)).toStrictEqual([]);
            expect(
              context.mocks.slack.fetchFile.mock.calls.slice(fetches),
            ).toStrictEqual([]);
            continue;
          }
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toBe(bytes);
          expect(response.headers.get("content-type")).toBe("text/plain");
          expect(response.headers.get("content-length")).toBe(
            String(bytes.length),
          );
          expect(response.headers.get("x-file-name")).toBe(`${fileId}.txt`);
          expect(response.headers.get("x-file-mimetype")).toBe("text/plain");
          expect(infoRequests.slice(infos)).toStrictEqual([
            {
              authorization: `Bearer ${request.installation.botToken}`,
              file: fileId,
            },
          ]);
          expect(
            context.mocks.slack.fetchFile.mock.calls.slice(fetches),
          ).toStrictEqual([
            [
              `https://files.slack.com/files-pri/${fileId}/download.txt`,
              request.installation.botToken,
            ],
          ]);
        }
      });
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
    if (args.withInstallation !== false) {
      await slackOrgs.installForOrg({ orgId });
    }
    // The OAuth install authenticates its installing admin; the Okou token
    // authenticates this member.
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    return {
      token: await claimedToken({ userId, orgId }),
    };
  }

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
    await slackOrgs.installForOrg({ orgId });
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
