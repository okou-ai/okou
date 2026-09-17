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

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);
const WINDOW_START_MS = ANCHOR_MS - 24 * 60 * 60 * 1000;
/** The collector's own concurrency, which bounds how many details can be held. */
const READER_CONCURRENCY = 3;

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
}

interface GmailStub {
  readonly calls: GmailCall[];
}

interface StubMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly internalDate: number;
  readonly unread?: boolean;
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  /** Pad the response past the reader's 256 KiB per-response ceiling. */
  readonly oversized?: boolean;
}

function messagePayload(message: StubMessage) {
  const headers = [
    { name: "Subject", value: message.subject ?? `Subject ${message.id}` },
    { name: "From", value: "sender@example.test" },
    { name: "To", value: "owner@example.test" },
    { name: "Date", value: new Date(message.internalDate).toUTCString() },
  ];
  const text =
    message.oversized === true
      ? "x".repeat(400 * 1024)
      : (message.text ?? `Body ${message.id}`);
  const body =
    message.html === undefined
      ? {
          mimeType: "text/plain",
          body: { data: Buffer.from(text).toString("base64url") },
        }
      : {
          mimeType: "text/html",
          body: { data: Buffer.from(message.html).toString("base64url") },
        };
  return {
    id: message.id,
    threadId: message.threadId ?? `thread-${message.id}`,
    internalDate: String(message.internalDate),
    labelIds: message.unread === true ? ["INBOX", "UNREAD"] : ["INBOX"],
    payload: { mimeType: "multipart/alternative", headers, parts: [body] },
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
      calls.push({ pathname: url.pathname, search: url.search });
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
      calls.push({ pathname: url.pathname, search: url.search });
      const messageId = String(params["messageId"]);
      if (args.holdDetails) {
        await args.holdDetails;
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
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.status).toBe("unavailable");
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
    expect(detailCalls(stub)).toHaveLength(READER_CONCURRENCY);
    expect(response.body.coverage.truncations).toContain("deadline");
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
});
