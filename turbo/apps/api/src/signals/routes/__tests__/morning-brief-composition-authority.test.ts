import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture as rebindMorningBriefThreadFixture,
  replaceMorningBriefAutomationFixture,
} from "../../../test-fixtures/morning-brief-chat-collection";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
  reselectThreadGmailAccountFixture,
  revokeAgentConnectorGrantFixture,
  selectThreadGmailAccountFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { createDeferredPromise } from "../../utils";
import { integrationsSlackRoutes } from "../integrations-slack";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Exact source selection and retained-source revalidation, through the real
 * registered composition route.
 *
 * The engine reads its sources in waves, so a source can finish, wait while a
 * later wave is still running, and only then have its material used. These
 * tests drive that window at the application boundary: the account choice is
 * frozen before any source starts, and the authority every supplied source was
 * read under is re-asked before the request is planned.
 *
 * External boundaries are doubled — Gmail and Slack answer through MSW, and
 * every gate they pass is the deployed one. Nothing here reaches a real
 * provider, and the arrival of a held provider request is the barrier, not a
 * sleep.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";
const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);

/**
 * Real OAuth setup, five collectors and a held provider request do not fit the
 * 5-second default. The barrier is still the request's arrival, never elapsed
 * time; this only stops the runner from cutting the attempt short.
 */
const TEST_TIMEOUT_MS = 60_000;

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

/**
 * An object store that actually round-trips.
 *
 * Creating an Agent publishes its instructions volume, and the composition's
 * language context reads that volume back. The shared default answers every
 * command with a fixed size and no body, so the read fails and the composition
 * reports an unreadable Agent instead of running. Keeping the written bytes is
 * what makes the published instructions readable by the same production path.
 */
function stubObjectStorage(
  objects: Map<string, Buffer>,
  onGet?: () => void,
): void {
  const objectKey = (command: {
    readonly input?: { readonly Bucket?: string; readonly Key?: string };
  }): string => {
    return `${command.input?.Bucket ?? ""}/${command.input?.Key ?? ""}`;
  };
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (typeof command !== "object" || command === null) {
      return Promise.resolve({});
    }
    const typed = command as {
      readonly input?: {
        readonly Bucket?: string;
        readonly Key?: string;
        readonly Body?: unknown;
      };
    };
    const name = command.constructor.name;
    const key = objectKey(typed);
    if (name === "PutObjectCommand") {
      const body = typed.input?.Body;
      objects.set(
        key,
        typeof body === "string"
          ? Buffer.from(body, "utf8")
          : Buffer.from(body as Uint8Array),
      );
      return Promise.resolve({});
    }
    const stored = objects.get(key);
    if (name === "HeadObjectCommand") {
      return stored === undefined
        ? Promise.reject(
            Object.assign(new Error("NotFound"), { name: "NotFound" }),
          )
        : Promise.resolve({ ContentLength: stored.length });
    }
    if (name === "GetObjectCommand") {
      onGet?.();
      return stored === undefined
        ? Promise.reject(
            Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }),
          )
        : Promise.resolve({
            Body: Readable.from([stored]),
            ContentLength: stored.length,
          });
    }
    return Promise.resolve({});
  });
}

function composeClient(signal?: AbortSignal, rethrowErrors = false) {
  return setupApp({
    context,
    routes: morningBriefCompositionPreviewRoutes,
    signal,
    rethrowErrors,
  })(morningBriefCompositionPreviewContract);
}

function slackClient() {
  return setupApp({ context, routes: integrationsSlackRoutes })(
    integrationsSlackContract,
  );
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer test-token" } as const;
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly gmailAccountId: string;
  readonly botToken: string;
  readonly membershipId: string;
}

/** Record every provider call so a refusal is observable as zero reads. */
interface ProviderCalls {
  readonly gmail: string[];
  readonly slack: string[];
}

function gmailMessagePayload(id: string, unread: boolean, anchorMs: number) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(anchorMs - 60_000),
    labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "sender@example.test" },
        { name: "To", value: "owner@example.test" },
        { name: "Date", value: new Date(anchorMs - 60_000).toUTCString() },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
        },
      ],
    },
  };
}

/**
 * Gmail answers immediately; Slack's channel enumeration waits on `hold`.
 *
 * Slack runs in the second wave, so by the time its enumeration is reached
 * Gmail's whole collection — including its own release fence — has already
 * finished. That makes the hold an exact barrier for "a source returned and its
 * material is now waiting", which is the window this issue is about.
 */
function stubProviders(args: {
  readonly slackHold?: Promise<void>;
  readonly onSlackEnumerated?: () => void;
  readonly onGmailRequest?: () => void;
  readonly onSlackEnumeration?: (
    call: number,
    request: Request,
  ) => Promise<
    readonly { readonly id: string; readonly name: string }[] | void
  >;
  readonly gmailBody?: string;
  readonly gmailUnread?: boolean;
  readonly slackFraction?: string;
  readonly slackText?: string;
  readonly calendarAllDay?: boolean;
  readonly onCalendarRequest?: () => void;
  readonly anchorMs?: number;
}): ProviderCalls {
  const calls: ProviderCalls = { gmail: [], slack: [] };
  // The first enumeration is collection discovery. With one channel, the
  // collector then proves the protected history read and its final release;
  // the fourth enumeration is the retained-source re-proof.
  let slackEnumerations = 0;
  let onEnumerated = args.onSlackEnumerated;
  const fireOnce = (): void => {
    onEnumerated = undefined;
  };
  server.use(
    http.get(GMAIL_LIST_URL, ({ request }) => {
      args.onGmailRequest?.();
      const url = new URL(request.url);
      calls.gmail.push(url.pathname);
      const query = url.searchParams.get("q") ?? "";
      return HttpResponse.json({
        messages:
          query === "is:unread" && args.gmailUnread !== true
            ? []
            : [{ id: "m1", threadId: "thread-m1" }],
      });
    }),
    http.get(GMAIL_MESSAGE_URL, ({ request, params }) => {
      args.onGmailRequest?.();
      calls.gmail.push(new URL(request.url).pathname);
      const payload = gmailMessagePayload(
        String(params["messageId"]),
        args.gmailUnread === true,
        args.anchorMs ?? ANCHOR_MS,
      );
      payload.payload.parts[0]!.body.data = Buffer.from(
        args.gmailBody ?? `Body ${String(params["messageId"])}`,
      ).toString("base64url");
      return HttpResponse.json(payload);
    }),
    http.get(SLACK_CONVERSATIONS_URL, async ({ request }) => {
      calls.slack.push("users.conversations");
      slackEnumerations += 1;
      onEnumerated?.();
      fireOnce();
      if (args.slackHold) {
        await args.slackHold;
      }
      const channels = await args.onSlackEnumeration?.(
        slackEnumerations,
        request,
      );
      return HttpResponse.json({
        ok: true,
        channels: (channels ?? [{ id: "C1", name: "general" }]).map(
          (channel) => {
            return { ...channel, is_private: false };
          },
        ),
      });
    }),
    http.get(SLACK_HISTORY_URL, () => {
      calls.slack.push("conversations.history");
      return HttpResponse.json({
        ok: true,
        messages: [
          {
            type: "message",
            ts: `${String(Math.floor(((args.anchorMs ?? ANCHOR_MS) - 120_000) / 1000))}.${args.slackFraction ?? "000100"}`,
            user: "U9",
            text: args.slackText ?? "standup at ten",
          },
        ],
      });
    }),
    http.get(SLACK_REPLIES_URL, () => {
      calls.slack.push("conversations.replies");
      return HttpResponse.json({ ok: true, messages: [] });
    }),
    http.get(CALENDAR_LIST_URL, () => {
      args.onCalendarRequest?.();
      return HttpResponse.json({
        items:
          args.calendarAllDay === true
            ? [
                {
                  id: "primary",
                  summary: "Primary",
                  accessRole: "owner",
                  primary: true,
                  timeZone: "America/Los_Angeles",
                },
              ]
            : [],
      });
    }),
    http.get(CALENDAR_EVENTS_URL, () => {
      args.onCalendarRequest?.();
      return HttpResponse.json({
        items:
          args.calendarAllDay === true
            ? [
                {
                  id: "dst-day",
                  status: "confirmed",
                  summary: "DST day",
                  start: { date: "2026-11-01" },
                  end: { date: "2026-11-02" },
                  recurringEventId: "dst-series",
                  originalStartTime: { date: "2026-11-01" },
                },
              ]
            : [],
      });
    }),
  );
  return calls;
}

async function connectGmail(
  actor: ApiTestUser,
  agentId: string,
  args: { readonly email: string; readonly subject: string },
): Promise<string> {
  mockGmailConnectorOAuth({
    accessToken: `gmail-token-${args.subject}`,
    email: args.email,
    subject: args.subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
    { intent: "add", displayName: args.email },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: `gmail-code-${args.subject}`,
    state,
  });
  const account = (
    await connectorsApi.listBuiltinConnectorAccounts(actor, "gmail")
  ).find((candidate) => {
    return candidate.externalId === args.subject;
  });
  if (!account) {
    throw new Error("Expected the connected Gmail account");
  }
  return account.id;
}

async function setupOwner(
  /** Everything this suite's production writes published, kept across setup. */
  objectStorage: Map<string, Buffer>,
  options: {
    readonly instructions?: string;
    readonly timezone?: string;
    readonly withCalendar?: boolean;
    readonly withGmail?: boolean;
  } = {},
): Promise<Fixture> {
  const timezone = options.timezone ?? "Asia/Shanghai";
  const withCalendar = options.withCalendar === true;
  const withGmail = options.withGmail !== false;
  const { actor } = await workflowBdd.setupWorkflowOrg({ timezone });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  // A freshly created Agent, so no instructions volume has ever been published
  // for it and the language context resolves from the member's locale. The
  // onboarding default Agent promises an instructions archive this suite has no
  // reason to populate, and an unreadable promise is an incomplete composition
  // rather than an absent one.
  // `setupWorkflowOrg` installs the shared object-storage double that answers
  // every command with a fixed size and no body. Restore the round-tripping one
  // before publishing anything this suite has to read back.
  stubObjectStorage(objectStorage);
  const agent = await bdd.createAgent(actor, {
    displayName: `brief-${randomUUID().slice(0, 8)}`,
  });
  const agentId = agent.agentId;
  // Published through the production endpoint, so the composition's language
  // context resolves a real version rather than an unreadable promise.
  await bdd.updateAgentInstructions(
    actor,
    agentId,
    options.instructions ?? "Summarize the morning.",
  );
  const gmailAccountId = withGmail
    ? await connectGmail(actor, agentId, {
        email: "owner@example.test",
        subject: `gmail-${randomUUID()}`,
      })
    : "";
  if (withCalendar) {
    const calendarSubject = `calendar-${randomUUID()}`;
    mockGoogleCalendarConnectorOAuth({
      accessToken: `calendar-token-${randomUUID()}`,
      email: "owner@example.test",
      subject: calendarSubject,
    });
    const calendarStart = await connectorsApi.startOauth(
      actor,
      "google-calendar",
      "oauth",
      agentId,
    );
    const calendarState = new URL(
      calendarStart.authorizationUrl,
    ).searchParams.get("state");
    if (!calendarState) {
      throw new Error("Expected a Google Calendar OAuth state");
    }
    await connectorsApi.completeOauthCallback("google-calendar", {
      code: `calendar-code-${calendarSubject}`,
      state: calendarState,
    });
  }
  const connectorSlugs = [
    ...(withGmail ? (["gmail"] as const) : []),
    ...(withCalendar ? (["google-calendar"] as const) : []),
  ];
  if (connectorSlugs.length > 0) {
    await runsApi.enableAgentConnectors(actor, agentId, connectorSlugs);
  }
  if (withGmail) {
    await runsApi.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "allow",
    });
  }
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId, timezone },
  );
  const chatThreadId = await bindMorningBriefThreadFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { workflowId: installation.workflowId, agentId },
  );
  if (withGmail) {
    await selectThreadGmailAccountFixture({
      chatThreadId,
      connectorId: gmailAccountId,
    });
  }
  const botToken = `xoxb-test-${randomUUID()}`;
  const slack = await store.set(
    seedSlackOrgInstallation$,
    { orgId: actor.orgId, botToken },
    context.signal,
  );
  await store.set(
    seedSlackOrgConnection$,
    { slackWorkspaceId: slack.slackWorkspaceId, userId: actor.userId },
    context.signal,
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  // Connector and permission setup reinstall their own doubles, so the store
  // the composition reads through is restored last.
  stubObjectStorage(objectStorage);
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId,
    workflowId: installation.workflowId,
    automationId: installation.automationId,
    chatThreadId,
    gmailAccountId,
    botToken,
    membershipId: `orgmem_${randomUUID()}`,
  };
}

async function compose(fixture: Fixture, anchor = ANCHOR_ISO) {
  await store.set(
    seedOrgMembership$,
    {
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
      role: "admin",
      membershipId: fixture.membershipId,
    },
    context.signal,
  );
  return await accept(
    composeClient().compose({
      headers: authHeaders(fixture.actor),
      body: { anchor },
    }),
    [200],
  );
}

describe("Morning Brief exact source selection and retained authority", () => {
  let objectStorage = new Map<string, Buffer>();

  beforeEach(async () => {
    mockNow(ANCHOR_MS + 30_000);
    objectStorage = new Map();
    stubObjectStorage(objectStorage);
    await installApiTestConnectorCatalog();
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "keeps all-day DST dates, timezone, window and recurrence semantics through request assembly",
    async () => {
      const anchor = "2026-11-01T20:00:00.000Z";
      mockNow(Date.parse(anchor) + 30_000);
      const fixture = await setupOwner(objectStorage, {
        timezone: "America/Los_Angeles",
        withCalendar: true,
      });
      let calendarRequests = 0;
      stubProviders({
        calendarAllDay: true,
        onCalendarRequest: () => {
          calendarRequests += 1;
        },
      });

      const response = await compose(fixture, anchor);
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed result, received ${JSON.stringify(response.body)}`,
        );
      }
      const calendar = response.body.composition.sources.find((entry) => {
        return entry.source === "calendar";
      });
      expect(calendar?.timeSemantics.dateOnly).toBe(1);
      expect(calendar?.provenance.timezone).toBe("America/Los_Angeles");
      expect(calendar?.provenance.startDate).toBe("2026-11-01");
      expect(calendar?.provenance.endDateExclusive).toBe("2026-11-04");
      expect(calendar?.requests).toBe(calendarRequests);
      expect(calendar?.evidenceDigest).not.toBe("");
      expect(response.body.composition.request?.totalBytes).toBeLessThanOrEqual(
        response.body.composition.request?.maxBytes ?? 0,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves Gmail overlap and exact Slack timestamps through request assembly",
    async () => {
      const fixture = await setupOwner(objectStorage);
      stubProviders({ gmailUnread: false, slackFraction: "000100" });
      const baseline = await compose(fixture);
      if (baseline.status !== 200 || baseline.body.result !== "composed") {
        throw new Error(
          `Expected a composed baseline, received ${JSON.stringify(baseline.body)}`,
        );
      }
      stubProviders({ gmailUnread: true, slackFraction: "000200" });
      const changed = await compose(fixture);
      if (changed.status !== 200 || changed.body.result !== "composed") {
        throw new Error(
          `Expected a composed result, received ${JSON.stringify(changed.body)}`,
        );
      }

      const before = new Map(
        baseline.body.composition.sources.map((entry) => {
          return [entry.source, entry];
        }),
      );
      const after = new Map(
        changed.body.composition.sources.map((entry) => {
          return [entry.source, entry];
        }),
      );
      expect(before.get("gmail")?.items).toBe(1);
      expect(after.get("gmail")?.items).toBe(1);
      // The Gmail record is identical except that the second collection reached
      // it through both recent and unread branches. If overlap provenance were
      // flattened, these request-evidence digests would be equal.
      expect(after.get("gmail")?.evidenceDigest).not.toBe(
        before.get("gmail")?.evidenceDigest,
      );
      expect(after.get("gmail")?.provenance.observedAt).not.toBeNull();
      expect(
        after.get("gmail")?.provenance.branches.map((branch) => {
          return branch.name;
        }),
      ).toStrictEqual(expect.arrayContaining(["recent", "unread"]));

      // Only the microsecond Slack record identity changed.
      expect(after.get("slack")?.evidenceDigest).not.toBe(
        before.get("slack")?.evidenceDigest,
      );
      expect(after.get("slack")?.provenance.startAt).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "removes material whose grant was withdrawn while a later source was held, and keeps its siblings",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const held = createDeferredPromise<void>(context.signal);
      const enumerated = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        slackHold: held.promise,
        onSlackEnumerated: () => {
          enumerated.resolve();
        },
      });

      const pending = compose(fixture);
      // Slack runs in the second wave, so its arrival proves Gmail's collection
      // and its own release fence already finished.
      await enumerated.promise;
      expect(calls.gmail.length).toBeGreaterThan(0);
      await revokeAgentConnectorGrantFixture(
        { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
        { agentId: fixture.agentId, connectorSlug: "gmail" },
      );
      held.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      const composition = response.body.composition;
      const bySource = new Map(
        composition.sources.map((entry) => {
          return [entry.source, entry];
        }),
      );
      // Gmail's day is accounted for as failed rather than as a quiet morning,
      // and none of its material remains in the request.
      expect(bySource.get("gmail")?.coverage).toBe("failed");
      expect(bySource.get("gmail")?.items).toBe(0);
      expect(
        composition.descriptors.some((descriptor) => {
          return descriptor.source === "gmail";
        }),
      ).toBeFalsy();
      // The authorized sibling is preserved and still supplies the request.
      expect(bySource.get("slack")?.items).toBeGreaterThan(0);
      const slack = composition.descriptors.find((descriptor) => {
        return descriptor.source === "slack";
      });
      expect(slack?.contributed).toBeTruthy();
      expect(slack?.containers).toStrictEqual(["C1"]);
      // No hidden recollection: the revalidation asks about permissions, so
      // Gmail is never read a second time for the check.
      expect(
        calls.gmail.filter((path) => {
          return path.endsWith("/messages");
        }),
      ).toHaveLength(2);
      expect(composition.request?.items).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "proves the exact selected account and refuses to swap it mid-attempt",
    async () => {
      const fixture = await setupOwner(objectStorage);
      stubProviders({});

      const baseline = await compose(fixture);
      if (baseline.status !== 200 || baseline.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(baseline.body)}`,
        );
      }
      const gmail = baseline.body.composition.descriptors.find((descriptor) => {
        return descriptor.source === "gmail";
      });
      expect(baseline.body.composition.descriptorBytes).toBe(
        Buffer.byteLength(
          JSON.stringify(baseline.body.composition.descriptors),
          "utf8",
        ),
      );
      // The retained proof names the exact connection and mailbox this material
      // came from, and the endpoints a later check re-asks about.
      expect(gmail?.connectionId).toBe(fixture.gmailAccountId);
      expect(gmail?.accountRef).toBe("owner@example.test");
      expect(gmail?.endpoints.length).toBeGreaterThan(0);
      expect(gmail?.contributed).toBeTruthy();
      expect(gmail?.scopeDigest).not.toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not adopt an account selected after the attempt was admitted",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const second = await connectGmail(fixture.actor, fixture.agentId, {
        email: "other@example.test",
        subject: `gmail-${randomUUID()}`,
      });
      const held = createDeferredPromise<void>(context.signal);
      const enumerated = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        slackHold: held.promise,
        onSlackEnumerated: () => {
          enumerated.resolve();
        },
      });

      const pending = compose(fixture);
      await enumerated.promise;
      // The owner switches accounts while a later source is still reading.
      await reselectThreadGmailAccountFixture({
        chatThreadId: fixture.chatThreadId,
        connectorId: second,
      });
      held.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      // Nothing was read through the newly selected account, and no descriptor
      // claims it: the frozen attempt neither swaps nor silently continues.
      expect(
        response.body.composition.descriptors.some((descriptor) => {
          return descriptor.connectionId === second;
        }),
      ).toBeFalsy();
      expect(
        calls.gmail.filter((path) => {
          return path.endsWith("/messages");
        }).length,
      ).toBeLessThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a frozen absent account absent when one is connected mid-attempt",
    async () => {
      const fixture = await setupOwner(objectStorage, { withGmail: false });
      const held = createDeferredPromise<void>(context.signal);
      const enumerated = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        slackHold: held.promise,
        onSlackEnumerated: () => {
          enumerated.resolve();
        },
      });

      const pending = compose(fixture);
      await enumerated.promise;
      await connectGmail(fixture.actor, fixture.agentId, {
        email: "late@example.test",
        subject: `gmail-${randomUUID()}`,
      });
      held.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a Slack composition, received ${JSON.stringify(response.body)}`,
        );
      }
      expect(calls.gmail).toStrictEqual([]);
      expect(
        response.body.composition.descriptors.find((descriptor) => {
          return descriptor.source === "gmail";
        })?.contributed,
      ).toBeFalsy();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "proves a source introduced by reallocation before releasing the final request",
    async () => {
      const fixture = await setupOwner(objectStorage, {
        instructions: '"'.repeat(62_000),
      });
      const providerShape = {
        gmailBody: "g".repeat(10_000),
        slackText: "s".repeat(10_000),
      } as const;
      stubProviders(providerShape);
      const control = await compose(fixture);
      if (control.status !== 200 || control.body.result !== "composed") {
        throw new Error(
          `Expected a composed control, received ${JSON.stringify(control.body)}`,
        );
      }
      const contributed = control.body.composition.descriptors.filter(
        (descriptor) => {
          return descriptor.contributed;
        },
      );
      expect(
        contributed.map((descriptor) => {
          return descriptor.source;
        }),
      ).toStrictEqual(["gmail"]);
      expect(
        control.body.composition.descriptors.find((descriptor) => {
          return descriptor.source === "slack";
        })?.contributed,
      ).toBeFalsy();

      const collectionArrived = createDeferredPromise<void>(context.signal);
      const releaseCollection = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        ...providerShape,
        slackHold: releaseCollection.promise,
        onSlackEnumerated: () => {
          collectionArrived.resolve();
        },
        onSlackEnumeration: (call) => {
          if (call !== 4) {
            return Promise.resolve();
          }
          // Gmail was revoked after its collection. Slack was allocation-
          // dropped in the first plan and only enters after replanning, so
          // reaching this refusal proves the new final source was re-asked.
          return Promise.resolve([]);
        },
      });
      const pending = compose(fixture);
      await collectionArrived.promise;
      await runsApi.applyUserPermissionGrant(fixture.actor, {
        agentId: fixture.agentId,
        connectorSlug: "gmail",
        permission: "messages.detail",
        action: "deny",
      });
      releaseCollection.resolve();

      const response = await pending;
      expect(response.body).toStrictEqual({ result: "authority-changed" });
      // The newly eligible source is authorized, not recollected.
      expect(
        calls.gmail.filter((path) => {
          return path.endsWith("/messages");
        }),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a local Slack disconnect committed while the remote re-proof is held",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const releaseReproof = createDeferredPromise<void>(context.signal);
      stubProviders({
        onSlackEnumeration: async (call) => {
          if (call === 4) {
            reproofArrived.resolve();
            await releaseReproof.promise;
          }
        },
      });

      const pending = compose(fixture);
      await reproofArrived.promise;
      context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
      await accept(
        slackClient().disconnect({
          headers: authHeaders(fixture.actor),
          query: {},
        }),
        [200],
      );
      releaseReproof.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected Gmail to survive, received ${JSON.stringify(response.body)}`,
        );
      }
      expect(
        response.body.composition.descriptors.find((descriptor) => {
          return descriptor.source === "slack";
        }),
      ).toBeUndefined();
      expect(
        response.body.composition.descriptors.find((descriptor) => {
          return descriptor.source === "gmail";
        })?.contributed,
      ).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [4999, "composed"],
    [5000, "authority-changed"],
    [5001, "authority-changed"],
  ] as const)(
    "decides retained proof at the absolute five-second boundary (%i ms)",
    async (elapsedMs, expected) => {
      const fixture = await setupOwner(objectStorage);
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const releaseReproof = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        onSlackEnumeration: async (call) => {
          if (call === 4) {
            reproofArrived.resolve();
            await releaseReproof.promise;
          }
        },
      });

      const pending = compose(fixture);
      await reproofArrived.promise;
      mockNow(ANCHOR_MS + 30_000 + elapsedMs);
      releaseReproof.resolve();

      const response = await pending;
      expect(response.body.result).toBe(expected);
      expect(
        calls.slack.filter((call) => {
          return call === "users.conversations";
        }),
      ).toHaveLength(4);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [3999, "composed"],
    [4000, "incomplete"],
  ] as const)(
    "uses the tighter attempt reservation for retained proof (%i ms)",
    async (retainedElapsedMs, expected) => {
      const fixture = await setupOwner(objectStorage);
      const phaseStartedAt = ANCHOR_MS + 30_000;
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const releaseReproof = createDeferredPromise<void>(context.signal);
      // Wave one finishes at +19s. Slack therefore receives the remaining
      // new-read window and lands at +39s; language storage advances within its
      // own bound to +41s, leaving only four seconds of the attempt reservation.
      stubObjectStorage(objectStorage, () => {
        mockNow(phaseStartedAt + 41_000);
      });
      stubProviders({
        onGmailRequest: () => {
          mockNow(phaseStartedAt + 19_000);
        },
        onSlackEnumeration: async (call) => {
          if (call === 3) {
            mockNow(phaseStartedAt + 39_000);
          }
          if (call === 4) {
            reproofArrived.resolve();
            await releaseReproof.promise;
          }
        },
      });

      const pending = compose(fixture);
      await reproofArrived.promise;
      mockNow(phaseStartedAt + 41_000 + retainedElapsedMs);
      releaseReproof.resolve();

      const response = await pending;
      expect(response.body.result).toBe(expected);
      if (response.body.result === "incomplete") {
        // The retained five-second ceiling and the outer reservation meet at
        // equality here. The outer lifecycle owns that public classification.
        expect(response.body.reason).toBe("deadline-exceeded");
        expect(response.body.detail).toContain("final authority check");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "automation replacement",
      async (fixture: Fixture) => {
        await replaceMorningBriefAutomationFixture({
          orgId: fixture.actor.orgId,
          userId: fixture.actor.userId,
          workflowId: fixture.workflowId,
          automationId: fixture.automationId,
        });
      },
    ],
    [
      "destination rebind",
      async (fixture: Fixture) => {
        await rebindMorningBriefThreadFixture({
          orgId: fixture.actor.orgId,
          userId: fixture.actor.userId,
          workflowId: fixture.workflowId,
          chatThreadId: null,
        });
      },
    ],
  ] as const)(
    "rejects a %s committed during retained provider work",
    async (_name, changeBinding) => {
      const fixture = await setupOwner(objectStorage);
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const releaseReproof = createDeferredPromise<void>(context.signal);
      stubProviders({
        onSlackEnumeration: async (call) => {
          if (call === 4) {
            reproofArrived.resolve();
            await releaseReproof.promise;
          }
        },
      });

      const pending = compose(fixture);
      await reproofArrived.promise;
      await changeBinding(fixture);
      releaseReproof.resolve();

      const response = await pending;
      expect(response.body).toStrictEqual({ result: "authority-changed" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a changed membership generation through the shared owner authorizer",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const releaseReproof = createDeferredPromise<void>(context.signal);
      stubProviders({
        onSlackEnumeration: async (call) => {
          if (call === 4) {
            reproofArrived.resolve();
            await releaseReproof.promise;
          }
        },
      });

      const pending = compose(fixture);
      await reproofArrived.promise;
      await store.set(
        seedOrgMembership$,
        {
          orgId: fixture.actor.orgId,
          userId: fixture.actor.userId,
          role: "admin",
          membershipId: `orgmem_rejoined_${randomUUID()}`,
        },
        context.signal,
      );
      releaseReproof.resolve();

      const response = await pending;
      expect(response.body).toStrictEqual({ result: "authority-changed" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "propagates caller cancellation from a held retained proof without starting more checks",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const controller = new AbortController();
      const cancellation = new Error(`cancelled ${randomUUID()}`);
      const reproofArrived = createDeferredPromise<void>(context.signal);
      const reproofCancelled = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        onSlackEnumeration: async (call, request) => {
          if (call !== 4) {
            return;
          }
          request.signal.addEventListener(
            "abort",
            () => {
              reproofCancelled.resolve();
            },
            { once: true },
          );
          reproofArrived.resolve();
          await reproofCancelled.promise;
          return [];
        },
      });
      await store.set(
        seedOrgMembership$,
        {
          orgId: fixture.actor.orgId,
          userId: fixture.actor.userId,
          role: "admin",
          membershipId: fixture.membershipId,
        },
        context.signal,
      );
      const pending = composeClient(controller.signal, true).compose({
        headers: authHeaders(fixture.actor),
        body: { anchor: ANCHOR_ISO },
      });

      await reproofArrived.promise;
      controller.abort(cancellation);
      await reproofCancelled.promise;

      await expect(pending).rejects.toThrow(cancellation.message);
      expect(
        calls.slack.filter((call) => {
          return call === "users.conversations";
        }),
      ).toHaveLength(4);
    },
    TEST_TIMEOUT_MS,
  );
});
