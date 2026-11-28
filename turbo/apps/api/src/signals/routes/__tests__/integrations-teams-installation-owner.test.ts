import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadCompleteContract,
  integrationsTeamsUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { http, HttpResponse } from "msw";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTeamsMessageRoutes } from "../integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "../integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { teamsConnectRoutes } from "../teams-connect";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();

const TEAMS_TOKEN_URL = "https://teams-auth.test/token";
const BOT_TOKEN = "teams-bot-token";

interface TeamsDelivery {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** Bot Framework for this case's installation: records every bot POST. */
function serveBotFramework(fixture: TeamsConnectFixture) {
  const deliveries: TeamsDelivery[] = [];
  const service = new URL(fixture.serviceUrl);
  const servicePath = service.pathname.replace(/\/+$/u, "");
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
      const body = (await record(request)) as {
        members?: { id?: string }[];
      };
      return HttpResponse.json({
        id: `a:personal-${body.members?.[0]?.id ?? "unknown"}`,
      });
    }),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId?`,
      async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: "delivered-activity" });
      },
    ),
  );
  return deliveries;
}

/** The org installs the bot through Teams; the member connects through OAuth. */
async function installedTeamsMember() {
  const fixture = teamsConnectFixture();
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", TEAMS_TOKEN_URL);
  serveBotFramework(fixture);
  await installTeamsForTest(context.signal, fixture);
  await connectTeamsAccountForTest(context, fixture, {
    displayName: "Teams User",
  });
  const deliveries = serveBotFramework(fixture);
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  return { fixture, deliveries };
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function messageClient() {
  return setupApp({ context, routes: integrationsTeamsMessageRoutes })(
    integrationsTeamsMessageContract,
  );
}

function connectClient() {
  return setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
}

async function disconnectTeams(fixture: TeamsConnectFixture) {
  const client = connectClient();
  await accept(client.disconnect({ headers, query: {} }), [200]);
  const status = await accept(client.getStatus({ headers }), [200]);
  expect(status.body).toMatchObject({
    isInstalled: true,
    isConnected: false,
    tenantId: fixture.teamsTenantId,
  });
}

/** Teams answers member lookups for a user it resolves in the tenant. */
function resolveTeamsMember(
  fixture: TeamsConnectFixture,
  teamsUserId: string,
): void {
  server.use(
    http.get(
      `${fixture.serviceUrl}v3/conversations/:conversationId/members/:memberId`,
      ({ params }) => {
        if (params.memberId !== teamsUserId) {
          return;
        }
        return HttpResponse.json({
          id: teamsUserId,
          tenantId: fixture.teamsTenantId,
        });
      },
    ),
  );
}

const CARD = Object.freeze({
  type: "AdaptiveCard" as const,
  version: "1.5",
  body: [{ type: "TextBlock", text: "Card body" }],
});

describe("Teams messages through the organization installation", () => {
  it("integrations-teams-installation-owner-003 reports a missing installation to a message sender", async () => {
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: { user: "me", text: "No installation" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "No Microsoft Teams installation found for this organization",
      },
    });
  });

  it("integrations-teams-installation-owner-001 sends a personal card through the connected installation", async () => {
    const { fixture, deliveries } = await installedTeamsMember();

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: { user: "me", text: "Personal card summary", card: CARD },
      }),
      [200],
    );

    const conversationId = `a:personal-${fixture.teamsUserId}`;
    expect(response.body).toStrictEqual({
      ok: true,
      activityId: "delivered-activity",
      conversationId,
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      path: "/v3/conversations",
      authorization: `Bearer ${BOT_TOKEN}`,
      body: {
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [{ id: fixture.teamsUserId, name: "Teams User" }],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
    expect(deliveries[1]).toMatchObject({
      path: `/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      authorization: `Bearer ${BOT_TOKEN}`,
      body: {
        type: "message",
        summary: expect.stringContaining("Personal card summary"),
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: expect.objectContaining({ type: "AdaptiveCard" }),
          },
        ],
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
  });

  it("integrations-teams-installation-owner-002 uploads bytes and delivers a personal attachment", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    const bytes = new TextEncoder().encode("Meeting notes for Teams\n");
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
          ContentType: "text/plain",
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
          ContentType: "text/plain",
          Body: Readable.from([stored.bytes]),
        });
      }
      return Promise.resolve({ ETag: '"etag-1"' });
    });
    const init = await accept(
      setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
        integrationsTeamsUploadInitContract,
      ).init({
        headers,
        body: {
          checksumSha256: createHash("sha256").update(bytes).digest("hex"),
          user: "me",
          text: "Uploaded notes",
          filename: "notes.txt",
          contentType: "text/plain",
          length: bytes.byteLength,
        },
      }),
      [200],
    );
    expect(init.body).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain",
      size: bytes.byteLength,
    });
    const uploaded = await fetch(init.body.uploadUrl, {
      method: "PUT",
      headers: init.body.uploadHeaders,
      body: bytes,
    });
    expect(uploaded.status).toBe(200);

    const completed = await accept(
      setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
        integrationsTeamsUploadCompleteContract,
      ).complete({
        headers,
        body: {
          uploadId: init.body.uploadId,
          user: "me",
          text: "Uploaded notes",
        },
      }),
      [200],
    );

    const conversationId = `a:personal-${fixture.teamsUserId}`;
    const fileUrl = new URL(
      `/artifacts/${init.body.uploadId.replace(/-/gu, "")}.txt`,
      init.body.fileUrl,
    ).href;
    expect(completed.body).toStrictEqual({
      activityId: "delivered-activity",
      conversationId,
      filename: "notes.txt",
      mimetype: "text/plain",
      size: bytes.byteLength,
      url: fileUrl,
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      path: "/v3/conversations",
      body: { members: [{ id: fixture.teamsUserId }] },
    });
    expect(deliveries[1]).toMatchObject({
      body: {
        type: "message",
        text: expect.stringContaining(
          `Uploaded notes\n\n[notes.txt](${fileUrl})`,
        ),
        textFormat: "markdown",
        attachments: [
          {
            contentType: "text/plain",
            name: "notes.txt",
            contentUrl: expect.stringContaining(
              `object=${encodeURIComponent("test-private-artifacts/")}`,
            ),
          },
        ],
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
  });

  it("integrations-teams-installation-owner-005 rejects a personal message after the member disconnects", async () => {
    const { fixture } = await installedTeamsMember();
    await disconnectTeams(fixture);

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: { user: "me", text: "Disconnected recipient" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message:
          "This Teams conversation is unavailable to your connected account and Okou.",
      },
    });
  });

  it("integrations-teams-installation-owner-007 delivers to an explicit Teams user for a connected member", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    const explicitUser = `29:explicit-${fixture.fixtureId}`;
    resolveTeamsMember(fixture, explicitUser);

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: { user: explicitUser, text: "Explicit recipient" },
      }),
      [200],
    );

    const conversationId = `a:personal-${explicitUser}`;
    expect(response.body).toStrictEqual({
      ok: true,
      activityId: "delivered-activity",
      conversationId,
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      path: "/v3/conversations",
      authorization: `Bearer ${BOT_TOKEN}`,
      body: {
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [{ id: explicitUser }],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
    expect(deliveries[1]).toMatchObject({
      authorization: `Bearer ${BOT_TOKEN}`,
      body: {
        type: "message",
        text: expect.stringContaining("Explicit recipient"),
        textFormat: "markdown",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
  });

  it("integrations-teams-installation-owner-008 refuses an explicit Teams user after the member disconnects", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    await disconnectTeams(fixture);
    const explicitUser = `29:explicit-${fixture.fixtureId}`;
    resolveTeamsMember(fixture, explicitUser);

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: { user: explicitUser, text: "Explicit recipient" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(deliveries).toStrictEqual([]);
  });

  it("integrations-teams-installation-owner-011 replies to an explicit activity for a connected member", async () => {
    const { fixture, deliveries } = await installedTeamsMember();
    const conversationId = `19:explicit-${fixture.fixtureId}@thread.tacv2`;
    const activityId = `activity-explicit-${fixture.fixtureId}`;

    const response = await accept(
      messageClient().sendMessage({
        headers,
        body: {
          conversationId,
          activityId,
          text: "Explicit reply",
          card: CARD,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      activityId: "delivered-activity",
      conversationId,
    });
    expect(deliveries).toStrictEqual([
      {
        path: `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
        authorization: `Bearer ${BOT_TOKEN}`,
        body: expect.objectContaining({
          type: "message",
          summary: expect.stringContaining("Explicit reply"),
          replyToId: activityId,
          attachments: [
            expect.objectContaining({
              contentType: "application/vnd.microsoft.card.adaptive",
            }),
          ],
          channelData: { tenant: { id: fixture.teamsTenantId } },
        }),
      },
    ]);
  });
});
