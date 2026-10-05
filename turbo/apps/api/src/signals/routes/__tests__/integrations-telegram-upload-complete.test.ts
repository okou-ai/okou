import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import {
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { deleteTelegramFixture$ } from "./helpers/telegram";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function uniqueBotId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

interface UploadCompleteFixture {
  readonly orgId: string;
  readonly telegramBotId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

function actorFor(args: {
  readonly orgId: string;
  readonly userId: string;
}): ApiTestUser {
  return {
    orgId: args.orgId,
    userId: args.userId,
    orgRole: "org:admin",
    email: `${args.userId}@example.test`,
  };
}

async function createRunScopedChat(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}> {
  const actor = actorFor(args);
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensurePersonalSubscriptionModel(actor);
  const runnerGroup = runsApi.configureRunnerGroup();
  await runsApi.heartbeatRunner(runnerGroup);
  const agent = await bdd.createAgent(actor, {
    displayName: `Telegram upload ${randomUUID().slice(0, 8)}`,
  });
  const sent = await chatApi.sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: "Create a run for Telegram upload completion",
  });
  return { runId: sent.runId, threadId: sent.threadId, agentId: agent.agentId };
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

async function seedSendableContext(): Promise<UploadCompleteFixture> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  const { runId, threadId, agentId } = await createRunScopedChat({
    orgId,
    userId,
  });
  onTestFinished(async () => {
    await runsApi.requestCancelRun(actorFor({ orgId, userId }), runId, [200]);
    await flushWaitUntilForTest();
    await bdd.deleteAgent(actorFor({ orgId, userId }), agentId);
    await deleteFeatureSwitchesForUser(context, { orgId, userId });
    await store.set(
      deleteTelegramFixture$,
      {
        orgId,
        composeIds: [],
        userIds: [userId],
      },
      context.signal,
    );
  });
  return {
    orgId,
    telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
    userId,
    runId,
    threadId,
  };
}

describe("POST /api/integrations/telegram/upload-file/complete", () => {
  beforeEach(() => {
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", "987654:official-upload-token");
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
  });

  it.each([false, true])(
    "delivers file bytes through Telegram (private=%s)",
    async (privateFiles) => {
      const fixture = await seedSendableContext();

      let uploadId: string = randomUUID();
      const telegramFileId = `tg-doc-${randomUUID().slice(0, 8)}`;
      const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
      let fileUrl = `https://cdn.vm7.io/artifacts/${fixture.userId}/${uploadId}/report.pdf`;

      if (privateFiles) {
        await updateFeatureSwitchesForUser(context, fixture, {
          [FeatureSwitchKey.PrivateArtifacts]: true,
        });
        installSharedThreadStorage(context);
        mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
        const initialized = await accept(
          setupApp({ context, routes: integrationsTelegramUploadInitRoutes })(
            integrationsTelegramUploadInitContract,
          ).init({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              filename: "report.pdf",
              contentType: "application/pdf",
              length: 1234,
            },
          }),
          [200],
        );
        uploadId = initialized.body.uploadId;
        fileUrl = initialized.body.fileUrl;
        expect(
          (
            await fetch(initialized.body.uploadUrl, {
              method: "PUT",
              body: Buffer.alloc(1234),
            })
          ).status,
        ).toBe(200);
        // The object retains its private layout after the user's flag changes.
        await updateFeatureSwitchesForUser(context, fixture, {
          [FeatureSwitchKey.PrivateArtifacts]: false,
        });
      } else {
        mocks.s3.listObjects([
          { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
        ]);
      }

      let telegramBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "https://api.telegram.org/bot987654:official-upload-token/sendDocument",
          async ({ request }) => {
            telegramBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ok: true,
              result: {
                message_id: 321,
                chat: { id: -1_001_234_567_890 },
                document: {
                  file_id: telegramFileId,
                  file_unique_id: "tg-doc-unique",
                  file_name: "report.pdf",
                  mime_type: "application/pdf",
                  file_size: 1234,
                },
              },
            });
          },
        ),
      );

      const client = setupApp({
        context,
        routes: integrationsTelegramUploadCompleteRoutes,
      })(integrationsTelegramUploadCompleteContract);
      const response = await accept(
        client.complete({
          body: {
            uploadId,
            botId: fixture.telegramBotId,
            chatId: "-1001234567890",
            contentType: "application/pdf",
            caption: "Daily report",
            messageThreadId: 42,
          },
          headers: {
            authorization: `Bearer ${okouToken({
              userId: fixture.userId,
              orgId: fixture.orgId,
              runId: fixture.runId,
            })}`,
          },
        }),
        [200],
      );

      expect(telegramBody).toMatchObject({
        chat_id: "-1001234567890",
        document: privateFiles
          ? "https://attachment-storage.example/download"
          : fileUrl,
        caption: "Daily report",
        message_thread_id: 42,
      });
      expect(response.body).toMatchObject({
        messageId: 321,
        chatId: "-1001234567890",
        fileId: telegramFileId,
        filename: "report.pdf",
        mimetype: "application/pdf",
        size: 1234,
        url: fileUrl,
      });

      const files = await visibleUploadedFiles(fixture);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        id: telegramFileId,
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 1234,
        url: fileUrl,
      });
    },
  );

  it("returns 404 for an unsupported bot id", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramUploadCompleteRoutes,
    })(integrationsTelegramUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: uniqueBotId(),
          chatId: "-1001234567890",
        },
        headers: {
          authorization: `Bearer ${okouToken({ userId, orgId, runId })}`,
        },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 403 when the token has no organization membership", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const client = setupApp({
      context,
      routes: integrationsTelegramUploadCompleteRoutes,
    })(integrationsTelegramUploadCompleteContract);

    const response = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "-1001234567890",
        },
        headers: {
          authorization: `Bearer ${okouToken({ userId, orgId, runId })}`,
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization context is required",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 when Telegram rejects the sendDocument call", async () => {
    const fixture = await seedSendableContext();

    const uploadId = randomUUID();
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
    ]);

    server.use(
      http.post(
        "https://api.telegram.org/bot987654:official-upload-token/sendDocument",
        () => {
          return HttpResponse.json(
            { ok: false, description: "Bad Request: chat not found" },
            { status: 400 },
          );
        },
      ),
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramUploadCompleteRoutes,
    })(integrationsTelegramUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          contentType: "application/pdf",
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("chat not found");
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
    await expect(visibleUploadedFiles(fixture)).resolves.toStrictEqual([]);
  });
});
