import { randomUUID } from "node:crypto";

import { webhookGoogleCalendarContract } from "@okouai/api-contracts/contracts/webhooks";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { webhooksGoogleCalendarRoutes } from "../webhooks-google-calendar";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

interface CalendarEvent {
  readonly id: string;
  readonly etag: string;
  readonly status: string;
  readonly summary?: string;
}

interface CalendarProvider {
  readonly incrementalReads: string[];
  readonly baselineTokens: string[];
  readonly watchTokens: string[];
  readonly stopTokens: string[];
  stopStatus: number;
  incremental: CalendarEvent[];
  channel(): { readonly id: string; readonly token: string };
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

/** Google Calendar API boundary for the member's connected accounts. */
function mockCalendarProvider(baseline: CalendarEvent[]): CalendarProvider {
  const watches: { id: string; token: string }[] = [];
  const provider: CalendarProvider = {
    incrementalReads: [],
    baselineTokens: [],
    watchTokens: [],
    stopTokens: [],
    stopStatus: 204,
    incremental: [],
    channel() {
      const [watch] = watches;
      if (!watch) {
        throw new Error("Expected the automation to register a watch");
      }
      return watch;
    },
  };
  server.use(
    http.get(`${CALENDAR_API}/calendars/:calendarId/events`, ({ request }) => {
      const syncToken = new URL(request.url).searchParams.get("syncToken");
      if (syncToken) {
        provider.incrementalReads.push(syncToken);
      } else {
        provider.baselineTokens.push(bearer(request));
      }
      return HttpResponse.json({
        items: syncToken ? provider.incremental : baseline,
        nextSyncToken: `sync-${randomUUID()}`,
      });
    }),
    http.get(`${CALENDAR_API}/calendars/:calendarId`, ({ params }) => {
      return HttpResponse.json({ id: String(params.calendarId) });
    }),
    http.post(
      `${CALENDAR_API}/calendars/:calendarId/events/watch`,
      async ({ request }) => {
        provider.watchTokens.push(bearer(request));
        const body = (await request.json()) as { id: string; token: string };
        watches.push({ id: body.id, token: body.token });
        return HttpResponse.json({
          id: body.id,
          resourceId: `resource-${body.id}`,
          resourceUri: `${CALENDAR_API}/calendars/primary/events`,
          expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.post(`${CALENDAR_API}/channels/stop`, ({ request }) => {
      provider.stopTokens.push(bearer(request));
      return new HttpResponse(null, { status: provider.stopStatus });
    }),
  );
  return provider;
}

async function setupCalendarAutomation(
  baseline: CalendarEvent[] = [],
  accessToken = "calendar-access-token",
) {
  const workflows = createWorkflowsBddApi(context);
  const actor = workflows.user();
  mockGoogleCalendarConnectorOAuth({
    accessToken,
    subject: `calendar-${randomUUID()}`,
    email: `calendar-${randomUUID()}@example.com`,
  });
  const provider = mockCalendarProvider(baseline);
  const [workflowId] = await Promise.all([
    workflows.createWorkflow(actor, {
      name: `calendar-${randomUUID().slice(0, 8)}`,
      visibility: "private",
    }),
    workflows.connectConnector(actor, "google-calendar"),
  ]);
  const mocks = createRouteMocks(context);
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const automations = setupApp({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);
  const created = await accept(
    automations.create({
      headers: { authorization: "Bearer clerk-session" },
      params: { workflowId },
      body: { kind: "event", eventType: "google-calendar-event-created" },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  return {
    actor,
    provider,
    automationId: created.body.id,
    automations,
    authenticate() {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      return { authorization: "Bearer clerk-session" } as const;
    },
  };
}

async function notify(
  channel: { readonly id: string; readonly token: string },
  overrides: { readonly token?: string; readonly messageNumber?: string } = {},
) {
  return await setupApp({ context, routes: webhooksGoogleCalendarRoutes })(
    webhookGoogleCalendarContract,
  ).post({
    body: "",
    extraHeaders: {
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": overrides.token ?? channel.token,
      "x-goog-resource-id": `resource-${channel.id}`,
      "x-goog-resource-state": "exists",
      "x-goog-message-number": overrides.messageNumber ?? "2",
    },
  });
}

describe("POST /api/webhooks/google-calendar", () => {
  it("webhooks-google-calendar-017 acknowledges updated and cancelled events without dispatching", async () => {
    const existing = {
      id: `event-${randomUUID()}`,
      etag: '"1"',
      status: "confirmed",
      summary: "Existing",
    };
    const { provider } = await setupCalendarAutomation([existing]);
    provider.incremental = [
      { ...existing, etag: '"2"', summary: "Existing renamed" },
      { id: `event-${randomUUID()}`, etag: '"1"', status: "cancelled" },
    ];

    const response = await accept(notify(provider.channel()), [200]);

    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
  });

  it("webhooks-google-calendar-005 rejects notifications for a disabled automation without reading events", async () => {
    const { provider, automationId, automations, authenticate } =
      await setupCalendarAutomation();
    provider.stopStatus = 500;
    await accept(
      automations.disable({
        headers: authenticate(),
        params: { id: automationId },
      }),
      [200],
    );

    await accept(notify(provider.channel()), [401]);

    expect(provider.baselineTokens).toHaveLength(1);
    expect(provider.incrementalReads).toStrictEqual([]);
    provider.stopStatus = 204;
    await accept(
      automations.delete({
        headers: authenticate(),
        params: { id: automationId },
      }),
      [204],
    );
  });

  it("webhooks-google-calendar-006 acknowledges notifications without dispatching once Calendar access is revoked", async () => {
    const { actor, provider, automationId, automations, authenticate } =
      await setupCalendarAutomation();
    const refreshes: string[] = [];
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        refreshes.push(
          new URLSearchParams(await request.text()).get("grant_type") ?? "",
        );
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Token revoked" },
          { status: 400 },
        );
      }),
    );
    mockNow(Date.now() + 2 * 60 * 60 * 1000);

    const responses = [
      await accept(notify(provider.channel(), { messageNumber: "2" }), [200]),
      await accept(notify(provider.channel(), { messageNumber: "3" }), [200]),
    ];

    for (const response of responses) {
      expect(response.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 0,
      });
    }
    expect(refreshes).toStrictEqual(["refresh_token"]);
    const accounts = await createConnectorBddApi(
      context,
    ).listBuiltinConnectorAccounts(actor, "google-calendar");
    expect(accounts).toStrictEqual([
      expect.objectContaining({
        isDefault: true,
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
    ]);
    await accept(
      automations.disable({
        headers: authenticate(),
        params: { id: automationId },
      }),
      [200],
    );
  });
});
