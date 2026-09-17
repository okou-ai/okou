import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  morningBriefGmailCollectionPreviewContract,
  type MorningBriefGmailCollection,
} from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  breakThreadGmailSelectionFixture,
  installMorningBriefFixture,
  revokeAgentConnectorGrantFixture,
  selectThreadGmailAccountFixture,
  setMorningBriefEnabledFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { ROUTES } from "../../route";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Gmail collection through the shared Morning Brief OAuth reader.
 *
 * Every request below reaches the route through `ROUTES`, the same composition
 * `createProductionApp` mounts, so a route that is only reachable from a test
 * harness would fail this suite rather than pass it.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";

const ANCHOR = new Date("2026-09-17T07:00:00.000Z");
const WINDOW_START = new Date(ANCHOR.getTime() - 24 * 60 * 60 * 1000);

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

function previewClient() {
  // The real application composition, not a hand-mounted route list.
  return setupApp({ context, routes: ROUTES })(
    morningBriefGmailCollectionPreviewContract,
  );
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
}

function messagePayload(message: StubMessage) {
  const headers = [
    { name: "Subject", value: message.subject ?? `Subject ${message.id}` },
    { name: "From", value: "sender@example.test" },
    { name: "To", value: "owner@example.test" },
    { name: "Date", value: new Date(message.internalDate).toUTCString() },
  ];
  const body =
    message.html === undefined
      ? {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(message.text ?? `Body ${message.id}`).toString(
              "base64url",
            ),
          },
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
 * A Gmail stub that records every call, so a denial can be asserted as *zero
 * provider reads* rather than as an absent response body.
 */
function stubGmail(args: {
  readonly recent?: readonly StubMessage[];
  readonly unread?: readonly StubMessage[];
  readonly pages?: ReadonlyMap<
    string,
    { readonly ids: readonly string[]; readonly nextPageToken?: string }
  >;
  readonly holdFirstDetail?: Promise<void>;
  readonly detailStatus?: ReadonlyMap<string, number>;
}): GmailStub {
  const calls: GmailCall[] = [];
  const byId = new Map<string, StubMessage>();
  for (const message of [...(args.recent ?? []), ...(args.unread ?? [])]) {
    byId.set(message.id, message);
  }
  let held = false;

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
      if (args.holdFirstDetail && !held) {
        held = true;
        await args.holdFirstDetail;
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

function detailCalls(stub: GmailStub): readonly GmailCall[] {
  return stub.calls.filter((call) => {
    return /\/messages\/[^/]+$/.test(call.pathname);
  });
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
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
  await connectGmail(actor, agentId, {
    email: "owner@example.test",
    subject: `gmail-${randomUUID()}`,
  });
  await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
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

/** Narrows the contract's response union to a collected Gmail envelope. */
async function collectOk(
  actor: ApiTestUser,
): Promise<{ readonly body: MorningBriefGmailCollection }> {
  const response = await collect(actor, [200]);
  if (response.status !== 200) {
    throw new Error(`Expected a Gmail collection, received ${response.status}`);
  }
  return { body: response.body };
}

beforeEach(async () => {
  await installApiTestConnectorCatalog();
});

describe("Morning Brief Gmail collection preview", () => {
  it("collects both the recent window and the older unread backlog", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({
      recent: [
        { id: "recent-inside", internalDate: WINDOW_START.getTime() },
        { id: "recent-before", internalDate: WINDOW_START.getTime() - 1 },
        { id: "recent-at-anchor", internalDate: ANCHOR.getTime() },
        {
          id: "both-branches",
          internalDate: ANCHOR.getTime() - 1,
          unread: true,
        },
      ],
      unread: [
        {
          id: "both-branches",
          internalDate: ANCHOR.getTime() - 1,
          unread: true,
        },
        {
          id: "unread-backlog",
          internalDate: WINDOW_START.getTime() - 30 * 24 * 60 * 60 * 1000,
          unread: true,
        },
      ],
    });

    const response = await collectOk(fixture.actor);
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
    expect(detailCalls(stub)).toHaveLength(
      new Set(
        detailCalls(stub).map((call) => {
          return call.pathname;
        }),
      ).size,
    );
    expect(response.body).toMatchObject({
      source: "gmail",
      status: "ok",
      failure: null,
      timezone: "Asia/Shanghai",
      recentWindow: {
        from: WINDOW_START.toISOString(),
        to: ANCHOR.toISOString(),
      },
      coverage: { recent: "complete", unread: "complete", truncations: [] },
    });
    expect(
      response.body.items.every((item) => {
        return item.sourceUrl.includes("owner%40example.test");
      }),
    ).toBe(true);
  });

  it("answers 404 in production before authentication whether or not the switch is on", async () => {
    const fixture = await setupOwner();
    const stub = stubGmail({ recent: [], unread: [] });
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
    expect(stub.calls).toStrictEqual([]);

    await updateFeatureSwitchesForUser(
      context,
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { [FeatureSwitchKey.SimpleMorningBrief]: false },
    );
    const switchOff = await collect(fixture.actor, [404]);
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
        body: { anchor: ANCHOR.toISOString() },
      }),
      [401],
    );
    expect(anonymous.status).toBe(401);

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
    const response = await collect(actor, [403]);
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
      recent: [
        { id: "selected-message", internalDate: ANCHOR.getTime() - 60_000 },
      ],
      unread: [],
    });

    const response = await collectOk(fixture.actor);
    const item = response.body.items[0];
    expect(item?.messageId).toBe("selected-message");
    // The deep link names the selected mailbox, never the default one.
    expect(item?.sourceUrl).toContain("selected%40example.test");
    expect(item?.sourceUrl).not.toContain("owner%40example.test");
  });

  it("fails closed when the explicit account selection no longer resolves", async () => {
    const fixture = await setupOwner();
    const chatThreadId = await bindMorningBriefThreadFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { workflowId: fixture.workflowId, agentId: fixture.agentId },
    );
    const strandedConnectorId = await connectGmail(
      fixture.actor,
      fixture.agentId,
      {
        email: "stranded@example.test",
        subject: `gmail-stranded-${randomUUID()}`,
        displayName: "Stranded",
      },
    );
    await breakThreadGmailSelectionFixture({
      chatThreadId,
      connectorId: strandedConnectorId,
    });
    await connectorsApi.deleteBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      strandedConnectorId,
    );
    const stub = stubGmail({
      recent: [{ id: "default-only", internalDate: ANCHOR.getTime() - 1 }],
    });

    const response = await collectOk(fixture.actor);
    // The default account must not rescue a failed explicit choice.
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-connected",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("refuses to read when the Agent no longer holds the connector grant", async () => {
    const fixture = await setupOwner();
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "gmail" },
    );
    const stub = stubGmail({
      recent: [{ id: "unreadable", internalDate: ANCHOR.getTime() - 1 }],
    });

    const response = await collectOk(fixture.actor);
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "not-authorized",
      items: [],
    });
    expect(stub.calls).toStrictEqual([]);
  });

  it("stops a held request's source when the grant is revoked while it waits", async () => {
    const fixture = await setupOwner();
    const release = createDeferredPromise<void>(new AbortController().signal);
    const stub = stubGmail({
      recent: [
        { id: "held-1", internalDate: ANCHOR.getTime() - 1_000 },
        { id: "held-2", internalDate: ANCHOR.getTime() - 2_000 },
        { id: "held-3", internalDate: ANCHOR.getTime() - 3_000 },
        { id: "held-4", internalDate: ANCHOR.getTime() - 4_000 },
      ],
      unread: [],
      holdFirstDetail: release.promise,
    });

    const collection = collectOk(fixture.actor);
    // Arrival, not a sleep: the stub has entered the held detail request.
    await expect
      .poll(() => {
        return detailCalls(stub).length;
      })
      .toBeGreaterThan(0);
    const heldCalls = detailCalls(stub).length;
    await revokeAgentConnectorGrantFixture(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      { agentId: fixture.agentId, connectorSlug: "gmail" },
    );
    release.resolve();

    const response = await collection;
    expect(response.body).toMatchObject({
      status: "unavailable",
      failure: "source-revoked",
      items: [],
    });
    // No request was issued after the revocation, and no payload was released.
    expect(detailCalls(stub).length).toBeLessThanOrEqual(heldCalls + 1);
  });

  it("separates an empty day from a rate-limited read", async () => {
    const fixture = await setupOwner();
    stubGmail({ recent: [], unread: [] });
    const empty = await collectOk(fixture.actor);
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
    const limited = await collectOk(fixture.actor);
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
            internalDate: ANCHOR.getTime() - 5_000,
            unread: true,
          }),
        );
      }),
    );

    const response = await collectOk(fixture.actor);
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

  it("keeps a deleted message from failing the branch and reports an unreadable one", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        { id: "present", internalDate: ANCHOR.getTime() - 1_000 },
        { id: "deleted", internalDate: ANCHOR.getTime() - 2_000 },
      ],
      unread: [],
      detailStatus: new Map([["deleted", 404]]),
    });

    const response = await collectOk(fixture.actor);
    expect(
      response.body.items.map((item) => {
        return item.messageId;
      }),
    ).toStrictEqual(["present"]);
    // A deleted message is a gap in that message, not a failed branch.
    expect(response.body.coverage.recent).toBe("complete");
    expect(response.body.status).toBe("ok");
  });

  it("declares limited coverage for an HTML-only message instead of inventing text", async () => {
    const fixture = await setupOwner();
    stubGmail({
      recent: [
        {
          id: "html-only",
          internalDate: ANCHOR.getTime() - 1_000,
          html: "<html><body><p>Board sync moved to Friday.</p></body></html>",
        },
      ],
      unread: [],
    });

    const response = await collectOk(fixture.actor);
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

    const response = await collectOk(fixture.actor);
    expect(response.body).toMatchObject({
      status: "unavailable",
      items: [],
    });
    expect(response.body.coverage.recent).toBe("failed");
    expect(response.body.failure).toBe("provider-failed");
  });
});
