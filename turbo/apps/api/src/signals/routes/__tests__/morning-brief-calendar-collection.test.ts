import { randomUUID } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  morningBriefCalendarCollectionPreviewContract,
  type MorningBriefCalendarCollection,
} from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  holdMorningBriefAuthorizerFixture,
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

/** Distinct per-account credentials, so "which account" is observable. */
const DEFAULT_ACCOUNT_TOKEN = "calendar-default-account-token";
const SELECTED_ACCOUNT_TOKEN = "calendar-selected-account-token";

/** The collector's own caps, restated so a drift in either side is visible. */
const MAX_EVENTS = 200;
const MAX_TEXT_CHARACTERS = 40_000;
const MAX_IDENTITY_CHARACTERS = 512;
const MAX_LINK_CHARACTERS = 2048;

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
  /** The credential the provider was actually shown for this call. */
  readonly authorization: string | null;
}

interface CalendarStub {
  readonly calls: CalendarCall[];
}

interface StubCalendar {
  readonly id: string;
  readonly summary?: string;
  readonly accessRole?: string;
  readonly primary?: boolean;
  readonly timeZone?: string;
}

interface StubEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly location?: string;
  readonly description?: string;
  readonly start: Record<string, string>;
  readonly end: Record<string, string>;
  readonly recurringEventId?: string;
  readonly originalStartTime?: Record<string, string>;
  readonly iCalUID?: string;
  readonly htmlLink?: string;
  readonly organizer?: {
    readonly email?: string;
    readonly displayName?: string;
  };
  readonly attendees?: readonly {
    readonly email: string;
    readonly responseStatus?: string;
  }[];
}

/**
 * Every character the response actually retains, counted from the body.
 *
 * Walking the delivered items keeps the assertion independent of whichever
 * fields the collector believes it charged: the promise is about the text a
 * composed brief would have to carry, not about an internal counter.
 */
function retainedTextLength(value: unknown): number {
  let total = 0;
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      total += entry.length;
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) {
        visit(child);
      }
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) {
        visit(child);
      }
    }
  };
  visit(value);
  return total;
}

/** Every provider-derived string released in items and per-calendar coverage. */
function retainedProviderTextLength(
  body: MorningBriefCalendarCollection,
): number {
  return (
    retainedTextLength(body.items) +
    body.coverage.calendars.reduce((total, entry) => {
      return (
        total +
        entry.calendarId.length +
        (entry.summary?.length ?? 0) +
        (entry.accessRole?.length ?? 0)
      );
    }, 0)
  );
}

/** An exact, unique provider identity of the requested retained length. */
function calendarIdOfLength(index: number, length: number): string {
  const prefix = String(index).padStart(3, "0");
  if (length < prefix.length) {
    throw new Error(
      "Calendar identity length is shorter than its unique prefix",
    );
  }
  return `${prefix}${"c".repeat(length - prefix.length)}`;
}

/**
 * A Calendar stub that records every call, so a denial can be asserted as
 * *zero provider reads* rather than as an absent response body.
 */
function stubCalendar(args: {
  readonly calendars?: readonly StubCalendar[];
  /** One entry per calendar-list page; each but the last offers a token. */
  readonly calendarPages?: readonly (readonly StubCalendar[])[];
  readonly events?: ReadonlyMap<string, readonly StubEvent[]>;
  readonly eventStatus?: ReadonlyMap<string, number>;
  /** Calendars answered with a body past the shared per-response ceiling. */
  readonly oversized?: ReadonlySet<string>;
  /** Calendars answered with a body the event schema rejects. */
  readonly malformed?: ReadonlySet<string>;
  readonly listStatus?: number;
  readonly pages?: ReadonlyMap<string, string>;
  readonly holdEvents?: ReadonlyMap<string, Promise<void>>;
  readonly onEventsHeld?: () => void;
  /** Sent with a failing event response, as a real rate limit would be. */
  readonly retryAfterSeconds?: number;
}): CalendarStub {
  const calls: CalendarCall[] = [];
  let listPage = 0;

  const record = (request: Request): URL => {
    const url = new URL(request.url);
    calls.push({
      pathname: url.pathname,
      search: url.search,
      authorization: request.headers.get("authorization"),
    });
    return url;
  };

  server.use(
    http.get(CALENDAR_LIST_URL, ({ request }) => {
      record(request);
      if (args.listStatus !== undefined) {
        return HttpResponse.json(
          { error: { code: args.listStatus } },
          { status: args.listStatus },
        );
      }
      if (args.calendarPages === undefined) {
        return HttpResponse.json({ items: args.calendars ?? [] });
      }
      const page = args.calendarPages[listPage] ?? [];
      listPage += 1;
      // Every page offers a continuation, so the collector has to stop at its
      // own page cap rather than follow the provider to the end of the list.
      return HttpResponse.json({
        items: page,
        nextPageToken: `list-page-${listPage}`,
      });
    }),
    http.get(CALENDAR_EVENTS_URL, async ({ request, params }) => {
      record(request);
      const calendarId = decodeURIComponent(String(params["calendarId"]));
      const hold = args.holdEvents?.get(calendarId);
      if (hold) {
        args.onEventsHeld?.();
        await hold;
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
      if (args.malformed?.has(calendarId)) {
        return HttpResponse.json({ items: [{ id: 42 }] });
      }
      if (args.oversized?.has(calendarId)) {
        return HttpResponse.json({ items: [], padding: "z".repeat(300_000) });
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
    /**
     * Each account is issued its own credential, so a claim that one account
     * was read can be checked against what the provider was actually shown.
     */
    readonly accessToken?: string;
  },
): Promise<string> {
  mockGoogleCalendarConnectorOAuth({
    accessToken: args.accessToken ?? "calendar-access-token",
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
    accessToken: DEFAULT_ACCOUNT_TOKEN,
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
        accessToken: SELECTED_ACCOUNT_TOKEN,
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
    const stub = stubCalendar({
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
    // The two accounts hold different credentials, so "the chosen account was
    // used" is an observation at the provider boundary rather than an
    // inference from a shared fixture token.
    expect(stub.calls).not.toStrictEqual([]);
    expect(
      stub.calls.map((call) => {
        return call.authorization;
      }),
    ).toStrictEqual(
      stub.calls.map(() => {
        return `Bearer ${SELECTED_ACCOUNT_TOKEN}`;
      }),
    );
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
    let held = 0;
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
              "collected-event",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      // Let the owner's event be collected, then stop both workers so no
      // sibling can advance while the grant withdrawal is still committing.
      holdEvents: new Map([
        [TEAM_CALENDAR, release.promise],
        ["third@example.test", release.promise],
        ["fourth@example.test", release.promise],
      ]),
      onEventsHeld: () => {
        held += 1;
        if (held === 2 && !arrived.settled()) {
          arrived.resolve();
        }
      },
    });

    const collection = collectOk(fixture);
    async function expectRevokedCollection() {
      // Observe an early request failure while waiting for the actual hold.
      await Promise.race([arrived.promise, collection]);
      const heldCalls = eventCalls(stub);
      expect(heldCalls).toHaveLength(3);
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
      expect(eventCalls(stub)).toStrictEqual(heldCalls);
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
    let held = 0;
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
              "collected-event",
              "2026-03-10T01:00:00.000Z",
              "2026-03-10T01:30:00.000Z",
            ),
          ],
        ],
      ]),
      // Keep both workers held while the membership is replaced, after the
      // owner's event has already been collected under the old membership.
      holdEvents: new Map([
        [TEAM_CALENDAR, release.promise],
        ["third@example.test", release.promise],
        ["fourth@example.test", release.promise],
      ]),
      onEventsHeld: () => {
        held += 1;
        if (held === 2 && !arrived.settled()) {
          arrived.resolve();
        }
      },
    });

    const collection = collectOk(fixture);
    async function expectRevokedCollection() {
      await Promise.race([arrived.promise, collection]);
      const heldCalls = eventCalls(stub);
      expect(heldCalls).toHaveLength(3);
      // A removal and rejoin issues a new immutable membership id. The new
      // membership does not speak for what the previous one started.
      await seedMembership(fixture.actor, `orgmem_${randomUUID()}`);
      if (!release.settled()) {
        release.resolve();
      }

      const response = await collection;
      expect(eventCalls(stub)).toStrictEqual(heldCalls);
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
    // The list was read in full and nothing in it grants event detail, which
    // is a scope this account does not hold rather than a provider failure.
    expect(response.body).toMatchObject({
      failure: "not-authorized",
      coverage: { calendarList: "complete" },
    });
    expect(response.body.coverage.calendars[0]?.outcome).toBe("free-busy-only");
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

  describe("event time normalization", () => {
    /** One readable calendar holding exactly these events. */
    function stubOwnerEvents(events: readonly StubEvent[]): CalendarStub {
      return stubCalendar({
        calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
        events: new Map([[OWNER_CALENDAR, events]]),
      });
    }

    function idsOf(body: MorningBriefCalendarCollection): readonly string[] {
      return body.items.map((item) => {
        return item.eventId;
      });
    }

    /** The calendar kept usable content but declared the events it lost. */
    function expectDeclaredTimeGap(body: MorningBriefCalendarCollection): void {
      expect(body.coverage.truncations).toContain("unreadable-event-time");
      expect(body.coverage.calendars[0]?.outcome).toBe("truncated");
      expect(body.status).toBe("partial");
    }

    it("never rolls an impossible date into a real meeting", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        // February 2026 ends on the 28th. Lenient parsing turns this into
        // 2026-03-02T01:00Z, which lands inside this anchor's window.
        {
          id: "impossible",
          status: "confirmed",
          summary: "Never happened",
          start: { dateTime: "2026-02-30T01:00:00Z" },
          end: { dateTime: "2026-02-30T02:00:00Z" },
        },
        timed(
          "sibling",
          "2026-03-02T03:00:00.000Z",
          "2026-03-02T04:00:00.000Z",
        ),
      ]);

      const body = await collectAt(fixture, "2026-03-01T02:30:00.000Z");
      expect(idsOf(body)).toStrictEqual(["sibling"]);
      expectDeclaredTimeGap(body);
    });

    it("resolves an offsetless time by its declared zone, not the server's", async () => {
      // The suite runs in UTC, so the server timezone is moved for this case:
      // the expected instants are the declared zones' own, under a process
      // clock that agrees with neither.
      onTestFinished(() => {
        stubTestTimezone("UTC");
      });
      stubTestTimezone("Asia/Shanghai");
      const fixture = await setupOwner();
      stubTestTimezone("America/New_York");
      // The same wall time in two zones also cannot collapse onto one instant,
      // so no single server timezone can produce this pair.
      stubOwnerEvents([
        {
          id: "shanghai",
          status: "confirmed",
          summary: "Shanghai standup",
          start: { dateTime: "2026-03-10T09:00:00", timeZone: "Asia/Shanghai" },
          end: { dateTime: "2026-03-10T10:00:00", timeZone: "Asia/Shanghai" },
        },
        {
          id: "new-york",
          status: "confirmed",
          summary: "New York standup",
          start: {
            dateTime: "2026-03-10T09:00:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-03-10T10:00:00",
            timeZone: "America/New_York",
          },
        },
      ]);

      const response = await collectOk(fixture);
      expect(response.body.items).toMatchObject([
        {
          eventId: "shanghai",
          start: "2026-03-10T01:00:00.000Z",
          end: "2026-03-10T02:00:00.000Z",
          eventTimezone: "Asia/Shanghai",
        },
        {
          eventId: "new-york",
          start: "2026-03-10T13:00:00.000Z",
          end: "2026-03-10T14:00:00.000Z",
          eventTimezone: "America/New_York",
        },
      ]);
      expect(response.body.coverage.truncations).not.toContain(
        "unreadable-event-time",
      );
    });

    it("declares an offsetless time with no usable zone instead of guessing one", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        {
          id: "no-zone",
          status: "confirmed",
          summary: "Context-free",
          start: { dateTime: "2026-03-10T09:00:00" },
          end: { dateTime: "2026-03-10T10:00:00" },
        },
        {
          id: "unknown-zone",
          status: "confirmed",
          summary: "Unknown zone",
          start: { dateTime: "2026-03-10T09:00:00", timeZone: "Mars/Olympus" },
          end: { dateTime: "2026-03-10T10:00:00", timeZone: "Mars/Olympus" },
        },
        timed("kept", "2026-03-10T01:00:00.000Z", "2026-03-10T01:30:00.000Z"),
      ]);

      const response = await collectOk(fixture);
      expect(idsOf(response.body)).toStrictEqual(["kept"]);
      expectDeclaredTimeGap(response.body);
    });

    it("keeps an explicit offset exactly, even against a conflicting zone", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        {
          id: "offset",
          status: "confirmed",
          summary: "Offset",
          // An explicit offset already identifies the instant; a `timeZone`
          // alongside it is provenance, not a second interpretation.
          start: {
            dateTime: "2026-03-10T09:00:00.250+08:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-03-10T10:00:00-05:00",
            timeZone: "America/New_York",
          },
        },
        timed("utc", "2026-03-11T02:00:00.000Z", "2026-03-11T03:00:00.000Z"),
      ]);

      const response = await collectOk(fixture);
      expect(response.body.items).toMatchObject([
        {
          eventId: "offset",
          start: "2026-03-10T01:00:00.250Z",
          end: "2026-03-10T15:00:00.000Z",
        },
        {
          eventId: "utc",
          start: "2026-03-11T02:00:00.000Z",
          end: "2026-03-11T03:00:00.000Z",
        },
      ]);
      expect(response.body.coverage.truncations).not.toContain(
        "unreadable-event-time",
      );
    });

    it("declares a wall time its zone never had, or had twice", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        {
          id: "skipped",
          status: "confirmed",
          summary: "Spring forward",
          // America/New_York jumps 02:00 to 03:00 on 2026-03-08.
          start: {
            dateTime: "2026-03-08T02:30:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-03-08T03:30:00",
            timeZone: "America/New_York",
          },
        },
        {
          id: "repeated",
          status: "confirmed",
          summary: "Fall back",
          // 2026-11-01T01:30 happens twice in America/New_York.
          start: {
            dateTime: "2026-11-01T01:30:00",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-11-01T02:30:00",
            timeZone: "America/New_York",
          },
        },
        timed("kept", "2026-03-10T01:00:00.000Z", "2026-03-10T01:30:00.000Z"),
      ]);

      const response = await collectOk(fixture);
      expect(idsOf(response.body)).toStrictEqual(["kept"]);
      expectDeclaredTimeGap(response.body);
    });

    it("rejects a backwards timed range while keeping a zero-length one", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        // An end before its start describes no interval at all.
        timed(
          "backwards",
          "2026-03-10T02:00:00.000Z",
          "2026-03-10T01:00:00.000Z",
        ),
        timed("point", "2026-03-10T05:00:00.000Z", "2026-03-10T05:00:00.000Z"),
      ]);

      const response = await collectOk(fixture);
      expect(idsOf(response.body)).toStrictEqual(["point"]);
      expectDeclaredTimeGap(response.body);
    });

    it("rejects backwards and empty all-day ranges", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        {
          id: "backwards-all-day",
          status: "confirmed",
          summary: "Backwards",
          start: { date: "2026-03-11" },
          end: { date: "2026-03-10" },
        },
        {
          id: "empty-all-day",
          status: "confirmed",
          summary: "Empty",
          // The end date is exclusive, so this covers no day at all.
          start: { date: "2026-03-10" },
          end: { date: "2026-03-10" },
        },
        {
          id: "conference",
          status: "confirmed",
          summary: "Conference",
          start: { date: "2026-03-10" },
          end: { date: "2026-03-12" },
        },
      ]);

      const response = await collectOk(fixture);
      expect(idsOf(response.body)).toStrictEqual(["conference"]);
      expect(response.body.items[0]).toMatchObject({
        allDay: true,
        start: "2026-03-10",
        end: "2026-03-12",
        localDayOffset: 0,
      });
      expectDeclaredTimeGap(response.body);
    });

    it("keeps an event that straddles either window edge", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        // Begins before the window and runs into it: it overlaps rather than
        // starting inside, so it has no covered local day.
        timed(
          "straddles-start",
          "2026-03-09T15:00:00.000Z",
          "2026-03-09T17:00:00.000Z",
        ),
        // Begins on the last covered day and runs past the exclusive end.
        timed(
          "straddles-end",
          "2026-03-12T15:00:00.000Z",
          "2026-03-12T17:00:00.000Z",
        ),
      ]);

      const response = await collectOk(fixture);
      expect(response.body.items).toMatchObject([
        { eventId: "straddles-start", localDayOffset: null },
        { eventId: "straddles-end", localDayOffset: 2 },
      ]);
      expect(response.body).toMatchObject({
        status: "ok",
        failure: null,
        coverage: { truncations: [] },
      });
    });

    it("rejects an event that states two different representations", async () => {
      const fixture = await setupOwner();
      stubOwnerEvents([
        {
          id: "both",
          status: "confirmed",
          summary: "Both",
          // Claiming a date and a time states two different moments.
          start: { date: "2026-03-10", dateTime: "2026-03-10T09:00:00Z" },
          end: { date: "2026-03-11" },
        },
        {
          id: "mixed",
          status: "confirmed",
          summary: "Mixed",
          start: { date: "2026-03-10" },
          end: { dateTime: "2026-03-10T10:00:00Z" },
        },
        {
          id: "empty-endpoint",
          status: "confirmed",
          summary: "Empty endpoint",
          start: { timeZone: "Asia/Shanghai" },
          end: { dateTime: "2026-03-10T10:00:00Z" },
        },
        timed("kept", "2026-03-10T01:00:00.000Z", "2026-03-10T01:30:00.000Z"),
      ]);

      const response = await collectOk(fixture);
      expect(idsOf(response.body)).toStrictEqual(["kept"]);
      expectDeclaredTimeGap(response.body);
    });
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

  it("admits each exact calendar identity once across list pages", async () => {
    const fixture = await setupOwner();
    const calendarIds = Array.from({ length: 9 }, (_, index) => {
      return `distinct-${index}@example.test`;
    });
    const repeated = calendarIds[0];
    const sameEventSibling = calendarIds[1];
    if (repeated === undefined || sameEventSibling === undefined) {
      throw new Error("Expected duplicate-admission fixtures");
    }
    const calendars = calendarIds.map((id) => {
      return { id, accessRole: "reader" } as const;
    });
    const events = new Map<string, readonly StubEvent[]>(
      calendarIds.map((calendarId, index) => {
        return [
          calendarId,
          index === 0
            ? [
                timed(
                  "same-event",
                  "2026-03-10T01:00:00.000Z",
                  "2026-03-10T01:30:00.000Z",
                ),
                {
                  ...timed(
                    "shared-instance-id",
                    "2026-03-10T02:00:00.000Z",
                    "2026-03-10T02:30:00.000Z",
                  ),
                  recurringEventId: "series",
                  originalStartTime: {
                    dateTime: "2026-03-10T02:00:00.000Z",
                  },
                },
                {
                  ...timed(
                    "shared-instance-id",
                    "2026-03-11T02:00:00.000Z",
                    "2026-03-11T02:30:00.000Z",
                  ),
                  recurringEventId: "series",
                  originalStartTime: {
                    dateTime: "2026-03-11T02:00:00.000Z",
                  },
                },
              ]
            : index === 1
              ? [
                  timed(
                    "same-event",
                    "2026-03-10T03:00:00.000Z",
                    "2026-03-10T03:30:00.000Z",
                  ),
                ]
              : [],
        ];
      }),
    );
    const stub = stubCalendar({
      calendarPages: [calendars.slice(0, 8), [calendars[0]!, calendars[8]!]],
      events,
    });

    const response = await collectOk(fixture);
    const identities = response.body.items.map((item) => {
      return `${item.calendarId}:${item.eventId}:${item.originalStartTime ?? "ordinary"}`;
    });
    expect(identities).toStrictEqual([
      `${repeated}:same-event:ordinary`,
      `${repeated}:shared-instance-id:2026-03-10T02:00:00.000Z`,
      `${repeated}:shared-instance-id:2026-03-11T02:00:00.000Z`,
      `${sameEventSibling}:same-event:ordinary`,
    ]);
    expect(new Set(identities).size).toBe(identities.length);
    // The repeated calendar consumes one of eight distinct slots, not two, and
    // the ninth distinct identity is the only calendar left unread.
    const requestedCalendars = eventCalls(stub).map((call) => {
      return decodeURIComponent(call.pathname.split("/").at(-2) ?? "");
    });
    expect(new Set(requestedCalendars).size).toBe(8);
    expect(requestedCalendars).toHaveLength(8);
    expect(
      response.body.coverage.calendars.filter((entry) => {
        return entry.calendarId === repeated;
      }),
    ).toHaveLength(1);
    expect(
      response.body.coverage.calendars.filter((entry) => {
        return entry.outcome === "not-read";
      }),
    ).toHaveLength(1);
  });

  it("treats contradictory repeated metadata identically in either page order", async () => {
    async function collectOrder(
      first: StubCalendar,
      second: StubCalendar,
    ): Promise<MorningBriefCalendarCollection> {
      const fixture = await setupOwner();
      stubCalendar({ calendarPages: [[first], [second]] });
      return (await collectOk(fixture)).body;
    }
    const owner = {
      id: OWNER_CALENDAR,
      summary: "Owner version",
      accessRole: "owner",
      primary: true,
    } as const;
    const reader = {
      id: OWNER_CALENDAR,
      summary: "Reader version",
      accessRole: "reader",
      primary: false,
    } as const;

    const ownerFirst = await collectOrder(owner, reader);
    const readerFirst = await collectOrder(reader, owner);
    expect(readerFirst.items).toStrictEqual(ownerFirst.items);
    expect(readerFirst.coverage).toStrictEqual(ownerFirst.coverage);
    expect(readerFirst.status).toBe(ownerFirst.status);
    expect(readerFirst.failure).toBe(ownerFirst.failure);
    expect(ownerFirst.items).toStrictEqual([]);
    expect(ownerFirst.coverage.calendars).toStrictEqual([
      {
        calendarId: OWNER_CALENDAR,
        summary: null,
        accessRole: null,
        primary: false,
        outcome: "unknown-access",
        retryAfterMs: null,
      },
    ]);
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

  describe("final output budget", () => {
    const LONG_SUMMARY = "s".repeat(100);
    const LONG_ORGANIZER = "o".repeat(200);
    const LONG_CALENDAR_NAME = "c".repeat(200);

    /** Four readable calendars, each offering a full page of wordy events. */
    function crowdedCalendars(): {
      readonly calendars: readonly StubCalendar[];
      readonly events: ReadonlyMap<string, readonly StubEvent[]>;
    } {
      const calendars = Array.from({ length: 4 }, (_, index) => {
        return {
          id: `crowded-${index}@example.test`,
          summary: LONG_CALENDAR_NAME,
          accessRole: "reader",
        };
      });
      const events = new Map(
        calendars.map((calendar, calendarIndex) => {
          return [
            calendar.id,
            Array.from({ length: 50 }, (_, eventIndex) => {
              return {
                ...timed(
                  `crowded-${calendarIndex}-${eventIndex}`,
                  "2026-03-10T01:00:00.000Z",
                  "2026-03-10T01:30:00.000Z",
                ),
                summary: LONG_SUMMARY,
                organizer: { displayName: LONG_ORGANIZER },
              };
            }),
          ] as const;
        }),
      );
      return { calendars, events };
    }

    it("keeps the retained text inside its promised budget when ordinary fields repeat", async () => {
      const fixture = await setupOwner();
      const { calendars, events } = crowdedCalendars();
      const stub = stubCalendar({ calendars, events });

      const response = await collectOk(fixture);

      // 200 events, each carrying a 100-character summary, a 200-character
      // organizer and a 200-character calendar name, is 100,000 characters of
      // ordinary displayed text. The shared byte ceilings never see it: five
      // small responses stay far inside them.
      expect(eventCalls(stub)).toHaveLength(4);
      expect(retainedProviderTextLength(response.body)).toBeLessThanOrEqual(
        MAX_TEXT_CHARACTERS,
      );
      expect(response.body.items.length).toBeLessThan(MAX_EVENTS);
      expect(response.body.items).not.toStrictEqual([]);
      // What could not be carried is declared, and the day is not a healthy one.
      expect(response.body.status).toBe("partial");
      expect(response.body.coverage.truncations).toContain("text-characters");
      expect(
        response.body.coverage.calendars.every((entry) => {
          return entry.outcome !== "complete" || entry.calendarId.length === 0;
        }) ||
          response.body.coverage.calendars.some((entry) => {
            return entry.outcome === "truncated";
          }),
      ).toBeTruthy();
      // The organizer and the calendar name are retained, so they are exactly
      // the text the budget had to account for.
      const first = response.body.items[0];
      expect(first?.organizer).toBe(LONG_ORGANIZER);
      expect(first?.calendarSummary).toBe(LONG_CALENDAR_NAME);
    });

    it("allocates the shared budget the same way whichever calendar answers first", async () => {
      const description = "d".repeat(500);
      const calendars = [
        { id: "race-a@example.test", accessRole: "reader" },
        { id: "race-b@example.test", accessRole: "reader" },
      ];
      const events = new Map(
        calendars.map((calendar, calendarIndex) => {
          return [
            calendar.id,
            Array.from({ length: 50 }, (_, eventIndex) => {
              return {
                ...timed(
                  `race-${calendarIndex}-${eventIndex}`,
                  "2026-03-10T01:00:00.000Z",
                  "2026-03-10T01:30:00.000Z",
                ),
                description,
              };
            }),
          ] as const;
        }),
      );

      /** Collect with `firstToAnswer` served before its sibling. */
      async function collectRacing(
        firstToAnswer: string,
      ): Promise<MorningBriefCalendarCollection> {
        const fixture = await setupOwner();
        const answered = createDeferredPromise<void>(context.signal);
        server.use(
          http.get(CALENDAR_LIST_URL, () => {
            return HttpResponse.json({ items: calendars });
          }),
          http.get(CALENDAR_EVENTS_URL, async ({ params }) => {
            const calendarId = decodeURIComponent(String(params["calendarId"]));
            if (calendarId !== firstToAnswer) {
              // Arrival order, not a sleep: the sibling has already answered.
              await answered.promise;
            }
            const body = HttpResponse.json({
              items: events.get(calendarId) ?? [],
            });
            if (calendarId === firstToAnswer) {
              answered.resolve();
            }
            return body;
          }),
        );
        const response = await collectOk(fixture);
        return response.body;
      }

      const aFirst = await collectRacing("race-a@example.test");
      const bFirst = await collectRacing("race-b@example.test");

      // Both calendars want more than the budget can hold, so the order their
      // responses arrive in decides nothing: the owner's day is allocated in
      // the stable calendar order either way.
      expect(retainedProviderTextLength(aFirst)).toBeLessThanOrEqual(
        MAX_TEXT_CHARACTERS,
      );
      expect(aFirst.items).not.toStrictEqual([]);
      expect(aFirst.coverage.truncations).toContain("text-characters");
      expect(bFirst.items).toStrictEqual(aFirst.items);
      expect(bFirst.coverage.truncations).toStrictEqual(
        aFirst.coverage.truncations,
      );
      expect(bFirst.status).toBe(aFirst.status);
    });

    it("bounds the 70,600-character coverage example inside the same budget", async () => {
      const fixture = await setupOwner();
      const summary = "s".repeat(200);
      const calendars = Array.from({ length: 100 }, (_, index) => {
        return {
          id: calendarIdOfLength(index, 500),
          summary,
          accessRole: "reader",
        } as const;
      });
      const stub = stubCalendar({
        calendarPages: [calendars.slice(0, 50), calendars.slice(50)],
        events: new Map(),
      });

      const response = await collectOk(fixture);
      expect(response.body.items).toStrictEqual([]);
      expect(retainedProviderTextLength(response.body)).toBeLessThanOrEqual(
        MAX_TEXT_CHARACTERS,
      );
      expect(response.body.coverage.calendars.length).toBeLessThan(100);
      expect(response.body.coverage.truncations).toContain("text-characters");
      expect(response.body.coverage.requests).toBe(10);
      expect(eventCalls(stub)).toHaveLength(8);
      const exactIds = new Set(
        calendars.map((calendar) => {
          return calendar.id;
        }),
      );
      expect(
        response.body.coverage.calendars.every((entry) => {
          return exactIds.has(entry.calendarId);
        }),
      ).toBeTruthy();
      expect(response.body.status).toBe("unavailable");
    });

    it("retains exact-fit coverage and drops an overflowing identity whole", async () => {
      async function collectCoverage(identityLength: number) {
        const fixture = await setupOwner();
        const summary = "s".repeat(200);
        const calendars = Array.from({ length: 100 }, (_, index) => {
          return {
            id: calendarIdOfLength(index, identityLength),
            summary,
            accessRole: "reader",
          } as const;
        });
        stubCalendar({
          calendarPages: [calendars.slice(0, 50), calendars.slice(50)],
          events: new Map(),
        });
        return { body: (await collectOk(fixture)).body, calendars };
      }

      const exact = await collectCoverage(194);
      expect(retainedProviderTextLength(exact.body)).toBe(MAX_TEXT_CHARACTERS);
      expect(exact.body.coverage.calendars).toHaveLength(100);
      expect(exact.body.coverage.truncations).not.toContain("text-characters");

      const overflow = await collectCoverage(195);
      expect(retainedProviderTextLength(overflow.body)).toBeLessThanOrEqual(
        MAX_TEXT_CHARACTERS,
      );
      expect(overflow.body.coverage.calendars.length).toBeLessThan(100);
      expect(overflow.body.coverage.truncations).toContain("text-characters");
      const completeIds = new Set(
        overflow.calendars.map((calendar) => {
          return calendar.id;
        }),
      );
      expect(
        overflow.body.coverage.calendars.every((entry) => {
          return completeIds.has(entry.calendarId);
        }),
      ).toBeTruthy();
    });

    it("keeps at most two hundred events and says so", async () => {
      const fixture = await setupOwner();
      const calendars = Array.from({ length: 5 }, (_, index) => {
        return { id: `many-${index}@example.test`, accessRole: "reader" };
      });
      const events = new Map(
        calendars.map((calendar, calendarIndex) => {
          return [
            calendar.id,
            Array.from({ length: 50 }, (_, eventIndex) => {
              return timed(
                `many-${calendarIndex}-${eventIndex}`,
                "2026-03-10T01:00:00.000Z",
                "2026-03-10T01:30:00.000Z",
              );
            }),
          ] as const;
        }),
      );
      stubCalendar({ calendars, events });

      const response = await collectOk(fixture);
      expect(response.body.items).toHaveLength(MAX_EVENTS);
      expect(response.body.coverage.truncations).toContain("events");
      expect(response.body.coverage.truncations).not.toContain(
        "text-characters",
      );
      expect(response.body.status).toBe("partial");
      // 250 short events stay far inside the character budget, so this is the
      // event cap and nothing else.
      expect(retainedTextLength(response.body.items)).toBeLessThan(
        MAX_TEXT_CHARACTERS,
      );
    });

    it("stops at the calendar-list page cap and reports the unfollowed remainder", async () => {
      const fixture = await setupOwner();
      const page = (prefix: string): readonly StubCalendar[] => {
        return Array.from({ length: 50 }, (_, index) => {
          return {
            id: `${prefix}-${String(index).padStart(2, "0")}@example.test`,
            accessRole: "reader",
          };
        });
      };
      const stub = stubCalendar({
        calendarPages: [page("first"), page("second")],
        events: new Map(),
      });

      const response = await collectOk(fixture);
      // Two pages were followed and the third token was not, so the list is
      // declared incomplete instead of being presented as the whole account.
      expect(
        stub.calls.filter((call) => {
          return call.pathname.endsWith("/calendarList");
        }),
      ).toHaveLength(2);
      expect(response.body.coverage.calendarList).toBe("truncated");
      expect(response.body.coverage.truncations).toContain(
        "calendar-list-pages",
      );
      expect(response.body.coverage.truncations).toContain("calendars");
      expect(eventCalls(stub)).toHaveLength(8);
      expect(response.body.status).toBe("unavailable");
    });

    it("drops an unrepresentable identity and keeps its valid siblings", async () => {
      const fixture = await setupOwner();
      const oversizedId = "x".repeat(MAX_IDENTITY_CHARACTERS + 1);
      const oversizedLink = `https://calendar.google.com/event?eid=${"y".repeat(
        MAX_LINK_CHARACTERS,
      )}`;
      const stub = stubCalendar({
        calendars: [
          { id: OWNER_CALENDAR, accessRole: "owner", primary: true },
          // A calendar id this long cannot address a request or name a
          // coverage entry, so it is never asked for.
          {
            id: `${"c".repeat(MAX_IDENTITY_CHARACTERS)}@example.test`,
            accessRole: "reader",
          },
        ],
        events: new Map([
          [
            OWNER_CALENDAR,
            [
              timed(
                "kept-first",
                "2026-03-10T01:00:00.000Z",
                "2026-03-10T01:30:00.000Z",
              ),
              timed(
                oversizedId,
                "2026-03-10T02:00:00.000Z",
                "2026-03-10T02:30:00.000Z",
              ),
              {
                ...timed(
                  "kept-recurring",
                  "2026-03-10T03:00:00.000Z",
                  "2026-03-10T03:30:00.000Z",
                ),
                iCalUID: `${oversizedId}@google.test`,
              },
              {
                ...timed(
                  "kept-linked",
                  "2026-03-10T04:00:00.000Z",
                  "2026-03-10T04:30:00.000Z",
                ),
                htmlLink: oversizedLink,
              },
              timed(
                "kept-last",
                "2026-03-10T05:00:00.000Z",
                "2026-03-10T05:30:00.000Z",
              ),
            ],
          ],
        ]),
      });

      const response = await collectOk(fixture);
      const ids = response.body.items.map((item) => {
        return item.eventId;
      });

      // The two events whose identity cannot be carried are gone whole. No
      // prefix of either survives as a new, colliding identity.
      expect(ids).toStrictEqual(["kept-first", "kept-linked", "kept-last"]);
      expect(
        ids.some((id) => {
          return id.startsWith("xxx");
        }),
      ).toBeFalsy();
      expect(
        response.body.items.some((item) => {
          return item.iCalUID !== null && item.iCalUID.startsWith("xxx");
        }),
      ).toBeFalsy();
      // A URL has no shorter form, so the event keeps its place without one.
      expect(
        response.body.items.find((item) => {
          return item.eventId === "kept-linked";
        })?.link,
      ).toBeNull();
      expect(response.body.coverage.truncations).toContain(
        "oversized-identity",
      );
      expect(response.body.coverage.truncations).toContain("oversized-link");
      expect(response.body.status).toBe("partial");
      // The unusable calendar is declared through the same limit and is never
      // requested under a clipped id.
      expect(eventCalls(stub)).toHaveLength(1);
      expect(
        response.body.coverage.calendars.map((entry) => {
          return entry.calendarId;
        }),
      ).toStrictEqual([OWNER_CALENDAR]);
    });
  });

  describe("coverage of what was never read", () => {
    it("reports an unrecognized access role as unknown coverage, not a quiet day", async () => {
      const fixture = await setupOwner();
      const stub = stubCalendar({
        calendars: [
          { id: "mystery@example.test", accessRole: "mystery" },
          { id: "roleless@example.test" },
        ],
      });

      const response = await collectOk(fixture);
      // Whether these calendars hold anything is unknown. Presenting them as a
      // complete empty read would be the same answer as a real quiet day.
      expect(response.body.status).toBe("unavailable");
      expect(response.body.items).toStrictEqual([]);
      expect(response.body.coverage.calendars).toStrictEqual([
        {
          calendarId: "mystery@example.test",
          summary: null,
          accessRole: "mystery",
          primary: false,
          outcome: "unknown-access",
          retryAfterMs: null,
        },
        {
          calendarId: "roleless@example.test",
          summary: null,
          accessRole: null,
          primary: false,
          outcome: "unknown-access",
          retryAfterMs: null,
        },
      ]);
      expect(response.body.failure).toBe("provider-failed");
      expect(eventCalls(stub)).toStrictEqual([]);
    });

    it("reports an account with an empty calendar list as no readable scope", async () => {
      const fixture = await setupOwner();
      const stub = stubCalendar({ calendars: [] });

      const response = await collectOk(fixture);
      // Nothing was opened, so nothing can be reported as quiet.
      expect(response.body).toMatchObject({
        status: "unavailable",
        failure: "not-authorized",
        items: [],
        coverage: { calendarList: "complete", calendars: [] },
      });
      expect(eventCalls(stub)).toStrictEqual([]);
    });

    it("keeps a throttled calendar rate-limited without a Retry-After header", async () => {
      const fixture = await setupOwner();
      const stub = stubCalendar({
        calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
        eventStatus: new Map([[OWNER_CALENDAR, 429]]),
      });

      const response = await collectOk(fixture);
      // Whether the provider volunteered a wait does not change what happened
      // to the read.
      expect(response.body.coverage.calendars[0]).toMatchObject({
        outcome: "rate-limited",
        retryAfterMs: null,
      });
      expect(response.body.coverage.retryAfterMs).toBeNull();
      expect(response.body.failure).toBe("rate-limited");
      expect(eventCalls(stub)).toHaveLength(1);
    });

    it("does not call a denied calendar throttled because it offered a wait", async () => {
      const fixture = await setupOwner();
      const stub = stubCalendar({
        calendars: [{ id: OWNER_CALENDAR, accessRole: "owner", primary: true }],
        eventStatus: new Map([[OWNER_CALENDAR, 403]]),
        retryAfterSeconds: 30,
      });

      const response = await collectOk(fixture);
      // The hint is kept because it is real, but nothing throttled this read.
      expect(response.body.coverage.calendars[0]).toMatchObject({
        outcome: "denied",
        retryAfterMs: 30_000,
      });
      expect(response.body.failure).toBe("provider-failed");
      expect(eventCalls(stub)).toHaveLength(1);
    });

    it("keeps a readable sibling through a throttled, oversized and malformed calendar", async () => {
      const fixture = await setupOwner();
      const throttled = "throttled@example.test";
      const oversized = "oversized@example.test";
      const malformed = "malformed@example.test";
      stubCalendar({
        calendars: [
          { id: OWNER_CALENDAR, accessRole: "owner", primary: true },
          { id: throttled, accessRole: "reader" },
          { id: oversized, accessRole: "reader" },
          { id: malformed, accessRole: "reader" },
        ],
        events: new Map([
          [
            OWNER_CALENDAR,
            [
              timed(
                "survivor",
                "2026-03-10T01:00:00.000Z",
                "2026-03-10T01:30:00.000Z",
              ),
            ],
          ],
        ]),
        eventStatus: new Map([[throttled, 429]]),
        oversized: new Set([oversized]),
        malformed: new Set([malformed]),
      });

      const response = await collectOk(fixture);
      const outcomes = new Map(
        response.body.coverage.calendars.map((entry) => {
          return [entry.calendarId, entry.outcome] as const;
        }),
      );
      expect(
        response.body.items.map((item) => {
          return item.eventId;
        }),
      ).toStrictEqual(["survivor"]);
      expect(response.body.status).toBe("partial");
      expect(outcomes.get(OWNER_CALENDAR)).toBe("complete");
      expect(outcomes.get(throttled)).toBe("rate-limited");
      expect(outcomes.get(oversized)).toBe("failed");
      expect(outcomes.get(malformed)).toBe("failed");
      expect(response.body.coverage.truncations).toContain("response-bytes");
      // Usable content survived, so the source itself did not fail.
      expect(response.body.failure).toBeNull();
    });
  });

  describe("concurrent worker lifetime", () => {
    const JOIN_CALENDARS = [
      { id: "join-1@example.test", accessRole: "reader" },
      { id: "join-2@example.test", accessRole: "reader" },
      { id: "join-3@example.test", accessRole: "reader" },
      { id: "join-4@example.test", accessRole: "reader" },
    ] as const;

    it("cancels both started calendar reads and issues nothing afterwards", async () => {
      const fixture = await setupOwner();
      const cancellation = new Error(`cancelled ${randomUUID()}`);
      const controller = new AbortController();
      const started = JOIN_CALENDARS.slice(0, 2).map((calendar) => {
        return calendar.id;
      });
      const deferreds = (): ReadonlyMap<
        string,
        ReturnType<typeof createDeferredPromise<void>>
      > => {
        return new Map(
          started.map((calendarId) => {
            return [
              calendarId,
              createDeferredPromise<void>(context.signal),
            ] as const;
          }),
        );
      };
      const arrived = deferreds();
      const cancelled = deferreds();
      const finished = deferreds();
      const held = JOIN_CALENDARS[1].id;
      const release = createDeferredPromise<void>(context.signal);
      const eventRequests: string[] = [];

      server.use(
        http.get(CALENDAR_LIST_URL, () => {
          return HttpResponse.json({ items: [...JOIN_CALENDARS] });
        }),
        http.get(CALENDAR_EVENTS_URL, async ({ request, params }) => {
          const calendarId = decodeURIComponent(String(params["calendarId"]));
          eventRequests.push(calendarId);
          // Neither calendar answers on its own, so both reads stay started
          // until the cancellation actually reaches them.
          request.signal.addEventListener(
            "abort",
            () => {
              cancelled.get(calendarId)?.resolve();
            },
            { once: true },
          );
          arrived.get(calendarId)?.resolve();
          // The held calendar outlives its sibling's cancellation and is
          // released explicitly, so no handler survives this test.
          await (calendarId === held
            ? release.promise
            : cancelled.get(calendarId)?.promise);
          finished.get(calendarId)?.resolve();
          return HttpResponse.json({ items: [] });
        }),
      );

      const settle = async (
        deferred: ReadonlyMap<
          string,
          ReturnType<typeof createDeferredPromise<void>>
        >,
      ): Promise<void> => {
        await Promise.all(
          [...deferred.values()].map((entry) => {
            return entry.promise;
          }),
        );
      };

      await seedMembership(fixture.actor, fixture.membershipId);
      const pending = setupApp({
        context,
        routes: morningBriefCalendarCollectionPreviewRoutes,
        signal: controller.signal,
        rethrowErrors: true,
      })(morningBriefCalendarCollectionPreviewContract).collect({
        headers: authHeaders(fixture.actor),
        body: { anchor: ANCHOR_ISO },
      });

      // Arrival, not a sleep: both workers are inside a started provider read
      // and one of them is held.
      await settle(arrived);
      const startedRequests = [...eventRequests].sort();
      controller.abort(cancellation);
      // Awaiting each request's own abort proves the cancellation reached
      // every started read rather than only the one that answered first.
      await settle(cancelled);
      release.resolve();
      await settle(finished);

      // The caller receives the cancellation instead of a collection, so it is
      // propagated rather than masked into a partial day.
      await expect(pending).rejects.toThrow(cancellation.message);
      // Concurrency two, so exactly two calendars were ever started, and the
      // remaining two are never requested after the cancellation boundary.
      expect(startedRequests).toStrictEqual([...started].sort());
      expect([...eventRequests].sort()).toStrictEqual(startedRequests);
    });

    it("keeps public cancellation pending until a blocked authorized sibling settles", async () => {
      const fixture = await setupOwner();
      const cancellation = new Error(`cancelled ${randomUUID()}`);
      const controller = new AbortController();
      const calendars = JOIN_CALENDARS.slice(0, 2);
      const bothArrived = createDeferredPromise<void>(context.signal);
      const releaseContinuation = createDeferredPromise<void>(context.signal);
      const cancelled = createDeferredPromise<void>(context.signal);
      let arrivals = 0;
      const eventRequests: string[] = [];

      server.use(
        http.get(CALENDAR_LIST_URL, () => {
          return HttpResponse.json({ items: calendars });
        }),
        http.get(CALENDAR_EVENTS_URL, async ({ request, params }) => {
          const calendarId = decodeURIComponent(String(params["calendarId"]));
          const pageToken = new URL(request.url).searchParams.get("pageToken");
          eventRequests.push(`${calendarId}:${pageToken ?? "first"}`);
          if (pageToken !== null) {
            throw new Error("No provider request may pass the held authorizer");
          }
          arrivals += 1;
          if (arrivals === 2) {
            bothArrived.resolve();
          }
          if (calendarId === calendars[0]?.id) {
            await releaseContinuation.promise;
            return HttpResponse.json({ items: [], nextPageToken: "next" });
          }
          request.signal.addEventListener(
            "abort",
            () => {
              cancelled.resolve();
            },
            { once: true },
          );
          await cancelled.promise;
          return HttpResponse.error();
        }),
      );

      await seedMembership(fixture.actor, fixture.membershipId);
      const request = setupApp({
        context,
        routes: morningBriefCalendarCollectionPreviewRoutes,
        signal: controller.signal,
        rethrowErrors: true,
      })(morningBriefCalendarCollectionPreviewContract).collect({
        headers: authHeaders(fixture.actor),
        body: { anchor: ANCHOR_ISO },
      });
      const publicOutcome = createDeferredPromise<
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: unknown }
      >(context.signal);
      const outcomeObservation = settleIncludingAbort(request).then(
        (outcome) => {
          publicOutcome.resolve(outcome);
        },
      );

      // Both first-page HTTP requests are real and in flight before the
      // canonical installation relation is locked. Releasing only one page
      // drives that worker into the shared authorizer for its continuation.
      await bothArrived.promise;
      const barrier = await holdMorningBriefAuthorizerFixture(context.signal);
      releaseContinuation.resolve();
      await barrier.waitForBlocked();

      controller.abort(cancellation);
      await cancelled.promise;
      const callsAtCancellation = [...eventRequests];
      // Let the rejected worker and the route promise run their microtasks. A
      // plain Promise.all settles here; joinAll must still be waiting for the
      // sibling whose real authorization query remains blocked.
      const nextTurn = createDeferredPromise<void>(context.signal);
      setImmediate(() => {
        nextTurn.resolve();
      });
      await nextTurn.promise;
      expect(publicOutcome.settled()).toBeFalsy();

      await barrier.release();
      const outcome = await publicOutcome.promise;
      await outcomeObservation;
      expect(outcome.ok).toBeFalsy();
      if (outcome.ok) {
        throw new Error("Expected caller cancellation");
      }
      expect(outcome.error).toBe(cancellation);
      expect(eventRequests).toStrictEqual(callsAtCancellation);
    });

    it("declares a calendar whose id cannot address a request and keeps its sibling", async () => {
      const fixture = await setupOwner();
      const siblingArrived = createDeferredPromise<void>(context.signal);
      const releaseSibling = createDeferredPromise<void>(context.signal);
      const eventRequests: string[] = [];
      // A lone surrogate is a valid JSON string and an impossible URL
      // component. Encoding it inside the worker throws, which is the one
      // provider-driven way a per-calendar read rejects rather than reporting.
      const unencodable = "\uD800";

      server.use(
        http.get(CALENDAR_LIST_URL, () => {
          return HttpResponse.json({
            items: [
              { id: unencodable, accessRole: "reader" },
              { id: TEAM_CALENDAR, accessRole: "reader" },
            ],
          });
        }),
        http.get(CALENDAR_EVENTS_URL, async ({ params }) => {
          const calendarId = decodeURIComponent(String(params["calendarId"]));
          eventRequests.push(calendarId);
          siblingArrived.resolve();
          // Held until the test releases it, so a collection that abandoned
          // this started read would have to answer without its events.
          await releaseSibling.promise;
          return HttpResponse.json({
            items: [
              timed(
                "sibling-survived",
                "2026-03-10T01:00:00.000Z",
                "2026-03-10T01:30:00.000Z",
              ),
            ],
          });
        }),
      );

      const collection = collectOk(fixture);
      await siblingArrived.promise;
      releaseSibling.resolve();
      const response = await collection;

      // The unusable calendar is a declared limit on one calendar, not a
      // failure of the collection, and the sibling read that was already
      // started still reaches the result.
      expect(
        response.body.items.map((item) => {
          return item.eventId;
        }),
      ).toStrictEqual(["sibling-survived"]);
      expect(response.body.status).toBe("partial");
      expect(response.body.coverage.truncations).toContain(
        "oversized-identity",
      );
      // It is never requested, under its raw id or a clipped one.
      expect(eventRequests).toStrictEqual([TEAM_CALENDAR]);
      expect(
        response.body.coverage.calendars.map((entry) => {
          return entry.calendarId;
        }),
      ).toStrictEqual([TEAM_CALENDAR]);
    });
  });
});
