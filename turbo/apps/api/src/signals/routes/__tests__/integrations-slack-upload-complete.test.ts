import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { createHash, randomUUID } from "node:crypto";
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
import {
  chatThreadArtifactsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";

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
  const historyHash = createHash("sha256")
    .update(`canonical Slack upload ${args.runId}`)
    .digest("hex");
  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `canonical-slack-${args.runId}`,
        cliAgentSessionHistoryHash: historyHash,
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
    const actors = new Map<string, ApiTestUser>();
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
    scenario.beforeWorkspaceCleanup(async () => {
      for (const actor of actors.values()) {
        if (!actor.orgId) {
          throw new Error("Expected the owned Slack organization");
        }
        await deleteFeatureSwitchesForUser(context, {
          ...actor,
          orgId: actor.orgId,
        });
      }
    });
    async function seedBaseContext() {
      const actor = scenario.user({ orgRole: "org:admin" });
      if (!actor.orgId) {
        throw new Error("Expected a Slack organization");
      }
      const orgId = actor.orgId;
      actors.set(actor.userId, actor);
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
    async function connectMember(base: {
      readonly orgId: string;
      readonly userId: string;
      readonly slackWorkspaceId: string;
    }) {
      const connection = await scenario.run(() => {
        return slackOrgs.connectMember({ ...base, run: scenario.run });
      });
      await restoreMembership(base);
      return connection;
    }
    async function seedWithInstallation() {
      const base = await seedBaseContext();
      const installed = await scenario.run(() => {
        return slackOrgs.installForOrg({
          orgId: base.orgId,
          installer: scenario.user({ orgId: base.orgId, orgRole: "org:admin" }),
          run: scenario.run,
        });
      });
      await restoreMembership(base);
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

  it("does not revive a canonical file erased while storage verification is pending", async () => {
    const fixture = createUploadFixture();
    const upload = await pendingCanonicalUpload(fixture);
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
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
    const pending = fixture.run(() => {
      return accept(
        setupApp({ context, routes: integrationsSlackUploadMaterializeRoutes })(
          integrationsSlackUploadMaterializeContract,
        ).materialize(upload.request),
        [404],
      );
    });
    await started.promise;
    await fixture.cancelRun(actorFor(upload.actor), upload.actor.runId);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: upload.actor.userId },
    });
    await fixture.run(() => {
      return webhooks.requestClerkWebhook("{}", {}, [200]);
    });
    await flushWaitUntilForTest();
    release.resolve(undefined);
    const result = await pending;
    expect(result.body.error.code).toBe("NOT_FOUND");
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

  it("opens a DM for a direct completion addressed to the current user", async () => {
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
            body: { fileId, user: "me", title: "Self report" },
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
      expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
        users: slackUserId,
      });
      expect(
        context.mocks.slack.files.completeUploadExternal,
      ).toHaveBeenLastCalledWith({
        files: [{ id: fileId, title: "Self report" }],
        channel_id: "D-SELF",
      });
    });
  });

  it("persists the current user's DM channel for a canonical upload", async () => {
    const fixture = createUploadFixture();
    const { seedRunScoped, connectMember, okouToken } = fixture;
    await fixture.run(async () => {
      const { orgId, userId, runId, slackWorkspaceId } = await fixture.run(
        () => {
          return seedRunScoped();
        },
      );
      await fixture.run(() => {
        return updateFeatureSwitchesForUser(
          context,
          { userId, orgId },
          { [FeatureSwitchKey.PrivateArtifacts]: false },
        );
      });
      const { slackUserId } = await fixture.run(() => {
        return connectMember({
          orgId,
          userId,
          slackWorkspaceId,
        });
      });
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
                user: "me",
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
      expect(context.mocks.slack.conversations.open).toHaveBeenLastCalledWith({
        users: slackUserId,
      });

      objectStore.addObject({
        bucket: "test-user-artifacts",
        key: `artifacts/${new URL(initialized.body.url).pathname.replace(/^\/+/u, "")}`,
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
          setupApp({ context, routes: integrationsSlackUploadCompleteRoutes })(
            integrationsSlackUploadCompleteContract,
          ).complete({
            body: {
              fileId: "F-SELF",
              user: "me",
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
  });

  it.each([
    { privateFiles: false, artifactUpload: false },
    { privateFiles: true, artifactUpload: false },
    { privateFiles: false, artifactUpload: true },
    { privateFiles: true, artifactUpload: true },
  ])(
    "keeps one canonical output across Slack and Drive after a flag change (private=$privateFiles, artifactUpload=$artifactUpload)",
    async ({ privateFiles, artifactUpload }) => {
      const fixture = createUploadFixture();
      const { seedRunScoped, okouToken, sandboxToken, claimRun } = fixture;
      await fixture.run(async () => {
        const { orgId, userId, runId, threadId, runnerGroup, agentId } =
          await fixture.run(() => {
            return seedRunScoped();
          });
        await fixture.run(() => {
          return updateFeatureSwitchesForUser(
            context,
            { userId, orgId },
            { [FeatureSwitchKey.PrivateArtifacts]: privateFiles },
          );
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
        expect(initialized.body.uploadHeaders).toStrictEqual(
          privateFiles
            ? {
                "x-amz-meta-artifact-id": canonicalAssetId,
              }
            : {
                "x-amz-meta-artifact-id": canonicalAssetId,
                "x-amz-meta-filename": "report.csv",
                "x-amz-meta-public-brand": "okou",
                "x-amz-meta-user-id": encodeURIComponent(userId),
              },
        );
        expect(
          context.mocks.slack.files.getUploadURLExternal,
        ).not.toHaveBeenCalled();
        const storageKey = privateFiles
          ? `private-artifacts/${canonicalAssetId}/report.csv`
          : `artifacts/${new URL(initialized.body.url).pathname.replace(/^\/+/u, "")}`;
        if (privateFiles) {
          expect(initialized.body.url).toMatch(
            /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.csv$/u,
          );
        } else {
          expect(initialized.body.url).toMatch(
            /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.csv$/u,
          );
        }
        await fixture.run(() => {
          return updateFeatureSwitchesForUser(
            context,
            { userId, orgId },
            { [FeatureSwitchKey.PrivateArtifacts]: !privateFiles },
          );
        });
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
            Bucket: privateFiles
              ? "test-private-artifacts"
              : "test-user-artifacts",
            Key: storageKey,
          },
        });
        objectStore.addObject({
          bucket: privateFiles
            ? "test-private-artifacts"
            : "test-user-artifacts",
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

        if (privateFiles) {
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
        }
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
        })(chatThreadArtifactsContract);
        const driveSync = await fixture.run(() => {
          return accept(
            driveClient.syncGoogleDrive({
              headers: { authorization: "Bearer clerk-session" },
              params: { threadId },
              body: { runId, fileId: canonicalAssetId },
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
            driveClient.syncGoogleDrive({
              headers: { authorization: "Bearer clerk-session" },
              params: { threadId },
              body: { runId, fileId: canonicalAssetId },
            }),
            [200],
          );
        });
        expect(retryDriveSync.body.name).toBe("report.csv");

        const runDriveSync = await fixture.run(() => {
          return accept(
            driveClient.syncGoogleDrive({
              headers: {
                authorization: `Bearer ${okouToken({
                  userId,
                  orgId,
                  runId,
                })}`,
              },
              params: { threadId },
              body: { runId, fileId: canonicalAssetId },
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
          expect(body).toContain(`"vm0FileId":"${canonicalAssetId}"`);
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
          expect(finalReply).not.toHaveProperty("attachFiles");

          const lifecycleMarker = messages.events.find(
            (message): message is CompletedChatEvent => {
              return (
                message.eventType === "run.completed" &&
                message.runId === runId &&
                message.runLifecycleEvent === "completed"
              );
            },
          );
          expect(lifecycleMarker).toBeDefined();
          expect(lifecycleMarker?.content).toBeNull();
          expect(lifecycleMarker).not.toHaveProperty("attachFiles");
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
              params: { artifactId: "not-an-artifact-id" },
            }),
            [400],
          );
        });
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

        // Public upload writers have no canonical materialization state. They
        // remain independently uploadable both with and without a catalog row.
        await fixture.run(() => {
          return updateFeatureSwitchesForUser(
            context,
            { userId, orgId },
            { [FeatureSwitchKey.PrivateArtifacts]: false },
          );
        });
        const ordinary = await fixture.run(() => {
          return chatApi.prepareUpload(actor, {
            filename: "ordinary.csv",
            contentType: "text/csv",
            size: 42,
            purpose: "artifact",
          });
        });
        objectStore.addObject({
          bucket: "test-user-artifacts",
          key: `artifacts/${new URL(ordinary.url).pathname.replace(/^\/+/u, "")}`,
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
        const site = await fixture.run(() => {
          return chatApi.prepareHostedSiteWithBearer(hostBearer, {
            site: `drive-companion-${randomUUID().slice(0, 8)}`,
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
        const groupedCatalog = await fixture.run(() => {
          return chatApi.listArtifactCatalog(actor);
        });
        expect(
          groupedCatalog.artifacts.some((entry) => {
            return entry.id === catalogEntry.id;
          }),
        ).toBeFalsy();
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
      expect(lifecycleMarker).toBeDefined();
      expect(lifecycleMarker?.content).toBeNull();
      expect(lifecycleMarker).not.toHaveProperty("attachFiles");
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
