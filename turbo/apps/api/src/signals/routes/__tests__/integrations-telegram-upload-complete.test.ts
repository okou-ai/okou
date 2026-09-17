import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/telegram";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";

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

interface UploadCompleteFixture extends TelegramFixture {
  readonly composeId: string;
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
}): Promise<{ readonly runId: string; readonly threadId: string }> {
  const actor = actorFor(args);
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const runnerGroup = runsApi.configureRunnerGroup();
  await runsApi.heartbeatRunner(runnerGroup);
  const agent = await bdd.createAgent(actor, {
    displayName: `Telegram upload ${randomUUID().slice(0, 8)}`,
  });
  const sent = await chatApi.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "Create a run for Telegram upload completion",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected chat send to create a run for Telegram upload");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
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
  const telegramBotId = uniqueBotId();
  const installation = await store.set(
    seedTelegramInstallation$,
    { orgId, ownerUserId: userId, telegramBotId },
    context.signal,
  );
  const { runId, threadId } = await createRunScopedChat({ orgId, userId });
  return {
    orgId,
    composeIds: [installation.composeId],
    composeId: installation.composeId,
    telegramBotIds: [telegramBotId],
    telegramBotId,
    userIds: [userId],
    userId,
    runId,
    threadId,
  };
}

describe("POST /api/integrations/telegram/upload-file/complete", () => {
  const fixtures: UploadCompleteFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it.each([false, true])(
    "delivers file bytes through Telegram (private=%s)",
    async (privateFiles) => {
      const fixture = await seedSendableContext();
      fixtures.push(fixture);

      let uploadId: string = randomUUID();
      const telegramFileId = `tg-doc-${randomUUID().slice(0, 8)}`;
      const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
      let fileUrl = `https://cdn.vm7.io/artifacts/${fixture.userId}/${uploadId}/report.pdf`;

      if (privateFiles) {
        await updateFeatureSwitchesForUser(context, fixture, {
          [FeatureSwitchKey.PrivateArtifacts]: true,
        });
        installSharedThreadStorage(context);
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
          "https://api.telegram.org/bottest-bot-token/sendDocument",
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

  it("returns 404 when the bot id is not owned by the org", async () => {
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

  it("returns 403 when authenticated without an organization context", async () => {
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
          botId: uniqueBotId(),
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
    fixtures.push(fixture);

    const uploadId = randomUUID();
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
    ]);

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendDocument",
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
  });
});
