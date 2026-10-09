import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
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
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicTelegramActor } from "./helpers/public-telegram-actor";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";

const context = testContext();
const store = createStore();
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
  const fixture = createPublicTelegramActor(context);
  const sent = await fixture.run(async () => {
    await runsApi.grantProEntitlement(fixture.actor);
    await runsApi.ensurePersonalSubscriptionModel(fixture.actor);
    await runsApi.updateUserModelPreference(fixture.actor, "claude-fable-5-1");
    const agent = await bdd.createAgent(fixture.actor, {
      displayName: "Telegram upload",
    });
    const sent = await chatApi.sendAndLaunch(fixture.actor, {
      agentId: agent.agentId,
      prompt: "Create a run for Telegram upload completion",
    });
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(sent.runId);
    fixture.rememberClaim(sent.runId, claim.sandboxToken);
    return { ...sent, token: okouTokenFromClaim(claim) };
  });
  return { ...fixture, ...sent, telegramBotId: OFFICIAL_TELEGRAM_BOT_ID };
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
      fixture.ownsFeatureSwitches();
      await fixture.run(async () => {
        const telegramFileId = `tg-doc-${randomUUID().slice(0, 8)}`;
        await updateFeatureSwitchesForUser(context, fixture, {
          [FeatureSwitchKey.PrivateArtifacts]: privateFiles,
        });
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
        if (privateFiles) {
          // Changing the flag does not change the already authorized private object.
          await updateFeatureSwitchesForUser(context, fixture, {
            [FeatureSwitchKey.PrivateArtifacts]: false,
          });
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
