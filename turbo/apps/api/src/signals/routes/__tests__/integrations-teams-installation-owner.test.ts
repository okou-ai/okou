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
  );
  return requests;
}

describe("Teams installation read ownership", () => {
  it("sends a personal card using the publicly connected installation", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({ withDefaultAgent: true });
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
      const fixture = await owner.create({ withDefaultAgent: true });
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

  it("rejects an authenticated message with both target forms", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({ withDefaultAgent: true });
      const requests = captureTeamsRequests(
        fixture.installation.serviceUrl,
        "unused",
      );
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsMessageRoutes })(
          integrationsTeamsMessageContract,
        ).sendMessage({
          headers,
          body: {
            user: "me",
            conversationId: fixture.installation.teamsConversationId,
            text: "Invalid target",
          },
        }),
        [400],
      );
      expect(response.body.error.message).toContain(
        "Exactly one of conversationId or user is required",
      );
      expect(requests).toStrictEqual([]);
    });
  });

  it("rejects an authenticated upload with both target forms", async () => {
    const owner = createPublicTeamsDispatchFixture(context);
    await owner.run(async () => {
      const fixture = await owner.create({ withDefaultAgent: true });
      const requests = captureTeamsRequests(
        fixture.installation.serviceUrl,
        "unused",
      );
      const response = await accept(
        setupApp({ context, routes: integrationsTeamsUploadCompleteRoutes })(
          integrationsTeamsUploadCompleteContract,
        ).complete({
          headers,
          body: {
            uploadId: randomUUID(),
            user: "me",
            conversationId: fixture.installation.teamsConversationId,
          },
        }),
        [400],
      );
      expect(response.body.error.message).toContain(
        "Exactly one of conversationId or user is required",
      );
      expect(requests).toStrictEqual([]);
    });
  });

  it("reports the missing installation for a publicly onboarded message sender", async () => {
    const owner = createPublicConnectorActor(context);
    await owner.run(async () => {
      await createBddApi(context).bootstrapLimitedFreeOnboarding(owner.actor, {
        displayName: "No Teams installation",
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
