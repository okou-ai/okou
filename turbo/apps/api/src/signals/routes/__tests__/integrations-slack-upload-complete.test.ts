import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createHash, randomUUID } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
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
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
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
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/integrations-slack";
import {
  deleteUsageStateFixture$,
  type UsageStateFixture,
} from "./helpers/usage-state";
import { integrationsSlackUploadCompleteRoutes } from "../integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "../integrations-slack-upload-materialize";
import { chatThreadsArtifactsSyncRoutes } from "../chat-threads-artifacts-sync";

type CompletedChatEvent = Extract<ChatEvent, { eventType: "run.completed" }>;

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
      checkpoint: {
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

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly runnerGroup: string;
  readonly agentId: string;
}

describe("POST /api/integrations/slack/upload-file/complete", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const usageFixtures: UsageStateFixture[] = [];

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

  afterEach(async () => {
    while (slackFixtures.length > 0) {
      const fixture = slackFixtures.pop();
      if (fixture) {
        await store.set(
          deleteSlackIntegrationFixture$,
          fixture,
          context.signal,
        );
      }
    }
    while (usageFixtures.length > 0) {
      const fixture = usageFixtures.pop();
      if (fixture) {
        await store.set(deleteUsageStateFixture$, fixture, context.signal);
      }
    }
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

  async function seedBaseContext(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    usageFixtures.push({ orgId, userId });
    return { orgId, userId };
  }

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return base;
  }

  async function seedRunScoped(): Promise<RunScopedContext> {
    const base = await seedWithInstallation();
    const actor = actorFor(base);
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const runnerGroup = runsApi.configureRunnerGroup();
    await runsApi.heartbeatRunner(runnerGroup);
    const agent = await bdd.createAgent(actor, {
      displayName: `Slack upload ${randomUUID().slice(0, 8)}`,
    });
    const sent = await chatApi.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Create a run for Slack upload completion",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected chat send to create a run for Slack upload");
    }
    return {
      orgId: base.orgId,
      userId: base.userId,
      runId: sent.body.runId,
      threadId: sent.body.threadId,
      runnerGroup,
      agentId: agent.agentId,
    };
  }

  async function claimRun(runnerGroup: string, runId: string) {
    await runsApi.heartbeatRunner(runnerGroup);
    let response:
      | Awaited<ReturnType<typeof runsApi.requestClaimRunnerJob>>
      | undefined;
    await expect
      .poll(
        async () => {
          response = await runsApi.requestClaimRunnerJob(
            true,
            runId,
            [200, 404],
          );
          return response.status;
        },
        { interval: 100, timeout: 10_000 },
      )
      .toBe(200);
    if (!response || response.status !== 200) {
      throw new Error("Expected the canonical upload run to be claimable");
    }
    return response.body;
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
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
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { orgId, userId } = await seedBaseContext();
    const token = okouToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
  });

  it("forwards Slack file info errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    const token = okouToken({ userId, orgId, runId });
    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("file_not_found");
    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("records a Slack upload for a run-scoped agent token", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = okouToken({ userId, orgId, runId });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
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

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
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

  it.each([false, true])(
    "keeps one canonical output across Slack and Drive after a flag change (private=%s)",
    async (privateFiles) => {
      const { orgId, userId, runId, threadId, runnerGroup, agentId } =
        await seedRunScoped();
      await updateFeatureSwitchesForUser(
        context,
        { userId, orgId },
        { [FeatureSwitchKey.PrivateArtifacts]: privateFiles },
      );
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
      const initialized = await accept(
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
      await updateFeatureSwitchesForUser(
        context,
        { userId, orgId },
        { [FeatureSwitchKey.PrivateArtifacts]: !privateFiles },
      );
      const retry = await accept(
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
        bucket: privateFiles ? "test-private-artifacts" : "test-user-artifacts",
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
      const materialized = await accept(
        materializeClient.materialize({
          body: {
            assetId: canonicalAssetId,
            operationId,
          },
          headers: { authorization: `Bearer ${token}` },
        }),
        [200],
      );
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

      const catalog = await chatApi.listArtifactCatalog(
        actorFor({ orgId, userId }),
      );
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
      const catalogDetail = await chatApi.getArtifactCatalogEntry(
        actorFor({ orgId, userId }),
        catalogEntry.id,
      );
      if (catalogDetail.kind !== "file") {
        throw new Error("Expected canonical output to use the file kind");
      }
      expect(catalogDetail.file.id).toBe(canonicalAssetId);

      const completeClient = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      const completed = await accept(
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
      expect(completed.body).toMatchObject({
        fileId: "F-CANONICAL",
        assetId: canonicalAssetId,
        deliveryStatus: "delivered",
      });

      if (privateFiles) {
        await chatApi.requestSendEvent(
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
        await flushWaitUntilForTest();
      }
      const files = await visibleUploadedFiles({
        orgId,
        userId,
        runId,
        threadId,
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
      const oauth = await connectorsApi.startOauth(
        actorFor({ orgId, userId }),
        "google-drive",
        "oauth",
      );
      await connectorsApi.completeOauthCallback("google-drive", {
        code: "canonical-asset-drive",
        state: authorizationState(oauth.authorizationUrl),
      });
      await runsApi.enableAgentConnectors(
        actorFor({ orgId, userId }),
        agentId,
        ["google-drive"],
      );

      const driveFolders: DriveFolderFixture[] = [];
      const driveUploadBodies: string[] = [];
      const driveUploadContentTypes: (string | null)[] = [];
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
            const body = (await request.json()) as {
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
        http.post(
          "https://www.googleapis.com/upload/drive/v3/files",
          async ({ request }) => {
            driveUploadContentTypes.push(request.headers.get("content-type"));
            driveUploadBodies.push(await request.text());
            return HttpResponse.json({
              id: "drive-canonical-asset",
              name: "report.csv",
              webViewLink:
                "https://drive.google.com/file/d/drive-canonical-asset/view",
            });
          },
        ),
      );
      mocks.clerk.session(userId, orgId);
      const driveClient = setupApp({
        baseUrl: "https://api.okou.ai",
        context,
        routes: chatThreadsArtifactsSyncRoutes,
      })(chatThreadArtifactsContract);
      const driveSync = await accept(
        driveClient.syncGoogleDrive({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId },
          body: { runId, fileId: canonicalAssetId },
        }),
        [200],
      );
      expect(driveSync.body).toStrictEqual({
        id: "drive-canonical-asset",
        name: "report.csv",
        webViewLink:
          "https://drive.google.com/file/d/drive-canonical-asset/view",
      });

      const retryDriveSync = await accept(
        driveClient.syncGoogleDrive({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId },
          body: { runId, fileId: canonicalAssetId },
        }),
        [200],
      );
      expect(retryDriveSync.body.name).toBe("report.csv");

      const runDriveSync = await accept(
        driveClient.syncGoogleDrive({
          headers: {
            authorization: `Bearer ${okouToken({
              userId,
              orgId,
              runId,
              capabilities: ["file:write"],
            })}`,
          },
          params: { threadId },
          body: { runId, fileId: canonicalAssetId },
        }),
        [200],
      );
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
          return contentType?.startsWith(
            "multipart/related; boundary=multipart-",
          );
        }),
      ).toBeTruthy();

      const claim = await claimRun(runnerGroup, runId);
      await completeRun({
        runId,
        sandboxToken: claim.sandboxToken,
        events: [assistantEvent(0, "The canonical report is ready.")],
        lastEventSequence: 0,
      });

      const messages = await chatApi.listThreadEvents(
        actorFor({ orgId, userId }),
        threadId,
      );
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
    },
    20_000,
  );

  it("keeps an attachment-only output out of the event stream", async () => {
    const { orgId, userId, runId, threadId, runnerGroup } =
      await seedRunScoped();
    chatCallbacks.acceptChatObjectStorage();
    const operationId = randomUUID();
    const token = okouToken({ userId, orgId, runId });
    const initClient = setupApp({
      context,
      routes: integrationsSlackUploadInitRoutes,
    })(integrationsSlackUploadInitContract);
    const initialized = await accept(
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
    if (!("kind" in initialized.body)) {
      throw new Error("Expected canonical Slack upload initialization");
    }
    const claim = await claimRun(runnerGroup, runId);
    await completeRun({
      runId,
      sandboxToken: claim.sandboxToken,
      events: [],
    });

    const messages = await chatApi.listThreadEvents(
      actorFor({ orgId, userId }),
      threadId,
    );
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
  }, 20_000);

  it("keeps a canonical Slack delivery failed when file info has no permalink", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
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
    const initialized = await accept(
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
    if (!("kind" in initialized.body)) {
      throw new Error("Expected canonical Slack upload initialization");
    }
    const canonicalAssetId = initialized.body.assetId;
    const storageKey = `artifacts${new URL(initialized.body.url).pathname}`;
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: storageKey,
      size: 42,
      body: Buffer.alloc(42, "a"),
    });

    const materializeClient = setupApp({
      context,
      routes: integrationsSlackUploadMaterializeRoutes,
    })(integrationsSlackUploadMaterializeContract);
    const materialized = await accept(
      materializeClient.materialize({
        body: { assetId: canonicalAssetId, operationId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(materialized.body.delivery).toMatchObject({
      status: "pending",
      fileId,
    });

    const completeClient = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const completed = await accept(
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
    expect(completed.body).toMatchObject({
      fileId,
      assetId: canonicalAssetId,
      permalink: "",
      deliveryStatus: "failed",
      deliveryError: "Slack file info did not include a permalink",
    });
  });

  it("keeps one Slack delivery authoritative across concurrent retries", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const operationId = randomUUID();
    const token = okouToken({ userId, orgId, runId });
    const allocations: string[] = [];
    const bothAllocationsStarted = createDeferredPromise<void>(context.signal);
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
        await bothAllocationsStarted.promise;
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
    const initialized = await accept(
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
    if (!("kind" in initialized.body)) {
      throw new Error("Expected canonical Slack upload initialization");
    }
    const canonicalAssetId = initialized.body.assetId;
    const storageKey = `artifacts${new URL(initialized.body.url).pathname}`;
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: storageKey,
      size: 42,
      body: Buffer.alloc(42, "a"),
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
    const materialized = await Promise.all([materialize(), materialize()]);
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
    const staleCompletion = await accept(
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
    expect(staleCompletion.body).toMatchObject({
      fileId: staleFileId,
      assetId: canonicalAssetId,
      deliveryStatus: "failed",
      deliveryError: expect.stringContaining("already in progress"),
    });

    mockSlackFileInfo(pendingDelivery.fileId);
    const completed = await accept(
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
    expect(completed.body).toMatchObject({
      fileId: pendingDelivery.fileId,
      assetId: canonicalAssetId,
      deliveryStatus: "delivered",
    });

    const staleFailure = await accept(
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
    expect(staleFailure.body).toMatchObject({
      fileId: pendingDelivery.fileId,
      assetId: canonicalAssetId,
      deliveryStatus: "delivered",
    });

    const rematerialized = await materialize();
    expect(rematerialized.body.delivery).toMatchObject({
      status: "delivered",
      fileId: pendingDelivery.fileId,
      permalink: `https://slack.example/files/${pendingDelivery.fileId}`,
    });
  });

  it("stores a Slack video preview in the configured artifact host", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
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
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const frameRequests: string[] = [];
    server.use(
      http.get(
        /^https:\/\/a\.okou\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//,
        ({ request }) => {
          frameRequests.push(request.url);
          return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "Content-Type": "image/jpeg" },
          });
        },
      ),
    );
    const token = okouToken({
      userId,
      orgId,
      runId,
    });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    await accept(
      client.complete({
        body: { fileId, channel: "C123", title: "Demo video" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(frameRequests).toStrictEqual([
      `https://a.okou.io/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${permalink}`,
    ]);
    expect(
      objectStore.puts.some((put) => {
        return (
          put.bucket === "test-user-artifacts" &&
          /^artifacts\/[0-9a-z]{10}\.jpg$/u.test(put.key) &&
          put.contentType === "image/jpeg" &&
          put.metadata?.["public-brand"] === "okou"
        );
      }),
    ).toBeTruthy();
    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: fileId,
      previewImageUrl: expect.stringMatching(
        /^https:\/\/a\.okou\.io\/[0-9a-z]{10}\.jpg$/u,
      ),
    });
  });

  it("does not record a run association for ordinary clerk session auth", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123", title: "Session upload" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = okouToken({ userId, orgId, runId });

    const client = setupApp({
      context,
      routes: integrationsSlackUploadCompleteRoutes,
    })(integrationsSlackUploadCompleteContract);
    const body = { fileId, channel: "C123", title: "Retry upload" };

    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );
    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
  });
});
