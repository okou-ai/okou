import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  morningBriefGmailCollectionPreviewContract,
  type MorningBriefGmailCollection,
} from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  clearConnectorTokenExpiryFixture,
  expireConnectorTokenFixture,
  expirePermissionGrantFixture,
  installMorningBriefFixture,
  requireConnectorReconnectFixture,
  revokeAgentConnectorGrantFixture,
  selectThreadGmailAccountFixture,
  setMorningBriefEnabledFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { createDeferredPromise } from "../../utils";
import { morningBriefGmailCollectionPreviewRoutes } from "../morning-brief-gmail-collection-preview";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Gmail collection through the shared Morning Brief OAuth reader.
 *
 * The route's presence in the production table is asserted where the import
 * boundary allows the aggregate to be read, in `route-registration.test.ts`.
 * This suite drives that same exported slice through the normal app so the
 * deployed production gate, authentication, membership and ownership checks are
 * the ones under test.
 *
 * The accepted-catalog fixture splits Gmail into `messages.read` for the list
 * and `messages.detail` for message bodies, with only `messages.read` allowed by
 * default. That is what makes a real permission refusal, an expired grant and a
 * surviving authorized sibling observable from a route test.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);
const WINDOW_START_MS = ANCHOR_MS - 24 * 60 * 60 * 1000;
/** The collector's own concurrency, which bounds how many details can be held. */
const READER_CONCURRENCY = 3;
/** The Gmail source budget the preview starts before it admits the source. */
const MORNING_BRIEF_SOURCE_BUDGET_MS = 20_000;

/** The reader's own caps, restated so the byte arithmetic below is explicit. */
const RESPONSE_BYTE_CAP = 256 * 1024;
const TOTAL_RESPONSE_BYTE_CAP = 4 * 1024 * 1024;
/**
 * Raw body bytes whose base64 encoding clears the per-response ceiling.
 *
 * `ceil(n / 3) * 4` of 200 KiB is just over 256 KiB, so every such response is
 * refused at its allowance without padding the suite with megabytes it does not
 * need.
 */
const OVERSIZED_BODY_BYTES = 200 * 1024;
/**
 * How many oversized bodies the cumulative budget can charge in full.
 *
 * The two list responses refund everything they did not use, so the remainder
 * is the whole 4 MiB divided by the per-response ceiling.
 */
const FULL_OVERSIZED_ALLOWANCES = TOTAL_RESPONSE_BYTE_CAP / RESPONSE_BYTE_CAP;

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
    routes: morningBriefGmailCollectionPreviewRoutes,
  })(morningBriefGmailCollectionPreviewContract);
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer test-token" } as const;
}

interface GmailCall {
  readonly pathname: string;
  readonly search: string;
  readonly authorization: string | null;
}

interface GmailStub {
  readonly calls: GmailCall[];
}

/** A MIME part exactly as Gmail nests it inside `payload`. */
interface StubPart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly body?: { readonly data: string };
  readonly parts?: readonly StubPart[];
}

function inlineTextPart(text: string): StubPart {
  return {
    mimeType: "text/plain",
    body: { data: Buffer.from(text).toString("base64url") },
  };
}

function inlineHtmlPart(html: string): StubPart {
  return {
    mimeType: "text/html",
    body: { data: Buffer.from(html).toString("base64url") },
  };
}

/**
 * Place `leaf` at an exact MIME depth.
 *
 * `payload` itself is depth 0 and the parts handed to `stubGmail` are its
 * children, so `nestedPart(12, leaf)` puts the leaf at depth 12 — the deepest
 * level the collector's cap still visits.
 */
function nestedPart(depth: number, leaf: StubPart): StubPart {
  let part = leaf;
  for (let level = 1; level < depth; level += 1) {
    part = { mimeType: "multipart/mixed", parts: [part] };
  }
  return part;
}

/** Structural parts that carry nothing, used to spend the node budget. */
function emptyParts(count: number): readonly StubPart[] {
  return Array.from({ length: count }, () => {
    return { mimeType: "multipart/mixed" };
  });
}

/**
 * A response whose headers arrive at once and whose bytes wait for a gate.
 *
 * Holding the handler parks a request before it has an allowance; holding the
 * body parks the reader after one was taken. Only the second shape can show
 * whether concurrent readers were each handed the same remaining allowance.
 */
function gatedBodyResponse(
  payload: unknown,
  gate: () => Promise<void>,
  onOpen: () => void,
): HttpResponse<ReadableStream<Uint8Array>> {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      onOpen();
      await gate();
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { "content-type": "application/json" },
  });
}

interface StubMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly internalDate: number;
  /** Send `internalDate` verbatim, including values Gmail should never send. */
  readonly rawInternalDate?: string;
  readonly unread?: boolean;
  readonly subject?: string;
  readonly from?: string;
  readonly to?: string;
  readonly date?: string;
  readonly text?: string;
  readonly html?: string;
  /** Replace the generated body with a MIME tree the defaults cannot express. */
  readonly parts?: readonly StubPart[];
  /** Pad the response past the reader's 256 KiB per-response ceiling. */
  readonly oversized?: boolean;
}

function messagePayload(message: StubMessage) {
  const headers = [
    { name: "Subject", value: message.subject ?? `Subject ${message.id}` },
    { name: "From", value: message.from ?? "sender@example.test" },
    { name: "To", value: message.to ?? "owner@example.test" },
    {
      name: "Date",
      value: message.date ?? new Date(message.internalDate).toUTCString(),
    },
  ];
  const text =
    message.oversized === true
      ? "x".repeat(OVERSIZED_BODY_BYTES)
      : (message.text ?? `Body ${message.id}`);
  const body =
    message.html === undefined
      ? inlineTextPart(text)
      : inlineHtmlPart(message.html);
  return {
    id: message.id,
    threadId: message.threadId ?? `thread-${message.id}`,
    internalDate: message.rawInternalDate ?? String(message.internalDate),
    labelIds: message.unread === true ? ["INBOX", "UNREAD"] : ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers,
      parts: message.parts ?? [body],
    },
  };
}

/**
 * A Gmail stub that records every call, so a refusal can be asserted as *zero
 * provider reads* rather than as an absent response body. `holdDetails` gates
 * every message body, which is how a mid-flight authority change is observed at
 * a known arrival point instead of after a sleep.
 */
function stubGmail(args: {
  readonly recent?: readonly StubMessage[];
  readonly unread?: readonly StubMessage[];
  readonly pages?: ReadonlyMap<
    string,
    { readonly ids: readonly string[]; readonly nextPageToken?: string }
  >;
  readonly holdDetails?: Promise<void>;
  /** Gate every body individually, so batches can be released one at a time. */
  readonly gateDetails?: () => Promise<void>;
  /**
   * Message ids whose body waits on `bodyGate` instead of their handler, so
   * they are parked after their byte allowance has already been taken.
   */
  readonly bodyGatedIds?: ReadonlySet<string>;
  readonly bodyGate?: () => Promise<void>;
  readonly onBodyOpen?: () => void;
  readonly detailStatus?: ReadonlyMap<string, number>;
}): GmailStub {
  const calls: GmailCall[] = [];
  const byId = new Map<string, StubMessage>();
  for (const message of [...(args.recent ?? []), ...(args.unread ?? [])]) {
    byId.set(message.id, message);
  }

  server.use(
    http.get(GMAIL_LIST_URL, ({ request }) => {
      const url = new URL(request.url);
      calls.push({
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
      });
      const query = url.searchParams.get("q") ?? "";
      const pageToken = url.searchParams.get("pageToken");
      if (args.pages && pageToken !== null) {
        const page = args.pages.get(pageToken);
        return HttpResponse.json({
          messages: (page?.ids ?? []).map((id) => {
            return { id, threadId: `thread-${id}` };
          }),
          ...(page?.nextPageToken === undefined
            ? {}
            : { nextPageToken: page.nextPageToken }),
        });
      }
      const selected =
        query === "is:unread" ? (args.unread ?? []) : (args.recent ?? []);
      const firstPage = args.pages?.get("first");
      return HttpResponse.json({
        messages: selected.map((message) => {
          return {
            id: message.id,
            threadId: message.threadId ?? `thread-${message.id}`,
          };
        }),
        ...(firstPage?.nextPageToken === undefined
          ? {}
          : { nextPageToken: firstPage.nextPageToken }),
      });
    }),
    http.get(GMAIL_MESSAGE_URL, async ({ request, params }) => {
      const url = new URL(request.url);
      calls.push({
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
      });
      const messageId = String(params["messageId"]);
      if (args.holdDetails) {
        await args.holdDetails;
      }
      const bodyGated = args.bodyGatedIds?.has(messageId) === true;
      if (args.gateDetails && !bodyGated) {
        await args.gateDetails();
      }
      if (bodyGated && args.bodyGate) {
        const gatedMessage = byId.get(messageId);
        if (!gatedMessage) {
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        }
        return gatedBodyResponse(
          messagePayload(gatedMessage),
          args.bodyGate,
          args.onBodyOpen ?? (() => {}),
        );
      }
      const status = args.detailStatus?.get(messageId);
      if (status !== undefined) {
        return HttpResponse.json({ error: { code: status } }, { status });
      }
      const message = byId.get(messageId);
      if (!message) {
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }
      return HttpResponse.json(messagePayload(message));
    }),
  );

  return { calls };
}

function listCalls(stub: GmailStub): readonly GmailCall[] {
  return stub.calls.filter((call) => {
    return call.pathname.endsWith("/messages");
  });
}

function detailCalls(stub: GmailStub): readonly GmailCall[] {
  return stub.calls.filter((call) => {
    return /\/messages\/[^/]+$/.test(call.pathname);
  });
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
  readonly connectorId: string;
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
  const connectorId = await connectGmail(actor, agentId, {
    email: "owner@example.test",
    subject: `gmail-${randomUUID()}`,
  });
  await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
  // Message bodies are not allowed by default, so a working collection needs a
  // real grant. That is also what makes denying or expiring it observable.
  await runsApi.applyUserPermissionGrant(actor, {
    agentId,
    connectorSlug: "gmail",
    permission: "messages.detail",
    action: "allow",
  });
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  const membershipId = `orgmem_${randomUUID()}`;
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId,
    workflowId: installation.workflowId,
    connectorId,
    membershipId,
  };
}

async function connectGmail(
  actor: ApiTestUser,
  agentId: string,
  args: {
    readonly email: string;
    readonly subject: string;
    readonly displayName?: string;
  },
): Promise<string> {
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: args.email,
    subject: args.subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
    args.displayName === undefined
      ? undefined
      : { intent: "add", displayName: args.displayName },
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

/** Narrows the contract's response union to a collected Gmail envelope. */
async function collectOk(
  fixture: Pick<Fixture, "actor" | "membershipId">,
): Promise<{ readonly body: MorningBriefGmailCollection }> {
  const response = await collect(fixture, [200]);
  if (response.status !== 200) {
    throw new Error(`Expected a Gmail collection, received ${response.status}`);
  }
  return { body: response.body };
}

function itemById(collection: MorningBriefGmailCollection, messageId: string) {
  return collection.items.find((item) => {
    return item.messageId === messageId;
  });
}

/**
 * Every character this collection retained, in the budget's own unit.
 *
 * The promised 40,000-character bound covers the whole normalized result, so a
 * header that escapes it is as much an overrun as an oversized excerpt.
 */
function retainedCharacters(collection: MorningBriefGmailCollection): number {
  return collection.items.reduce((total, item) => {
    return (
      total +
      (item.subject?.length ?? 0) +
      (item.from?.length ?? 0) +
      (item.to?.length ?? 0) +
      (item.date?.length ?? 0) +
      item.excerpt.length
    );
  }, 0);
}

/** Wait for a known number of provider arrivals, never for a duration. */
async function waitForDetailArrivals(
  stub: GmailStub,
  count: number,
): Promise<void> {
  await expect
    .poll(
      () => {
        return detailCalls(stub).length;
      },
      { timeout: 10_000 },
    )
    .toBe(count);
}

interface DetailGate {
  readonly wait: () => Promise<void>;
  /** Let exactly the bodies currently waiting through; hold the next ones. */
  readonly release: () => void;
  readonly openPermanently: () => void;
}

/**
 * Release message bodies in exact, concurrency-sized batches.
 *
 * Holding every body and then releasing a known number of them is what makes
 * the cumulative byte budget observable from outside: at each release exactly
 * one batch is in flight and every earlier batch has already been charged, so
 * the number of requests the budget still admits is arithmetic rather than a
 * race between arrivals and completions.
 */
function createDetailGate(): DetailGate {
  let current = createDeferredPromise<void>(context.signal);
  let open = false;
  const releaseCurrent = (): void => {
    if (!current.settled()) {
      current.resolve();
    }
  };
  return {
    wait: async (): Promise<void> => {
      if (open) {
        return;
      }
      await current.promise;
    },
    release: (): void => {
      const released = current;
      current = createDeferredPromise<void>(context.signal);
      if (!released.settled()) {
        released.resolve();
      }
    },
    openPermanently: (): void => {
      open = true;
      releaseCurrent();
    },
  };
}

interface GmailRefreshStub {
  readonly calls: () => number;
}

/**
 * A Gmail token endpoint that actually refreshes.
 *
 * The shared connect fixture deliberately refuses `grant_type=refresh_token`,
 * so an expiring credential only reaches a real refresh round trip — and the
 * window in which its authority can be withdrawn — once this handler is
 * registered.
 */
function stubGmailTokenRefresh(
  args: {
    readonly accessToken?: string;
    readonly hold?: Promise<void>;
  } = {},
): GmailRefreshStub {
  let calls = 0;
  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "refresh_token") {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Not a refresh" },
          { status: 400 },
        );
      }
      calls += 1;
      if (args.hold) {
        await args.hold;
      }
      return HttpResponse.json({
        access_token: args.accessToken ?? "gmail-refreshed-token",
        refresh_token: "gmail-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }),
  );
  return {
    calls: () => {
      return calls;
    },
  };
}

async function waitForRefreshArrivals(
  refresh: GmailRefreshStub,
  count: number,
): Promise<void> {
  await expect.poll(refresh.calls, { timeout: 10_000 }).toBe(count);
}

/**
 * Hold the next live membership read, which is the public admission's.
 *
 * `admitMorningBriefCollection` is the first thing in this route to ask the
 * membership authority who this member currently is, so holding the next answer
 * holds the public admission itself. Seeding a membership reinstalls this mock,
 * so the hold wraps whatever implementation is current and delegates to it.
 */
function holdNextMembershipRead(release: Promise<void>): {
  readonly arrived: Promise<void>;
  readonly calls: () => number;
} {
  const membershipList =
    context.mocks.clerk.organizations.getOrganizationMembershipList;
  const seeded = membershipList.getMockImplementation();
  if (!seeded) {
    throw new Error("Expected a seeded membership implementation");
  }
  const arrival = createDeferredPromise<void>(context.signal);
  let calls = 0;
  membershipList.mockImplementation(async (...callArgs: unknown[]) => {
    calls += 1;
    if (calls === 1) {
      arrival.resolve();
      await release;
    }
    return await seeded(...callArgs);
  });
  return {
    arrived: arrival.promise,
    calls: () => {
      return calls;
    },
  };
}

beforeEach(async () => {
  await installApiTestConnectorCatalog();
});

afterEach(() => {
  clearMockNow();
});

describe("Morning Brief Gmail collection preview", () => {
  it("collects both the recent window and the older unread backlog", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        { id: "recent-inside", internalDate: WINDOW_START_MS },
        { id: "recent-before", internalDate: WINDOW_START_MS - 1 },
        { id: "recent-at-anchor", internalDate: ANCHOR_MS },
        { id: "both-branches", internalDate: ANCHOR_MS - 1, unread: true },
      ],
      unread: [
        { id: "both-branches", internalDate: ANCHOR_MS - 1, unread: true },
        {
          id: "unread-backlog",
          internalDate: WINDOW_START_MS - 30 * 24 * 60 * 60 * 1000,
          unread: true,
        },
      ],
    });

    const response = await collectOk(fixture);
    const ids = response.body.items.map((item) => {
      return item.messageId;
    });
    // The window is half-open: its start is inside and the anchor is outside.
    expect(ids).toContain("recent-inside");
    expect(ids).not.toContain("recent-before");
    expect(ids).not.toContain("recent-at-anchor");
    // An unread message far older than 24h has no invented lower bound.
    expect(ids).toContain("unread-backlog");
    const shared = response.body.items.find((item) => {
      return item.messageId === "both-branches";
    });
    expect(shared?.branches).toStrictEqual(["recent", "unread"]);
    expect(response.body).toMatchObject({
      source: "gmail",
      status: "ok",
      failure: null,
      timezone: "Asia/Shanghai",
      recentWindow: {
        from: new Date(WINDOW_START_MS).toISOString(),
        to: ANCHOR_ISO,
      },
      coverage: { recent: "complete", unread: "complete", truncations: [] },
    });
    expect(
      response.body.items.every((item) => {
        return item.sourceUrl.includes("owner%40example.test");
      }),
    ).toBeTruthy();
  });

  it("answers 404 in production before authentication whether or not the switch is on", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({ recent: [], unread: [] });
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
    expect(stub.calls).toStrictEqual([]);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    const switchOff = await collect(fixture, [404]);
    expect(switchOff.status).toBe(404);
    expect(stub.calls).toStrictEqual([]);
  });

  it("refuses unauthenticated, switched-off and disabled owners without reading Gmail", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({ recent: [], unread: [] });

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      previewClient().collect({
        headers: {},
        body: { anchor: ANCHOR_ISO },
      }),
      [401],
    );
    expect(anonymous.status).toBe(401);

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

  it("refuses a member who owns no Morning Brief installation", async () => {
    const stub = stubGmail({ recent: [], unread: [] });
    const { actor } = await workflowBdd.setupWorkflowOrg({});
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: true },
    );
    const response = await collect(
      { actor: { ...actor, orgId: actor.orgId }, membershipId: "orgmem_none" },
      [403],
    );
    expect(response.status).toBe(403);
    expect(stub.calls).toStrictEqual([]);
  });

  it("reads the explicitly selected non-default account", async () => {
    const fixture = await setupOwner();
    const selectedConnectorId = await connectGmail(
      fixture.actor,
      fixture.agentId,
      {
        email: "selected@example.test",
        subject: `gmail-selected-${randomUUID()}`,
        displayName: "Selected",
      },
    );
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    await selectThreadGmailAccountFixture({
      chatThreadId,
      connectorId: selectedConnectorId,
    });
    stubGmail({
      recent: [{ id: "selected-message", internalDate: ANCHOR_MS - 60_000 }],
      unread: [],
    });

    const response = await collectOk(fixture);
    const item = response.body.items[0];
    expect(item?.messageId).toBe("selected-message");
    // The deep link names the selected mailbox, never the default one.
    expect(item?.sourceUrl).toContain("selected%40example.test");
    expect(item?.sourceUrl).not.toContain("owner%40example.test");
  });

  it("fails closed when the explicitly selected account needs reconnect", async () => {
    const fixture = await setupOwner();
    const selectedConnectorId = await connectGmail(
      fixture.actor,
      fixture.agentId,
      {
        email: "selected@example.test",
        subject: `gmail-selected-${randomUUID()}`,
        displayName: "Selected",
      },
    );
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    await selectThreadGmailAccountFixture({
      chatThreadId,
      connectorId: selectedConnectorId,
    });
    await requireConnectorReconnectFixture(selectedConnectorId);
    const stub = stubGmail({
      recent: [{ id: "default-only", internalDate: ANCHOR_MS - 1 }],
    });

    const response = await collectOk(fixture);
    // The default account must not rescue an unusable explicit choice.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "reconnect-required",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("never substitutes another account when the pinned one is deleted mid-flight", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR_MS - 1000 },
        { id: "held-2", internalDate: ANCHOR_MS - 2000 },
        { id: "held-3", internalDate: ANCHOR_MS - 3000 },
      ],
      unread: [],
      holdDetails: release.promise,
    });

    const collection = collectOk(fixture);
    await waitForDetailArrivals(stub, READER_CONCURRENCY);
    // Deleting the account the source is pinned to, while its bodies are in
    // flight, withdraws the access this invocation was admitted under.
    await connectorsApi.deleteBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      fixture.connectorId,
    );
    release.resolve();

    const response = await collection;
    expect(response.body).toMatchObject({ status: "unavailable", items: [] });
    expect(response.body.failure).toBe("source-revoked");
  });

  it("refuses to read when the Agent no longer holds the connector grant", async () => {
    const fixture = await setupOwner();
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "gmail" },
    );
    const stub = stubGmail({
      recent: [{ id: "unreadable", internalDate: ANCHOR_MS - 1 }],
    });

    const response = await collectOk(fixture);
    // Refused at admission, before anything was collected, so the reason names
    // the missing authority rather than a mid-flight revocation.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-authorized",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("admits no further request and releases nothing when the grant is revoked mid-flight", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR_MS - 1000 },
        { id: "held-2", internalDate: ANCHOR_MS - 2000 },
        { id: "held-3", internalDate: ANCHOR_MS - 3000 },
        { id: "held-4", internalDate: ANCHOR_MS - 4000 },
        { id: "held-5", internalDate: ANCHOR_MS - 5000 },
      ],
      unread: [],
      holdDetails: release.promise,
    });

    const collection = collectOk(fixture);
    // Exactly the reader's concurrency is admitted before the change.
    await waitForDetailArrivals(stub, READER_CONCURRENCY);
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "gmail" },
    );
    release.resolve();

    const response = await collection;
    // A change under a source that already holds data discards it.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
    // Two candidates were never requested: no request was newly authorized
    // after the revocation, rather than "roughly the ones already in flight".
    expect(detailCalls(stub)).toHaveLength(READER_CONCURRENCY);
  });

  it("stops reading message bodies when their permission is denied, keeping the authorized list", async () => {
    const fixture = await setupOwner();
    await runsApi.applyUserPermissionGrant(fixture.actor, {
      agentId: fixture.agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "deny",
    });
    const stub = stubGmail({
      recent: [{ id: "denied-body", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const response = await collectOk(fixture);
    // The list permission is untouched, so its requests still happen.
    expect(listCalls(stub).length).toBeGreaterThan(0);
    // The denied endpoint is never requested, and the credential is not lost.
    expect(detailCalls(stub)).toStrictEqual([]);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: null,
      items: [],
    });
    expect(response.body.coverage.recent).toBe("denied");
  });

  it("treats an expired allow as no permission at all", async () => {
    const fixture = await setupOwner();
    await expirePermissionGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      {
        agentId: fixture.agentId,
        connectorSlug: "gmail",
        permission: "messages.detail",
      },
    );
    const stub = stubGmail({
      recent: [{ id: "expired-body", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const response = await collectOk(fixture);
    expect(detailCalls(stub)).toStrictEqual([]);
    expect(response.body.coverage.recent).toBe("denied");
    expect(response.body.items).toStrictEqual([]);
  });

  it("withholds the payload when a permission used earlier is denied while the last request is held", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR_MS - 1000 },
        { id: "held-2", internalDate: ANCHOR_MS - 2000 },
        { id: "held-3", internalDate: ANCHOR_MS - 3000 },
      ],
      unread: [],
      holdDetails: release.promise,
    });

    const collection = collectOk(fixture);
    await waitForDetailArrivals(stub, READER_CONCURRENCY);
    // The list results are already collected under `messages.read`. Denying it
    // now leaves the connector grant and `messages.detail` untouched, so the
    // final request is still allowed — only the earlier permission is gone.
    await runsApi.applyUserPermissionGrant(fixture.actor, {
      agentId: fixture.agentId,
      connectorSlug: "gmail",
      permission: "messages.read",
      action: "deny",
    });
    release.resolve();

    const response = await collection;
    // Checking only the last authorized endpoint would have released the list
    // content this member may no longer read.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("refuses a member whose Clerk membership is gone even while the cache row remains", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [{ id: "unreadable", internalDate: ANCHOR_MS - 1 }],
    });
    // Every preceding request populated `org_members_cache` for this pair. Only
    // the live membership read can tell that the member has been removed.
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
    const release = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR_MS - 1000 },
        { id: "held-2", internalDate: ANCHOR_MS - 2000 },
        { id: "held-3", internalDate: ANCHOR_MS - 3000 },
      ],
      unread: [],
      holdDetails: release.promise,
    });

    const collection = collectOk(fixture);
    await waitForDetailArrivals(stub, READER_CONCURRENCY);
    // A remove and rejoin issues a new immutable membership id. The new
    // membership does not speak for what the previous one started.
    await seedMembership(fixture.actor, `orgmem_${randomUUID()}`);
    release.resolve();

    const response = await collection;
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("reads with a credential that never expires instead of forcing a refresh", async () => {
    const fixture = await setupOwner();
    // GitHub OAuth tokens, personal access tokens and manual methods all store
    // a null expiry. Refreshing one fails before any provider request.
    await clearConnectorTokenExpiryFixture(fixture.connectorId);
    stubGmail({
      recent: [{ id: "non-expiring", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const response = await collectOk(fixture);
    expect(response.body.status).toBe("ok");
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["non-expiring"]);
  });

  it("refreshes an expiring credential once and reads with the refreshed token", async () => {
    const fixture = await setupOwner();
    await expireConnectorTokenFixture(fixture.connectorId);
    const refresh = stubGmailTokenRefresh({
      accessToken: "gmail-refreshed-token",
    });
    const stub = stubGmail({
      recent: [{ id: "after-refresh", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const response = await collectOk(fixture);
    // Unchanged authority still spends exactly one refresh, and every provider
    // request carries what that refresh produced rather than the stale token.
    expect(refresh.calls()).toBe(1);
    expect(response.body.status).toBe("ok");
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["after-refresh"]);
    expect(
      stub.calls.map((call) => {
        return call.authorization;
      }),
    ).not.toContain("Bearer gmail-access-token");
    expect(
      stub.calls.every((call) => {
        return call.authorization === "Bearer gmail-refreshed-token";
      }),
    ).toBeTruthy();
  });

  it("issues no Gmail request when the grant is revoked while the refresh is held", async () => {
    const fixture = await setupOwner();
    await expireConnectorTokenFixture(fixture.connectorId);
    const release = createDeferredPromise<void>(context.signal);
    const refresh = stubGmailTokenRefresh({ hold: release.promise });
    const stub = stubGmail({
      recent: [{ id: "unreadable", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const collection = collectOk(fixture);
    // The reader is parked on the provider's refresh response, after the
    // endpoint decision that admitted this request and before the request
    // itself exists.
    await waitForRefreshArrivals(refresh, 1);
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "gmail" },
    );
    release.resolve();

    const response = await collection;
    // A prepared credential is not permission: the authority withdrawn during
    // that wait is re-derived before the first request, so the source spends no
    // request at all.
    expect(stub.calls).toStrictEqual([]);
    // Refusing never reaches for a second account or a second refresh.
    expect(refresh.calls()).toBe(1);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("issues no Gmail request when the account choice changes during the refresh", async () => {
    const fixture = await setupOwner();
    const otherConnectorId = await connectGmail(
      fixture.actor,
      fixture.agentId,
      {
        email: "selected@example.test",
        subject: `gmail-selected-${randomUUID()}`,
        displayName: "Selected",
      },
    );
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    await expireConnectorTokenFixture(fixture.connectorId);
    const release = createDeferredPromise<void>(context.signal);
    const refresh = stubGmailTokenRefresh({ hold: release.promise });
    const stub = stubGmail({
      recent: [{ id: "unreadable", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });

    const collection = collectOk(fixture);
    await waitForRefreshArrivals(refresh, 1);
    // The owner picks a different mailbox while the account this source pinned
    // is still refreshing its own credential.
    await selectThreadGmailAccountFixture({
      chatThreadId,
      connectorId: otherConnectorId,
    });
    release.resolve();

    const response = await collection;
    // The refreshed credential belongs to an account this source may no longer
    // read, and the newly chosen one was never admitted, so neither is used.
    expect(stub.calls).toStrictEqual([]);
    expect(refresh.calls()).toBe(1);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
  });

  it("names only the per-response cap for a lone oversized body", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [{ id: "huge", internalDate: ANCHOR_MS - 1000, oversized: true }],
      unread: [],
    });

    const response = await collectOk(fixture);
    expect(detailCalls(stub)).toHaveLength(1);
    // One 256 KiB overrun says nothing about the 4 MiB cumulative budget, which
    // still had a full per-response allowance left to give.
    expect(response.body.coverage.truncations).toStrictEqual([
      "response-bytes",
    ]);
    expect(response.body.items).toStrictEqual([]);
  });

  it("charges an abandoned oversized body and reports the truncation", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [
        { id: "huge-1", internalDate: ANCHOR_MS - 1000, oversized: true },
        { id: "huge-2", internalDate: ANCHOR_MS - 2000, oversized: true },
        { id: "huge-3", internalDate: ANCHOR_MS - 3000, oversized: true },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    expect(detailCalls(stub)).toHaveLength(3);
    // Three concurrent readers each stopped at the per-response ceiling; none
    // of their partial bodies became content.
    expect(response.body.coverage.truncations).toContain("response-bytes");
    // Three ceilings are 768 KiB of a 4 MiB budget, so the cumulative cap is
    // not what bound them.
    expect(response.body.coverage.truncations).not.toContain(
      "total-response-bytes",
    );
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.status).toBe("unavailable");
  });

  it("spends the cumulative byte budget once across concurrent bodies", async () => {
    const fixture = await setupOwner();
    const gate = createDetailGate();
    // Sixteen full allowances are admitted in whole concurrency-sized batches,
    // and one more batch is seeded so the refusal is observed rather than
    // inferred from running out of candidates.
    const admittedBatches = Math.ceil(
      FULL_OVERSIZED_ALLOWANCES / READER_CONCURRENCY,
    );
    const stub = stubGmail({
      recent: Array.from(
        { length: (admittedBatches + 1) * READER_CONCURRENCY },
        (_unused, index) => {
          return {
            id: `huge-${String(index).padStart(2, "0")}`,
            internalDate: ANCHOR_MS - (index + 1) * 1000,
            oversized: true,
          };
        },
      ),
      unread: [],
      gateDetails: gate.wait,
    });

    const collection = collectOk(fixture);
    // Release one concurrency-sized batch at a time. Before each release every
    // earlier batch is charged and exactly this batch is in flight.
    const admitted = admittedBatches * READER_CONCURRENCY;
    for (
      let arrived = READER_CONCURRENCY;
      arrived <= admitted;
      arrived += READER_CONCURRENCY
    ) {
      await waitForDetailArrivals(stub, arrived);
      gate.release();
    }
    gate.openPermanently();

    const response = await collection;
    // Sixteen full 256 KiB allowances exhaust 4 MiB exactly, and the bodies
    // already in flight when the last one landed share what remained instead of
    // each being handed it again. Anything past that is refused before it
    // reaches Gmail.
    expect(detailCalls(stub)).toHaveLength(admitted);
    // The two list responses gave back everything they did not use: without
    // that refund their reservations alone would have cost two whole
    // allowances and stopped this a batch earlier.
    expect(response.body.coverage.truncations).toContain(
      "total-response-bytes",
    );
    expect(response.body.coverage.truncations).toContain("response-bytes");
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.status).toBe("unavailable");
  });

  it("hands the last aggregate allowance to one concurrent body, not to each", async () => {
    const fixture = await setupOwner();
    const gate = createDetailGate();
    const bodyGate = createDetailGate();
    let openBodies = 0;
    // Fill the cumulative budget with whole allowances until what remains is
    // smaller than one per-response ceiling, then meet that remainder with
    // exactly one concurrency-sized batch of ordinary bodies.
    const fillerBatches = Math.ceil(
      FULL_OVERSIZED_ALLOWANCES / READER_CONCURRENCY,
    );
    const fillers = Array.from(
      { length: (fillerBatches - 1) * READER_CONCURRENCY },
      (_unused, index) => {
        return {
          id: `filler-${String(index).padStart(2, "0")}`,
          internalDate: ANCHOR_MS - (index + 1) * 1000,
          oversized: true,
        };
      },
    );
    const boundaryIds = Array.from(
      { length: READER_CONCURRENCY },
      (_unused, index) => {
        return `boundary-${index}`;
      },
    );
    const stub = stubGmail({
      recent: [
        ...fillers,
        ...boundaryIds.map((id, index) => {
          return {
            id,
            internalDate: ANCHOR_MS - (fillers.length + index + 1) * 1000,
          };
        }),
      ],
      unread: [],
      gateDetails: gate.wait,
      bodyGatedIds: new Set(boundaryIds),
      bodyGate: bodyGate.wait,
      onBodyOpen: () => {
        openBodies += 1;
      },
    });

    const collection = collectOk(fixture);
    for (
      let arrived = READER_CONCURRENCY;
      arrived <= fillers.length;
      arrived += READER_CONCURRENCY
    ) {
      await waitForDetailArrivals(stub, arrived);
      gate.release();
    }
    gate.openPermanently();
    // Each boundary reader has been handed its own allowance and is parked on
    // the body. Reading them is what would spend the same remainder twice.
    await expect
      .poll(
        () => {
          return openBodies;
        },
        { timeout: 10_000 },
      )
      .toBe(READER_CONCURRENCY);
    bodyGate.openPermanently();

    const response = await collection;
    expect(detailCalls(stub)).toHaveLength(fillers.length + READER_CONCURRENCY);
    // The allowance is taken before the body is read, so the remainder belongs
    // to whichever reader claimed it and its two siblings are left with none.
    // Taking it after the read instead would hand all three the same bytes and
    // let all three succeed.
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toHaveLength(1);
    expect(boundaryIds).toContain(response.body.items[0]?.messageId);
    // The siblings were bound by the cumulative budget, not by their own size.
    expect(response.body.coverage.truncations).toContain(
      "total-response-bytes",
    );
    expect(response.body.status).toBe("partial");
  });

  it("admits no request after the source deadline has passed", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(context.signal);
    const startedAt = now();
    mockNow(startedAt);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR_MS - 1000 },
        { id: "held-2", internalDate: ANCHOR_MS - 2000 },
        { id: "held-3", internalDate: ANCHOR_MS - 3000 },
        { id: "held-4", internalDate: ANCHOR_MS - 4000 },
        { id: "held-5", internalDate: ANCHOR_MS - 5000 },
      ],
      unread: [],
      holdDetails: release.promise,
    });

    const collection = collectOk(fixture);
    await waitForDetailArrivals(stub, READER_CONCURRENCY);
    // The source budget is 20 s. Authorization for the next requests would
    // otherwise complete and start them after their own deadline.
    mockNow(startedAt + 21_000);
    release.resolve();

    const response = await collection;
    // The two candidates that had not been requested never are, and what the
    // three in-flight bodies did return is not released either: the budget the
    // whole source was admitted under is gone, so this is an expired source
    // rather than a partially collected one.
    expect(detailCalls(stub)).toHaveLength(READER_CONCURRENCY);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "deadline-exceeded",
      items: [],
    });
  });

  it("gives a held source admission no fresh collection budget", async () => {
    const fixture = await setupOwner();
    const startedAt = now();
    mockNow(startedAt);
    const stub = stubGmail({
      recent: [{ id: "never-read", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
    });
    const release = createDeferredPromise<void>(context.signal);
    await seedMembership(fixture.actor, fixture.membershipId);
    const admission = holdNextMembershipRead(release.promise);

    const collection = accept(
      previewClient().collect({
        headers: authHeaders(fixture.actor),
        body: { anchor: ANCHOR_ISO },
      }),
      [504],
    );
    await admission.arrived;
    // The entire source budget is spent inside the public admission, before the
    // collection this deadline is meant to cover has begun.
    mockNow(startedAt + MORNING_BRIEF_SOURCE_BUDGET_MS + 1000);
    release.resolve();

    const response = await collection;
    // A slow preflight shortens the source instead of earning it a second
    // allowance. The late answer stops the preflight where it stands: no
    // retry, no further admission read and no provider request.
    expect(response.status).toBe(504);
    expect(stub.calls).toStrictEqual([]);
    expect(admission.calls()).toBe(1);
  });

  it("withholds a payload whose release finished after the source deadline", async () => {
    const fixture = await setupOwner();
    const startedAt = now();
    mockNow(startedAt);
    const bodies = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [{ id: "collected", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
      holdDetails: bodies.promise,
    });

    const collection = collectOk(fixture);
    // Every request has been authorized and issued, so the next membership read
    // belongs to the release fence rather than to an admission.
    await waitForDetailArrivals(stub, 1);
    const releaseFence = createDeferredPromise<void>(context.signal);
    const membership = holdNextMembershipRead(releaseFence.promise);
    bodies.resolve();
    await membership.arrived;
    // The budget runs out while the final authorization is still answering, so
    // the payload is already collected and the timer has not fired.
    mockNow(startedAt + MORNING_BRIEF_SOURCE_BUDGET_MS);
    releaseFence.resolve();

    const response = await collection;
    // Re-deriving authority takes real time, and a payload accepted after the
    // absolute deadline is late content. The boundary is inclusive: arriving
    // exactly at it is already too late.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "deadline-exceeded",
      items: [],
    });
  });

  it("releases a payload whose release finished just inside the source deadline", async () => {
    const fixture = await setupOwner();
    const startedAt = now();
    mockNow(startedAt);
    const bodies = createDeferredPromise<void>(context.signal);
    const stub = stubGmail({
      recent: [{ id: "collected", internalDate: ANCHOR_MS - 1000 }],
      unread: [],
      holdDetails: bodies.promise,
    });

    const collection = collectOk(fixture);
    await waitForDetailArrivals(stub, 1);
    const releaseFence = createDeferredPromise<void>(context.signal);
    const membership = holdNextMembershipRead(releaseFence.promise);
    bodies.resolve();
    await membership.arrived;
    // The final local authority transaction still has one second to complete:
    // the positive control keeps the case above from passing by refusing every
    // payload while respecting that local checks now spend this same budget.
    mockNow(startedAt + MORNING_BRIEF_SOURCE_BUDGET_MS - 1000);
    releaseFence.resolve();

    const response = await collection;
    expect(response.body.status).toBe("ok");
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["collected"]);
  });

  it("separates an empty day from a rate-limited read", async () => {
    const fixture = await setupOwner();
    stubGmail({ recent: [], unread: [] });
    const empty = await collectOk(fixture);
    expect(empty.body).toMatchObject({
      status: "empty",
      failure: null,
      items: [],
      coverage: { recent: "complete", unread: "complete" },
    });

    server.use(
      http.get(GMAIL_LIST_URL, () => {
        return HttpResponse.json(
          { error: { code: 429 } },
          { status: 429, headers: { "retry-after": "30" } },
        );
      }),
    );
    const limited = await collectOk(fixture);
    expect(limited.body).toMatchObject({
      status: "unavailable",
      failure: "rate-limited",
      items: [],
    });
    expect(limited.body.coverage.retryAfterMs).toBe(30_000);
  });

  it("pages past an empty page that still carries a continuation token", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [],
      unread: [],
      pages: new Map([
        ["first", { ids: [], nextPageToken: "page-2" }],
        ["page-2", { ids: ["late-message"] }],
      ]),
    });
    server.use(
      http.get(GMAIL_MESSAGE_URL, ({ params }) => {
        return HttpResponse.json(
          messagePayload({
            id: String(params["messageId"]),
            internalDate: ANCHOR_MS - 5000,
            unread: true,
          }),
        );
      }),
    );

    const response = await collectOk(fixture);
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toContain("late-message");
    expect(
      stub.calls.filter((call) => {
        return call.search.includes("pageToken=page-2");
      }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps a deleted message from failing the branch", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        { id: "present", internalDate: ANCHOR_MS - 1000 },
        { id: "deleted", internalDate: ANCHOR_MS - 2000 },
      ],
      unread: [],
      detailStatus: new Map([["deleted", 404]]),
    });

    const response = await collectOk(fixture);
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["present"]);
    // A deleted message is a gap in that message, not a failed branch.
    expect(response.body.coverage.recent).toBe("complete");
    expect(response.body.status).toBe("ok");
  });

  it("keeps an authorized sibling when the provider forbids one message", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        { id: "readable", internalDate: ANCHOR_MS - 1000 },
        { id: "forbidden", internalDate: ANCHOR_MS - 2000 },
      ],
      unread: [],
      detailStatus: new Map([["forbidden", 403]]),
    });

    const response = await collectOk(fixture);
    // A provider 403 is one resource refusing a read, not a lost credential.
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["readable"]);
    expect(response.body.status).toBe("partial");
    expect(response.body.failure).toBeNull();
  });

  it("declares limited coverage for an HTML-only message instead of inventing text", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        {
          id: "html-only",
          internalDate: ANCHOR_MS - 1000,
          html: "<html><body><p>Board sync moved to Friday.</p></body></html>",
        },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    const item = response.body.items[0];
    expect(item?.excerptSource).toBe("html-normalized");
    expect(item?.excerpt).toContain("Board sync moved to Friday.");
  });

  it("reports a malformed provider response as a failure, never as an empty day", async () => {
    const fixture = await setupOwner();
    server.use(
      http.get(GMAIL_LIST_URL, () => {
        return HttpResponse.json({ messages: "not-a-list" });
      }),
    );

    const response = await collectOk(fixture);
    expect(response.body).toMatchObject({ status: "unavailable", items: [] });
    expect(response.body.coverage.recent).toBe("failed");
    expect(response.body.failure).toBe("provider-failed");
  });

  it("bounds every retained header and keeps its authorized sibling", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [
        {
          id: "oversized-headers",
          internalDate: ANCHOR_MS - 1000,
          // Every one of these is transport-valid: the whole response stays far
          // below the reader's 256 KiB ceiling, so nothing upstream rejects it
          // and normalization is the only thing that can bound it.
          subject: "S".repeat(50_000),
          from: `${"f".repeat(4000)}@example.test`,
          to: Array.from({ length: 200 }, (_unused, index) => {
            return `recipient-${index}@example.test`;
          }).join(", "),
          date: `Wed, 16 Sep 2026 07:00:00 +0000 ${"(padding)".repeat(200)}`,
          text: "Short body.",
        },
        {
          id: "normal-headers",
          internalDate: ANCHOR_MS - 2000,
          subject: "Weekly sync",
          text: "Agenda attached.",
        },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    const oversized = itemById(response.body, "oversized-headers");
    expect(oversized?.subject).toHaveLength(300);
    expect(oversized?.from).toHaveLength(320);
    expect(oversized?.to).toHaveLength(1000);
    expect(oversized?.date).toHaveLength(64);
    expect(oversized?.excerpt).toBe("Short body.");
    // The sibling keeps everything it legitimately had.
    expect(itemById(response.body, "normal-headers")).toMatchObject({
      subject: "Weekly sync",
      excerpt: "Agenda attached.",
    });
    expect(retainedCharacters(response.body)).toBeLessThanOrEqual(40_000);
    expect(response.body.coverage.truncations).toContain("header-characters");
    // Shortened content is reduced coverage, never a clean read.
    expect(response.body.status).toBe("partial");
    // Bounding is normalization only: the provider budget is untouched.
    expect(listCalls(stub)).toHaveLength(2);
    expect(detailCalls(stub)).toHaveLength(2);
  });

  it("charges every retained field to the final text budget under high volume", async () => {
    const fixture = await setupOwner();
    const bulk = (branch: "recent" | "unread") => {
      return Array.from({ length: 25 }, (_unused, index) => {
        return {
          id: `${branch}-${String(index).padStart(2, "0")}`,
          internalDate: ANCHOR_MS - 1000 * (index + 1),
          unread: branch === "unread",
          subject: `${branch} ${"S".repeat(400)}`,
          text: "B".repeat(2000),
        };
      });
    };
    const stub = stubGmail({ recent: bulk("recent"), unread: bulk("unread") });

    const response = await collectOk(fixture);
    // The detail cap, not the budget, decides how many messages are read.
    expect(detailCalls(stub)).toHaveLength(40);
    expect(response.body.coverage.truncations).toContain("detail-requests");
    // Interleaving keeps the unread backlog from starving behind the window.
    expect(
      new Set(
        response.body.items.flatMap((item) => {
          return item.branches;
        }),
      ),
    ).toStrictEqual(new Set(["recent", "unread"]));
    expect(retainedCharacters(response.body)).toBeLessThanOrEqual(40_000);
    expect(response.body.coverage.truncations).toContain("text-characters");
    expect(response.body.status).toBe("partial");
  });

  it("names the MIME cap instead of calling a deep message HTML-only", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [
        {
          id: "depth-at-limit",
          internalDate: ANCHOR_MS - 1000,
          parts: [nestedPart(12, inlineTextPart("Deep but still reachable."))],
        },
        {
          id: "depth-past-limit",
          internalDate: ANCHOR_MS - 2000,
          parts: [nestedPart(13, inlineTextPart("Below the depth cap."))],
        },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    expect(itemById(response.body, "depth-at-limit")).toMatchObject({
      excerptSource: "text-plain",
      excerpt: "Deep but still reachable.",
    });
    // A part the walk never reached is not evidence of an HTML-only message.
    expect(itemById(response.body, "depth-past-limit")).toMatchObject({
      excerptSource: "mime-truncated",
      excerpt: "",
    });
    expect(response.body.coverage.truncations).toContain("mime-nodes");
    expect(response.body.status).toBe("partial");
    expect(detailCalls(stub)).toHaveLength(2);
  });

  it("names the MIME cap when the node budget runs out", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        {
          id: "nodes-at-limit",
          internalDate: ANCHOR_MS - 1000,
          // `payload` plus 199 children is exactly the 200-node budget.
          parts: [
            ...emptyParts(198),
            inlineTextPart("The last node inside the budget."),
          ],
        },
      ],
      unread: [],
    });
    const atLimit = await collectOk(fixture);
    expect(itemById(atLimit.body, "nodes-at-limit")).toMatchObject({
      excerptSource: "text-plain",
      excerpt: "The last node inside the budget.",
    });
    expect(atLimit.body.coverage.truncations).toStrictEqual([]);
    expect(atLimit.body.status).toBe("ok");

    stubGmail({
      recent: [
        {
          id: "nodes-past-limit",
          internalDate: ANCHOR_MS - 1000,
          parts: [
            ...emptyParts(199),
            inlineTextPart("One node past the budget."),
          ],
        },
      ],
      unread: [],
    });
    const pastLimit = await collectOk(fixture);
    expect(itemById(pastLimit.body, "nodes-past-limit")).toMatchObject({
      excerptSource: "mime-truncated",
      excerpt: "",
    });
    expect(pastLimit.body.coverage.truncations).toContain("mime-nodes");
    expect(pastLimit.body.status).toBe("partial");
  });

  it("never lets a filename-bearing attachment subtree become the excerpt", async () => {
    const fixture = await setupOwner();
    const forwarded: StubPart = {
      mimeType: "message/rfc822",
      filename: "forwarded.eml",
      parts: [inlineTextPart("Attached plaintext that must never surface.")],
    };
    const stub = stubGmail({
      recent: [
        {
          id: "attachment-and-inline",
          internalDate: ANCHOR_MS - 1000,
          parts: [forwarded, inlineHtmlPart("<p>Visible inline body.</p>")],
        },
        {
          id: "attachment-only",
          internalDate: ANCHOR_MS - 2000,
          parts: [forwarded],
        },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    const inline = itemById(response.body, "attachment-and-inline");
    expect(inline?.excerptSource).toBe("html-normalized");
    expect(inline?.excerpt).toContain("Visible inline body.");
    // With nothing inline left, the message declares the gap rather than
    // reaching into the attachment already sitting in this response.
    expect(itemById(response.body, "attachment-only")).toMatchObject({
      excerptSource: "none",
      excerpt: "",
    });
    expect(
      response.body.items.every((item) => {
        return !item.excerpt.includes("Attached plaintext");
      }),
    ).toBeTruthy();
    // Pruning content this response already carried is not a cap, and the two
    // message reads are the only provider requests it takes. An attachment
    // endpoint would arrive unhandled and fail this suite outright.
    expect(response.body.coverage.truncations).toStrictEqual([]);
    expect(response.body.status).toBe("ok");
    expect(detailCalls(stub)).toHaveLength(2);
  });

  it("reports a malformed recent timestamp as provider data, not an empty day", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        {
          id: "malformed-recent",
          internalDate: ANCHOR_MS - 1000,
          // Numeric and transport-valid, but no instant a `Date` can hold.
          rawInternalDate: "1000000000000000000000",
        },
        { id: "valid-recent", internalDate: ANCHOR_MS - 2000 },
      ],
      unread: [],
    });

    const response = await collectOk(fixture);
    // Filtering the unusable message out of the window silently reported a
    // healthy read of whatever was left.
    expect(response.body.coverage.recent).toBe("failed");
    expect(response.body.status).toBe("partial");
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["valid-recent"]);
  });

  it("answers a malformed unread timestamp without an unhandled exception", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [],
      unread: [
        {
          id: "malformed-unread",
          internalDate: ANCHOR_MS - 1000,
          unread: true,
          rawInternalDate: "not-a-timestamp",
        },
        { id: "valid-unread", internalDate: ANCHOR_MS - 2000, unread: true },
      ],
    });

    const response = await collectOk(fixture);
    expect(response.body.coverage.unread).toBe("failed");
    expect(response.body.status).toBe("partial");
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["valid-unread"]);
    // No timestamp is invented for the message that could not be normalized.
    expect(
      response.body.items.every((item) => {
        return !Number.isNaN(Date.parse(item.internalDate));
      }),
    ).toBeTruthy();
  });

  it("keeps a 429 that carries no Retry-After classified as rate-limited", async () => {
    const fixture = await setupOwner();
    stubGmail({ recent: [], unread: [] });
    server.use(
      http.get(GMAIL_LIST_URL, () => {
        return HttpResponse.json({ error: { code: 429 } }, { status: 429 });
      }),
    );

    const response = await collectOk(fixture);
    // The limit is the fact; the advisory header is optional metadata.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "rate-limited",
      items: [],
    });
    expect(response.body.coverage.retryAfterMs).toBeNull();
  });
});
