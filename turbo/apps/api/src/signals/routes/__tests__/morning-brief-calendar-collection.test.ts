import { randomUUID } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  morningBriefCalendarCollectionPreviewContract,
  type MorningBriefCalendarCollection,
} from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
  requireConnectorReconnectFixture,
  revokeAgentConnectorGrantFixture,
  setMorningBriefEnabledFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { morningBriefCalendarCollectionPreviewRoutes } from "../morning-brief-calendar-collection-preview";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Calendar collection through the shared Morning Brief OAuth reader.
 *
 * The route's presence in the production table is asserted where the import
 * boundary allows the aggregate to be read, in `route-registration.test.ts`,
 * which pins the exact entry object this suite mounts. Driving that same
 * exported slice here therefore exercises the deployed handler: its production
 * environment gate, authentication, membership and ownership checks are the
 * ones under test.
 */

const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events";

/** 2026-03-10T02:30Z is 10:30 on 2026-03-10 in Asia/Shanghai. */
const ANCHOR_ISO = "2026-03-10T02:30:00.000Z";
const WINDOW_START = "2026-03-09T16:00:00.000Z";
const WINDOW_END = "2026-03-12T16:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

const OWNER_CALENDAR = "owner@example.test";
const TEAM_CALENDAR = "team@example.test";
const EXEC_CALENDAR = "exec@example.test";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

function previewClient() {
  return setupApp({
    context,
    routes: morningBriefCalendarCollectionPreviewRoutes,
  })(morningBriefCalendarCollectionPreviewContract);
}

/** The endpoint a member actually uses to pin an account to a thread. */
async function selectThreadCalendarAccount(
  actor: ApiTestUser,
  args: { readonly chatThreadId: string; readonly connectorId: string },
): Promise<void> {
  await accept(
    setupApp({ context, routes: chatThreadConnectorSelectionRoutes })(
      chatThreadConnectorSelectionContract,
    ).update({
      headers: authHeaders(actor),
      params: { id: args.chatThreadId },
      body: {
        connectionId: args.connectorId,
        target: { kind: "builtin", connectorSlug: "google-calendar" },
      },
    }),
    [200],
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
  readonly htmlLink?: string;
  readonly attendees?: readonly {
    readonly email: string;
    readonly responseStatus?: string;
  }[];
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
  readonly onFirstEventsHeld?: () => void;
  /** Sent with a failing event response, as a real rate limit would be. */
  readonly retryAfterSeconds?: number;
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
        args.onFirstEventsHeld?.();
        await args.holdFirstEvents;
      }
      const status = args.eventStatus?.get(calendarId);
      if (status !== undefined) {
        return HttpResponse.json(
          { error: { code: status } },
          {
            status,
            headers:
              args.retryAfterSeconds === undefined
                ? undefined
                : { "retry-after": String(args.retryAfterSeconds) },
          },
        );
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
  /** The immutable Clerk membership this collection must speak for. */
  readonly membershipId: string;
}

async function seedMembership(
  owner: { readonly orgId: string; readonly userId: string },
  membershipId: string,
): Promise<void> {
  await store.set(
    seedOrgMembership$,
    { orgId: owner.orgId, userId: owner.userId, role: "admin", membershipId },
    context.signal,
  );
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

async function setupOwner(timezone = "Asia/Shanghai"): Promise<Fixture> {
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
    { agentId, timezone },
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
    membershipId: `orgmem_${randomUUID()}`,
  };
}

/**
 * Issue the preview request.
 *
 * The membership is reseeded here because the shared BDD helpers reinstall
 * their own Clerk membership mocks while setting an org up; the request must
 * run against the generation this fixture pins.
 */
async function collect(
  fixture: Pick<Fixture, "actor" | "membershipId">,
  statuses: readonly (200 | 401 | 403 | 404)[],
) {
  await seedMembership(fixture.actor, fixture.membershipId);
  return await accept(
    previewClient().collect({
      headers: authHeaders(fixture.actor),
      body: { anchor: ANCHOR_ISO },
    }),
    statuses,
  );
}

/** Issue the preview request with an anchor other than the shared one. */
async function collectAt(
  fixture: Pick<Fixture, "actor" | "membershipId">,
  anchor: string,
): Promise<MorningBriefCalendarCollection> {
  await seedMembership(fixture.actor, fixture.membershipId);
  const response = await accept(
    previewClient().collect({
      headers: authHeaders(fixture.actor),
      body: { anchor },
    }),
    [200],
  );
  if (response.status !== 200) {
    throw new Error(
      `Expected a calendar collection, received ${response.status}`,
    );
  }
  return response.body;
}

/** Narrows the contract's response union to a collected calendar envelope. */
async function collectOk(
  fixture: Pick<Fixture, "actor" | "membershipId">,
): Promise<{ readonly body: MorningBriefCalendarCollection }> {
  const response = await collect(fixture, [200]);
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

    const response = await collectOk(fixture);
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

    const authenticated = await collect(fixture, [404]);
    expect(authenticated.status).toBe(404);

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      previewClient().collect({
        headers: {},
        body: { anchor: ANCHOR_ISO },
      }),
      [404],
    );
    expect(anonymous.status).toBe(404);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    const switchedOff = await collect(fixture, [404]);
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
    const switchedOff = await collect(fixture, [403]);
    expect(switchedOff.status).toBe(403);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: true },
    );
    await setMorningBriefEnabledFixture(fixture.workflowId, false);
    const disabled = await collect(fixture, [403]);
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
    await selectThreadCalendarAccount(fixture.actor, {
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

    const response = await collectOk(fixture);
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
    await selectThreadCalendarAccount(fixture.actor, {
      chatThreadId,
      connectorId: strandedConnectorId,
    });
    await requireConnectorReconnectFixture(strandedConnectorId);
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
    });

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-authorized",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("stops a held calendar read and releases nothing when the grant is revoked", async () => {
    const fixture = await setupOwner();
    const arrived = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
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
      onFirstEventsHeld: () => {
        if (!arrived.settled()) {
          arrived.resolve();
        }
      },
    });

    const collection = collectOk(fixture);
    async function expectRevokedCollection() {
      // Observe an early request failure while waiting for the actual hold.
      await Promise.race([arrived.promise, collection]);
      const heldCalls = eventCalls(stub).length;
      expect(heldCalls).toBeGreaterThan(0);
      await revokeAgentConnectorGrantFixture(
        { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
        { agentId: fixture.agentId, connectorSlug: "google-calendar" },
      );
      if (!release.settled()) {
        release.resolve();
      }

      const response = await collection;
      // The release fence discards everything collected before the withdrawal,
      // including the calendars that had already answered.
      // Nothing new was issued after the revocation landed.
      expect(eventCalls(stub).length).toBeLessThanOrEqual(heldCalls + 1);
      return response;
    }
    const result = await settleIncludingAbort(expectRevokedCollection());
    if (!release.settled()) {
      release.resolve();
    }
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await Promise.allSettled([collection]);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("refuses a member whose Clerk membership is gone", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
    });
    await seedMembership(fixture.actor, fixture.membershipId);
    // The cached role row can outlive the membership, so the live membership
    // read is what must notice the member has been removed.
    await store.set(
      deleteOrgMembership$,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      context.signal,
    );

    const response = await accept(
      previewClient().collect({
        headers: authHeaders(fixture.actor),
        body: { anchor: ANCHOR_ISO },
      }),
      [403],
    );
    expect(response.status).toBe(403);
    expect(stub.calls).toStrictEqual([]);
  });

  it("releases nothing when the member rejoins under a new membership while a request is held", async () => {
    const fixture = await setupOwner();
    const arrived = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
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
      onFirstEventsHeld: () => {
        if (!arrived.settled()) {
          arrived.resolve();
        }
      },
    });

    const collection = collectOk(fixture);
    async function expectRevokedCollection() {
      await Promise.race([arrived.promise, collection]);
      const heldCalls = eventCalls(stub).length;
      expect(heldCalls).toBeGreaterThan(0);
      // A removal and rejoin issues a new immutable membership id. The new
      // membership does not speak for what the previous one started.
      await seedMembership(fixture.actor, `orgmem_${randomUUID()}`);
      if (!release.settled()) {
        release.resolve();
      }

      const response = await collection;
      expect(eventCalls(stub).length).toBeLessThanOrEqual(heldCalls + 1);
      return response;
    }
    const result = await settleIncludingAbort(expectRevokedCollection());
    if (!release.settled()) {
      release.resolve();
    }
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await Promise.allSettled([collection]);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("never falls back to primary when the calendar list is denied", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({ listStatus: 403 });

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
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

    const response = await collectOk(fixture);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.coverage.calendars[0]?.outcome).toBe("failed");
  });
  describe("owner-timezone window", () => {
    /** The window the envelope reports for one anchor in one timezone. */
    async function windowFor(
      timezone: string,
      anchor: string,
    ): Promise<MorningBriefCalendarCollection["window"]> {
      const fixture = await setupOwner(timezone);
      stubCalendar({
        calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
        events: new Map([[OWNER_CALENDAR, []]]),
      });
      const body = await collectAt(fixture, anchor);
      return body.window;
    }

    function spanHours(window: MorningBriefCalendarCollection["window"]) {
      return (Date.parse(window.endAt) - Date.parse(window.startAt)) / HOUR_MS;
    }

    it("covers three calendar days, not 72 hours, across a spring-forward", async () => {
      // America/Los_Angeles moves to DST on 2026-03-08.
      const window = await windowFor(
        "America/Los_Angeles",
        "2026-03-07T20:00:00.000Z",
      );

      expect(window.startDate).toBe("2026-03-07");
      expect(window.endDateExclusive).toBe("2026-03-10");
      expect(spanHours(window)).toBe(71);
    });

    it("covers 73 hours across a fall-back", async () => {
      // America/Los_Angeles leaves DST on 2026-11-01.
      const window = await windowFor(
        "America/Los_Angeles",
        "2026-10-31T18:00:00.000Z",
      );

      expect(window.startDate).toBe("2026-10-31");
      expect(spanHours(window)).toBe(73);
    });

    it("starts at the first existing instant when local midnight is skipped", async () => {
      // America/Santiago springs forward at 00:00 on 2026-09-06, so that day
      // has no 00:00 at all.
      const window = await windowFor(
        "America/Santiago",
        "2026-09-06T15:00:00.000Z",
      );

      expect(window.startDate).toBe("2026-09-06");
      expect(window.startAt).toBe("2026-09-06T04:00:00.000Z");
    });

    it("refuses an unusable owner timezone instead of guessing one", async () => {
      const fixture = await setupOwner("Mars/Olympus");
      const stub = stubCalendar({
        calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      });

      const body = await collectAt(fixture, ANCHOR_ISO);
      expect(body.status).toBe("unavailable");
      expect(body.items).toStrictEqual([]);
      expect(stub.calls).toStrictEqual([]);
    });
  });

  it("keeps a zero-length event and a multi-day all-day range inside the window", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            timed("instant", WINDOW_START, WINDOW_START),
            {
              id: "long-leave",
              status: "confirmed",
              summary: "Leave",
              start: { date: "2026-03-01" },
              end: { date: "2026-04-01" },
            },
          ],
        ],
      ]),
    });

    const response = await collectOk(fixture);
    expect(
      response.body.items.map((item) => {
        return item.eventId;
      }),
    ).toStrictEqual(["instant", "long-leave"]);
  });

  it("declares an unreadable event time instead of dropping the event silently", async () => {
    const fixture = await setupOwner();
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            // 2026-02-30 is not a date; it must never become UTC midnight.
            {
              id: "impossible",
              status: "confirmed",
              start: { date: "2026-02-30" },
              end: { date: "2026-03-02" },
            },
          ],
        ],
      ]),
    });

    const response = await collectOk(fixture);
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.coverage.truncations).toContain(
      "unreadable-event-time",
    );
    expect(response.body.coverage.calendars[0]?.outcome).toBe("truncated");
  });

  it("deduplicates one event repeated across two pages of a calendar", async () => {
    const fixture = await setupOwner();
    const repeated = timed(
      "repeated",
      "2026-03-10T01:00:00.000Z",
      "2026-03-10T01:30:00.000Z",
    );
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([[OWNER_CALENDAR, [repeated]]]),
      pages: new Map([[OWNER_CALENDAR, "more"]]),
    });

    const response = await collectOk(fixture);
    expect(response.body.items).toHaveLength(1);
  });

  it("reads at most eight calendars and reports the rest as unread", async () => {
    const fixture = await setupOwner();
    const many = Array.from({ length: 10 }, (_, index) => {
      return {
        id: `cal-${String(index).padStart(2, "0")}@example.test`,
        accessRole: "reader",
      };
    });
    const stub = stubCalendar({ calendars: many, events: new Map() });

    const response = await collectOk(fixture);
    expect(
      response.body.coverage.calendars.filter((entry) => {
        return entry.outcome === "not-read";
      }),
    ).toHaveLength(2);
    expect(response.body.coverage.truncations).toContain("calendars");
    // The two calendars beyond the cap are never requested.
    expect(eventCalls(stub)).toHaveLength(8);
  });

  it("bounds attendees and keeps only a safe display link", async () => {
    const fixture = await setupOwner();
    const attendees = Array.from({ length: 25 }, (_, index) => {
      return {
        email: `person-${index}@example.test`,
        responseStatus: "accepted",
      };
    });
    stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      events: new Map([
        [
          OWNER_CALENDAR,
          [
            {
              ...timed(
                "crowded",
                "2026-03-10T01:00:00.000Z",
                "2026-03-10T01:30:00.000Z",
              ),
              attendees,
              htmlLink: "javascript:alert(1)",
            },
            {
              ...timed(
                "linked",
                "2026-03-10T02:00:00.000Z",
                "2026-03-10T02:30:00.000Z",
              ),
              htmlLink: "https://calendar.google.com/event?eid=ok",
            },
          ],
        ],
      ]),
    });

    const response = await collectOk(fixture);
    const crowded = response.body.items.find((item) => {
      return item.eventId === "crowded";
    });
    const linked = response.body.items.find((item) => {
      return item.eventId === "linked";
    });
    expect(crowded?.attendees).toHaveLength(20);
    expect(crowded?.attendeesTruncated).toBeTruthy();
    expect(crowded?.link).toBeNull();
    expect(linked?.link).toBe("https://calendar.google.com/event?eid=ok");
    expect(response.body.coverage.truncations).toContain("attendees");
  });

  it("reports a rate-limited calendar with its bounded wait and never retries", async () => {
    const fixture = await setupOwner();
    const stub = stubCalendar({
      calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
      eventStatus: new Map([[OWNER_CALENDAR, 429]]),
      retryAfterSeconds: 30,
    });

    const response = await collectOk(fixture);
    expect(response.body.coverage.calendars[0]).toMatchObject({
      outcome: "rate-limited",
      retryAfterMs: 30_000,
    });
    expect(response.body.failure).toBe("rate-limited");
    // One attempt, not a retry loop.
    expect(eventCalls(stub)).toHaveLength(1);
  });
});
