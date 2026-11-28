import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
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
import { createApp } from "../../../app-factory";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { githubOauthRoutes } from "../github-oauth";
import { integrationsGithubUploadCompleteRoutes } from "../integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../integrations-github-upload-init";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const fileBytes = "private file";
const GITHUB_APP_ID = "123456";
const GITHUB_APP_SLUG = "okou-test";
const GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
).toString("base64");

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
    if (command instanceof GetObjectCommand) {
      const bytes = stored.get(`${command.input.Bucket}/${command.input.Key}`);
      if (bytes === undefined) {
        return Promise.reject(
          Object.assign(new Error("NoSuchKey"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: Buffer.byteLength(bytes),
        ContentType: "text/plain",
        LastModified: nowDate(),
        Body: Readable.from([Buffer.from(bytes)]),
      });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({ ETag: '"etag-1"' });
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
  expect(completed.body.url).toBe(
    new URL(
      `/artifacts/${init.body.uploadId.replace(/-/gu, "")}.txt`,
      init.body.fileUrl,
    ).href,
  );
  expect(sentDocuments).toHaveLength(1);
  expect(preview.body.publicUrl).toBeNull();
  const downloaded = new URL(preview.body.downloadUrl).searchParams.get(
    "object",
  );
  expect(downloaded?.split("/")[0]).toBe(privateBucket);
  expect(elsewhere.status).toBe(404);
});

test("private-integration-uploads-003 keeps a GitHub upload private through completion", async () => {
  mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", randomUUID());
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY_B64);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", "github-app-client-id");
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", "github-app-client-secret");

  const bdd = createBddApi(context);
  const member = bdd.user();
  if (!member.orgId) {
    throw new Error("Expected organization ID");
  }
  const routeMocks = createRouteMocks(context);
  routeMocks.clerk.session(member.userId, member.orgId, "org:admin");
  mockClerkMembership(context, member, "org:admin");
  const emailId = `email_${member.userId}`;
  mockClerkUsers(context, [
    {
      id: member.userId,
      emailAddresses: [{ id: emailId, emailAddress: member.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "GitHub",
    },
  ]);

  const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
  const targetId = String(randomInt(1_000_000_000, 9_999_999_999));
  const oauthCode = `code-${randomUUID()}`;
  const oauthToken = `gho_${randomUUID()}`;

  server.use(
    http.get(
      `https://api.github.com/app/installations/${installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(installationId),
          app_id: Number(GITHUB_APP_ID),
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(targetId),
            login: "bdd-org",
            type: "Organization",
          },
        });
      },
    ),
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () => {
        return HttpResponse.json(
          {
            token: `ghs_${installationId}`,
            expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      },
    ),
    http.post("https://github.com/login/oauth/access_token", () => {
      return HttpResponse.json({
        access_token: oauthToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({
        id: 7001,
        login: "bdd-gh-admin",
        email: null,
      });
    }),
    http.get("https://api.github.com/user/memberships/orgs", () => {
      return HttpResponse.json([
        {
          state: "active",
          role: "admin",
          organization: { id: Number(targetId) },
        },
      ]);
    }),
    http.post(
      "https://api.github.com/repos/bdd-org/notes/issues/7/comments",
      () => {
        return HttpResponse.json({ id: 9001 }, { status: 201 });
      },
    ),
  );

  const oauthApp = createApp({
    signal: context.signal,
    routes: githubOauthRoutes,
  });
  const installQuery = new URLSearchParams({
    userId: member.userId,
    orgId: member.orgId,
  }).toString();
  const installRes = await oauthApp.request(
    `http://localhost:3001/api/github/oauth/install?${installQuery}`,
    { method: "GET", headers },
  );
  const installLocation = installRes.headers.get("location");
  if (installRes.status !== 307 || !installLocation) {
    throw new Error(`Expected 307 install redirect, got ${installRes.status}`);
  }
  const state = new URL(installLocation).searchParams.get("state");
  if (!state) {
    throw new Error("Expected signed install state");
  }
  const callbackQuery = new URLSearchParams({
    installation_id: installationId,
    setup_action: "install",
    state,
    code: oauthCode,
  }).toString();
  const callbackRes = await oauthApp.request(
    `http://localhost:3001/api/github/app/setup/callback?${callbackQuery}`,
    { method: "GET", headers },
  );
  expect(callbackRes.status).toBe(307);

  const storage = installPrivateUploadStorage();
  const init = await accept(
    setupApp({ context, routes: integrationsGithubUploadInitRoutes })(
      integrationsGithubUploadInitContract,
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
    setupApp({ context, routes: integrationsGithubUploadCompleteRoutes })(
      integrationsGithubUploadCompleteContract,
    ).complete({
      headers,
      body: {
        uploadId: init.body.uploadId,
        repo: "bdd-org/notes",
        issueNumber: 7,
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
  expect(completed.body.url).toBe(
    new URL(
      `/artifacts/${init.body.uploadId.replace(/-/gu, "")}.txt`,
      init.body.fileUrl,
    ).href,
  );
  expect(preview.body.publicUrl).toBeNull();
  const downloaded = new URL(preview.body.downloadUrl).searchParams.get(
    "object",
  );
  expect(downloaded?.split("/")[0]).toBe(privateBucket);
  expect(elsewhere.status).toBe(404);
});
