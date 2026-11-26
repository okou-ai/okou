import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const fileBytes = "private file";

/** Links the member to the official bot with a Telegram Login Widget payload. */
async function linkTelegram(member: ApiTestUser, telegramUserId: number) {
  const botToken = env("TELEGRAM_OFFICIAL_BOT_TOKEN");
  if (!botToken) {
    throw new Error("Expected the official Telegram bot to be configured");
  }
  const fields = {
    auth_date: Math.floor(now() / 1000),
    first_name: "Member",
    id: telegramUserId,
  };
  const checked = Object.entries(fields)
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");
  const hash = createHmac(
    "sha256",
    createHash("sha256").update(botToken).digest(),
  )
    .update(checked)
    .digest("hex");
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole,
  );
  await accept(
    setupApp({ context, routes: integrationsTelegramRoutes })(
      integrationsTelegramContract,
    ).link({
      headers,
      body: {
        telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
        telegramAuth: { ...fields, hash },
      },
    }),
    [200],
  );
}

/** Private artifact storage that keeps the bytes the browser PUTs. */
function installPrivateUploadStorage() {
  const presigned: { readonly bucket: unknown; readonly key: unknown }[] = [];
  const stored = new Map<string, string>();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      if (command instanceof PutObjectCommand) {
        presigned.push({
          bucket: command.input.Bucket,
          key: command.input.Key,
        });
      }
      return Promise.resolve(apiTestS3PresignedUrl(command));
    },
  );
  server.use(
    http.put("https://r2.example.com/upload", async ({ request }) => {
      const upload = presigned.at(-1);
      stored.set(
        `${String(upload?.bucket)}/${String(upload?.key)}`,
        await request.text(),
      );
      return new HttpResponse(null, { status: 200 });
    }),
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const bytes = stored.get(`${command.input.Bucket}/${command.input.Key}`);
      if (bytes === undefined) {
        return Promise.reject(
          Object.assign(new Error("NotFound"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: Buffer.byteLength(bytes),
        ContentType: "text/plain",
        LastModified: nowDate(),
      });
    }
    return Promise.resolve({});
  });
  return { presigned };
}

test("private-integration-uploads-005 keeps a Telegram upload private through completion", async () => {
  const botToken = `123456:${randomUUID()}`;
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", botToken);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "okou_test_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", randomUUID());
  const bdd = createBddApi(context);
  const member = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(member);
  const telegramUserId = randomInt(1_000_000_000, 9_000_000_000);
  server.use(
    http.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      async ({ request }) => {
        const message = await request.json();
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: 800,
            chat: { id: telegramUserId },
            text:
              typeof message === "object" &&
              message !== null &&
              "text" in message
                ? message.text
                : "",
          },
        });
      },
    ),
  );
  await linkTelegram(member, telegramUserId);
  const storage = installPrivateUploadStorage();
  const sentDocuments: unknown[] = [];
  server.use(
    http.post(
      `https://api.telegram.org/bot${botToken}/sendDocument`,
      async ({ request }) => {
        sentDocuments.push(await request.json());
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: 801,
            chat: { id: telegramUserId },
            document: {
              file_id: `file-${randomUUID()}`,
              file_name: "notes.txt",
              mime_type: "text/plain",
              file_size: Buffer.byteLength(fileBytes),
            },
          },
        });
      },
    ),
  );

  const init = await accept(
    setupApp({ context, routes: integrationsTelegramUploadInitRoutes })(
      integrationsTelegramUploadInitContract,
    ).init({
      headers,
      body: {
        filename: "notes.txt",
        contentType: "text/plain",
        length: Buffer.byteLength(fileBytes),
      },
    }),
    [200],
  );
  const put = await fetch(init.body.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "text/plain", ...init.body.uploadHeaders },
    body: fileBytes,
  });
  const completed = await accept(
    setupApp({ context, routes: integrationsTelegramUploadCompleteRoutes })(
      integrationsTelegramUploadCompleteContract,
    ).complete({
      headers,
      body: {
        uploadId: init.body.uploadId,
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        chatId: String(telegramUserId),
      },
    }),
    [200],
  );
  const files = setupApp({ context, routes: webFileUrlRoutes })(
    webFilesContract,
  );
  const preview = await accept(
    files.fileUrl({ headers, query: { file_id: init.body.uploadId } }),
    [200],
  );
  createRouteMocks(context).clerk.session(member.userId, `org_${randomUUID()}`);
  const elsewhere = await accept(
    files.fileUrl({ headers, query: { file_id: init.body.uploadId } }),
    [404],
  );

  const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  expect(put.status).toBe(200);
  expect(storage.presigned).toStrictEqual([
    expect.objectContaining({ bucket: privateBucket }),
  ]);
  expect(completed.body.url).toBe(init.body.fileUrl);
  expect(sentDocuments).toHaveLength(1);
  expect(preview.body.publicUrl).toBeNull();
  const downloaded = new URL(preview.body.downloadUrl).searchParams.get(
    "object",
  );
  expect(downloaded?.split("/")[0]).toBe(privateBucket);
  expect(elsewhere.status).toBe(404);
});
