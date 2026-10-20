import { randomUUID } from "node:crypto";
import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadCompleteContract,
  integrationsTeamsUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { integrationsTeamsMessageRoutes } from "../integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "../integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { createBddApi } from "./helpers/api-bdd";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import type { TeamsConnectFixture } from "./helpers/teams-connect";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function captureTeamsRequests(serviceUrl: string, conversationId: string) {
  const requests: {
    url: string;
    authorization: string | null;
    body: unknown;
  }[] = [];
  server.use(
    http.post(`${serviceUrl}v3/conversations`, async ({ request }) => {
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return HttpResponse.json({ id: conversationId });
    }),
    http.post(
      `${serviceUrl}v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({ id: "delivered-activity" });
      },
    ),
    http.post(
      `${serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      async ({ request }) => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({ id: "delivered-activity" });
      },
    ),
  );
  return requests;
}

function expectDisconnectedInstallation(status: unknown, tenantId: string) {
  expect(status).toMatchObject({
    isInstalled: true,
    isConnected: false,
    tenantId,
  });
}

function expectPersonalConversation(
  request: unknown,
  installation: TeamsConnectFixture,
  teamsUserId: string,
) {
  expect(request).toStrictEqual({
    url: `${installation.serviceUrl}v3/conversations`,
    authorization: "Bearer teams-token",
    body: {
      bot: { id: installation.teamsBotId, name: "Nova" },
      members: [{ id: teamsUserId }],
      isGroup: false,
      channelData: { tenant: { id: installation.teamsTenantId } },
    },
  });
}

function expectUploadedActivity(
  request: unknown,
  installation: TeamsConnectFixture,
  input: {
    readonly conversationId: string;
    readonly activityId?: string;
    readonly fileUrl: string;
    readonly text: string;
    readonly filename: string;
  },
) {
  const replyPath = input.activityId
    ? `/${encodeURIComponent(input.activityId)}`
    : "";
  expect(request).toStrictEqual({
    url: `${installation.serviceUrl}v3/conversations/${encodeURIComponent(input.conversationId)}/activities${replyPath}`,
    authorization: "Bearer teams-token",
    body: {
      type: "message",
      text: `${input.text}\n\n[${input.filename}](${input.fileUrl})`,
      textFormat: "markdown",
      ...(input.activityId ? { replyToId: input.activityId } : {}),
      attachments: [
        {
          contentType: "text/plain",
          contentUrl: "https://attachment-storage.example/download",
          name: input.filename,
        },
      ],
      channelData: { tenant: { id: installation.teamsTenantId } },
    },
  });
}

describe("Teams installation read ownership", () => {
  it("sends a personal card using the publicly connected installation", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      const conversationId = `a:personal-${installation.teamsUserId}`;
      const requests = captureTeamsRequests(
        installation.serviceUrl,
        conversationId,
      );
      const card = {
        type: "AdaptiveCard" as const,
        version: "1.4",
        body: [{ type: "TextBlock", text: "Installation-owned message" }],
      };
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: { user: "me", text: "Personal card summary", card },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        ok: true,
        activityId: "delivered-activity",
        conversationId,
      });
      expect(requests).toStrictEqual([
        {
          url: `${installation.serviceUrl}v3/conversations`,
          authorization: "Bearer teams-token",
          body: {
            bot: { id: installation.teamsBotId, name: "Nova" },
            members: [{ id: installation.teamsUserId, name: "Teams User" }],
            isGroup: false,
            channelData: { tenant: { id: installation.teamsTenantId } },
          },
        },
        {
          url: `${installation.serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`,
          authorization: "Bearer teams-token",
          body: {
            type: "message",
            summary: "Personal card summary",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: card,
              },
            ],
            channelData: { tenant: { id: installation.teamsTenantId } },
          },
        },
      ]);
    });
  });

  it("uploads public request bytes and delivers a personal attachment", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      const conversationId = `a:personal-${installation.teamsUserId}`;
      const requests = captureTeamsRequests(
        installation.serviceUrl,
        conversationId,
      );
      installSharedThreadStorage(context);
      const bytes = "Teams upload bytes";
      const initialized = await accept(
        setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
          integrationsTeamsUploadInitContract,
        ).init({
          headers,
          body: {
            filename: "notes.txt",
            contentType: "text/plain",
            length: Buffer.byteLength(bytes),
          },
        }),
        [200],
      );
      expect(initialized.body).toMatchObject({
        filename: "notes.txt",
        contentType: "text/plain",
        size: Buffer.byteLength(bytes),
      });
      expect(
        (
          await fetch(initialized.body.uploadUrl, {
            method: "PUT",
            headers: initialized.body.uploadHeaders,
            body: bytes,
            signal: context.signal,
          })
        ).status,
      ).toBe(200);
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
          integrationsTeamsUploadCompleteContract,
        ).complete({
          headers,
          body: {
            uploadId: initialized.body.uploadId,
            user: "me",
            text: "Uploaded notes",
          },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        activityId: "delivered-activity",
        conversationId,
        filename: "notes.txt",
        mimetype: "text/plain",
        size: Buffer.byteLength(bytes),
        url: initialized.body.fileUrl,
      });
      expect(requests).toStrictEqual([
        {
          url: `${installation.serviceUrl}v3/conversations`,
          authorization: "Bearer teams-token",
          body: {
            bot: { id: installation.teamsBotId, name: "Nova" },
            members: [{ id: installation.teamsUserId, name: "Teams User" }],
            isGroup: false,
            channelData: { tenant: { id: installation.teamsTenantId } },
          },
        },
        {
          url: `${installation.serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`,
          authorization: "Bearer teams-token",
          body: {
            type: "message",
            text: `Uploaded notes\n\n[notes.txt](${initialized.body.fileUrl})`,
            textFormat: "markdown",
            attachments: [
              {
                contentType: "text/plain",
                contentUrl: "https://attachment-storage.example/download",
                name: "notes.txt",
              },
            ],
            channelData: { tenant: { id: installation.teamsTenantId } },
          },
        },
      ]);
      expect(initialized.body.fileUrl).not.toBe(
        "https://attachment-storage.example/download",
      );
    });
  });

  it("reports the missing installation for a publicly onboarded message sender", async () => {
    const owner = createPublicConnectorActor(context);
    await owner.run(async () => {
      await createBddApi(context).bootstrapLimitedFreeOnboarding(owner.actor, {
        displayName: "No Teams installation",
        isolatePg: true,
      });
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: { user: "me", text: "No installation" },
        }),
        [404],
      );
      expect(response.body).toStrictEqual({
        error: {
          message:
            "No Microsoft Teams installation found for this organization",
          code: "NOT_FOUND",
        },
      });
    });
  });

  it("reports the missing installation before resolving an uploaded file", async () => {
    const owner = createPublicConnectorActor(context);
    await owner.run(async () => {
      await createBddApi(context).bootstrapLimitedFreeOnboarding(owner.actor, {
        displayName: "No Teams installation",
        isolatePg: true,
      });
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
          integrationsTeamsUploadCompleteContract,
        ).complete({ headers, body: { uploadId: randomUUID(), user: "me" } }),
        [404],
      );
      expect(response.body).toStrictEqual({
        error: {
          message:
            "No Microsoft Teams installation found for this organization",
          code: "NOT_FOUND",
        },
      });
    });
  });
});

describe("Teams target command ownership", () => {
  it("reports a disconnected personal message recipient while retaining the installation", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        fixture.installation.teamsTenantId,
      );
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: { user: "me", text: "Disconnected recipient" },
        }),
        [404],
      );
      expect(response.body).toStrictEqual({
        error: {
          message:
            "No connected Microsoft Teams user found for this organization",
          code: "NOT_FOUND",
        },
      });
    });
  });

  it("materializes an upload before resolving a disconnected personal recipient", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        fixture.installation.teamsTenantId,
      );
      installSharedThreadStorage(context);
      const client = setupApp({
        context,
        routes: integrationsTeamsUploadCompleteRoutes,
      })(integrationsTeamsUploadCompleteContract);
      const bytes = "A real upload for a disconnected recipient";
      const initialized = await accept(
        setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
          integrationsTeamsUploadInitContract,
        ).init({
          headers,
          body: {
            filename: "disconnected.txt",
            contentType: "text/plain",
            length: Buffer.byteLength(bytes),
          },
        }),
        [200],
      );
      expect(
        (
          await fetch(initialized.body.uploadUrl, {
            method: "PUT",
            headers: initialized.body.uploadHeaders,
            body: bytes,
            signal: context.signal,
          })
        ).status,
      ).toBe(200);
      const disconnected = await accept(
        client.complete({
          headers,
          body: { uploadId: initialized.body.uploadId, user: "me" },
        }),
        [404],
      );
      expect(disconnected.body).toStrictEqual({
        error: {
          message:
            "No connected Microsoft Teams user found for this organization",
          code: "NOT_FOUND",
        },
      });
    });
  });

  it("sends to an explicit Teams user after the authenticated user disconnects", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        installation.teamsTenantId,
      );
      const teamsUserId = `29:explicit-${randomUUID()}`;
      const conversationId = `a:explicit-${randomUUID()}`;
      const requests = captureTeamsRequests(
        installation.serviceUrl,
        conversationId,
      );
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: { user: teamsUserId, text: "Explicit recipient" },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        ok: true,
        activityId: "delivered-activity",
        conversationId,
      });
      expect(requests).toHaveLength(2);
      expectPersonalConversation(requests[0], installation, teamsUserId);
      expect(requests[1]).toStrictEqual({
        url: `${installation.serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`,
        authorization: "Bearer teams-token",
        body: {
          type: "message",
          text: "Explicit recipient",
          textFormat: "markdown",
          channelData: { tenant: { id: installation.teamsTenantId } },
        },
      });
    });
  });
});

describe("Teams explicit target delivery", () => {
  it("uploads to an explicit Teams user after the authenticated user disconnects", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        installation.teamsTenantId,
      );
      const teamsUserId = `29:explicit-${randomUUID()}`;
      const conversationId = `a:explicit-${randomUUID()}`;
      const requests = captureTeamsRequests(
        installation.serviceUrl,
        conversationId,
      );
      installSharedThreadStorage(context);
      const bytes = "Explicit Teams upload bytes";
      const initialized = await accept(
        setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
          integrationsTeamsUploadInitContract,
        ).init({
          headers,
          body: {
            filename: "explicit.txt",
            contentType: "text/plain",
            length: Buffer.byteLength(bytes),
          },
        }),
        [200],
      );
      expect(
        (
          await fetch(initialized.body.uploadUrl, {
            method: "PUT",
            headers: initialized.body.uploadHeaders,
            body: bytes,
            signal: context.signal,
          })
        ).status,
      ).toBe(200);
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
          integrationsTeamsUploadCompleteContract,
        ).complete({
          headers,
          body: {
            uploadId: initialized.body.uploadId,
            user: teamsUserId,
            text: "Explicit attachment",
          },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        activityId: "delivered-activity",
        conversationId,
        filename: "explicit.txt",
        mimetype: "text/plain",
        size: Buffer.byteLength(bytes),
        url: initialized.body.fileUrl,
      });
      expect(requests).toHaveLength(2);
      expectPersonalConversation(requests[0], installation, teamsUserId);
      expectUploadedActivity(requests[1], installation, {
        conversationId,
        fileUrl: initialized.body.fileUrl,
        text: "Explicit attachment",
        filename: "explicit.txt",
      });
      expect(initialized.body.fileUrl).not.toBe(
        "https://attachment-storage.example/download",
      );
    });
  });

  it("replies to an explicit Teams activity after the authenticated user disconnects", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        installation.teamsTenantId,
      );
      const conversationId = `19:explicit-${randomUUID()}@thread.v2`;
      const activityId = `activity:${randomUUID()}`;
      const requests = captureTeamsRequests(installation.serviceUrl, "unused");
      const card = {
        type: "AdaptiveCard" as const,
        version: "1.4",
        body: [{ type: "TextBlock", text: "Explicit activity card" }],
      };
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: { conversationId, activityId, text: "Explicit reply", card },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        ok: true,
        activityId: "delivered-activity",
        conversationId,
      });
      expect(requests).toStrictEqual([
        {
          url: `${installation.serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
          authorization: "Bearer teams-token",
          body: {
            type: "message",
            summary: "Explicit reply",
            replyToId: activityId,
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: card,
              },
            ],
            channelData: { tenant: { id: installation.teamsTenantId } },
          },
        },
      ]);
    });
  });

  it("uploads a reply to an explicit Teams activity after disconnect", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({
        withDefaultAgent: true,
        isolatePg: true,
      });
      const installation = fixture.installation;
      await owner.disconnect(fixture);
      expectDisconnectedInstallation(
        await owner.status(fixture),
        installation.teamsTenantId,
      );
      const conversationId = `19:explicit-${randomUUID()}@thread.v2`;
      const activityId = `activity:${randomUUID()}`;
      const requests = captureTeamsRequests(installation.serviceUrl, "unused");
      installSharedThreadStorage(context);
      const bytes = "Explicit Teams reply bytes";
      const initialized = await accept(
        setupApp({ context, routes: integrationsTeamsUploadInitRoutes })(
          integrationsTeamsUploadInitContract,
        ).init({
          headers,
          body: {
            filename: "reply.txt",
            contentType: "text/plain",
            length: Buffer.byteLength(bytes),
          },
        }),
        [200],
      );
      expect(
        (
          await fetch(initialized.body.uploadUrl, {
            method: "PUT",
            headers: initialized.body.uploadHeaders,
            body: bytes,
            signal: context.signal,
          })
        ).status,
      ).toBe(200);
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
          integrationsTeamsUploadCompleteContract,
        ).complete({
          headers,
          body: {
            uploadId: initialized.body.uploadId,
            conversationId,
            activityId,
            text: "Reply attachment",
          },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        activityId: "delivered-activity",
        conversationId,
        filename: "reply.txt",
        mimetype: "text/plain",
        size: Buffer.byteLength(bytes),
        url: initialized.body.fileUrl,
      });
      expect(requests).toHaveLength(1);
      expectUploadedActivity(requests[0], installation, {
        conversationId,
        activityId,
        fileUrl: initialized.body.fileUrl,
        text: "Reply attachment",
        filename: "reply.txt",
      });
      expect(initialized.body.fileUrl).not.toBe(
        "https://attachment-storage.example/download",
      );
    });
  });
});
