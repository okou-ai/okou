import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";
import { createHash, randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, type Mock } from "vitest";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import {
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadMaterializeContract,
} from "@okouai/api-contracts/contracts/integrations";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRouteMocks } from "./helpers/route-test";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGoogleDriveConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { integrationsSlackUploadCompleteRoutes } from "../integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "../integrations-slack-upload-materialize";
import { chatThreadsArtifactsSyncRoutes } from "../chat-threads-artifacts-sync";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

type CompletedChatEvent = Extract<ChatEvent, { eventType: "run.completed" }>;

interface DriveFolderFixture {
  readonly id: string;
  readonly name: string;
  readonly parentFolderId: string | null;
}

const context = testContext();

const store = createStore();
const mocks = createRouteMocks(context);
const chatCallbacks = createChatCallbacksApi(context);
const chatApi = createChatFilesBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const slackOrgs = createPublicSlackOrgApi(context);

function authorizationState(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function completeRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly events: readonly Record<string, unknown>[];
  readonly lastEventSequence?: number;
}): Promise<void> {
  chatCallbacks.mockChatOutputEvents(args.events);
  const authorization = `Bearer ${args.sandboxToken}`;
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId: args.runId, events: stagedOutputEvents },
      { authorization },
      [200],
    );
  }

  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `canonical-slack-${args.runId}`,
        cliAgentSessionHistoryDisposition: "native_only",
      },
      ...(args.lastEventSequence === undefined
        ? stagedOutputEvents.length === 0
          ? {}
          : {
              lastEventSequence: Math.max(
                ...stagedOutputEvents.map((event) => {
                  return event.sequenceNumber;
                }),
              ),
            }
        : { lastEventSequence: args.lastEventSequence }),
    },
    { authorization },
    [200],
  );
  await flushWaitUntilForTest();
}

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly runId: string;
  readonly threadId: string;
}

describe("POST /api/integrations/slack/upload-file/deliver and complete", () => {
  function actorFor(args: { readonly orgId: string; readonly userId: string }) {
    return {
      orgId: args.orgId,
      userId: args.userId,
      orgRole: "org:admin",
      email: `${args.userId}@example.test`,
    } satisfies ApiTestUser;
  }

  beforeEach(() => {
    mockSharedSlackConversations();
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      channel: "D_CONNECTED",
      ts: "1.0",
    });
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  function mockSlackFileInfo(fileId: string): void {
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: fileId,
        name: "report.csv",
        title: "Slack Report",
        mimetype: "text/csv",
        filetype: "csv",
        size: 42,
        channels: ["C123"],
        permalink: `https://slack.example/files/${fileId}`,
      },
    });
  }

  function createUploadFixture() {
    const receivedExecutions = new Map<
      string,
      {
        actor: ApiTestUser;
        receivedExecution: Awaited<ReturnType<typeof runsApi.executionInput>>;
      }
    >();
    const scenario = createPublicComputerUseScenario(context, {
      optionalEnvironmentNames: [
        "SLACK_OAUTH_CLIENT_ID",
        "SLACK_OAUTH_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_BOT_TOKEN",
      ],
      retainProviderState() {
        function retain<T extends (...args: never[]) => unknown>(
          method: Mock<T>,
        ) {
          const implementation = method.getMockImplementation();
          return () => {
            method.mockReset();
            if (implementation) {
              method.mockImplementation(implementation);
            }
          };
        }
        const restores = [
          retain(context.mocks.slack.files.info),
          retain(context.mocks.slack.files.getUploadURLExternal),
          retain(context.mocks.slack.files.completeUploadExternal),
          retain(context.mocks.slack.conversations.open),
          retain(context.mocks.slack.chat.postMessage),
          retain(context.mocks.slack.oauth.v2.access),
          retain(context.mocks.slack.users.info),
        ];
        return () => {
          for (const restore of restores) {
            restore();
          }
        };
      },
    });
    async function seedBaseContext() {
      const actor = scenario.user({ orgRole: "org:admin" });
      if (!actor.orgId) {
        throw new Error("Expected a Slack organization");
      }
      const orgId = actor.orgId;
      await scenario.run(() => {
        return store.set(
          seedOrgMembership$,
          { orgId, userId: actor.userId, role: "admin" },
          context.signal,
        );
      });
      return { ...actor, orgId: actor.orgId };
    }
    async function restoreMembership(base: {
      readonly orgId: string;
      readonly userId: string;
    }) {
      await scenario.run(() => {
        return store.set(
          seedOrgMembership$,
          { ...base, role: "admin" },
          context.signal,
        );
      });
    }
    const connections = new Map<string, { readonly slackUserId: string }>();
    async function connectMember(base: {
      readonly orgId: string;
      readonly userId: string;
      readonly slackWorkspaceId: string;
    }) {
      const key = `${base.orgId}:${base.slackWorkspaceId}:${base.userId}`;
      const existing = connections.get(key);
      if (existing) {
        return existing;
      }
      context.mocks.slack.users.info.mockImplementation(
        (...args: unknown[]) => {
          const request = args[0];
          if (
            typeof request !== "object" ||
            request === null ||
            !("user" in request)
          ) {
            throw new Error("Expected a Slack member lookup");
          }
          return Promise.resolve({
            ok: true,
            user: { id: request.user, team_id: base.slackWorkspaceId },
          });
        },
      );
      const connection = await scenario.run(() => {
        return slackOrgs.connectMember({ ...base, run: scenario.run });
      });
      connections.set(key, connection);
      context.mocks.slack.users.info.mockResolvedValue({
        ok: true,
        user: {
          id: connection.slackUserId,
          team_id: base.slackWorkspaceId,
          deleted: false,
          is_bot: false,
        },
      });
      await restoreMembership(base);
      mockSharedSlackConversations(undefined, connection.slackUserId);
      return connection;
    }
    async function seedWithInstallation() {
      const base = await seedBaseContext();
      const installed = await scenario.run(() => {
        return slackOrgs.installForOrg({
          orgId: base.orgId,
          installer: actorFor(base),
          run: scenario.run,
        });
      });
      const connection = { slackUserId: installed.installerSlackUserId };
      connections.set(
        `${base.orgId}:${installed.slackWorkspaceId}:${base.userId}`,
        connection,
      );
      context.mocks.slack.users.info.mockResolvedValue({
        ok: true,
        user: {
          id: connection.slackUserId,
          team_id: installed.slackWorkspaceId,
          deleted: false,
          is_bot: false,
        },
      });
      await restoreMembership(base);
      mockSharedSlackConversations(undefined, connection.slackUserId);
      return { ...base, slackWorkspaceId: installed.slackWorkspaceId };
    }
    async function rememberExecution(actor: ApiTestUser, runId: string) {
      const receivedExecution = await scenario.executionInput(actor, runId);
      receivedExecutions.set(runId, { actor, receivedExecution });
      return receivedExecution;
    }
    async function seedRunScoped(install = true): Promise<RunScopedContext> {
      const base = install
        ? await seedWithInstallation()
        : { ...(await seedBaseContext()), slackWorkspaceId: "" };
      const actor = actorFor(base);
      await scenario.prepareActor(actor);
      const sent = await scenario.run(() => {
        return chatApi.sendAndLaunch(actor, {
          prompt: "Create a run for Slack upload completion",
          model: "claude-fable-5-1",
        });
      });
      await rememberExecution(actor, sent.runId);
      return {
        ...base,
        runId: sent.runId,
        threadId: sent.threadId,
      };
    }
    function okouToken(args: {
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string;
    }) {
      const issued = receivedExecutions.get(args.runId);
      if (
        !issued ||
        issued.actor.userId !== args.userId ||
        issued.actor.orgId !== args.orgId
      ) {
        throw new Error("Expected this owner's actual Runner execution");
      }
      const token = issued.receivedExecution.platformEnvironment.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected the actual Okou credential");
      }
      return token;
    }
    function sandboxToken(runId: string) {
      const issued = receivedExecutions.get(runId);
      if (!issued) {
        throw new Error("Expected the actual sandbox credential");
      }
      return issued.receivedExecution.sandboxToken;
    }
    function readRunExecution(runId: string) {
      const issued = receivedExecutions.get(runId);
      if (!issued) {
        throw new Error("Expected the already returned Runner execution");
      }
      return Promise.resolve(issued.receivedExecution);
    }
    return {
      ...scenario,
      seedRunScoped,
      seedWithInstallation,
      seedBaseContext,
      connectMember,
      restoreMembership,
      okouToken,
      sandboxToken,
      readRunExecution,
      rememberExecution,
    };
  }

  async function pendingCanonicalUpload(
    fixture: ReturnType<typeof createUploadFixture>,
    storedBytes = Buffer.alloc(42, "a"),
    target: {
      readonly channel?: string;
      readonly user?: string;
      readonly threadTs?: string;
      readonly title?: string;
      readonly initialComment?: string;
    } = { channel: "C123" },
  ) {
    const actor = await fixture.run(() => {
      return fixture.seedRunScoped();
    });
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const token = fixture.okouToken(actor);
    const headers = { authorization: `Bearer ${token}` };
    const initialized = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadInitRoutes })(
          integrationsSlackUploadInitContract,
        ).init({
          body: {
            filename: "report.csv",
            length: 42,
            canonical: {
              contentType: "text/csv",
              checksumSha256: createHash("sha256")
                .update(Buffer.alloc(42, "a"))
                .digest("hex"),
              ...target,
            },
          },
          headers,
        }),
        [200],
      );
    });
    if (!("kind" in initialized.body)) {
      throw new Error("Expected a canonical Slack upload");
    }
    const assetId = initialized.body.assetId;
    objectStore.addObject({
      bucket: "test-private-artifacts",
      key: `private-artifacts/${assetId}/report.csv`,
      size: 42,
      body: storedBytes,
      metadata: { "artifact-id": assetId },
    });
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      file_id: "F-MATERIALIZED",
      upload_url: "https://files.slack.com/upload/v1/materialized",
    });
    return {
      actor,
      objectStore,
      request: { headers, body: { assetId, ...target } },
      url: initialized.body.url,
    };
  }

  function sharedServerFileInfo(size = 42, channels = ["C123"]) {
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: "F-MATERIALIZED",
        size,
        channels,
        permalink: "https://slack.example/files/F-MATERIALIZED",
      },
    });
  }

  it("delivers canonical bytes fire-and-forget and publishes to artifact catalog", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const received: string[] = [];
    server.use(
      http.post(
        "https://files.slack.com/upload/v1/materialized",
        async ({ request }) => {
          received.push(await request.text());
          return new HttpResponse("OK");
        },
      ),
    );
    sharedServerFileInfo(42);
    const client = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const result = await fixture.run(() => {
      return accept(client.deliver(upload.request), [200]);
    });
    expect(result.body).toMatchObject({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "delivered",
        fileId: "F-MATERIALIZED",
        permalink: "https://slack.example/files/F-MATERIALIZED",
      },
    });
    expect(received).toStrictEqual(["a".repeat(42)]);
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenCalledTimes(1);
    const catalog = await fixture.run(() => {
      return chatApi.listArtifactCatalog(actorFor(upload.actor));
    });
    expect(catalog.artifacts).toHaveLength(1);
  });

  it("reports rejected Slack byte upload without finalizing the empty reservation", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    server.use(
      http.post("https://files.slack.com/upload/v1/materialized", () => {
        return new HttpResponse("result", { status: 403 });
      }),
    );
    const client = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const failed = await fixture.run(() => {
      return accept(client.deliver(upload.request), [200]);
    });
    expect(failed.body.delivery).toMatchObject({
      status: "failed",
      message: "Slack file byte upload failed (HTTP 403)",
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unshared", size: 42, channels: [] },
    { name: "empty", size: 0, channels: ["C123"] },
    { name: "unprocessed", size: undefined, channels: ["C123"] },
  ])(
    "reports failed delivery when Slack file info receipt is $name",
    async ({ size, channels }) => {
      const fixture = createUploadFixture();
      const upload = await pendingCanonicalUpload(fixture);
      server.use(
        http.post("https://files.slack.com/upload/v1/materialized", () => {
          return new HttpResponse("OK");
        }),
      );
      context.mocks.slack.files.info.mockResolvedValue({
        ok: true,
        file: {
          id: "F-MATERIALIZED",
          size,
          channels,
          permalink: "https://slack.example/files/F-MATERIALIZED",
        },
      });
      const client = setupApp({
        context,
        routes: integrationsSlackUploadMaterializeRoutes,
      })(integrationsSlackUploadMaterializeContract);
      const failed = await fixture.run(() => {
        return accept(client.deliver(upload.request), [200]);
      });
      expect(failed.body.delivery.status).toBe("failed");
    },
  );

  it("rejects corrupted canonical bytes before contacting Slack's upload host", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture, Buffer.alloc(42, "b"));
    const result = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).deliver(upload.request),
        [400],
      );
    });
    expect(result.body.error.code).toBe("INVALID_FILE");
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it("rejects an unexpected provider upload host without forwarding bytes", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      file_id: "F-UNTRUSTED",
      upload_url: "https://untrusted.example/upload/v1/file",
    });
    const result = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).deliver(upload.request),
        [200],
      );
    });
    expect(result.body.delivery).toMatchObject({
      status: "failed",
      message: "Slack returned an unsupported file upload destination",
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it.each(["missing", "undefined length", "mismatched length"] as const)(
    "keeps a canonical upload unpublished after %s storage verification",
    async (failure) => {
      const fixture = createUploadFixture();
      const upload = await pendingCanonicalUpload(fixture);
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the external object storage mock");
      }
      context.mocks.s3.send.mockImplementation((command, ...args) => {
        if (command instanceof HeadObjectCommand) {
          if (failure === "missing") {
            return Promise.reject(
              Object.assign(new Error("Object not found"), {
                name: "NotFound",
                $metadata: { httpStatusCode: 404 },
              }),
            );
          }
          return Promise.resolve({
            ContentLength: failure === "undefined length" ? undefined : 41,
          });
        }
        return send(command, ...args);
      });
      const client = setupApp({
        context,
        routes: integrationsSlackUploadMaterializeRoutes,
      })(integrationsSlackUploadMaterializeContract);
      const failed = await fixture.run(() => {
        return accept(client.deliver(upload.request), [400]);
      });
      expect(failed.body.error.code).toBe("INVALID_FILE");
      const before = await fixture.run(() => {
        return chatApi.listArtifactCatalog(actorFor(upload.actor));
      });
      expect(before.artifacts).toStrictEqual([]);
    },
  );

  it("returns 401 when no auth token is provided", async () => {
    const fixture = createUploadFixture();
    await fixture.run(async () => {
      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId: "F123", channel: "C123" },
            headers: {},
          }),
          [401],
        );
      });
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, sandboxToken } = fixture;
    await fixture.run(async () => {
      const { runId } = await fixture.run(() => {
        return seedRunScoped(false);
      });
      const token = sandboxToken(runId);

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId: "F123", channel: "C123" },
            headers: { authorization: `Bearer ${token}` },
          }),
          [403],
        );
      });
      expect(response.body.error.message).toContain("slack:write");
    });
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId } = await fixture.run(() => {
        return seedRunScoped(false);
      });
      const token = okouToken({ userId, orgId, runId });

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId: "F123", channel: "C123" },
            headers: { authorization: `Bearer ${token}` },
          }),
          [404],
        );
      });
      expect(response.body.error.message).toContain("No Slack installation");
    });
  });

  it("forwards Slack file info errors as 400 SLACK_ERROR", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const fileId = `F-${randomUUID().slice(0, 8)}`;
      const token = okouToken({ userId, orgId, runId });
      context.mocks.slack.files.info.mockRejectedValue(
        Object.assign(new Error("file_not_found"), {
          data: { ok: false, error: "file_not_found" },
        }),
      );

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId, channel: "C123" },
            headers: { authorization: `Bearer ${token}` },
          }),
          [400],
        );
      });

      expect(response.body.error.code).toBe("SLACK_ERROR");
      expect(response.body.error.message).toContain("file_not_found");
    });
  });

  it("completes a direct Slack upload for a run-scoped agent token", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const fileId = `F-${randomUUID().slice(0, 8)}`;
      mockSlackFileInfo(fileId);
      const token = okouToken({ userId, orgId, runId });

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: {
              fileId,
              channel: "C123",
              threadTs: "123.456",
              title: "Quarterly report",
              initialComment: "Uploaded from a run",
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });

      expect(response.body).toMatchObject({
        fileId,
        permalink: `https://slack.example/files/${fileId}`,
      });
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenLastCalledWith({
        files: [{ id: fileId, title: "Quarterly report" }],
        channel_id: "C123",
        thread_ts: "123.456",
        initial_comment: expect.stringMatching(
          /^Uploaded from a run\n\nTriggered by <@[^>]+>$/u,
        ),
      });
    });
  });

  it.each(["me", "U_OTHER_USER"])(
    "opens a DM for direct completion addressed to %s",
    async (target) => {
      const fixture = createUploadFixture();
      const { seedRunScoped, connectMember, okouToken } = fixture;
      await fixture.run(async () => {
        const { orgId, userId, slackWorkspaceId, runId } = await fixture.run(
          () => {
            return seedRunScoped();
          },
        );
        const { slackUserId } = await fixture.run(() => {
          return connectMember({
            orgId,
            userId,
            slackWorkspaceId,
          });
        });
        mockSharedSlackConversations(
          [],
          target === "me" ? slackUserId : target,
        );
        context.mocks.slack.conversations.open.mockResolvedValue({
          ok: true,
          channel: { id: "D-SELF" },
        });
        const fileId = `F-${randomUUID().slice(0, 8)}`;
        mockSlackFileInfo(fileId);
        const token = okouToken({ userId, orgId, runId });

        const client = setupApp({
          context,
          routes: integrationsSlackUploadCompleteRoutes,
        })(integrationsSlackUploadCompleteContract);
        const response = await fixture.run(() => {
          return accept(
            client.complete({
              body: { fileId, user: target, title: "Self report" },
              headers: { authorization: `Bearer ${token}` },
            }),
            [200],
          );
        });

        expect(response.body).toStrictEqual({
          fileId,
          permalink: `https://slack.example/files/${fileId}`,
          channel: "D-SELF",
        });
        expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith(
          {
            users: target === "me" ? slackUserId : target,
          },
        );
        expect(
          context.mocks.slack.files.completeUploadExternal,
        ).toHaveBeenLastCalledWith({
          files: [{ id: fileId, title: "Self report" }],
          channel_id: "D-SELF",
          thread_ts: undefined,
          initial_comment: `Triggered by <@${slackUserId}>`,
        });
      });
    },
  );

  it("publishes one canonical file artifact across Slack delivery, catalog, hosted sites, and Google Drive sync", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken, sandboxToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const actor = actorFor({ orgId, userId });
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      const token = okouToken({ userId, orgId, runId });
      context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/canonical",
        file_id: "F-CANONICAL",
      });
      server.use(
        http.post("https://files.slack.com/upload/v1/canonical", () => {
          return new HttpResponse("OK");
        }),
      );
      mockSlackFileInfo("F-CANONICAL");

      const initClient = setupApp({
        context,
        routes: integrationsSlackUploadInitRoutes,
      })(integrationsSlackUploadInitContract);
      const initialized = await fixture.run(() => {
        return accept(
          initClient.init({
            body: {
              filename: "report.csv",
              length: 42,
              canonical: {
                contentType: "text/csv",
                checksumSha256: createHash("sha256")
                  .update(Buffer.alloc(42, "a"))
                  .digest("hex"),
                channel: "C123",
                threadTs: "123.456",
                title: "Canonical report",
              },
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      if (!("kind" in initialized.body)) {
        throw new Error("Expected canonical Slack upload initialization");
      }
      const canonicalAssetId = initialized.body.assetId;
      const storageKey = `private-artifacts/${canonicalAssetId}/report.csv`;
      objectStore.addObject({
        bucket: "test-private-artifacts",
        key: storageKey,
        size: 42,
        body: Buffer.alloc(42, "a"),
        metadata: { "artifact-id": canonicalAssetId },
      });

      const deliverClient = setupApp({
        context,
        routes: integrationsSlackUploadMaterializeRoutes,
      })(integrationsSlackUploadMaterializeContract);
      const delivered = await fixture.run(() => {
        return accept(
          deliverClient.deliver({
            body: {
              assetId: canonicalAssetId,
              channel: "C123",
              threadTs: "123.456",
              title: "Canonical report",
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(delivered.body).toMatchObject({
        assetId: canonicalAssetId,
        delivery: {
          status: "delivered",
          fileId: "F-CANONICAL",
          permalink: "https://slack.example/files/F-CANONICAL",
        },
      });

      const catalog = await fixture.run(() => {
        return chatApi.listArtifactCatalog(actor);
      });
      const catalogEntry = catalog.artifacts.find((artifact) => {
        return artifact.title === "report.csv";
      });
      if (!catalogEntry) {
        throw new Error(
          "Expected the canonical output in the artifact catalog",
        );
      }
      const catalogDetail = await fixture.run(() => {
        return chatApi.getArtifactCatalogEntry(actor, catalogEntry.id);
      });
      if (catalogDetail.kind !== "file") {
        throw new Error("Expected canonical output to use the file kind");
      }
      expect(catalogDetail.file.id).toBe(canonicalAssetId);

      // Publish a hosted site alongside the file and confirm both catalog entries remain intact.
      const hostBearer = `Bearer ${token}`;
      const siteName = `drive-companion-${randomUUID().slice(0, 8)}`;
      const site = await fixture.run(() => {
        return chatApi.prepareHostedSiteWithBearer(hostBearer, {
          site: siteName,
          title: siteName,
          artifactKind: "hosted-site",
          spaFallback: false,
          files: [
            hostedTextFile("/index.html", "<main>Report companion</main>"),
          ],
        });
      });
      await fixture.run(() => {
        return chatApi.completeHostedSiteWithBearer(
          hostBearer,
          site.deploymentId,
        );
      });

      // Google Drive sync by canonical artifactId works across threads and after source thread deletion.
      mockGoogleDriveConnectorOAuth();
      const oauth = await fixture.run(() => {
        return connectorsApi.startOauth(actor, "google-drive", "oauth");
      });
      await fixture.run(() => {
        return connectorsApi.completeOauthCallback("google-drive", {
          code: "canonical-asset-drive",
          state: authorizationState(oauth.authorizationUrl),
        });
      });
      const accounts = await fixture.run(() => {
        return connectorsApi.listBuiltinConnectorAccounts(
          actor,
          "google-drive",
        );
      });
      const selectedAccount = accounts[0];
      if (!selectedAccount) {
        throw new Error("Expected connected Google Drive account");
      }
      const driveFolders: DriveFolderFixture[] = [];
      const driveUploadBodies: string[] = [];
      const driveContentBodies: string[] = [];
      const driveUploadSessionUrl =
        "https://www.googleapis.com/upload/drive/v3/files/resumable-session";
      server.use(
        http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
          const query = new URL(request.url).searchParams.get("q");
          if (!query) {
            throw new Error("Expected Google Drive folder query");
          }
          const folder = driveFolders.find((candidate) => {
            const parentClause = candidate.parentFolderId
              ? `'${candidate.parentFolderId}' in parents`
              : "'root' in parents";
            return (
              query.includes(`name = '${candidate.name}'`) &&
              query.includes(parentClause)
            );
          });
          return HttpResponse.json({ files: folder ? [folder] : [] });
        }),
        http.post(
          "https://www.googleapis.com/drive/v3/files",
          async ({ request }) => {
            const body = (await fixture.run(() => {
              return request.json();
            })) as {
              readonly name?: string;
              readonly parents?: readonly string[];
            };
            const folder = {
              id: `drive-folder-${String(driveFolders.length + 1)}`,
              name: body.name ?? "Folder",
              parentFolderId: body.parents?.[0] ?? null,
            };
            driveFolders.push(folder);
            return HttpResponse.json(folder);
          },
        ),
        http.post(
          "https://www.googleapis.com/upload/drive/v3/files",
          async ({ request }) => {
            driveUploadBodies.push(
              await fixture.run(() => {
                return request.text();
              }),
            );
            return new HttpResponse(null, {
              status: 200,
              headers: { Location: driveUploadSessionUrl },
            });
          },
        ),
        http.put(driveUploadSessionUrl, async ({ request }) => {
          driveContentBodies.push(
            await fixture.run(() => {
              return request.text();
            }),
          );
          return HttpResponse.json({
            id: "drive-canonical-asset",
            name: "report.csv",
            webViewLink:
              "https://drive.google.com/file/d/drive-canonical-asset/view",
          });
        }),
      );

      const uploadClient = setupApp({
        context,
        routes: chatThreadsArtifactsSyncRoutes,
      })(artifactGoogleDriveContract);
      mocks.clerk.session(userId, orgId);
      const uploaded = await fixture.run(() => {
        return accept(
          uploadClient.uploadFromChat({
            headers: { authorization: "Bearer clerk-session" },
            params: { artifactId: catalogEntry.id },
            body: {
              chatThreadId: threadId,
              connectionId: selectedAccount.id,
              mode: "original",
            },
          }),
          [200],
        );
      });
      expect(uploaded.body.name).toBe("report.csv");
      expect(driveUploadBodies.at(-1)).toContain(
        `"okouArtifactId":"${catalogEntry.id}"`,
      );
      expect(driveContentBodies.at(-1)).toBe("a".repeat(42));

      // Sandbox token without capability is rejected.
      await fixture.run(() => {
        return accept(
          uploadClient.uploadFromChat({
            headers: { authorization: `Bearer ${sandboxToken(runId)}` },
            params: { artifactId: catalogEntry.id },
            body: {
              chatThreadId: threadId,
              connectionId: selectedAccount.id,
              mode: "original",
            },
          }),
          [403],
        );
      });

      // Artifact access remains available after source thread deletion; foreign user/org denied.
      const destination = await fixture.run(() => {
        return chatApi.sendAndLaunch(actor, {
          prompt: "Destination thread for detached Drive sync",
          model: "claude-fable-5-1",
        });
      });
      await fixture.run(() => {
        return chatApi.deleteThread(actor, threadId);
      });
      mocks.clerk.session(userId, orgId);
      const detached = await fixture.run(() => {
        return accept(
          uploadClient.uploadFromChat({
            headers: { authorization: "Bearer clerk-session" },
            params: { artifactId: catalogEntry.id },
            body: {
              chatThreadId: destination.threadId,
              connectionId: selectedAccount.id,
              mode: "original",
            },
          }),
          [200],
        );
      });
      expect(detached.body.name).toBe("report.csv");
      mocks.clerk.session("user_foreign_artifact_owner", orgId);
      await fixture.run(() => {
        return accept(
          uploadClient.uploadFromChat({
            headers: { authorization: "Bearer clerk-session" },
            params: { artifactId: catalogEntry.id },
            body: {
              chatThreadId: destination.threadId,
              connectionId: selectedAccount.id,
              mode: "original",
            },
          }),
          [404],
        );
      });
    });
  }, 20_000);

  it("keeps an attachment-only output out of the event stream", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken, readRunExecution } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
        return seedRunScoped();
      });
      chatCallbacks.acceptChatObjectStorage();
      const token = okouToken({ userId, orgId, runId });
      const initClient = setupApp({
        context,
        routes: integrationsSlackUploadInitRoutes,
      })(integrationsSlackUploadInitContract);
      const initialized = await fixture.run(() => {
        return accept(
          initClient.init({
            body: {
              filename: "attachment-only.pdf",
              length: 128,
              canonical: {
                contentType: "application/pdf",
                checksumSha256: "b".repeat(64),
                channel: "C123",
              },
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      if (!("kind" in initialized.body)) {
        throw new Error("Expected canonical Slack upload initialization");
      }
      const receivedExecution = await fixture.run(() => {
        return readRunExecution(runId);
      });
      await fixture.run(() => {
        return completeRun({
          runId,
          sandboxToken: receivedExecution.sandboxToken,
          events: [],
        });
      });

      const messages = await fixture.run(() => {
        return chatApi.listThreadEvents(actorFor({ orgId, userId }), threadId);
      });
      const lifecycleMarker = messages.events.find(
        (message): message is CompletedChatEvent => {
          return (
            message.eventType === "run.completed" &&
            message.runId === runId &&
            message.runLifecycleEvent === "completed"
          );
        },
      );
      expect(lifecycleMarker?.content).toBeNull();
      expect(
        messages.events.find((message) => {
          return (
            message.eventType === "output.message" && message.runId === runId
          );
        }),
      ).toBeUndefined();
    });
  }, 20_000);

  it("keeps a canonical Slack delivery failed when file info has no permalink", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    server.use(
      http.post("https://files.slack.com/upload/v1/materialized", () => {
        return new HttpResponse("OK");
      }),
    );
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: "F-MATERIALIZED",
        name: "report.csv",
        title: "Slack Report",
        mimetype: "text/csv",
        filetype: "csv",
        size: 42,
        channels: ["C123"],
      },
    });
    const delivered = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).deliver(upload.request),
        [200],
      );
    });
    expect(delivered.body).toMatchObject({
      assetId: upload.request.body.assetId,
      delivery: {
        status: "failed",
        message: "Slack file info did not include a permalink",
      },
    });
  });
});
