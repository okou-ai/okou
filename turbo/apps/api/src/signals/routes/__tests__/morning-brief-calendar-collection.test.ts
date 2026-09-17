import { randomUUID } from "node:crypto";

import {
  morningBriefCalendarCollectionPreviewContract,
  type MorningBriefCalendarCollection,
} from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  markCalendarAccountNeedsReconnectFixture,
  selectThreadCalendarAccountFixture,
} from "../../../test-fixtures/morning-brief-calendar-collection";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
  revokeAgentConnectorGrantFixture,
  setMorningBriefEnabledFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { ROUTES } from "../../route";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Calendar collection through the shared Morning Brief OAuth reader.
 *
 * Every request below reaches the route through `ROUTES`, the same composition
 * `createProductionApp` mounts, so a route that is only reachable from a test
 * harness would fail this suite rather than pass it.
 */

const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events";

/** 2026-03-10T02:30Z is 10:30 on 2026-03-10 in Asia/Shanghai. */
const ANCHOR = new Date("2026-03-10T02:30:00.000Z");
const WINDOW_START = "2026-03-09T16:00:00.000Z";
const WINDOW_END = "2026-03-12T16:00:00.000Z";

const OWNER_CALENDAR = "owner@example.test";
const TEAM_CALENDAR = "team@example.test";
const EXEC_CALENDAR = "exec@example.test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

function previewClient() {
  // The real application composition, not a hand-mounted route list.
  return setupApp({ context, routes: ROUTES })(
    morningBriefCalendarCollectionPreviewContract,
  );
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer test-token" } as const;
}

interface CalendarCall {
  readonly pathname: string;
  readonly search: string;
}

interface CalendarStub {
  readonly calls: CalendarCall[];
}

interface StubCalendar {
  readonly id: string;
  readonly summary?: string;
  readonly accessRole: string;
  readonly primary?: boolean;
  readonly timeZone?: string;
}

interface StubEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly start: Record<string, string>;
  readonly end: Record<string, string>;
  readonly recurringEventId?: string;
  readonly iCalUID?: string;
}

/**
 * A Calendar stub that records every call, so a denial can be asserted as
 * *zero provider reads* rather than as an absent response body.
 */
function stubCalendar(args: {
  readonly calendars?: readonly StubCalendar[];
  readonly events?: ReadonlyMap<string, readonly StubEvent[]>;
  readonly eventStatus?: ReadonlyMap<string, number>;
  readonly listStatus?: number;
  readonly pages?: ReadonlyMap<string, string>;
  readonly holdFirstEvents?: Promise<void>;
}): CalendarStub {
  const calls: CalendarCall[] = [];
  let held = false;

  server.use(
    http.get(CALENDAR_LIST_URL, ({ request }) => {
      const url = new URL(request.url);
      calls.push({ pathname: url.pathname, search: url.search });
      if (args.listStatus !== undefined) {
        return HttpResponse.json(
          { error: { code: args.listStatus } },
          { status: args.listStatus },
        );
      }
      return HttpResponse.json({ items: args.calendars ?? [] });
    }),
    http.get(CALENDAR_EVENTS_URL, async ({ request, params }) => {
      const url = new URL(request.url);
      calls.push({ pathname: url.pathname, search: url.search });
      const calendarId = decodeURIComponent(String(params["calendarId"]));
      if (args.holdFirstEvents && !held) {
        held = true;
        await args.holdFirstEvents;
      }
      const status = args.eventStatus?.get(calendarId);
      if (status !== undefined) {
        return HttpResponse.json({ error: { code: status } }, { status });
      }
      // A calendar in `pages` always offers another page, so the collector
      // must stop at its own page cap rather than follow the provider.
      const nextPageToken = args.pages?.get(calendarId);
      return HttpResponse.json({
        items: args.events?.get(calendarId) ?? [],
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
    }),
  );

  return { calls };
}

function eventCalls(stub: CalendarStub): readonly CalendarCall[] {
  return stub.calls.filter((call) => {
    return call.pathname.endsWith("/events");
  });
}

function timed(id: string, startIso: string, endIso: string): StubEvent {
  return {
    id,
    status: "confirmed",
    summary: `Event ${id}`,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
}

async function connectCalendar(
  actor: ApiTestUser,
  agentId: string,
  args: {
    readonly email: string;
    readonly subject: string;
    readonly displayName?: string;
  },
): Promise<string> {
  mockGoogleCalendarConnectorOAuth({
    accessToken: "calendar-access-token",
    email: args.email,
    subject: args.subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "google-calendar",
    "oauth",
    agentId,
    args.displayName === undefined
      ? undefined
      : { intent: "add", displayName: args.displayName },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Google Calendar OAuth state");
  }
  await connectorsApi.completeOauthCallback("google-calendar", {
    code: `calendar-code-${args.subject}`,
    state,
  });
  const account = (
    await connectorsApi.listBuiltinConnectorAccounts(actor, "google-calendar")
  ).find((candidate) => {
    return candidate.externalId === args.subject;
  });
  if (!account) {
    throw new Error("Expected the connected Google Calendar account");
  }
  return account.id;
}

async function setupOwner(): Promise<Fixture> {
  const { actor } = await workflowBdd.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected a default Agent");
  }
  const agentId = onboarding.defaultAgentId;
  await connectCalendar(actor, agentId, {
    email: OWNER_CALENDAR,
    subject: `calendar-${randomUUID()}`,
  });
  await runsApi.enableAgentConnectors(actor, agentId, ["google-calendar"]);
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId, timezone: "Asia/Shanghai" },
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId,
    workflowId: installation.workflowId,
  };
}

async function collect(
  actor: ApiTestUser,
  statuses: readonly (200 | 401 | 403 | 404)[],
) {
  return await accept(
    previewClient().collect({
      headers: authHeaders(actor),
      body: { anchor: ANCHOR.toISOString() },
    }),
    statuses,
  );
}

/** Narrows the contract's response union to a collected calendar envelope. */
async function collectOk(
  actor: ApiTestUser,
): Promise<{ readonly body: MorningBriefCalendarCollection }> {
  const response = await collect(actor, [200]);
  if (response.status !== 200) {
    throw new Error(
      `Expected a calendar collection, received ${response.status}`,
    );
  }
  return { body: response.body };
}

beforeEach(async () => {
  await installApiTestConnectorCatalog();
});

describe("Morning Brief calendar collection preview", () => {
  it("collects the owner's local three-day window across every readable calendar", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({
      calendars: [
        {
          id: OWNER_CALENDAR,
          summary: "Owner",
          accessRole: "owner",
          primary: true,
          timeZone: "Asia/Shanghai",
        },
        {
          id: TEAM_CALENDAR,
          summary: "Team",
          accessRole: "reader",
          timeZone: "America/Los_Angeles",
        },
        { id: EXEC_CALENDAR, summary: "Exec", accessRole: "freeBusyReader" },
      ],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "today",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
            // Ends exactly at the window start: outside the half-open window.
            timed("before", "2026-03-09T15:00:00.000Z", WINDOW_START),
            // Starts exactly at the window end: also outside.
            timed("after", WINDOW_END, "2026-03-12T17:00:00.000Z"),
            // Crosses local midnight and stays whole.
            timed(
              "overnight",
              "2026-03-10T15:30:00.000Z",
              "2026-03-10T16:30:00.000Z",
            ),
            {
              id: "holiday",
              status: "confirmed",
              summary: "Holiday",
              start: { date: "2026-03-12" },
              end: { date: "2026-03-13" },
            },
            {
              id: "ended-yesterday",
              status: "confirmed",
              summary: "Yesterday",
              start: { date: "2026-03-09" },
              end: { date: "2026-03-10" },
            },
            { ...timed("gone", WINDOW_START, WINDOW_END), status: "cancelled" },
          ],
        ],
        [
          TEAM_CALENDAR,
          [
            {
              ...timed(
                "series_20260311",
                "2026-03-11T02:00:00.000Z",
                "2026-03-11T03:00:00.000Z",
              ),
              recurringEventId: "series",
              iCalUID: "series@google.test",
            },
          ],
        ],
      ]),
    });

    const response = await collectOk(fixture.actor);
    const ids = response.body.items.map((item) => {
      return item.eventId;
    });

    expect(ids).toContain("today");
    expect(ids).toContain("overnight");
    expect(ids).toContain("holiday");
    expect(ids).toContain("series_20260311");
    expect(ids).not.toContain("before");
    expect(ids).not.toContain("after");
    expect(ids).not.toContain("ended-yesterday");
    expect(ids).not.toContain("gone");
    expect(response.body).toMatchObject({
      source: "google-calendar",
      status: "partial",
      timezone: "Asia/Shanghai",
      window: {
        startAt: WINDOW_START,
        endAt: WINDOW_END,
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-13",
      },
      failure: null,
    });
    // The free/busy-only calendar is a declared limit, never a silent omission,
    // and it is never requested.
    expect(
      response.body.coverage.calendars.find((entry) => {
        return entry.calendarId === EXEC_CALENDAR;
      })?.outcome,
    ).toBe("free-busy-only");
    expect(
      eventCalls(stub).some((call) => {
        return call.pathname.includes(encodeURIComponent(EXEC_CALENDAR));
      }),
    ).toBeFalsy();
    // The provider is asked for the frozen window with expanded instances.
    const ownerCall = eventCalls(stub)[0];
    expect(ownerCall?.search).toContain(
      `timeMin=${encodeURIComponent(WINDOW_START)}`,
    );
    expect(ownerCall?.search).toContain(
      `timeMax=${encodeURIComponent(WINDOW_END)}`,
    );
    expect(ownerCall?.search).toContain("singleEvents=true");
    expect(ownerCall?.search).toContain("showDeleted=false");
    const recurring = response.body.items.find((item) => {
      return item.eventId === "series_20260311";
    });
    expect(recurring).toMatchObject({
      recurringEventId: "series",
      iCalUID: "series@google.test",
      calendarTimezone: "America/Los_Angeles",
    });
  });

  it("answers 404 in production before authentication whether or not the switch is on", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({ calendars: [] });
    mockEnv("ENV", "production");

    const authenticated = await collect(fixture.actor, [404]);
    expect(authenticated.status).toBe(404);

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      previewClient().collect({
        headers: {},
        body: { anchor: ANCHOR.toISOString() },
      }),
      [404],
    );
    expect(anonymous.status).toBe(404);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    const switchedOff = await collect(fixture.actor, [404]);
    expect(switchedOff.status).toBe(404);
    expect(stub.calls).toStrictEqual([]);
  });

  it("refuses a switched-off or disabled owner without reading any calendar", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
    });

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    const switchedOff = await collect(fixture.actor, [403]);
    expect(switchedOff.status).toBe(403);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: true },
    );
    await setMorningBriefEnabledFixture(fixture.workflowId, false);
    const disabled = await collect(fixture.actor, [403]);
    expect(disabled.status).toBe(403);

    expect(stub.calls).toStrictEqual([]);
  });

  it("reads the explicitly selected non-default account", async () => {
    const fixture = await setupOwner();
    const selectedConnectorId = await connectCalendar(
      fixture.actor,
      fixture.agentId,
      {
        email: "selected@example.test",
        subject: `calendar-selected-${randomUUID()}`,
        displayName: "Selected",
      },
    );
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    await selectThreadCalendarAccountFixture({
      chatThreadId,
      connectorId: selectedConnectorId,
    });
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "selected-event",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
    });

    const response = await collectOk(fixture.actor);
    expect(response.body.items[0]?.eventId).toBe("selected-event");
  });

  it("fails closed when the explicitly selected account loses its access", async () => {
    const fixture = await setupOwner();
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    const strandedConnectorId = await connectCalendar(
      fixture.actor,
      fixture.agentId,
      {
        email: "stranded@example.test",
        subject: `calendar-stranded-${randomUUID()}`,
        displayName: "Stranded",
      },
    );
    await selectThreadCalendarAccountFixture({
      chatThreadId,
      connectorId: strandedConnectorId,
    });
    await markCalendarAccountNeedsReconnectFixture(strandedConnectorId);
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
    });

    const response = await collectOk(fixture.actor);
    // The owner's healthy default account must not rescue a failed explicit
    // choice, and nothing is read from it.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "reconnect-required",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("refuses to read when the Agent no longer holds the connector grant", async () => {
    const fixture = await setupOwner();
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "google-calendar" },
    );
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
    });

    const response = await collectOk(fixture.actor);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-authorized",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("stops a held calendar read and releases nothing when the grant is revoked", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(new AbortController().signal);
    const stub = stubCalendar({
      calendars: [
        { id: OWNER_CALENDAR, accessRole: "owner", primary: true },
        { id: TEAM_CALENDAR, accessRole: "reader" },
        { id: "third@example.test", accessRole: "reader" },
        { id: "fourth@example.test", accessRole: "reader" },
      ],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "held-event",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      holdFirstEvents: release.promise,
    });

    const collection = collectOk(fixture.actor);
    // Arrival, not a sleep: the stub has entered the held events request.
    await expect
      .poll(() => {
        return eventCalls(stub).length;
      })
      .toBeGreaterThan(0);
    const heldCalls = eventCalls(stub).length;
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "google-calendar" },
    );
    release.resolve();

    const response = await collection;
    // The release fence discards everything collected before the withdrawal,
    // including the calendars that had already answered.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-authorized",
      items: [],
    });
    // Nothing new was issued after the revocation landed.
    expect(eventCalls(stub).length).toBeLessThanOrEqual(heldCalls + 1);
  });

  it("never falls back to primary when the calendar list is denied", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({ listStatus: 403 });

    const response = await collectOk(fixture.actor);
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.status).toBe("unavailable");
    // A denial is never a healthy empty day, and no calendar was guessed.
    expect(response.body.failure).not.toBeNull();
    expect(eventCalls(stub)).toStrictEqual([]);
  });

  it("separates a complete empty day from an unread calendar", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([[OWNER_CALENDAR, []]]),
    });

    const response = await collectOk(fixture.actor);
    expect(response.body).toMatchObject({
      status: "empty",
      failure: null,
      items: [],
      coverage: { calendarList: "complete", truncations: [] },
    });
    expect(response.body.coverage.calendars[0]?.outcome).toBe("complete");
  });

  it("reports an account with no readable calendar as unavailable, not empty", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({
      calendars: [{ id: EXEC_CALENDAR, accessRole: "freeBusyReader" }],
    });

    const response = await collectOk(fixture.actor);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.items).toStrictEqual([]);
    expect(eventCalls(stub)).toStrictEqual([]);
  });

  it("reports an unfollowed continuation token as truncated coverage", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "paged",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      pages: new Map([[OWNER_CALENDAR, "more"]]),
    });

    const response = await collectOk(fixture.actor);
    expect(response.body.status).toBe("partial");
    expect(response.body.items).toHaveLength(1);
    expect(response.body.coverage.calendars[0]?.outcome).toBe("truncated");
  });

  it("keeps a readable sibling when one calendar denies event access", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [
        { id: OWNER_CALENDAR, accessRole: "owner", primary: true },
        { id: TEAM_CALENDAR, accessRole: "reader" },
      ],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "kept",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      // A single calendar's 403 is endpoint-local: it must not be read as the
      // whole account losing its credential.
      eventStatus: new Map([[TEAM_CALENDAR, 403]]),
    });

    const response = await collectOk(fixture.actor);
    expect(response.body.status).toBe("partial");
    expect(
      response.body.items.map((item) => {
        return item.eventId;
      }),
    ).toStrictEqual(["kept"]);
    expect(
      response.body.coverage.calendars.find((entry) => {
        return entry.calendarId === TEAM_CALENDAR;
      })?.outcome,
    ).toBe("denied");
  });

  it("keeps a readable sibling when one calendar is missing", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [
        { id: OWNER_CALENDAR, accessRole: "owner", primary: true },
        { id: TEAM_CALENDAR, accessRole: "reader" },
      ],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed(
              "kept",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      eventStatus: new Map([[TEAM_CALENDAR, 404]]),
    });

    const response = await collectOk(fixture.actor);
    expect(response.body.status).toBe("partial");
    expect(
      response.body.items.map((item) => {
        return item.eventId;
      }),
    ).toStrictEqual(["kept"]);
    expect(
      response.body.coverage.calendars.find((entry) => {
        return entry.calendarId === TEAM_CALENDAR;
      })?.outcome,
    ).toBe("not-found");
  });

  it("reports a malformed provider response as a failure, never as an empty day", async () => {
    const fixture = await setupOwner();
    server.use(
      http.get(CALENDAR_LIST_URL, () => {
        return HttpResponse.json({
          items: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
        });
      }),
      http.get(CALENDAR_EVENTS_URL, () => {
        return HttpResponse.json({ items: [{ id: 42 }] });
      }),
    );

    const response = await collectOk(fixture.actor);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.coverage.calendars[0]?.outcome).toBe("failed");
  });
});
