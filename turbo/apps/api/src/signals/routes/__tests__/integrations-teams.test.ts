import { connectTeamsAccountForTest } from "./helpers/teams-account";
import { createHash, randomUUID } from "node:crypto";

import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadInitContract,
  integrationsTeamsUploadCompleteContract,
} from "@okouai/api-contracts/contracts/integrations";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTeamsMessageRoutes } from "../integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "../integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsFixtureExternalId,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const store = createStore();
const mocks = createRouteMocks(context);
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const BOT_FRAMEWORK_TOKEN_URL = `https://login.microsoftonline.com/${TEAMS_APP_TENANT_ID}/oauth2/v2.0/token`;

interface CapturedTeamsActivity {
  conversationBody?: Record<string, unknown>;
  conversationId?: string;
  body?: Record<string, unknown>;
  authorization?: string | null;
}

function teamsFixture(): TeamsConnectFixture {
  return teamsConnectFixture({
    orgId: `org_teams_cli_${randomUUID().slice(0, 8)}`,
    userId: `user_teams_cli_${randomUUID().slice(0, 8)}`,
    serviceUrl: SERVICE_URL,
  });
}

function mockOutgoingTeams(
  fixture: TeamsConnectFixture,
  captured: CapturedTeamsActivity,
  recipientId = fixture.teamsUserId,
): {
  readonly activityId: string;
  readonly dmConversationId: string;
} {
  const activityId = teamsFixtureExternalId(fixture, "teams-activity");
  const dmConversationId = `a:${teamsFixtureExternalId(
    fixture,
    "teams-dm-conversation",
  )}`;
  server.use(
    http.get(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/members/:memberId",
      ({ params }) => {
        return String(params.memberId) === recipientId
          ? HttpResponse.json({
              id: recipientId,
              tenantId: fixture.teamsTenantId,
              aadObjectId: fixture.teamsAadObjectId,
            })
          : new HttpResponse(null, { status: 404 });
      },
    ),
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = await request.formData();
      expect(form.get("scope")).toBe("https://api.botframework.com/.default");
      return HttpResponse.json({ access_token: "bot-framework-token" });
    }),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations",
      async ({ request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationBody = (await request.json()) as Record<
          string,
          unknown
        >;
        return HttpResponse.json({ id: dmConversationId });
      },
    ),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities/:activityId",
      async ({ params, request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationId =
          typeof params.conversationId === "string"
            ? params.conversationId
            : undefined;
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: activityId });
      },
    ),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities",
      async ({ params, request }) => {
        captured.authorization = request.headers.get("authorization");
        captured.conversationId =
          typeof params.conversationId === "string"
            ? params.conversationId
            : undefined;
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: activityId });
      },
    ),
  );

  return { activityId, dmConversationId };
}

async function seedConnectedTeams(fixture: TeamsConnectFixture): Promise<void> {
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );
  await installTeamsForTest(context.signal, fixture);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

  await connectTeamsAccountForTest(context, fixture);
}

describe("Microsoft Teams integration CLI routes", () => {
  const fixtures: TeamsConnectFixture[] = [];

  beforeEach(() => {
    setupTeamsConnectTestEnv("https://app.okou.test");
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "bot-password");
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await removeTeamsForTest(context.signal, fixture);
      }
    }
  });

  it("sends a Teams message through the installed bot", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const captured: CapturedTeamsActivity = {};
    const outgoing = mockOutgoingTeams(fixture, captured);

    const client = setupApp({
      context,
      routes: integrationsTeamsMessageRoutes,
    })(integrationsTeamsMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          conversationId: fixture.teamsConversationId,
          activityId: fixture.teamsThreadId,
          text: "Hello from Teams CLI",
        },
        headers: {
          authorization: `Bearer ${await credentials.okouToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      activityId: outgoing.activityId,
      conversationId: fixture.teamsConversationId,
    });
    expect(captured.authorization).toBe("Bearer bot-framework-token");
    expect(captured.body).toMatchObject({
      type: "message",
      text: "Hello from Teams CLI\n\nSent via API caller credential · Triggered by <at>Ada Lovelace</at>",
      entities: [
        {
          type: "mention",
          text: "<at>Ada Lovelace</at>",
          mentioned: { id: fixture.teamsAadObjectId, name: "Ada Lovelace" },
        },
      ],
      textFormat: "markdown",
      replyToId: fixture.teamsThreadId,
      channelData: { tenant: { id: fixture.teamsTenantId } },
    });
  });

  it.each(["missing member", "different tenant"])(
    "denies Teams delivery for a %s",
    async (scenario) => {
      const fixture = teamsFixture();
      fixtures.push(fixture);
      await seedConnectedTeams(fixture);
      const captured: CapturedTeamsActivity = {};
      mockOutgoingTeams(fixture, captured);
      server.use(
        http.get(
          "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/members/:memberId",
          () => {
            return scenario === "missing member"
              ? new HttpResponse(null, { status: 404 })
              : HttpResponse.json({
                  id: fixture.teamsUserId,
                  tenantId: "another-tenant",
                });
          },
        ),
      );
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers: {
            authorization: `Bearer ${await credentials.okouToken(fixture)}`,
          },
          body: {
            conversationId: fixture.teamsConversationId,
            text: "blocked",
          },
        }),
        [404],
      );
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(captured.body).toBeUndefined();
    },
  );

  it.each(["me", "29:other-recipient"])(
    "delivers to Teams recipient %s: Adaptive Card",
    async (target) => {
      const fixture = teamsFixture();
      fixtures.push(fixture);
      await seedConnectedTeams(fixture);
      const captured: CapturedTeamsActivity = {};
      const recipientId = target === "me" ? fixture.teamsUserId : target;
      const outgoing = mockOutgoingTeams(fixture, captured, recipientId);

      const client = setupApp({
        context,
        routes: integrationsTeamsMessageRoutes,
      })(integrationsTeamsMessageContract);
      const response = await accept(
        client.sendMessage({
          body: {
            user: target,
            text: "Pick a workflow",
            card: {
              type: "AdaptiveCard",
              version: "1.4",
              msteams: { width: "Full" },
              body: [
                {
                  type: "TextBlock",
                  text: "Pick a workflow",
                  wrap: true,
                },
              ],
            },
          },
          headers: {
            authorization: `Bearer ${await credentials.okouToken({ userId: fixture.userId, orgId: fixture.orgId })}`,
          },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        ok: true,
        activityId: outgoing.activityId,
        conversationId: outgoing.dmConversationId,
      });
      expect(captured.conversationBody).toMatchObject({
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [
          {
            id: recipientId,
            ...(target === "me" ? { name: "Ada Lovelace" } : {}),
          },
        ],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      });
      expect(captured.conversationId).toBe(outgoing.dmConversationId);
      expect(captured.body).toMatchObject({
        type: "message",
        summary:
          "Pick a workflow\n\nSent via API caller credential · Triggered by <at>Ada Lovelace</at>",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: "Pick a workflow", wrap: true },
                {
                  type: "TextBlock",
                  text: "Sent via API caller credential · Triggered by <at>Ada Lovelace</at>",
                  size: "Small",
                  isSubtle: true,
                  wrap: true,
                  separator: true,
                },
              ],
              msteams: {
                width: "Full",
                entities: [
                  {
                    type: "mention",
                    text: "<at>Ada Lovelace</at>",
                    mentioned: {
                      id: fixture.teamsAadObjectId,
                      name: "Ada Lovelace",
                    },
                  },
                ],
              },
            },
          },
        ],
        channelData: { tenant: { id: fixture.teamsTenantId } },
      });
    },
  );

  it.each(
    ["delivered", "uncertain"].flatMap((outcome) => {
      return ["conversation", "direct DM", "me", "29:other-recipient"].map(
        (target) => {
          return {
            outcome,
            target,
          };
        },
      );
    }),
  )(
    "owns a non-Run v2 $target upload and preserves its $outcome delivery outcome",
    async ({ outcome, target }) => {
      const fixture = teamsFixture();
      fixtures.push(fixture);
      await seedConnectedTeams(fixture);
      const captured: CapturedTeamsActivity = {};
      const outgoing = mockOutgoingTeams(
        fixture,
        captured,
        target === "29:other-recipient" ? target : fixture.teamsUserId,
      );
      installSharedThreadStorage(context);
      let sends = 0;
      server.use(
        http.post(
          `${SERVICE_URL}v3/conversations/:conversationId/activities`,
          async ({ request, params }) => {
            sends++;
            captured.conversationId = String(params.conversationId);
            captured.body = (await request.json()) as Record<string, unknown>;
            return outcome === "uncertain"
              ? HttpResponse.error()
              : HttpResponse.json({ id: outgoing.activityId });
          },
        ),
      );
      const client = setupApp({
        context,
        routes: [
          ...integrationsTeamsUploadInitRoutes,
          ...integrationsTeamsUploadCompleteRoutes,
        ],
      });
      const headers = { authorization: "Bearer clerk-session" };
      const bytes = Buffer.from("Account-owned Teams report");
      const operationId = randomUUID();
      const body = {
        filename: "report.txt",
        contentType: "text/plain",
        length: bytes.length,
        canonical: {
          version: 2 as const,
          operationId,
          checksumSha256: createHash("sha256").update(bytes).digest("hex"),
          ...(target === "conversation"
            ? { conversationId: fixture.teamsConversationId }
            : target === "direct DM"
              ? { conversationId: outgoing.dmConversationId }
              : { user: target }),
          text: "Pinned account report",
        },
      };
      const prepared = await accept(
        client(integrationsTeamsUploadInitContract).init({ headers, body }),
        [200],
      );
      expect(prepared.body).toMatchObject({
        operationId,
        uploadRequired: true,
      });
      const uploaded = await fetch(prepared.body.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": body.contentType,
          ...prepared.body.uploadHeaders,
        },
        body: bytes,
      });
      expect(uploaded.status).toBe(200);
      const completion = {
        uploadId: prepared.body.uploadId,
        operationId,
        conversationId: "19:replacement-destination",
        text: "Replacement text",
      };
      const complete = () => {
        return client(integrationsTeamsUploadCompleteContract).complete({
          headers,
          body: completion,
        });
      };
      const response = await complete();
      expect(response.status).toBe(outcome === "delivered" ? 200 : 409);
      const replayed = await complete();
      expect(replayed.status).toBe(response.status);
      expect(replayed.body).toStrictEqual(response.body);
      expect(sends).toBe(1);
      expect(captured.conversationId).toBe(
        target === "conversation"
          ? fixture.teamsConversationId
          : outgoing.dmConversationId,
      );
      expect(captured.body?.text).toContain("Pinned account report");
      expect(captured.body?.text).not.toContain("Replacement text");
      const reused = await accept(
        client(integrationsTeamsUploadInitContract).init({
          headers,
          body:
            target === "direct DM"
              ? {
                  ...body,
                  canonical: {
                    ...body.canonical,
                    conversationId: undefined,
                    user: "me",
                  },
                }
              : body,
        }),
        [200],
      );
      expect(reused.body).toMatchObject({
        uploadId: prepared.body.uploadId,
        operationId,
        uploadRequired: false,
      });
      const changed = await client(integrationsTeamsUploadInitContract).init({
        headers,
        body: {
          ...body,
          canonical: { ...body.canonical, checksumSha256: "0".repeat(64) },
        },
      });
      expect(changed.status).toBe(409);
      mocks.clerk.session(`user_other_${randomUUID()}`, fixture.orgId);
      expect((await complete()).status).toBe(404);
      expect(sends).toBe(1);
    },
  );

  it("requires an organization for a non-Run v2 upload", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await setupApp({
      context,
      routes: integrationsTeamsUploadInitRoutes,
    })(integrationsTeamsUploadInitContract).init({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        filename: "report.txt",
        contentType: "text/plain",
        length: 12,
        canonical: {
          version: 2,
          operationId: randomUUID(),
          checksumSha256: "a".repeat(64),
          conversationId: "19:example",
        },
      },
    });
    expect(response.status).toBe(403);
  });

  it("keeps unversioned non-Run initialization compatible during the v2 preparation", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const initialized = await accept(
      setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
        integrationsTeamsUploadInitContract,
      ).init({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          filename: "report.txt",
          contentType: "text/plain",
          length: 12,
          canonical: {
            operationId: randomUUID(),
            checksumSha256: "a".repeat(64),
            conversationId: fixture.teamsConversationId,
          },
        },
      }),
      [200],
    );
    expect(initialized.body.operationId).toBeUndefined();
    expect(initialized.body.uploadUrl).toBeTruthy();
  });

  it("sends an uploaded file URL as a Teams attachment", async () => {
    const fixture = teamsFixture();
    fixtures.push(fixture);
    await seedConnectedTeams(fixture);
    const captured: CapturedTeamsActivity = {};
    const outgoing = mockOutgoingTeams(fixture, captured);

    const uploadId = randomUUID();
    mocks.s3.listObjects([
      {
        bucket: "test-user-artifacts",
        key: `artifacts/${fixture.userId}/${uploadId}/report.pdf`,
        size: 1234,
      },
    ]);

    const client = setupApp({
      context,
      routes: integrationsTeamsUploadCompleteRoutes,
    })(integrationsTeamsUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          conversationId: fixture.teamsConversationId,
          activityId: fixture.teamsThreadId,
          contentType: "application/pdf",
          text: "Daily report",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      activityId: outgoing.activityId,
      conversationId: fixture.teamsConversationId,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
    });
    expect(response.body.url).toContain(uploadId);
    expect(captured.body?.text).toContain("Daily report");
    expect(captured.body?.text).toContain("[report.pdf]");
    expect(captured.body).toMatchObject({
      type: "message",
      replyToId: fixture.teamsThreadId,
      attachments: [
        {
          contentType: "application/pdf",
          contentUrl: response.body.url,
          name: "report.pdf",
        },
      ],
    });
  });

  it.each(["me", "29:other-recipient"])(
    "delivers to Teams recipient %s: file",
    async (target) => {
      const fixture = teamsFixture();
      fixtures.push(fixture);
      await seedConnectedTeams(fixture);
      const captured: CapturedTeamsActivity = {};
      const recipientId = target === "me" ? fixture.teamsUserId : target;
      const outgoing = mockOutgoingTeams(fixture, captured, recipientId);

      const uploadId = randomUUID();
      mocks.s3.listObjects([
        {
          bucket: "test-user-artifacts",
          key: `artifacts/${fixture.userId}/${uploadId}/report.pdf`,
          size: 1234,
        },
      ]);

      const client = setupApp({
        context,
        routes: integrationsTeamsUploadCompleteRoutes,
      })(integrationsTeamsUploadCompleteContract);
      const response = await accept(
        client.complete({
          body: {
            uploadId,
            user: target,
            contentType: "application/pdf",
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        activityId: outgoing.activityId,
        conversationId: outgoing.dmConversationId,
        filename: "report.pdf",
      });
      expect(captured.conversationBody).toMatchObject({
        bot: { id: fixture.teamsBotId, name: "Nova" },
        members: [
          {
            id: recipientId,
            ...(target === "me" ? { name: "Ada Lovelace" } : {}),
          },
        ],
        isGroup: false,
        channelData: { tenant: { id: fixture.teamsTenantId } },
      });
      expect(captured.conversationId).toBe(outgoing.dmConversationId);
      expect(captured.body).toMatchObject({
        type: "message",
        attachments: [
          {
            contentType: "application/pdf",
            contentUrl: response.body.url,
            name: "report.pdf",
          },
        ],
      });
      expect(captured.body).not.toHaveProperty("replyToId");
    },
  );
});
