import { http, HttpResponse } from "msw";
import { randomInt, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

import {
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";

import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { createPublicTelegramActor } from "./helpers/public-telegram-actor";

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const bdd = createBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);

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

async function seedSendableContext() {
  const runnerGroup = runsApi.configureRunnerGroup();
  let restoreInvoice: (() => void) | undefined;
  const fixture = createPublicTelegramActor(
    context,
    {},
    {
      restoreEnvironment: () => {
        restoreInvoice?.();
      },
    },
  );
  await fixture.onboard();
  await fixture.link(String(randomInt(100_000_000, 999_999_999)));
  await fixture.run(() => {
    return runsApi.grantProEntitlement(fixture.actor, {
      onExternalStateReady: (restore) => {
        restoreInvoice = restore;
      },
    });
  });
  restoreInvoice = undefined;
  await fixture.run(() => {
    return runsApi.ensurePersonalSubscriptionModel(fixture.actor);
  });
  await fixture.run(() => {
    return runsApi.updateUserModelPreference(fixture.actor, "claude-fable-5-1");
  });
  const agent = await fixture.run(() => {
    return bdd.createAgent(fixture.actor, { displayName: "Telegram upload" });
  });
  const sent = await fixture.run(() => {
    return chatApi.sendAndLaunch(fixture.actor, {
      agentId: agent.agentId,
      prompt: "Create a run for Telegram upload completion",
    });
  });
  await fixture.run(() => {
    return runsApi.heartbeatRunner(runnerGroup);
  });
  const claim = await fixture.run(async () => {
    const accepted = await runsApi.claimRunnerJob(sent.runId);
    fixture.rememberClaim(sent.runId, accepted.sandboxToken);
    return accepted;
  });
  return {
    ...fixture,
    ...sent,
    token: okouTokenFromClaim(claim),
    telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
  };
}

describe("POST /api/integrations/telegram/upload-file/complete", () => {
  beforeEach(() => {
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", "987654:official-upload-token");
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_upload_bot");
    server.use(
      http.get(
        "https://api.telegram.org/bot987654:official-upload-token/getChat",
        () => {
          return HttpResponse.json({
            ok: true,
            result: {
              id: -1_001_234_567_890,
              type: "supergroup",
              permissions: {
                can_send_messages: true,
                can_send_documents: true,
              },
            },
          });
        },
      ),
      http.get(
        "https://api.telegram.org/bot987654:official-upload-token/getChatMember",
        ({ request }) => {
          return HttpResponse.json({
            ok: true,
            result: {
              user: {
                id: Number(new URL(request.url).searchParams.get("user_id")),
              },
              status: "member",
            },
          });
        },
      ),
    );
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
  });

  it("delivers private file bytes through Telegram", async () => {
    const fixture = await seedSendableContext();
    await fixture.run(async () => {
      const telegramFileId = `tg-doc-${randomUUID().slice(0, 8)}`;
      installSharedThreadStorage(context);
      fixture.session();
      const initialized = await accept(
        fixture.run(async () => {
          return await setupApp({
            context,
            routes: integrationsTelegramUploadInitRoutes,
          })(integrationsTelegramUploadInitContract).init({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              filename: "report.pdf",
              contentType: "application/pdf",
              length: 1234,
            },
          });
        }),
        [200],
      );
      const { uploadId, fileUrl } = initialized.body;
      expect(
        (
          await fixture.run(async () => {
            return await fetch(initialized.body.uploadUrl, {
              method: "PUT",
              headers: initialized.body.uploadHeaders,
              body: Buffer.alloc(1234),
            });
          })
        ).status,
      ).toBe(200);

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
        fixture.run(async () => {
          return await client.complete({
            body: {
              uploadId,
              botId: fixture.telegramBotId,
              chatId: "-1001234567890",
              contentType: "application/pdf",
              caption: "Daily report",
              messageThreadId: 42,
            },
            headers: {
              authorization: `Bearer ${fixture.token}`,
            },
          });
        }),
        [200],
      );

      expect(telegramBody).toMatchObject({
        chat_id: "-1001234567890",
        document: "https://attachment-storage.example/download",
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
    });
  });

  it("returns 403 when the token has no organization membership", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const token = await credentials.okouToken({ userId, orgId });
    await credentials.removeMember({ userId, orgId });
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
          authorization: `Bearer ${token}`,
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
    await fixture.run(async () => {
      installSharedThreadStorage(context);
      fixture.session();
      const initialized = await accept(
        fixture.run(async () => {
          return await setupApp({
            context,
            routes: integrationsTelegramUploadInitRoutes,
          })(integrationsTelegramUploadInitContract).init({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              filename: "report.pdf",
              contentType: "application/pdf",
              length: 1234,
            },
          });
        }),
        [200],
      );
      const { uploadId } = initialized.body;
      expect(
        (
          await fixture.run(async () => {
            return await fetch(initialized.body.uploadUrl, {
              method: "PUT",
              headers: initialized.body.uploadHeaders,
              body: Buffer.alloc(1234),
            });
          })
        ).status,
      ).toBe(200);

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
        fixture.run(async () => {
          return await client.complete({
            body: {
              uploadId,
              botId: fixture.telegramBotId,
              chatId: "-1001234567890",
              contentType: "application/pdf",
            },
            headers: {
              authorization: `Bearer ${fixture.token}`,
            },
          });
        }),
        [400],
      );
      expect(response.body.error.message).toContain("chat not found");
      expect(response.body.error.code).toBe("TELEGRAM_ERROR");
      await expect(visibleUploadedFiles(fixture)).resolves.toStrictEqual([]);
    });
  });
});
