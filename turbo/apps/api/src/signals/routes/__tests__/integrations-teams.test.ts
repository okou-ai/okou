import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import {
  integrationsTeamsUploadCompleteContract,
  integrationsTeamsUploadInitContract,
  type TeamsUploadCompleteBody,
  type TeamsUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTeamsUploadCompleteRoutes } from "../integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { webFileUrlRoutes } from "../web-file-url";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const memberships = createStore();

const TEAMS_TOKEN_URL = "https://teams-auth.test/token";
const BOT_TOKEN = "teams-bot-token";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface TeamsDelivery {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** Bot Framework for the installation: records every bot POST. */
function serveBotFramework(
  fixture: TeamsConnectFixture,
  activityOutcome: "delivered" | "network-error" = "delivered",
) {
  const deliveries: TeamsDelivery[] = [];
  const servicePath = new URL(fixture.serviceUrl).pathname.replace(/\/+$/u, "");
  async function record(request: Request): Promise<unknown> {
    const body: unknown = await request.json();
    deliveries.push({
      path: new URL(request.url).pathname.slice(servicePath.length),
      authorization: request.headers.get("authorization"),
      body,
    });
    return body;
  }
  server.use(
    http.post(TEAMS_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: BOT_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(`${fixture.serviceUrl}v3/conversations`, async ({ request }) => {
      const body = await record(request);
      const members =
        typeof body === "object" && body !== null && "members" in body
          ? body.members
          : undefined;
      const first = Array.isArray(members) ? members[0] : undefined;
      const memberId =
        typeof first === "object" &&
        first !== null &&
        "id" in first &&
        typeof first.id === "string"
          ? first.id
          : "unknown";
      return HttpResponse.json({ id: `a:personal-${memberId}` });
    }),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId?`,
      async ({ request }) => {
        await record(request);
        if (activityOutcome === "network-error") {
          return HttpResponse.error();
        }
        return HttpResponse.json({ id: "delivered-activity" });
      },
    ),
  );
  return deliveries;
}

/** The org installs the bot through Teams; Ada connects through OAuth. */
async function installedTeamsMember(
  activityOutcome: "delivered" | "network-error" = "delivered",
) {
  const fixture = teamsConnectFixture();
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", TEAMS_TOKEN_URL);
  serveBotFramework(fixture);
  await installTeamsForTest(context.signal, fixture);
  await connectTeamsAccountForTest(context, fixture, {
    displayName: "Ada Lovelace",
  });
  const deliveries = serveBotFramework(fixture, activityOutcome);
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  return { fixture, deliveries };
}

/** Private artifact storage accepts the bytes and reports what it stored. */
function acceptUploadStorage(contentType: string) {
  const stored: { bytes?: Buffer } = {};
  server.use(
    http.put("https://r2.example.com/upload", async ({ request }) => {
      stored.bytes = Buffer.from(await request.arrayBuffer());
      return new HttpResponse(null, { status: 200 });
    }),
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand && stored.bytes !== undefined) {
      return Promise.resolve({
        ContentLength: stored.bytes.byteLength,
        ContentType: contentType,
      });
    }
    if (
      command instanceof GetObjectCommand &&
      !command.input.Key?.startsWith("private-artifacts/")
    ) {
      return Promise.reject(
        Object.assign(new Error("Missing object"), {
          name: "NoSuchKey",
        }),
      );
    }
    if (command instanceof GetObjectCommand && stored.bytes !== undefined) {
      return Promise.resolve({
        ContentLength: stored.bytes.byteLength,
        ContentType: contentType,
        Body: Readable.from([stored.bytes]),
      });
    }
    return Promise.resolve({ ETag: '"etag-1"' });
  });
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function initUpload<Status extends 200 | 409>(
  body: TeamsUploadInitBody,
  statuses: readonly Status[],
) {
  return await accept(
    setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
      integrationsTeamsUploadInitContract,
    ).init({ headers, body }),
    statuses,
  );
}

async function initUploaded(body: TeamsUploadInitBody, bytes: Uint8Array) {
  const init = await initUpload(body, [200]);
  const uploaded = await fetch(init.body.uploadUrl, {
    method: "PUT",
    headers: init.body.uploadHeaders,
    body: bytes,
  });
  expect(uploaded.status).toBe(200);
  return init.body;
}

async function completeUpload<Status extends 200 | 404 | 409>(
  body: TeamsUploadCompleteBody,
  statuses: readonly Status[],
) {
  return await accept(
    setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
      integrationsTeamsUploadCompleteContract,
    ).complete({ headers, body }),
    statuses,
  );
}

async function fileUrl<Status extends 200 | 404>(
  fileId: string,
  statuses: readonly Status[],
) {
  return await accept(
    setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl({
      headers,
      query: { file_id: fileId },
    }),
    statuses,
  );
}

async function signInAnotherMember(orgId: string): Promise<void> {
  const userId = `user_${randomUUID()}`;
  await memberships.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(userId, orgId);
}

function personalConversationId(fixture: TeamsConnectFixture): string {
  return `a:personal-${fixture.teamsUserId}`;
}

describe("Microsoft Teams integration CLI routes", () => {
  it("integrations-teams-016 delivers an uploaded file to the caller's Teams DM", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    acceptUploadStorage("application/pdf");
    const bytes = new Uint8Array(1234);
    const init = await initUploaded(
      {
        checksumSha256: checksum(bytes),
        user: "me",
        filename: "report.pdf",
        contentType: "application/pdf",
        length: bytes.byteLength,
      },
      bytes,
    );

    const completed = await completeUpload(
      {
        uploadId: init.uploadId,
        user: "me",
        contentType: "application/pdf",
      },
      [200],
    );

    expect(completed.body).toMatchObject({
      activityId: "delivered-activity",
      conversationId: personalConversationId(fixture),
      filename: "report.pdf",
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      path: "/v3/conversations",
      body: {
        bot: { name: "Nova" },
        members: [{ id: fixture.teamsUserId, name: "Ada Lovelace" }],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
    expect(deliveries[1]).toMatchObject({
      path: `/v3/conversations/${encodeURIComponent(personalConversationId(fixture))}/activities`,
      body: {
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
            contentUrl: expect.stringContaining(
              `object=${encodeURIComponent("test-private-artifacts/")}`,
            ),
          },
        ],
      },
    });
    expect(deliveries[1]?.body).not.toHaveProperty("replyToId");
  });

  it("integrations-teams-015 replies in the thread with an uploaded file and keeps the file URL in the organization", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    acceptUploadStorage("application/pdf");
    const bytes = new Uint8Array(1234);
    const target = {
      conversationId: fixture.teamsConversationId,
      activityId: fixture.teamsThreadId,
      text: "Daily report",
    };
    const init = await initUploaded(
      {
        checksumSha256: checksum(bytes),
        ...target,
        filename: "report.pdf",
        contentType: "application/pdf",
        length: bytes.byteLength,
      },
      bytes,
    );

    const completed = await completeUpload(
      {
        uploadId: init.uploadId,
        contentType: "application/pdf",
        ...target,
      },
      [200],
    );
    const owned = await fileUrl(init.uploadId, [200]);
    await signInAnotherMember(`org_${randomUUID()}`);
    await fileUrl(init.uploadId, [404]);

    expect(completed.body).toStrictEqual({
      activityId: "delivered-activity",
      conversationId: fixture.teamsConversationId,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: new URL(
        `/artifacts/${init.uploadId.replace(/-/gu, "")}.pdf`,
        init.fileUrl,
      ).href,
    });
    expect(owned.body.publicUrl).toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      body: {
        replyToId: fixture.teamsThreadId,
        text: expect.stringContaining(`Daily report\n\n[report.pdf](`),
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
            contentUrl: expect.stringContaining(
              `object=${encodeURIComponent("test-private-artifacts/")}`,
            ),
          },
        ],
      },
    });
  });
});
