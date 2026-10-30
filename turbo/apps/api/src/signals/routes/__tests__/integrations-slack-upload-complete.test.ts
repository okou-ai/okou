import { mockSharedSlackConversations } from "./helpers/slack-conversation-access";
import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  type Mock,
} from "vitest";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import {
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadMaterializeContract,
} from "@okouai/api-contracts/contracts/integrations";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

type CompletedChatEvent = Extract<ChatEvent, { eventType: "run.completed" }>;

function requiredDriveArtifactId(
  files: readonly { readonly id: string; readonly artifactId?: string }[],
  fileId: string,
): string {
  const artifactId = files.find((file) => {
    return file.id === fileId;
  })?.artifactId;
  if (!artifactId) {
    throw new Error("Expected a stored resource identity for the grouped file");
  }
  return artifactId;
}

interface DriveFolderFixture {
  readonly id: string;
  readonly name: string;
  readonly parentFolderId: string | null;
}

const context = testContext();

const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
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

function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
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
  readonly runnerGroup: string;
  readonly agentId: string;
}

describe("POST /api/integrations/slack/upload-file/complete", () => {
  function actorFor(args: { readonly orgId: string; readonly userId: string }) {
    return {
      orgId: args.orgId,
      userId: args.userId,
      orgRole: "org:admin",
      email: `${args.userId}@example.test`,
    } satisfies ApiTestUser;
  }

  async function visibleUploadedFiles(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
  }) {
    const artifacts = await chatApi.listThreadArtifacts(
      actorFor(args),
      args.threadId,
    );
    return (
      artifacts.runs.find((run) => {
        return run.runId === args.runId;
      })?.files ?? []
    );
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
        permalink: `https://slack.example/files/${fileId}`,
      },
    });
  }

  function createUploadFixture() {
    const claimed = new Map<
      string,
      {
        actor: ApiTestUser;
        claim: Awaited<ReturnType<typeof runsApi.claimRunnerJob>>;
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
    async function rememberClaim(actor: ApiTestUser, runId: string) {
      const claim = await scenario.claimExisting(actor, runId);
      claimed.set(runId, { actor, claim });
      return claim;
    }
    async function seedRunScoped(install = true): Promise<RunScopedContext> {
      const base = install
        ? await seedWithInstallation()
        : { ...(await seedBaseContext()), slackWorkspaceId: "" };
      const actor = actorFor(base);
      const { agentId, runnerGroup } = await scenario.prepareActor(actor);
      await scenario.run(() => {
        return runsApi.heartbeatRunner(runnerGroup);
      });
      const sent = await scenario.run(() => {
        return chatApi.sendAndLaunch(actor, {
          agentId,
          prompt: "Create a run for Slack upload completion",
          model: "claude-fable-5-1",
        });
      });
      await rememberClaim(actor, sent.runId);
      return {
        ...base,
        agentId,
        runnerGroup,
        runId: sent.runId,
        threadId: sent.threadId,
      };
    }
    function okouToken(args: {
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string;
    }) {
      const issued = claimed.get(args.runId);
      if (
        !issued ||
        issued.actor.userId !== args.userId ||
        issued.actor.orgId !== args.orgId
      ) {
        throw new Error("Expected this owner's actual Runner claim");
      }
      const token = issued.claim.platformEnvironment.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected the actual Okou credential");
      }
      return token;
    }
    function sandboxToken(runId: string) {
      const issued = claimed.get(runId);
      if (!issued) {
        throw new Error("Expected the actual sandbox credential");
      }
      return issued.claim.sandboxToken;
    }
    function claimRun(_runnerGroup: string, runId: string) {
      const issued = claimed.get(runId);
      if (!issued) {
        throw new Error("Expected the already returned Runner claim");
      }
      return Promise.resolve(issued.claim);
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
      claimRun,
      rememberClaim,
    };
  }

  async function pendingCanonicalUpload(
    fixture: ReturnType<typeof createUploadFixture>,
  ) {
    const actor = await fixture.run(() => {
      return fixture.seedRunScoped();
    });
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const operationId = randomUUID();
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
              operationId,
              contentType: "text/csv",
              checksumSha256: "a".repeat(64),
              channel: "C123",
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
      body: Buffer.alloc(42, "a"),
      metadata: { "artifact-id": assetId },
    });
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      file_id: "F-MATERIALIZED",
      upload_url: "https://files.slack.com/upload/v1/materialized",
    });
    return {
      actor,
      request: { headers, body: { assetId, operationId } },
      url: initialized.body.url,
    };
  }

  it("returns an in-progress canonical Slack receipt for a mismatched file ID", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const materializeClient = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const materialized = await fixture.run(() => {
      return accept(materializeClient.materialize(upload.request), [200]);
    });
    expect(materialized.body).toStrictEqual({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "pending",
        fileId: "F-MATERIALIZED",
        uploadUrl: "https://files.slack.com/upload/v1/materialized",
      },
    });
    const delivery = materialized.body.delivery;
    if (delivery.status !== "pending") {
      throw new Error("Expected the reserved pending Slack delivery");
    }
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();

    const completeClient = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const request = {
      headers: upload.request.headers,
      body: {
        fileId: delivery.fileId,
        channel: "C_IGNORED_COMPLETION_TARGET",
        canonicalAssetId: upload.request.body.assetId,
        operationId: upload.request.body.operationId,
      },
    };
    const mismatched = await fixture.run(() => {
      return accept(
        completeClient.complete({
          ...request,
          body: { ...request.body, fileId: "F-WRONG" },
        }),
        [200],
      );
    });
    expect(mismatched.body).toStrictEqual({
      fileId: "F-WRONG",
      permalink: "",
      channel: "C123",
      assetId: upload.request.body.assetId,
      deliveryStatus: "failed",
      deliveryError: "Another Slack delivery attempt is already in progress",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();

    mockSlackFileInfo(delivery.fileId);
    const completed = await fixture.run(() => {
      return accept(completeClient.complete(request), [200]);
    });
    expect(completed.body).toStrictEqual({
      fileId: "F-MATERIALIZED",
      permalink: "https://slack.example/files/F-MATERIALIZED",
      channel: "C123",
      assetId: upload.request.body.assetId,
      deliveryStatus: "delivered",
    });
    mockSharedSlackConversations([]);
    const replay = await fixture.run(() => {
      return accept(completeClient.complete(request), [200]);
    });
    expect(replay.body).toStrictEqual(completed.body);
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenCalledExactlyOnceWith({
      files: [{ id: "F-MATERIALIZED", title: undefined }],
      channel_id: "C123",
      thread_ts: undefined,
      initial_comment: undefined,
    });
    expect(context.mocks.slack.files.info).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);
  });

  it("rechecks membership before preparing a canonical Slack delivery", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    mockSharedSlackConversations([]);
    const result = await fixture.run(() => {
      return accept(
        setupApp({
          context,
          routes: integrationsSlackUploadMaterializeRoutes,
        })(integrationsSlackUploadMaterializeContract).materialize(
          upload.request,
        ),
        [200],
      );
    });
    expect(result.body.delivery).toMatchObject({
      status: "failed",
      message: expect.stringContaining("not shared"),
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it("denies completion when membership is revoked after Slack upload preparation", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const materialized = await fixture.run(() => {
      return accept(
        setupApp({
          context,
          routes: integrationsSlackUploadMaterializeRoutes,
        })(integrationsSlackUploadMaterializeContract).materialize(
          upload.request,
        ),
        [200],
      );
    });
    const delivery = materialized.body.delivery;
    if (delivery.status !== "pending") {
      throw new Error("Expected a prepared Slack upload");
    }
    mockSharedSlackConversations([]);
    const completed = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadCompleteRoutes })(
          integrationsSlackUploadCompleteContract,
        ).complete({
          headers: upload.request.headers,
          body: {
            canonicalAssetId: upload.request.body.assetId,
            operationId: upload.request.body.operationId,
            fileId: delivery.fileId,
            channel: "C123",
          },
        }),
        [200],
      );
    });
    expect(completed.body).toMatchObject({
      deliveryStatus: "failed",
      deliveryError: expect.stringContaining("not shared"),
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it("revokes pending canonical delivery when the organization bot is uninstalled", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const materialized = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).materialize(upload.request),
        [200],
      );
    });
    const delivery = materialized.body.delivery;
    if (delivery.status !== "pending") {
      throw new Error("Expected a prepared organization upload");
    }
    await fixture.run(() => {
      return slackOrgs.uninstallWorkspace(upload.actor.slackWorkspaceId);
    });
    const denied = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadCompleteRoutes })(
          integrationsSlackUploadCompleteContract,
        ).complete({
          headers: upload.request.headers,
          body: {
            canonicalAssetId: upload.request.body.assetId,
            operationId: upload.request.body.operationId,
            fileId: delivery.fileId,
            channel: "C123",
          },
        }),
        [200],
      );
    });
    expect(denied.body).toMatchObject({
      channel: "C123",
      deliveryStatus: "failed",
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
  });

  it("records a canonical Slack reconciliation failure and retries materialization", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const client = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const materialized = await fixture.run(() => {
      return accept(client.materialize(upload.request), [200]);
    });
    expect(materialized.body).toStrictEqual({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "pending",
        uploadUrl: "https://files.slack.com/upload/v1/materialized",
        fileId: "F-MATERIALIZED",
      },
    });
    const delivery = materialized.body.delivery;
    if (delivery.status !== "pending") {
      throw new Error("Expected the reserved pending Slack delivery");
    }
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);
    context.mocks.slack.files.completeUploadExternal.mockRejectedValue(
      Object.assign(new Error("invalid_arguments"), {
        data: { ok: false, error: "invalid_arguments" },
      }),
    );
    const failed = await fixture.run(() => {
      return accept(client.materialize(upload.request), [200]);
    });
    expect(failed.body).toStrictEqual({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "failed",
        message: "Slack delivery failed: invalid_arguments",
        retryable: true,
      },
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith(expect.objectContaining({ channel_id: "C123" }));
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
    mockSlackFileInfo(delivery.fileId);
    const expected = {
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "delivered",
        fileId: delivery.fileId,
        permalink: `https://slack.example/files/${delivery.fileId}`,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const recovered = await fixture.run(() => {
        return accept(client.materialize(upload.request), [200]);
      });
      expect(recovered.body).toStrictEqual(expected);
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenCalledTimes(2);
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel_id: "C123" }),
      );
      expect(context.mocks.slack.files.info).toHaveBeenCalledTimes(1);
      expect(context.mocks.slack.files.info).toHaveBeenLastCalledWith({
        file: delivery.fileId,
      });
      expect(
        context.mocks.slack.files.getUploadURLExternal,
      ).toHaveBeenCalledTimes(1);
    }
  });

  it("records a canonical Slack preparation failure and retries materialization", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: false,
      error: "invalid_arguments",
    });
    const materializeClient = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const failed = await fixture.run(() => {
      return accept(materializeClient.materialize(upload.request), [200]);
    });
    expect(failed.body).toStrictEqual({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "failed",
        message: "Slack delivery failed: invalid_arguments",
        retryable: true,
      },
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      file_id: "F-MATERIALIZED",
      upload_url: "https://files.slack.com/upload/v1/materialized",
    });
    const materialized = await fixture.run(() => {
      return accept(materializeClient.materialize(upload.request), [200]);
    });
    expect(materialized.body).toStrictEqual({
      assetId: upload.request.body.assetId,
      url: upload.url,
      delivery: {
        status: "pending",
        uploadUrl: "https://files.slack.com/upload/v1/materialized",
        fileId: "F-MATERIALIZED",
      },
    });
    const delivery = materialized.body.delivery;
    if (delivery.status !== "pending") {
      throw new Error("Expected the retried pending Slack delivery");
    }
    mockSlackFileInfo(delivery.fileId);
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const body = {
      canonicalAssetId: upload.request.body.assetId,
      operationId: upload.request.body.operationId,
      fileId: delivery.fileId,
      channel: "C_IGNORED_COMPLETION_TARGET",
    };
    const expected = {
      fileId: delivery.fileId,
      permalink: `https://slack.example/files/${delivery.fileId}`,
      channel: "C123",
      assetId: upload.request.body.assetId,
      deliveryStatus: "delivered",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        mockSharedSlackConversations([]);
      }
      const completed = await fixture.run(() => {
        return accept(
          client.complete({ headers: upload.request.headers, body }),
          [200],
        );
      });
      expect(completed.body).toStrictEqual(expected);
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenCalledTimes(1);
      expect(context.mocks.slack.files.info).toHaveBeenCalledTimes(1);
    }
  });

  it("returns canonical not found for missing Slack delivery identities", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const materialized = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).materialize(upload.request),
        [200],
      );
    });
    const delivery = materialized.body.delivery;
    expect(delivery.status).toBe("pending");
    if (delivery.status !== "pending") {
      throw new Error("Expected the owned pending Slack delivery");
    }
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    for (const identities of [
      {
        canonicalAssetId: randomUUID(),
        operationId: upload.request.body.operationId,
      },
      {
        canonicalAssetId: upload.request.body.assetId,
        operationId: randomUUID(),
      },
    ]) {
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            headers: upload.request.headers,
            body: { ...identities, fileId: delivery.fileId, channel: "C123" },
          }),
          [404],
        );
      });
      expect(response.body.error).toStrictEqual({
        code: "NOT_FOUND",
        message: "Canonical Slack delivery was not found",
      });
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).not.toHaveBeenCalled();
      expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    }
  });

  it("rejects another run's canonical Slack delivery and preserves its owner's receipt", async () => {
    const fixture = createUploadFixture();
    const first = await pendingCanonicalUpload(fixture);
    const materializeClient = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const firstMaterialized = await fixture.run(() => {
      return accept(materializeClient.materialize(first.request), [200]);
    });
    expect(firstMaterialized.body.delivery.status).toBe("pending");
    const second = await pendingCanonicalUpload(fixture);
    const secondMaterialized = await fixture.run(() => {
      return accept(materializeClient.materialize(second.request), [200]);
    });
    const delivery = secondMaterialized.body.delivery;
    expect(delivery.status).toBe("pending");
    if (delivery.status !== "pending") {
      throw new Error("Expected the second owner's pending Slack delivery");
    }
    const body = {
      canonicalAssetId: second.request.body.assetId,
      operationId: second.request.body.operationId,
      fileId: delivery.fileId,
      channel: "C123",
    };
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    await fixture.restoreMembership(first.actor);
    mockSlackFileInfo(delivery.fileId);
    const rejected = await fixture.run(() => {
      return accept(
        client.complete({ headers: first.request.headers, body }),
        [404],
      );
    });
    expect(rejected.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: "Canonical Slack delivery was not found",
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    const expected = {
      fileId: delivery.fileId,
      permalink: `https://slack.example/files/${delivery.fileId}`,
      channel: "C123",
      assetId: second.request.body.assetId,
      deliveryStatus: "delivered",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await fixture.restoreMembership(second.actor);
      mockSlackFileInfo(delivery.fileId);
      const completed = await fixture.run(() => {
        return accept(
          client.complete({ headers: second.request.headers, body }),
          [200],
        );
      });
      expect(completed.body).toStrictEqual(expected);
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenCalledTimes(1);
      expect(context.mocks.slack.files.info).toHaveBeenCalledTimes(1);
    }
  });

  it("records an authoritative Slack upload error before successful completion and replay", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const materialized = await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).materialize(upload.request),
        [200],
      );
    });
    const delivery = materialized.body.delivery;
    expect(delivery.status).toBe("pending");
    if (delivery.status !== "pending") {
      throw new Error("Expected the authoritative pending Slack delivery");
    }
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const body = {
      canonicalAssetId: upload.request.body.assetId,
      operationId: upload.request.body.operationId,
      fileId: delivery.fileId,
      channel: "C_IGNORED_COMPLETION_TARGET",
    };
    const uploadError = "The prepared Slack upload failed";
    const failed = await fixture.run(() => {
      return accept(
        client.complete({
          headers: upload.request.headers,
          body: { ...body, uploadError },
        }),
        [200],
      );
    });
    expect(failed.body).toStrictEqual({
      fileId: delivery.fileId,
      permalink: "",
      channel: "C123",
      assetId: upload.request.body.assetId,
      deliveryStatus: "failed",
      deliveryError: uploadError,
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
    mockSlackFileInfo(delivery.fileId);
    const expected = {
      fileId: delivery.fileId,
      permalink: `https://slack.example/files/${delivery.fileId}`,
      channel: "C123",
      assetId: upload.request.body.assetId,
      deliveryStatus: "delivered",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const completed = await fixture.run(() => {
        return accept(
          client.complete({ headers: upload.request.headers, body }),
          [200],
        );
      });
      expect(completed.body).toStrictEqual(expected);
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenCalledTimes(1);
      expect(context.mocks.slack.files.info).toHaveBeenCalledTimes(1);
    }
  });

  async function assertRequestInstallations(
    fixture: ReturnType<typeof createUploadFixture>,
    requests: readonly {
      readonly actor: ApiTestUser;
      readonly installation:
        Awaited<ReturnType<typeof slackOrgs.installOrg>> | undefined;
    }[],
  ) {
    const claimedRunIds: string[] = [];
    const initClient = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const materializeClient = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const completeClient = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    let previous:
      { assetId: string; operationId: string; fileId: string } | undefined;
    for (const [index, request] of requests.entries()) {
      const claim = await fixture.claim(request.actor);
      claimedRunIds.push(claim.runId);
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
      const headers = { authorization: `Bearer ${claim.token}` };
      const clients = context.mocks.slack.createClient.mock.calls.length;
      const uploads =
        context.mocks.slack.files.getUploadURLExternal.mock.calls.length;
      const completions =
        context.mocks.slack.files.completeUploadExternal.mock.calls.length;
      const infos = context.mocks.slack.files.info.mock.calls.length;
      if (!request.installation) {
        if (!previous) {
          throw new Error("Expected a preceding public upload");
        }
        const materialized = await accept(
          materializeClient.materialize({
            headers,
            body: {
              assetId: previous.assetId,
              operationId: previous.operationId,
            },
          }),
          [404],
        );
        expect(materialized.body.error.code).toBe("NOT_FOUND");
        const completed = await accept(
          completeClient.complete({
            headers,
            body: {
              canonicalAssetId: previous.assetId,
              operationId: previous.operationId,
              fileId: previous.fileId,
              channel: "C_GRAPH",
            },
          }),
          [404],
        );
        expect(completed.body.error.code).toBe("NOT_FOUND");
        expect(
          context.mocks.slack.createClient.mock.calls.slice(clients),
        ).toStrictEqual([]);
        expect(
          context.mocks.slack.files.getUploadURLExternal.mock.calls.slice(
            uploads,
          ),
        ).toStrictEqual([]);
        expect(
          context.mocks.slack.files.completeUploadExternal.mock.calls.slice(
            completions,
          ),
        ).toStrictEqual([]);
        expect(
          context.mocks.slack.files.info.mock.calls.slice(infos),
        ).toStrictEqual([]);
        continue;
      }
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      const operationId = randomUUID();
      const filename = `request-${String(index)}.csv`;
      const channel = `C_GRAPH_${String(index)}`;
      const fileId = `F_GRAPH_${String(index)}`;
      const uploadUrl = `https://files.slack.com/upload/v1/graph-${String(index)}`;
      context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
        ok: true,
        file_id: fileId,
        upload_url: uploadUrl,
      });
      context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
        ok: true,
      });
      mockSlackFileInfo(fileId);
      const initialized = await accept(
        initClient.init({
          headers,
          body: {
            filename,
            length: 42,
            canonical: {
              operationId,
              contentType: "text/csv",
              checksumSha256: "a".repeat(64),
              channel,
            },
          },
        }),
        [200],
      );
      if (!("kind" in initialized.body)) {
        throw new Error("Expected a canonical Slack upload");
      }
      const assetId = initialized.body.assetId;
      const privateUpload =
        initialized.body.uploadHeaders?.["x-amz-meta-filename"] === undefined;
      objectStore.addObject({
        bucket: privateUpload
          ? "test-private-artifacts"
          : "test-user-artifacts",
        key: privateUpload
          ? `private-artifacts/${assetId}/${filename}`
          : `artifacts/${new URL(initialized.body.url).pathname.replace(/^\/+/u, "")}`,
        size: 42,
        body: Buffer.alloc(42, "a"),
        metadata: {
          "artifact-id": assetId,
          filename,
          "public-brand": "okou",
          "user-id": encodeURIComponent(request.actor.userId),
        },
      });
      const materialized = await accept(
        materializeClient.materialize({
          headers,
          body: { assetId, operationId },
        }),
        [200],
      );
      expect(materialized.body).toStrictEqual({
        assetId,
        url: initialized.body.url,
        delivery: { status: "pending", fileId, uploadUrl },
      });
      const completed = await accept(
        completeClient.complete({
          headers,
          body: { canonicalAssetId: assetId, operationId, fileId, channel },
        }),
        [200],
      );
      expect(completed.body).toStrictEqual({
        fileId,
        permalink: `https://slack.example/files/${fileId}`,
        channel,
        assetId,
        deliveryStatus: "delivered",
      });
      expect(
        context.mocks.slack.createClient.mock.calls
          .slice(clients)
          .map(([token]) => {
            return token;
          }),
      ).toStrictEqual([
        request.installation.botToken,
        request.installation.botToken,
        request.installation.botToken,
      ]);
      expect(
        context.mocks.slack.files.getUploadURLExternal.mock.calls.slice(
          uploads,
        ),
      ).toStrictEqual([[{ filename, length: 42 }]]);
      expect(
        context.mocks.slack.files.completeUploadExternal.mock.calls.slice(
          completions,
        ),
      ).toStrictEqual([
        [
          {
            files: [{ id: fileId, title: undefined }],
            channel_id: channel,
            thread_ts: undefined,
            initial_comment: undefined,
          },
        ],
      ]);
      expect(
        context.mocks.slack.files.info.mock.calls.slice(infos),
      ).toStrictEqual([[{ file: fileId }]]);
      const files = await chatApi.listThreadArtifacts(
        request.actor,
        claim.threadId,
      );
      expect(
        files.runs.flatMap((run) => {
          return run.files;
        }),
      ).toContainEqual(
        expect.objectContaining({ id: assetId, url: initialized.body.url }),
      );
      previous = { assetId, operationId, fileId };
    }
    return claimedRunIds;
  }

  it.each([
    "members of one organization",
    "different organizations",
    "an uninstalled organization",
  ] as const)(
    "selects each request's installation across %s and returns to the first actor",
    async (relationship) => {
      const fixture = createUploadFixture();
      const first = fixture.user({ orgRole: "org:admin" });
      const next =
        relationship === "members of one organization"
          ? fixture.user({ orgId: first.orgId, orgRole: "org:member" })
          : fixture.user({ orgRole: "org:admin" });
      await fixture.run(async () => {
        for (const actor of [first, next]) {
          await fixture.prepareActor(actor);
        }
        const a = await slackOrgs.installOrg({
          actor: first,
          withConnection: true,
        });
        fixture.beforeWorkspaceCleanup(() => {
          return slackOrgs.uninstallWorkspace(a.slackWorkspaceId);
        });
        let nextInstallation:
          Awaited<ReturnType<typeof slackOrgs.installOrg>> | undefined;
        if (relationship === "members of one organization") {
          if (!first.orgId) {
            throw new Error("Expected the first actor's organization");
          }
          await slackOrgs.connectMember({
            orgId: first.orgId,
            userId: next.userId,
            slackWorkspaceId: a.slackWorkspaceId,
            run: fixture.run,
          });
          nextInstallation = a;
        } else if (relationship === "different organizations") {
          const b = await slackOrgs.installOrg({
            actor: next,
            withConnection: true,
          });
          fixture.beforeWorkspaceCleanup(() => {
            return slackOrgs.uninstallWorkspace(b.slackWorkspaceId);
          });
          nextInstallation = b;
        }
        await flushWaitUntilForTest();
        const claimedRunIds = await assertRequestInstallations(fixture, [
          { actor: first, installation: a },
          { actor: next, installation: nextInstallation },
          { actor: first, installation: a },
        ]);
        expect(new Set(claimedRunIds).size).toBe(3);
      });
    },
  );

  it.each(["missing", "undefined length", "mismatched length"] as const)(
    "keeps a canonical upload unpublished after %s storage verification and recovers on replay",
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
        return accept(client.materialize(upload.request), [400]);
      });
      expect(failed.body.error).toStrictEqual({
        code: "storage-verification-failed",
        message:
          failure === "missing"
            ? "Canonical upload was not found"
            : "Canonical upload size did not match",
      });
      const before = await fixture.run(() => {
        return chatApi.listArtifactCatalog(actorFor(upload.actor));
      });
      expect(before.artifacts).toStrictEqual([]);
      context.mocks.s3.send.mockImplementation(send);
      const recovered = await fixture.run(() => {
        return accept(client.materialize(upload.request), [200]);
      });
      expect(recovered.body).toMatchObject({
        assetId: upload.request.body.assetId,
        url: upload.url,
        delivery: { status: "pending" },
      });
      const after = await fixture.run(() => {
        return chatApi.listArtifactCatalog(actorFor(upload.actor));
      });
      expect(after.artifacts).toHaveLength(1);
      const files = await fixture.run(() => {
        return visibleUploadedFiles(upload.actor);
      });
      expect(files).toContainEqual(
        expect.objectContaining({
          id: upload.request.body.assetId,
          assetRef: expect.objectContaining({
            materialization: { status: "ready" },
          }),
        }),
      );
    },
  );

  it("cancels canonical publication during storage verification and permits a fresh replay", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const owner = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      owner.abort();
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    const send = context.mocks.s3.send.getMockImplementation();
    if (!send) {
      throw new Error("Expected the external object storage mock");
    }
    context.mocks.s3.send.mockImplementation(async (command, ...args) => {
      if (command instanceof HeadObjectCommand) {
        started.resolve(undefined);
        await release.promise;
      }
      return await send(command, ...args);
    });
    const client = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
      signal: owner.signal,
      rethrowErrors: true,
    })(integrationsSlackUploadMaterializeContract);
    const cancelled = fixture.run(() => {
      return expect(client.materialize(upload.request)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
    await started.promise;
    owner.abort();
    release.resolve(undefined);
    await cancelled;
    const before = await fixture.run(() => {
      return chatApi.listArtifactCatalog(actorFor(upload.actor));
    });
    expect(before.artifacts).toStrictEqual([]);
    context.mocks.s3.send.mockImplementation(send);
    await fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).materialize(upload.request),
        [200],
      );
    });
    const after = await fixture.run(() => {
      return chatApi.listArtifactCatalog(actorFor(upload.actor));
    });
    expect(after.artifacts).toHaveLength(1);
  });

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
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
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
      const files = await fixture.run(() => {
        return visibleUploadedFiles({
          orgId,
          userId,
          runId,
          threadId,
        });
      });
      expect(files).toStrictEqual([]);
    });
  });

  it("records a Slack upload for a run-scoped agent token", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
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
        initial_comment: "Uploaded from a run",
      });

      const files = await fixture.run(() => {
        return visibleUploadedFiles({
          orgId,
          userId,
          runId,
          threadId,
        });
      });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        id: fileId,
        filename: "Quarterly report",
        contentType: "text/csv",
        size: 42,
        url: `https://slack.example/files/${fileId}`,
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
        });
      });
    },
  );

  it.each(["me", "U_OTHER_USER"])(
    "persists recipient %s DM for a canonical upload",
    async (target) => {
      const fixture = createUploadFixture();
      const { seedRunScoped, connectMember, okouToken } = fixture;
      await fixture.run(async () => {
        const { orgId, userId, runId, slackWorkspaceId } = await fixture.run(
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
        context.mocks.slack.conversations.open.mockClear();
        context.mocks.slack.conversations.open.mockResolvedValue({
          ok: true,
          channel: { id: "D-SELF" },
        });
        context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/self",
          file_id: "F-SELF",
        });
        mockSlackFileInfo("F-SELF");
        const objectStore = chatCallbacks.acceptChatObjectStorage();
        const operationId = randomUUID();
        const token = okouToken({ userId, orgId, runId });

        const initialized = await fixture.run(() => {
          return accept(
            setupApp({ context, routes: integrationsSlackUploadInitRoutes })(
              integrationsSlackUploadInitContract,
            ).init({
              body: {
                filename: "report.csv",
                length: 42,
                canonical: {
                  operationId,
                  contentType: "text/csv",
                  checksumSha256: "a".repeat(64),
                  user: target,
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
        expect(initialized.body.channel).toBe("D-SELF");
        expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith(
          {
            users: target === "me" ? slackUserId : target,
          },
        );

        objectStore.addObject({
          bucket: "test-private-artifacts",
          key: `private-artifacts/${canonicalAssetId}/report.csv`,
          size: 42,
          body: Buffer.alloc(42, "a"),
          metadata: {
            "artifact-id": canonicalAssetId,
            filename: "report.csv",
            "public-brand": "okou",
            "user-id": encodeURIComponent(userId),
          },
        });
        await fixture.run(() => {
          return accept(
            setupApp({
              context,
              routes: integrationsSlackUploadMaterializeRoutes,
            })(integrationsSlackUploadMaterializeContract).materialize({
              body: { assetId: canonicalAssetId, operationId },
              headers: { authorization: `Bearer ${token}` },
            }),
            [200],
          );
        });

        const completed = await fixture.run(() => {
          return accept(
            setupApp({
              context,
              routes: integrationsSlackUploadCompleteRoutes,
            })(integrationsSlackUploadCompleteContract).complete({
              body: {
                fileId: "F-SELF",
                user: target,
                canonicalAssetId,
                operationId,
              },
              headers: { authorization: `Bearer ${token}` },
            }),
            [200],
          );
        });

        expect(completed.body).toMatchObject({
          fileId: "F-SELF",
          channel: "D-SELF",
          assetId: canonicalAssetId,
          deliveryStatus: "delivered",
        });
        expect(
          context.mocks.slack.files.completeUploadExternal,
        ).toHaveBeenLastCalledWith({
          files: [{ id: "F-SELF" }],
          channel_id: "D-SELF",
        });
        expect(context.mocks.slack.conversations.open).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each([false, true])(
    "keeps one private canonical output across Slack and Drive (artifactUpload=%s)",
    async (artifactUpload) => {
      const fixture = createUploadFixture();
      const { seedRunScoped, okouToken, sandboxToken, claimRun } = fixture;
      await fixture.run(async () => {
        const { orgId, userId, runId, threadId, runnerGroup, agentId } =
          await fixture.run(() => {
            return seedRunScoped();
          });
        const objectStore = chatCallbacks.acceptChatObjectStorage();
        const operationId = randomUUID();
        const token = okouToken({
          userId,
          orgId,
          runId,
        });
        context.mocks.slack.files.getUploadURLExternal.mockClear();
        context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/canonical",
          file_id: "F-CANONICAL",
        });
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
                  operationId,
                  contentType: "text/csv",
                  checksumSha256: "a".repeat(64),
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
        expect(initialized.body.kind).toBe("canonical");
        expect(initialized.body.uploadHeaders).toStrictEqual({
          "x-amz-meta-artifact-id": canonicalAssetId,
        });
        expect(
          context.mocks.slack.files.getUploadURLExternal,
        ).not.toHaveBeenCalled();
        const storageKey = `private-artifacts/${canonicalAssetId}/report.csv`;
        expect(initialized.body.url).toMatch(
          /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.csv$/u,
        );
        const retry = await fixture.run(() => {
          return accept(
            initClient.init({
              body: {
                filename: "report.csv",
                length: 42,
                canonical: {
                  operationId,
                  contentType: "text/csv",
                  checksumSha256: "a".repeat(64),
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
        expect(retry.body).toMatchObject({
          assetId: canonicalAssetId,
          url: initialized.body.url,
        });
        expect(
          context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1],
        ).toMatchObject({
          input: {
            Bucket: "test-private-artifacts",
            Key: storageKey,
          },
        });
        objectStore.addObject({
          bucket: "test-private-artifacts",
          key: storageKey,
          size: 42,
          body: Buffer.alloc(42, "a"),
          metadata: {
            "artifact-id": canonicalAssetId,
            filename: "report.csv",
            "public-brand": "okou",
            "user-id": encodeURIComponent(userId),
          },
        });

        const materializeClient = setupApp({
          context,
          routes: integrationsSlackUploadMaterializeRoutes,
        })(integrationsSlackUploadMaterializeContract);
        const materialized = await fixture.run(() => {
          return accept(
            materializeClient.materialize({
              body: {
                assetId: canonicalAssetId,
                operationId,
              },
              headers: { authorization: `Bearer ${token}` },
            }),
            [200],
          );
        });
        expect(materialized.body).toMatchObject({
          assetId: canonicalAssetId,
          delivery: {
            status: "pending",
            fileId: "F-CANONICAL",
          },
        });
        expect(
          context.mocks.slack.files.getUploadURLExternal,
        ).toHaveBeenCalledTimes(1);

        const catalog = await fixture.run(() => {
          return chatApi.listArtifactCatalog(actorFor({ orgId, userId }));
        });
        const catalogEntry = catalog.artifacts.find((artifact) => {
          return artifact.title === "report.csv";
        });
        expect(catalogEntry).toMatchObject({
          kind: "file",
          title: "report.csv",
        });
        if (!catalogEntry) {
          throw new Error(
            "Expected the canonical output in the artifact catalog",
          );
        }
        const catalogDetail = await fixture.run(() => {
          return chatApi.getArtifactCatalogEntry(
            actorFor({ orgId, userId }),
            catalogEntry.id,
          );
        });
        if (catalogDetail.kind !== "file") {
          throw new Error("Expected canonical output to use the file kind");
        }
        expect(catalogDetail.file.id).toBe(canonicalAssetId);

        const completeClient = setupApp({
          context,
          routes: integrationsSlackUploadCompleteRoutes,
        })(integrationsSlackUploadCompleteContract);
        const completed = await fixture.run(() => {
          return accept(
            completeClient.complete({
              body: {
                fileId: "F-CANONICAL",
                channel: "C123",
                threadTs: "123.456",
                canonicalAssetId,
                operationId,
              },
              headers: { authorization: `Bearer ${token}` },
            }),
            [200],
          );
        });
        expect(completed.body).toMatchObject({
          fileId: "F-CANONICAL",
          assetId: canonicalAssetId,
          deliveryStatus: "delivered",
        });
        await fixture.run(() => {
          return chatApi.requestSendEvent(
            actorFor({ orgId, userId }),
            {
              agentId,
              prompt: "Reuse the existing output as an attachment",
              userMessage: {
                version: 1,
                parts: [
                  {
                    type: "file",
                    fileId: canonicalAssetId,
                    filenameSnapshot: "report.csv",
                    contentType: "text/csv",
                  },
                ],
              },
            },
            [201],
          );
        });
        await fixture.run(() => {
          return flushWaitUntilForTest();
        });
        const files = await fixture.run(() => {
          return visibleUploadedFiles({
            orgId,
            userId,
            runId,
            threadId,
          });
        });
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({
          id: canonicalAssetId,
          filename: "report.csv",
          url: initialized.body.url,
          assetRef: {
            id: canonicalAssetId,
            classification: "published-output",
            access: "published",
            materialization: { status: "ready" },
          },
        });

        mockGoogleDriveConnectorOAuth();
        const oauth = await fixture.run(() => {
          return connectorsApi.startOauth(
            actorFor({ orgId, userId }),
            "google-drive",
            "oauth",
          );
        });
        await fixture.run(() => {
          return connectorsApi.completeOauthCallback("google-drive", {
            code: "canonical-asset-drive",
            state: authorizationState(oauth.authorizationUrl),
          });
        });
        await fixture.run(() => {
          return runsApi.enableAgentConnectors(
            actorFor({ orgId, userId }),
            agentId,
            ["google-drive"],
          );
        });

        const driveFolders: DriveFolderFixture[] = [];
        const driveUploadBodies: string[] = [];
        const driveContentBodies: string[] = [];
        const driveUploadContentTypes: (string | null)[] = [];
        const driveUploadSessionUrl =
          "https://www.googleapis.com/upload/drive/v3/files/resumable-session";
        server.use(
          http.get(
            "https://www.googleapis.com/drive/v3/files",
            ({ request }) => {
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
            },
          ),
          http.post(
            "https://www.googleapis.com/drive/v3/files",
            async ({ request }) => {
              const body = (await fixture.run(() => {
                return request.json();
              })) as {
                readonly name?: string;
                readonly parents?: readonly string[];
              };
              if (!body.name) {
                throw new Error("Expected Google Drive folder name");
              }
              const folder = {
                id: `drive-folder-${String(driveFolders.length + 1)}`,
                name: body.name,
                parentFolderId: body.parents?.[0] ?? null,
              };
              driveFolders.push(folder);
              return HttpResponse.json(folder);
            },
          ),
          // A resumable upload opens a session with the metadata, then sends the
          // content against the returned session URI.
          http.post(
            "https://www.googleapis.com/upload/drive/v3/files",
            async ({ request }) => {
              driveUploadContentTypes.push(request.headers.get("content-type"));
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
        mocks.clerk.session(userId, orgId);
        const driveClient = setupApp({
          baseUrl: "https://api.okou.ai",
          context,
          routes: chatThreadsArtifactsSyncRoutes,
        })(artifactGoogleDriveContract);
        const driveSync = await fixture.run(() => {
          return accept(
            driveClient.upload({
              headers: { authorization: "Bearer clerk-session" },
              params: { artifactId: canonicalAssetId },
              body: { agentId },
            }),
            [200],
          );
        });
        expect(driveSync.body).toStrictEqual({
          id: "drive-canonical-asset",
          name: "report.csv",
          webViewLink:
            "https://drive.google.com/file/d/drive-canonical-asset/view",
        });

        const retryDriveSync = await fixture.run(() => {
          return accept(
            driveClient.upload({
              headers: { authorization: "Bearer clerk-session" },
              params: { artifactId: canonicalAssetId },
              body: { agentId },
            }),
            [200],
          );
        });
        expect(retryDriveSync.body.name).toBe("report.csv");

        const runDriveSync = await fixture.run(() => {
          return accept(
            driveClient.upload({
              headers: {
                authorization: `Bearer ${okouToken({
                  userId,
                  orgId,
                  runId,
                })}`,
              },
              params: { artifactId: canonicalAssetId },
              body: { agentId },
            }),
            [200],
          );
        });
        expect(runDriveSync.body.name).toBe("report.csv");

        expect(driveFolders).toHaveLength(2);
        expect(
          driveFolders
            .filter((folder) => {
              return folder.parentFolderId === null;
            })
            .map((folder) => {
              return folder.name;
            }),
        ).toStrictEqual(["Okou Artifacts"]);
        expect(driveUploadBodies).toHaveLength(3);
        for (const body of driveUploadBodies) {
          expect(body).toContain('"parents":["drive-folder-2"]');
          expect(body).toContain(`"vm0Artifact":"true"`);
          expect(body).toContain(`"vm0ThreadId":"${threadId}"`);
          expect(body).toContain(`"vm0RunId":"${runId}"`);
          expect(body).toContain(`"vm0FileId":"${operationId}"`);
        }
        expect(
          driveUploadContentTypes.every((contentType) => {
            return contentType === "application/json; charset=UTF-8";
          }),
        ).toBeTruthy();

        if (!artifactUpload) {
          const claim = await fixture.run(() => {
            return claimRun(runnerGroup, runId);
          });
          await fixture.run(() => {
            return completeRun({
              runId,
              sandboxToken: claim.sandboxToken,
              events: [assistantEvent(0, "The canonical report is ready.")],
              lastEventSequence: 0,
            });
          });

          const messages = await fixture.run(() => {
            return chatApi.listThreadEvents(
              actorFor({ orgId, userId }),
              threadId,
            );
          });
          const finalReply = messages.events.find((message) => {
            return (
              message.eventType === "output.message" &&
              message.content === "The canonical report is ready."
            );
          });
          expect(finalReply).toBeDefined();

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
          return;
        }

        const actor = actorFor({ orgId, userId });
        const accounts = await fixture.run(() => {
          return connectorsApi.listBuiltinConnectorAccounts(
            actor,
            "google-drive",
          );
        });
        const selectedAccount = accounts[0];
        if (!selectedAccount) {
          throw new Error("Expected the connected Google Drive account");
        }
        const resolvedArtifacts = await fixture.run(() => {
          return chatApi.listThreadArtifacts(actor, threadId);
        });
        expect(
          resolvedArtifacts.runs.flatMap((group) => {
            return group.files;
          }),
        ).toContainEqual(
          expect.objectContaining({
            id: canonicalAssetId,
            artifactId: catalogEntry.id,
            googleDriveConnectionId: selectedAccount.id,
          }),
        );
        const uploadClient = setupApp({
          context,
          routes: chatThreadsArtifactsSyncRoutes,
        })(artifactGoogleDriveContract);
        const destination = await fixture.run(() => {
          return chatApi.sendAndLaunch(actor, {
            agentId,
            prompt: "Upload an existing artifact from another conversation",
            model: "claude-fable-5-1",
          });
        });
        expect(destination.threadId).not.toBe(threadId);
        await fixture.run(() => {
          return fixture.rememberClaim(actor, destination.runId);
        });
        const uploaded = await fixture.run(() => {
          return accept(
            uploadClient.upload({
              headers: {
                authorization: `Bearer ${okouToken({ userId, orgId, runId: destination.runId })}`,
              },
              params: { artifactId: catalogEntry.id },
              body: { agentId, connectionId: selectedAccount.id },
            }),
            [200],
          );
        });
        expect(uploaded.body.name).toBe("report.csv");
        expect(driveUploadBodies.at(-1)).toContain(
          `"okouArtifactId":"${catalogEntry.id}"`,
        );
        expect(driveContentBodies.at(-1)).toBe("a".repeat(42));

        mocks.clerk.session(userId, orgId);
        const uploadRequest = {
          headers: { authorization: "Bearer clerk-session" },
          params: { artifactId: catalogEntry.id },
          body: { agentId, connectionId: selectedAccount.id },
        };
        context.mocks.clerk.authenticateRequest.mockResolvedValue({
          isAuthenticated: false,
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({ ...uploadRequest, headers: {} }),
            [401],
          );
        });
        mocks.clerk.session(userId, orgId);
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              params: { artifactId: randomUUID() },
            }),
            [404],
          );
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              body: { ...uploadRequest.body, agentId: randomUUID() },
            }),
            [400],
          );
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              body: { ...uploadRequest.body, connectionId: randomUUID() },
            }),
            [400],
          );
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              headers: {
                authorization: `Bearer ${sandboxToken(destination.runId)}`,
              },
            }),
            [403],
          );
        });
        const otherAgent = await fixture.run(() => {
          return bdd.createAgent(actor, {
            displayName: "Unauthorized upload Agent",
          });
        });
        await fixture.run(() => {
          return runsApi.enableAgentConnectors(actor, otherAgent.agentId, [
            "google-drive",
          ]);
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              headers: {
                authorization: `Bearer ${okouToken({ userId, orgId, runId: destination.runId })}`,
              },
              body: { ...uploadRequest.body, agentId: otherAgent.agentId },
            }),
            [400],
          );
        });
        const foreignActor = fixture.user({ orgId, orgRole: "org:admin" });
        const foreignOauth = await fixture.run(() => {
          return connectorsApi.startOauth(
            foreignActor,
            "google-drive",
            "oauth",
          );
        });
        await fixture.run(() => {
          return connectorsApi.completeOauthCallback("google-drive", {
            code: "foreign-drive-account",
            state: authorizationState(foreignOauth.authorizationUrl),
          });
        });
        const [foreignAccount] = await fixture.run(() => {
          return connectorsApi.listBuiltinConnectorAccounts(
            foreignActor,
            "google-drive",
          );
        });
        if (!foreignAccount) {
          throw new Error("Expected the other user's Drive account");
        }
        mocks.clerk.session(userId, orgId);
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              body: { ...uploadRequest.body, connectionId: foreignAccount.id },
            }),
            [400],
          );
        });
        expect(driveUploadBodies).toHaveLength(4);
        const ordinary = await fixture.run(() => {
          return chatApi.prepareUpload(actor, {
            filename: "ordinary.csv",
            contentType: "text/csv",
            size: 42,
            purpose: "artifact",
          });
        });
        objectStore.addObject({
          bucket: "test-private-artifacts",
          key: `private-artifacts/${ordinary.id}/ordinary.csv`,
          size: 42,
          body: Buffer.alloc(42, "b"),
          metadata: {
            "artifact-id": ordinary.id,
            filename: "ordinary.csv",
            "public-brand": "okou",
            "user-id": encodeURIComponent(userId),
          },
        });
        await fixture.run(() => {
          return chatApi.completeUploadWithBearer(
            `Bearer ${okouToken({ userId, orgId, runId })}`,
            { id: ordinary.id },
            [200],
          );
        });
        const ordinaryCatalog = await fixture.run(() => {
          return chatApi.listArtifactCatalog(actor);
        });
        const ordinaryEntry = ordinaryCatalog.artifacts.find((entry) => {
          return entry.title === "ordinary.csv";
        });
        if (!ordinaryEntry) {
          throw new Error("Expected the ordinary upload in the catalog");
        }
        const ordinaryDetail = await fixture.run(() => {
          return chatApi.getArtifactCatalogEntry(actor, ordinaryEntry.id);
        });
        if (ordinaryDetail.kind !== "file") {
          throw new Error("Expected the ordinary output to use the file kind");
        }
        expect(ordinaryDetail.file).toMatchObject({
          filename: "ordinary.csv",
          url: ordinary.url,
          contentType: "text/csv",
          size: 42,
        });
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              params: { artifactId: ordinaryEntry.id },
            }),
            [200],
          );
        });
        expect(driveContentBodies.at(-1)).toBe("b".repeat(42));

        const hostBearer = `Bearer ${okouToken({ userId, orgId, runId })}`;
        const siteName = `drive-companion-${randomUUID().slice(0, 8)}`;
        const site = await fixture.run(() => {
          return chatApi.prepareHostedSiteWithBearer(hostBearer, {
            site: siteName,
            artifactKind: "hosted-site",
            spaFallback: false,
            files: [
              hostedTextFile("/index.html", "<main>Report companion</main>"),
            ],
          });
        });
        const publishedSite = await fixture.run(() => {
          return chatApi.completeHostedSiteWithBearer(
            hostBearer,
            site.deploymentId,
          );
        });

        // File -> hosted: publishing an independent site preserves the files'
        // catalog identities, not only their thread-list fallback identities.
        const fileExpectations = [
          { id: catalogEntry.id, kind: "file", title: "report.csv" },
          { id: ordinaryEntry.id, kind: "file", title: "ordinary.csv" },
        ];
        const afterHosted = await fixture.run(() => {
          return chatApi.listArtifactCatalog(actor);
        });
        expect(afterHosted.artifacts).toStrictEqual(
          expect.arrayContaining(
            fileExpectations.map((entry) => {
              return expect.objectContaining(entry);
            }),
          ),
        );
        const hostedEntry = afterHosted.artifacts.find((entry) => {
          return entry.kind === "hosted-site" && entry.title === siteName;
        });
        if (!hostedEntry) {
          throw new Error(
            "Expected the independent hosted site in the catalog",
          );
        }
        const hostedDetail = await fixture.run(() => {
          return chatApi.getArtifactCatalogEntry(actor, hostedEntry.id);
        });
        expect(hostedDetail).toMatchObject({
          id: hostedEntry.id,
          kind: "hosted-site",
          title: siteName,
          site: {
            id: site.siteId,
            slug: siteName,
            publicSlug: publishedSite.publicSlug,
            url: publishedSite.url,
            entrypoint: "/index.html",
            spaFallback: false,
          },
        });

        // Hosted -> file: another output on this same claimed Run is also a
        // catalog entry while the hosted publication keeps its identity.
        const laterFile = await fixture.run(() => {
          return chatApi.prepareUpload(actor, {
            filename: "companion-data.csv",
            contentType: "text/csv",
            size: 42,
            purpose: "artifact",
          });
        });
        objectStore.addObject({
          bucket: "test-private-artifacts",
          key: `private-artifacts/${laterFile.id}/companion-data.csv`,
          size: 42,
          body: Buffer.alloc(42, "c"),
          metadata: {
            "artifact-id": laterFile.id,
            filename: "companion-data.csv",
            "public-brand": "okou",
            "user-id": encodeURIComponent(userId),
          },
        });
        await fixture.run(() => {
          return chatApi.completeUploadWithBearer(
            hostBearer,
            { id: laterFile.id },
            [200],
          );
        });
        const afterLaterFile = await fixture.run(() => {
          return chatApi.listArtifactCatalog(actor);
        });
        expect(afterLaterFile.artifacts).toStrictEqual(
          expect.arrayContaining(
            [...fileExpectations, hostedEntry].map((entry) => {
              return expect.objectContaining(entry);
            }),
          ),
        );
        const laterEntry = afterLaterFile.artifacts.find((entry) => {
          return entry.kind === "file" && entry.title === "companion-data.csv";
        });
        if (!laterEntry) {
          throw new Error("Expected the later independent file in the catalog");
        }
        for (const [entryId, expectedFile] of [
          [catalogEntry.id, catalogDetail.file],
          [ordinaryEntry.id, ordinaryDetail.file],
          [
            laterEntry.id,
            {
              filename: "companion-data.csv",
              url: laterFile.url,
              contentType: "text/csv",
              size: 42,
            },
          ],
        ] as const) {
          const detail = await fixture.run(() => {
            return chatApi.getArtifactCatalogEntry(actor, entryId);
          });
          expect(detail).toMatchObject({
            id: entryId,
            kind: "file",
            title: expectedFile.filename,
            file: expectedFile,
          });
        }
        const retainedHostedDetail = await fixture.run(() => {
          return chatApi.getArtifactCatalogEntry(actor, hostedEntry.id);
        });
        expect(retainedHostedDetail).toStrictEqual(hostedDetail);

        const groupedFiles = (
          await fixture.run(() => {
            return chatApi.listThreadArtifacts(actor, threadId);
          })
        ).runs.flatMap((group) => {
          return group.files;
        });
        for (const [fileId, bytes] of [
          [canonicalAssetId, "a"],
          [ordinary.id, "b"],
        ] as const) {
          const artifactId = requiredDriveArtifactId(groupedFiles, fileId);
          await fixture.run(() => {
            return accept(
              uploadClient.upload({ ...uploadRequest, params: { artifactId } }),
              [200],
            );
          });
          expect(driveContentBodies.at(-1)).toBe(bytes.repeat(42));
        }
        expect(driveUploadBodies).toHaveLength(7);

        // Artifact access does not depend on keeping its source conversation.
        await fixture.run(() => {
          return chatApi.deleteThread(actor, threadId);
        });
        mocks.clerk.session(userId, orgId);
        const groupedCanonical = {
          artifactId: requiredDriveArtifactId(groupedFiles, canonicalAssetId),
        };
        const detachedUpload = await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              params: { artifactId: groupedCanonical.artifactId },
            }),
            [200],
          );
        });
        expect(detachedUpload.body.name).toBe("report.csv");
        expect(driveContentBodies.at(-1)).toBe("a".repeat(42));
        expect(driveUploadBodies.at(-1)).toContain(
          `"okouArtifactId":"${groupedCanonical.artifactId}"`,
        );
        expect(driveUploadBodies.at(-1)).not.toContain("vm0ThreadId");

        mocks.clerk.session("user_foreign_artifact_owner", orgId);
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              params: { artifactId: groupedCanonical.artifactId },
            }),
            [404],
          );
        });
        mocks.clerk.session(userId, "org_foreign_artifact_owner");
        await fixture.run(() => {
          return accept(
            uploadClient.upload({
              ...uploadRequest,
              params: { artifactId: groupedCanonical.artifactId },
            }),
            [404],
          );
        });
        expect(driveUploadBodies).toHaveLength(8);
      });
    },
    20_000,
  );

  it("keeps an attachment-only output out of the event stream", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken, claimRun } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId, runnerGroup } = await fixture.run(
        () => {
          return seedRunScoped();
        },
      );
      chatCallbacks.acceptChatObjectStorage();
      const operationId = randomUUID();
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
                operationId,
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
      const claim = await fixture.run(() => {
        return claimRun(runnerGroup, runId);
      });
      await fixture.run(() => {
        return completeRun({
          runId,
          sandboxToken: claim.sandboxToken,
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
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      const operationId = randomUUID();
      const token = okouToken({ userId, orgId, runId });
      const fileId = "F-MISSING-PERMALINK";
      context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/missing-permalink",
        file_id: fileId,
      });
      context.mocks.slack.files.info.mockResolvedValue({
        ok: true,
        file: {
          id: fileId,
          name: "report.csv",
          title: "Slack Report",
          mimetype: "text/csv",
          filetype: "csv",
          size: 42,
        },
      });

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
                operationId,
                contentType: "text/csv",
                checksumSha256: "c".repeat(64),
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
      const canonicalAssetId = initialized.body.assetId;
      const storageKey = `private-artifacts/${canonicalAssetId}/report.csv`;
      objectStore.addObject({
        bucket: "test-private-artifacts",
        key: storageKey,
        size: 42,
        body: Buffer.alloc(42, "a"),
        metadata: { "artifact-id": canonicalAssetId },
      });

      const materializeClient = setupApp({
        context,
        routes: integrationsSlackUploadMaterializeRoutes,
      })(integrationsSlackUploadMaterializeContract);
      const materialized = await fixture.run(() => {
        return accept(
          materializeClient.materialize({
            body: { assetId: canonicalAssetId, operationId },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(materialized.body.delivery).toMatchObject({
        status: "pending",
        fileId,
      });

      const completeClient = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const completed = await fixture.run(() => {
        return accept(
          completeClient.complete({
            body: {
              fileId,
              channel: "C123",
              canonicalAssetId,
              operationId,
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(completed.body).toMatchObject({
        fileId,
        assetId: canonicalAssetId,
        permalink: "",
        deliveryStatus: "failed",
        deliveryError: "Slack file info did not include a permalink",
      });
    });
  });

  it("keeps one Slack delivery authoritative across concurrent retries", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const objectStore = chatCallbacks.acceptChatObjectStorage();
      const operationId = randomUUID();
      const token = okouToken({ userId, orgId, runId });
      const allocations: string[] = [];
      const bothAllocationsStarted = createDeferredPromise<void>(
        context.signal,
      );
      onTestFinished(() => {
        if (!bothAllocationsStarted.settled()) {
          bothAllocationsStarted.resolve(undefined);
        }
      });
      context.mocks.slack.files.getUploadURLExternal.mockImplementation(
        async () => {
          const fileId = `F-CONCURRENT-${allocations.length + 1}`;
          allocations.push(fileId);
          if (allocations.length === 2 && !bothAllocationsStarted.settled()) {
            bothAllocationsStarted.resolve(undefined);
          }
          await fixture.run(() => {
            return bothAllocationsStarted.promise;
          });
          return {
            ok: true,
            upload_url: `https://files.slack.com/upload/v1/${fileId}`,
            file_id: fileId,
          };
        },
      );

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
                operationId,
                contentType: "text/csv",
                checksumSha256: "a".repeat(64),
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

      const materializeClient = setupApp({
        context,
        routes: integrationsSlackUploadMaterializeRoutes,
      })(integrationsSlackUploadMaterializeContract);
      const materialize = () => {
        return accept(
          materializeClient.materialize({
            body: {
              assetId: canonicalAssetId,
              operationId,
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      };
      const materialized = await fixture.run(() => {
        return Promise.all([materialize(), materialize()]);
      });
      const deliveries = materialized.map((response) => {
        return response.body.delivery;
      });
      const pendingDeliveries = deliveries.filter((delivery) => {
        return delivery.status === "pending";
      });
      const failedDeliveries = deliveries.filter((delivery) => {
        return delivery.status === "failed";
      });
      expect(pendingDeliveries).toHaveLength(1);
      expect(failedDeliveries).toHaveLength(1);
      expect(failedDeliveries[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("already in progress"),
        retryable: true,
      });
      const pendingDelivery = pendingDeliveries[0];
      if (!pendingDelivery || pendingDelivery.status !== "pending") {
        throw new Error("Expected one authoritative pending Slack delivery");
      }
      const staleFileId = allocations.find((fileId) => {
        return fileId !== pendingDelivery.fileId;
      });
      if (!staleFileId) {
        throw new Error("Expected a stale concurrent Slack file allocation");
      }

      const completeClient = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const staleCompletion = await fixture.run(() => {
        return accept(
          completeClient.complete({
            body: {
              fileId: staleFileId,
              channel: "C123",
              threadTs: "123.456",
              canonicalAssetId,
              operationId,
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(staleCompletion.body).toMatchObject({
        fileId: staleFileId,
        assetId: canonicalAssetId,
        deliveryStatus: "failed",
        deliveryError: expect.stringContaining("already in progress"),
      });

      mockSlackFileInfo(pendingDelivery.fileId);
      const completed = await fixture.run(() => {
        return accept(
          completeClient.complete({
            body: {
              fileId: pendingDelivery.fileId,
              channel: "C123",
              threadTs: "123.456",
              canonicalAssetId,
              operationId,
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(completed.body).toMatchObject({
        fileId: pendingDelivery.fileId,
        assetId: canonicalAssetId,
        deliveryStatus: "delivered",
      });

      const staleFailure = await fixture.run(() => {
        return accept(
          completeClient.complete({
            body: {
              fileId: staleFileId,
              channel: "C123",
              threadTs: "123.456",
              canonicalAssetId,
              operationId,
              uploadError: "stale upload failed",
            },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      expect(staleFailure.body).toMatchObject({
        fileId: pendingDelivery.fileId,
        assetId: canonicalAssetId,
        deliveryStatus: "delivered",
      });

      const rematerialized = await fixture.run(() => {
        return materialize();
      });
      expect(rematerialized.body.delivery).toMatchObject({
        status: "delivered",
        fileId: pendingDelivery.fileId,
        permalink: `https://slack.example/files/${pendingDelivery.fileId}`,
      });
    });
  });

  it("records an uploaded Slack video in its thread artifacts", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const fileId = `F-${randomUUID().slice(0, 8)}`;
      const permalink = `https://slack.example/files/${fileId}`;
      context.mocks.slack.files.info.mockResolvedValue({
        ok: true,
        file: {
          id: fileId,
          name: "demo.mp4",
          title: "Demo video",
          mimetype: "video/mp4",
          filetype: "mp4",
          size: 1024,
          permalink,
        },
      });
      const token = okouToken({
        userId,
        orgId,
        runId,
      });

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId, channel: "C123", title: "Demo video" },
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      const files = await fixture.run(() => {
        return visibleUploadedFiles({
          orgId,
          userId,
          runId,
          threadId,
        });
      });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        id: fileId,
        filename: "Demo video",
        contentType: "video/mp4",
        url: permalink,
      });
    });
  });

  it("does not record a run association for ordinary clerk session auth", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const fileId = `F-${randomUUID().slice(0, 8)}`;
      mockSlackFileInfo(fileId);
      mocks.clerk.session(userId, orgId);

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const response = await fixture.run(() => {
        return accept(
          client.complete({
            body: { fileId, channel: "C123", title: "Session upload" },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      });

      expect(response.body).toMatchObject({
        fileId,
        permalink: `https://slack.example/files/${fileId}`,
      });

      const files = await fixture.run(() => {
        return visibleUploadedFiles({
          orgId,
          userId,
          runId,
          threadId,
        });
      });
      expect(files).toStrictEqual([]);
    });
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, threadId } = await fixture.run(() => {
        return seedRunScoped();
      });
      const fileId = `F-${randomUUID().slice(0, 8)}`;
      mockSlackFileInfo(fileId);
      const token = okouToken({ userId, orgId, runId });

      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const body = { fileId, channel: "C123", title: "Retry upload" };

      await fixture.run(() => {
        return accept(
          client.complete({
            body,
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });
      await fixture.run(() => {
        return accept(
          client.complete({
            body,
            headers: { authorization: `Bearer ${token}` },
          }),
          [200],
        );
      });

      const files = await fixture.run(() => {
        return visibleUploadedFiles({
          orgId,
          userId,
          runId,
          threadId,
        });
      });
      expect(files).toHaveLength(1);
    });
  });
});
