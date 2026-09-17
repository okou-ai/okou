import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  deleteMorningBriefAgent,
  holdCleanupAfterRevocation,
  holdMorningBriefCollectionClaim,
  holdMorningBriefCollectionOccurrence,
  holdMorningBriefMembershipLookup,
  pauseMorningBriefAutomation,
  readMorningBriefCollectionOccurrences,
  readMorningBriefCollectionOwnerRow,
  repointMorningBriefInstallationAgent,
  restrictMorningBriefAgent,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import { rebindMorningBriefSlackAccount } from "../../../test-fixtures/morning-brief-generation";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { morningBriefCollectionPreviewRoutes } from "../morning-brief-collection-preview";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { userPreferencesRoutes } from "../user-preferences";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();

const SLACK_USER_CONVERSATIONS_URL =
  "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";

/**
 * A second-aligned anchor an hour behind this run, so the frozen window and the
 * exact Slack range it asks for stay reproducible without pinning a date that
 * the anchor-age rule would later reject.
 */
const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_MS = ANCHOR_MS - 24 * 60 * 60 * 1000;
const WINDOW_START_SECONDS = WINDOW_START_MS / 1000;
/** Slack's `oldest` is exclusive, so the request asks one microsecond lower. */
const EXPECTED_OLDEST = `${WINDOW_START_SECONDS - 1}.999999`;
const EXPECTED_LATEST = `${ANCHOR_MS / 1000}.000000`;
/** The first instant inside the window, and two instants outside it. */
const FIRST_IN_WINDOW = `${WINDOW_START_SECONDS}.000000`;
const LAST_BEFORE_WINDOW = `${WINDOW_START_SECONDS - 1}.999999`;
const WINDOW_END_EXCLUSIVE = `${ANCHOR_MS / 1000}.000000`;
const THREAD_ROOT = `${WINDOW_START_SECONDS + 60}.000100`;
const THREAD_REPLY = `${WINDOW_START_SECONDS + 90}.000001`;
/**
 * The documented wall clock one attempt gets, counted from the moment the
 * executor starts collecting. Reaching it is already expired.
 */
const COLLECTION_DEADLINE_MS = 30_000;

afterEach(() => {
  clearMockNow();
});

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly botToken: string;
  readonly slackUserId: string;
  readonly workspaceId: string;
  readonly headers: { readonly authorization: string };
}

/**
 * The slice under test is the exact entry the production route table holds.
 *
 * `route-registration.test.ts` asserts that identity against `ROUTES`, which is
 * what makes these behavioral results statements about the deployed endpoint.
 * Composing a test app from the production-global table is rejected by
 * `api/no-global-sweep-test-routes`, so registration and behavior are proven
 * separately against the same handler object.
 */
function collectionClient() {
  return setupApp({ context, routes: morningBriefCollectionPreviewRoutes })(
    morningBriefCollectionPreviewContract,
  );
}

/**
 * A native agent credential carrying the Slack read capability.
 *
 * It is signed against the real clock so a test that moves the service clock to
 * exercise a lease boundary cannot accidentally expire its own credential. A
 * test that crosses the occurrence's whole lifetime asks for a longer one.
 */
function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["slack:read"],
  lifetimeSeconds = 3600,
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities,
      iat: seconds,
      exp: seconds + lifetimeSeconds,
    })}`,
  };
}

async function fixture(
  options: {
    readonly feature?: boolean;
    readonly enabled?: boolean;
    readonly timezone?: string | null;
    readonly installed?: boolean;
    readonly connected?: boolean;
    readonly capabilities?: readonly Capability[];
    readonly membershipId?: string;
    readonly agentVisibility?: "public" | "private";
    readonly agentOwner?: string;
  } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "admin", membershipId: options.membershipId },
    context.signal,
  );
  const brief = await seedInstalledMorningBrief({
    orgId,
    userId,
    timezone: options.timezone,
    enabled: options.enabled,
    agentVisibility: options.agentVisibility,
    agentOwner: options.agentOwner,
  });
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: options.feature !== false },
  );
  const botToken = `xoxb-test-${randomUUID()}`;
  const installation =
    options.installed === false
      ? null
      : await store.set(
          seedSlackOrgInstallation$,
          { orgId, botToken },
          context.signal,
        );
  const connection =
    installation && options.connected !== false
      ? await store.set(
          seedSlackOrgConnection$,
          { slackWorkspaceId: installation.slackWorkspaceId, userId },
          context.signal,
        )
      : null;
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    workflowId: brief.workflowId,
    automationId: brief.automationId,
    botToken,
    slackUserId: connection?.slackUserId ?? "",
    workspaceId: installation?.slackWorkspaceId ?? "",
    headers: agentToken(userId, orgId, options.capabilities),
  };
}

/**
 * The production preference endpoint, used to restore a rejoined member's row.
 *
 * Recreating `org_members_metadata` by hand would hide the very thing under
 * test: the ordinary preference write is what a real rejoin runs, and it
 * inserts a parent with no revocation stamp.
 */
function preferencesClient() {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
}

/** The ordinary signed-in session a member edits their own preferences with. */
function memberSessionHeaders(f: Pick<Fixture, "orgId" | "userId">) {
  createRouteMocks(context).clerk.session(f.userId, f.orgId, "org:admin");
  return { authorization: "Bearer clerk-session" };
}

function collect(f: Pick<Fixture, "headers">, scheduledFor = ANCHOR) {
  return collectionClient().collect({
    headers: f.headers,
    body: { scheduledFor },
  });
}

/** The same call with the deployment headers a preview operator would send. */
function collectWithHeaders(
  f: Pick<Fixture, "headers">,
  extraHeaders: Record<string, string>,
) {
  return collectionClient().collect({
    headers: f.headers,
    extraHeaders,
    body: { scheduledFor: ANCHOR },
  });
}

/**
 * One scripted Slack answer.
 *
 * It may hold its own response — returning a promise keeps the provider request
 * genuinely in flight — and it receives the request so a test can observe what
 * reaches that request, including its cancellation.
 */
type SlackReply = (query: URLSearchParams, request: Request) => unknown;

interface SlackTraffic {
  readonly requests: { url: string; token: string | null }[];
  readonly queries: URLSearchParams[];
}

/** Script the three native Slack reads and record exactly what was asked. */
function scriptSlack(script: {
  readonly channels?: SlackReply;
  readonly history?: SlackReply;
  readonly replies?: SlackReply;
}): SlackTraffic {
  const traffic: SlackTraffic = { requests: [], queries: [] };
  const handle = (reply: SlackReply | undefined) => {
    return async ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      traffic.requests.push({
        url: `${url.origin}${url.pathname}`,
        token: request.headers.get("authorization"),
      });
      traffic.queries.push(url.searchParams);
      const result = (await reply?.(url.searchParams, request)) ?? {
        ok: true,
        messages: [],
      };
      return result instanceof Response ? result : HttpResponse.json(result);
    };
  };
  server.use(
    http.get(SLACK_USER_CONVERSATIONS_URL, handle(script.channels)),
    http.get(SLACK_HISTORY_URL, handle(script.history)),
    http.get(SLACK_REPLIES_URL, handle(script.replies)),
  );
  return traffic;
}

interface ChannelSpec {
  readonly id: string;
  readonly name: string;
  readonly is_private?: boolean;
}

/** One page of the user/bot intersection, with an optional continuation. */
function channelPageBody(
  channels: readonly ChannelSpec[],
  nextCursor = "",
): unknown {
  return {
    ok: true,
    channels: channels.map((channel) => {
      return { is_private: false, ...channel };
    }),
    response_metadata: { next_cursor: nextCursor },
  };
}

function channelPage(
  channels: readonly ChannelSpec[],
  nextCursor = "",
): SlackReply {
  return () => {
    return channelPageBody(channels, nextCursor);
  };
}

function noMessages(): SlackReply {
  return () => {
    return { ok: true, messages: [] };
  };
}

/** A history page whose messages all sit inside the frozen window. */
function historyPage(
  messages: readonly {
    ts: string;
    text?: string;
    thread_ts?: string;
    reply_count?: number;
  }[],
  extra: { readonly has_more?: boolean; readonly next_cursor?: string } = {},
): SlackReply {
  return () => {
    return {
      ok: true,
      messages: messages.map((message) => {
        return { type: "message", user: "U1", text: "", ...message };
      }),
      ...(extra.has_more !== undefined && { has_more: extra.has_more }),
      ...(extra.next_cursor !== undefined && {
        response_metadata: { next_cursor: extra.next_cursor },
      }),
    };
  };
}

/**
 * Script one attempt whose reads succeed and whose final release proof then
 * meets a different live intersection.
 *
 * The switch is driven by the reads themselves: once every scripted history
 * page has answered, the only enumeration the algorithm has left is the release
 * proof. That reproduces a member losing access, or an intersection becoming
 * unlistable, while a response is already held — without counting calls from
 * outside or naming an internal step. `historyReads` states how many history
 * pages the script itself offers when that is not one per channel, so a read
 * phase bounded by its own request allowance still hands over cleanly.
 */
function scriptHeldRelease(script: {
  readonly channels: readonly ChannelSpec[];
  readonly history?: SlackReply;
  readonly historyReads?: number;
  readonly release: (page: number, request: Request) => unknown;
}): SlackTraffic {
  let reads = 0;
  let releasePages = 0;
  const discovery = channelPage(script.channels);
  const history = script.history ?? noMessages();
  const scriptedReads = script.historyReads ?? script.channels.length;
  return scriptSlack({
    channels: (query, request) => {
      if (reads < scriptedReads) {
        return discovery(query, request);
      }
      releasePages += 1;
      return script.release(releasePages, request);
    },
    history: (query, request) => {
      reads += 1;
      return history(query, request);
    },
  });
}

/** `count` distinct in-window timestamps, one second apart. */
function windowTimestamps(count: number, offsetSeconds = 60): string[] {
  return Array.from({ length: count }, (_value, index) => {
    return `${WINDOW_START_SECONDS + offsetSeconds + index}.000100`;
  });
}

/** The queries one Slack method received, in order. */
function queriesFor(traffic: SlackTraffic, url: string): URLSearchParams[] {
  return traffic.queries.filter((_query, index) => {
    return traffic.requests[index]?.url === url;
  });
}

function clipping(entry: { readonly textTruncated: boolean }): boolean {
  return entry.textTruncated;
}

/**
 * Script Slack so the first enumeration call parks until it is released.
 *
 * The attempt has already claimed its occurrence by the time that call is made,
 * so this is the live window a concurrent reclaim, revocation or lease expiry
 * has to be decided against.
 */
function scriptSuspendedSlack(messages: readonly unknown[] = []): {
  readonly arrived: Promise<void>;
  readonly release: () => void;
} {
  const arrived = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let suspended = false;
  server.use(
    http.get(SLACK_USER_CONVERSATIONS_URL, async () => {
      if (!suspended) {
        suspended = true;
        arrived.resolve();
        await released.promise;
      }
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C1", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      });
    }),
    http.get(SLACK_HISTORY_URL, () => {
      return HttpResponse.json({ ok: true, messages });
    }),
  );
  return {
    arrived: arrived.promise,
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
  };
}

describe("Morning Brief Slack collection preview", () => {
  it("claims, reads the exact shared scope, normalizes and finalizes one occurrence", async () => {
    const f = await fixture();
    const traffic = scriptSlack({
      channels: channelPage([
        { id: "C100", name: "general" },
        { id: "C200", name: "secrets", is_private: true },
      ]),
      history: (query) => {
        return query.get("channel") === "C100"
          ? {
              ok: true,
              messages: [
                {
                  type: "message",
                  ts: FIRST_IN_WINDOW,
                  user: "U1",
                  text: "boundary message",
                },
                {
                  type: "message",
                  ts: THREAD_ROOT,
                  user: "U2",
                  text: "root",
                  thread_ts: THREAD_ROOT,
                  reply_count: 2,
                },
                {
                  type: "message",
                  ts: LAST_BEFORE_WINDOW,
                  user: "U3",
                  text: "one microsecond too early",
                },
                {
                  type: "message",
                  ts: WINDOW_END_EXCLUSIVE,
                  user: "U4",
                  text: "exactly at the anchor",
                },
              ],
            }
          : { ok: true, messages: [] };
      },
      replies: () => {
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: THREAD_ROOT,
              user: "U2",
              text: "root",
              thread_ts: THREAD_ROOT,
            },
            {
              type: "message",
              ts: THREAD_REPLY,
              user: "U5",
              text: "reply",
              thread_ts: THREAD_ROOT,
            },
          ],
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    expect(response.body.occurrence).toStrictEqual({
      scheduledFor: ANCHOR,
      windowStart: new Date(WINDOW_START_MS).toISOString(),
      windowEnd: ANCHOR,
      timezone: "Asia/Shanghai",
      collectionKind: "slack",
      collectionVersion: 1,
      attempt: 1,
      status: "completed",
      outcome: "complete",
    });
    const { bundle } = response.body;
    expect(bundle.coverage).toBe("complete");
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.workspaceId).toBe(f.workspaceId);
    // The message on the window's opening microsecond is kept; the microsecond
    // before it and the message exactly at the exclusive end are not. The
    // thread parent both history and replies return appears once.
    expect(
      bundle.entries.map((entry) => {
        return { ts: entry.ts, text: entry.text, fromThread: entry.fromThread };
      }),
    ).toStrictEqual([
      { ts: FIRST_IN_WINDOW, text: "boundary message", fromThread: false },
      { ts: THREAD_ROOT, text: "root", fromThread: false },
      { ts: THREAD_REPLY, text: "reply", fromThread: true },
    ]);
    expect(bundle.entries.map(clipping)).toStrictEqual([false, false, false]);
    expect(bundle.counts).toStrictEqual({
      channels: 2,
      threads: 1,
      // Discovery, a live proof before each of the three protected reads, the
      // three reads themselves, and one final proof before release.
      requests: 8,
      messages: 3,
      textBytes: "boundary message".length + "root".length + "reply".length,
    });

    // Exactly the caller's own workspace, bot credential and connected user.
    for (const request of traffic.requests) {
      expect(request.token).toBe(`Bearer ${f.botToken}`);
    }
    // Every authorization lookup asks the same exact intersection question as
    // discovery, on the fixed set of allowed Slack methods.
    const enumerations = queriesFor(traffic, SLACK_USER_CONVERSATIONS_URL);
    expect(enumerations).toHaveLength(5);
    for (const query of enumerations) {
      expect(Object.fromEntries(query)).toStrictEqual({
        limit: "200",
        user: f.slackUserId,
        types: "public_channel,private_channel",
        exclude_archived: "true",
      });
    }
    expect(
      Object.fromEntries(queriesFor(traffic, SLACK_HISTORY_URL)[0] ?? []),
    ).toStrictEqual({
      channel: "C100",
      limit: "200",
      oldest: EXPECTED_OLDEST,
      latest: EXPECTED_LATEST,
    });
    expect(queriesFor(traffic, SLACK_REPLIES_URL)[0]?.get("ts")).toBe(
      THREAD_ROOT,
    );

    const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toHaveLength(0);
    expect(row).toMatchObject({
      status: "completed",
      outcome: "complete",
      attempt: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      membershipId: `orgmem_${f.orgId.slice(-8)}_${f.userId.slice(-8)}`,
      agentId: f.agentId,
      slackWorkspaceId: f.workspaceId,
      slackUserId: f.slackUserId,
      channelCount: 2,
      messageCount: 3,
      truncated: false,
    });
    // Nothing the collector read is recoverable from the stored row.
    expect(JSON.stringify(row)).not.toContain("boundary message");
    expect(JSON.stringify(row)).not.toContain(f.botToken);
  });

  it("reports having no shared channels separately from a quiet one", async () => {
    const f = await fixture();
    scriptSlack({ channels: channelPage([]) });
    const empty = await accept(collect(f), [200]);
    if (empty.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(empty.body.occurrence.outcome).toBe("no_shared_channels");
    expect(empty.body.bundle.coverage).toBe("empty");
    expect(empty.body.bundle.entries).toStrictEqual([]);

    const other = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "quiet" }]),
      history: noMessages(),
    });
    const quiet = await accept(collect(other), [200]);
    if (quiet.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(quiet.body.occurrence.outcome).toBe("complete");
    expect(quiet.body.bundle.coverage).toBe("empty");
  });

  it("treats a continuation without a usable cursor as truncation, not the end of a window", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: () => {
        return { ok: true, messages: [], has_more: true };
      },
    });
    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(response.body.bundle.coverage).toBe("partial");
    expect(response.body.bundle.channels[0]?.truncated).toBeTruthy();
  });

  it("stops a repeated enumeration cursor instead of looping or claiming completeness", async () => {
    const f = await fixture();
    const traffic = scriptSlack({
      // Every page hands back the same cursor, so an unbounded reader would
      // never stop. The page contents stay addressable by cursor, which keeps
      // the later authorization lookups answerable.
      channels: (query) => {
        return {
          ok: true,
          channels:
            query.get("cursor") === null
              ? [{ id: "C1", name: "c1", is_private: false }]
              : [{ id: "C2", name: "c2", is_private: false }],
          response_metadata: { next_cursor: "same" },
        };
      },
      history: noMessages(),
    });
    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(response.body.bundle.limits).toContain("cursor-anomaly");
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(
      response.body.bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1", "C2"]);
    // Two discovery pages, one lookup proving C1 and two proving C2, then the
    // two-page final proof that authorizes releasing both of them.
    expect(queriesFor(traffic, SLACK_USER_CONVERSATIONS_URL)).toHaveLength(7);
  });

  it("caps enumeration at the documented channel budget", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage(
        Array.from({ length: 25 }, (_value, index) => {
          return { id: `C${index}`, name: `channel-${index}` };
        }),
      ),
      history: noMessages(),
    });
    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(response.body.bundle.channels).toHaveLength(20);
    expect(response.body.bundle.limits).toContain("channels");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("excludes direct messages from the discovered scope", async () => {
    const f = await fixture();
    const traffic = scriptSlack({
      channels: channelPage([
        { id: "D999", name: "dm" },
        { id: "C1", name: "general" },
      ]),
      history: noMessages(),
    });
    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(
      response.body.bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1"]);
    expect(
      traffic.queries.some((query) => {
        return query.get("channel")?.startsWith("D") === true;
      }),
    ).toBeFalsy();
  });

  it.each([
    ["missing_scope", "permission_denied"],
    ["internal_error", "provider_failed"],
  ] as const)(
    "records a mid-stream %s as a failure rather than healthy empty data",
    async (code, outcome) => {
      const f = await fixture();
      scriptSlack({
        channels: channelPage([
          { id: "C1", name: "general" },
          { id: "C2", name: "other" },
        ]),
        history: (query) => {
          return query.get("channel") === "C1"
            ? { ok: true, messages: [] }
            : { ok: false, error: code };
        },
      });
      const response = await accept(collect(f), [200]);
      if (response.body.result !== "failed") {
        throw new Error(`Expected a failure, got ${response.body.result}`);
      }
      expect(response.body.failure.outcome).toBe(outcome);
      expect(response.body.occurrence.status).toBe("failed");
      const [row] = await readMorningBriefCollectionOccurrences(f);
      expect(row).toMatchObject({ status: "failed", outcome, attempt: 1 });
    },
  );

  it("honors Retry-After without sleeping and bounds the next explicit attempt", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    scriptSlack({
      channels: () => {
        return HttpResponse.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "30" } },
        );
      },
    });
    const limited = await accept(collect(f), [200]);
    if (limited.body.result !== "failed") {
      throw new Error("Expected a rate-limited failure");
    }
    expect(limited.body.failure).toStrictEqual({
      outcome: "rate_limited",
      retryAfterSeconds: 30,
    });

    const tooSoon = await accept(collect(f), [409]);
    expect(tooSoon.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_RETRY_PENDING",
    );

    mockNow(ANCHOR_MS + 30_000);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    const retried = await accept(collect(f), [200]);
    if (retried.body.result !== "collected") {
      throw new Error("Expected the bounded retry to collect");
    }
    expect(retried.body.occurrence.attempt).toBe(2);
  });

  it("returns an explicit already-completed result with no bundle and no provider call", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(f), [200]);

    const traffic = scriptSlack({});
    const duplicate = await accept(collect(f), [200]);
    expect(duplicate.body).toStrictEqual({
      result: "already-completed",
      occurrence: expect.objectContaining({ status: "completed", attempt: 1 }),
      bundle: null,
    });
    expect(traffic.requests).toStrictEqual([]);
  });

  it.each([
    [
      "its membership generation changed",
      async (f: Fixture) => {
        await store.set(
          seedOrgMembership$,
          {
            userId: f.userId,
            orgId: f.orgId,
            role: "admin",
            membershipId: `orgmem_rejoined_${randomUUID()}`,
          },
          context.signal,
        );
      },
    ],
    [
      "its installation moved to another Agent",
      async (f: Fixture) => {
        await repointMorningBriefInstallationAgent(f);
      },
    ],
    [
      "its native Slack binding changed",
      async (f: Fixture) => {
        await store.set(
          deleteSlackIntegrationFixture$,
          { orgId: f.orgId, slackWorkspaceId: f.workspaceId },
          context.signal,
        );
        const installation = await store.set(
          seedSlackOrgInstallation$,
          { orgId: f.orgId, botToken: `xoxb-test-${randomUUID()}` },
          context.signal,
        );
        await store.set(
          seedSlackOrgConnection$,
          {
            slackWorkspaceId: installation.slackWorkspaceId,
            userId: f.userId,
          },
          context.signal,
        );
      },
    ],
  ])(
    "refuses to reuse a completed occurrence once %s",
    async (_name, rebind) => {
      const f = await fixture();
      scriptSlack({
        channels: channelPage([{ id: "C1", name: "general" }]),
        history: noMessages(),
      });
      const collected = await accept(collect(f), [200]);
      expect(collected.body.result).toBe("collected");
      const [before] = await readMorningBriefCollectionOccurrences(f);

      await rebind(f);
      const traffic = scriptSlack({});
      const rejected = await accept(collect(f), [409]);
      expect(rejected.body.error.code).toBe(
        "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
      );
      // The terminal metadata of the old binding is neither reused nor
      // replaced, and nothing new is read or recorded under it.
      expect(traffic.requests).toStrictEqual([]);
      const [after, ...extra] = await readMorningBriefCollectionOccurrences(f);
      expect(extra).toHaveLength(0);
      expect(after).toStrictEqual(before);
    },
  );

  it("admits a single claimant when two invocations race the same occurrence", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    const held = await holdMorningBriefCollectionClaim(f, context.signal);
    const first = collect(f);
    const claimant = await held.waitForArrival();
    const second = collect(f);
    // Prove the second invocation really arrived and queued behind the first
    // uncommitted insert, instead of assuming an ordering.
    await waitForDeferredBlocker(claimant);
    await held.release();

    const [a, b] = await Promise.all([
      accept(first, [200]),
      accept(second, [409]),
    ]);
    expect(a.body.result).toBe("collected");
    expect(b.body.error.code).toBe("MORNING_BRIEF_COLLECTION_IN_PROGRESS");
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toHaveLength(1);
  });

  it("lets a newer claimant take an exactly expired lease and discards the old attempt's bundle", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const suspended = scriptSuspendedSlack();
    const stale = collect(f);
    await suspended.arrived;

    // The lease is already expired at its own deadline, so the next explicit
    // invocation may reclaim at exactly that instant.
    mockNow(ANCHOR_MS + 60_000);
    const newer = await accept(collect(f), [200]);
    if (newer.body.result !== "collected") {
      throw new Error("Expected the newer claimant to collect");
    }
    expect(newer.body.occurrence.attempt).toBe(2);

    suspended.release();
    const discarded = await accept(stale, [409]);
    expect(discarded.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_CLAIM_LOST",
    );
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ attempt: 2, status: "completed" });
  });

  it("refuses a completion whose lease expires while it waits for the occurrence row", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const suspended = scriptSuspendedSlack();
    const stale = collect(f);
    await suspended.arrived;

    // The claim is committed, so taking its row is the same wait the guarded
    // completion has to queue behind.
    const held = await holdMorningBriefCollectionOccurrence(f, context.signal);
    suspended.release();
    await held.waitForArrival();
    // Exactly the lease deadline, reached while the transition was blocked. A
    // timestamp sampled before that wait would still admit this completion.
    mockNow(ANCHOR_MS + 60_000);
    await held.release();

    const lost = await accept(stale, [409]);
    expect(lost.body.error.code).toBe("MORNING_BRIEF_COLLECTION_CLAIM_LOST");
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect(row?.leaseToken).not.toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.outcome).toBeNull();

    // A sibling whose own lease is intact is unaffected by that boundary.
    const sibling = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    const collected = await accept(collect(sibling), [200]);
    expect(collected.body.result).toBe("collected");
  });

  it("reclaims an occurrence whose lease expires while the reclaim waits for its row", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const suspended = scriptSuspendedSlack();
    const stale = collect(f);
    await suspended.arrived;

    const held = await holdMorningBriefCollectionOccurrence(f, context.signal);
    const reclaim = collect(f);
    // Prove the reclaim really queued on that row before the clock moves.
    await held.waitForArrival();
    mockNow(ANCHOR_MS + 60_000);
    await held.release();

    const newer = await accept(reclaim, [200]);
    if (newer.body.result !== "collected") {
      throw new Error(
        `Expected the reclaim to collect, got ${newer.body.result}`,
      );
    }
    expect(newer.body.occurrence.attempt).toBe(2);

    suspended.release();
    const discarded = await accept(stale, [409]);
    expect(discarded.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_CLAIM_LOST",
    );
    const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toHaveLength(0);
    expect(row).toMatchObject({ attempt: 2, status: "completed" });
  });

  /**
   * A failed first attempt at the anchor, leaving a claimable occurrence whose
   * lifetime started exactly there.
   *
   * The lifetime is a day, so the operator's own credential has to outlive the
   * clock move rather than expire with it.
   */
  async function agedOccurrence(): Promise<{
    readonly fixture: Fixture;
    readonly aged: Pick<Fixture, "headers">;
  }> {
    const f = await fixture();
    const aged = {
      headers: agentToken(f.userId, f.orgId, ["slack:read"], 48 * 3600),
    };
    mockNow(ANCHOR_MS);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: () => {
        return { ok: false, error: "internal_error" };
      },
    });
    await accept(collect(aged), [200]);
    return { fixture: f, aged };
  }

  it("stops an occurrence at exactly its lifetime deadline before any provider call", async () => {
    const { fixture: f, aged } = await agedOccurrence();
    const [before] = await readMorningBriefCollectionOccurrences(f);

    // Equality with the lifetime deadline is already expired, the same rule the
    // lease boundary uses. One millisecond later is not the boundary.
    mockNow(ANCHOR_MS + 24 * 60 * 60 * 1000);
    const traffic = scriptSlack({});
    const expired = await accept(collect(aged), [409]);
    expect(expired.body.error.code).toBe("MORNING_BRIEF_COLLECTION_EXPIRED");
    expect(traffic.requests).toStrictEqual([]);
    const [after, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toHaveLength(0);
    expect(after).toStrictEqual(before);
  });

  it("expires an occurrence whose lifetime elapses while a reclaim waits for its row", async () => {
    const { fixture: f, aged } = await agedOccurrence();

    // One millisecond inside the lifetime when the reclaim starts.
    mockNow(ANCHOR_MS + 24 * 60 * 60 * 1000 - 1);
    const held = await holdMorningBriefCollectionOccurrence(f, context.signal);
    const traffic = scriptSlack({});
    const reclaim = collect(aged);
    await held.waitForArrival();
    // The deadline is reached while the reclaim is blocked on that row, so only
    // a clock read after the wait can refuse it.
    mockNow(ANCHOR_MS + 24 * 60 * 60 * 1000);
    await held.release();

    const expired = await accept(reclaim, [409]);
    expect(expired.body.error.code).toBe("MORNING_BRIEF_COLLECTION_EXPIRED");
    expect(traffic.requests).toStrictEqual([]);
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ attempt: 1, status: "failed" });
  });

  it("refuses a retry whose membership generation changed", async () => {
    const f = await fixture({ membershipId: "orgmem_first" });
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: () => {
        return { ok: false, error: "internal_error" };
      },
    });
    await accept(collect(f), [200]);

    await store.set(
      seedOrgMembership$,
      {
        userId: f.userId,
        orgId: f.orgId,
        role: "admin",
        membershipId: "orgmem_rejoined",
      },
      context.signal,
    );
    const rejoined = await accept(collect(f), [409]);
    expect(rejoined.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    );
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ membershipId: "orgmem_first", attempt: 1 });
  });

  it("stops an occurrence after its attempt budget", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: () => {
        return { ok: false, error: "internal_error" };
      },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await accept(collect(f), [200]);
      if (failed.body.result !== "failed") {
        throw new Error("Expected each bounded attempt to fail");
      }
      expect(failed.body.occurrence.attempt).toBe(attempt);
    }
    const exhausted = await accept(collect(f), [409]);
    expect(exhausted.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_ATTEMPTS_EXHAUSTED",
    );
    const [row] = await readMorningBriefCollectionOccurrences(f);
    expect(row).toMatchObject({ attempt: 3, status: "failed" });
  });

  it.each([
    ["a future anchor", 10 * 60_000],
    ["an anchor older than the supported window", -8 * 24 * 60 * 60 * 1000],
  ])("rejects %s before claiming anything", async (_name, offset) => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const traffic = scriptSlack({});
    const rejected = await accept(
      collect(f, new Date(ANCHOR_MS + offset).toISOString()),
      [400],
    );
    expect(rejected.body.error.code).toBe("BAD_REQUEST");
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });
});

describe("Morning Brief Slack collection admission", () => {
  it("is unavailable in production even with the collector switch on", async () => {
    const f = await fixture();
    mockEnv("ENV", "production");
    const traffic = scriptSlack({});
    const denied = await accept(collect(f), [404]);
    expect(denied.body).toBe("Not found");
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });

  it("answers a protected preview deployment only with the bypass secret", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const missingHeader = await accept(collect(f), [404]);
    expect(missingHeader.body).toBe("Not found");
    const wrongHeader = await accept(
      collectWithHeaders(f, { "x-vercel-protection-bypass": "wrong-secret" }),
      [404],
    );
    expect(wrongHeader.body).toBe("Not found");
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);

    const bypassed = await accept(
      collectWithHeaders(f, { "x-vercel-protection-bypass": "preview-secret" }),
      [200],
    );
    expect(bypassed.body.result).toBe("collected");
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toHaveLength(1);
  });

  it("rejects an unauthenticated caller before any collection", async () => {
    const f = await fixture();
    const traffic = scriptSlack({});
    await accept(
      collectionClient().collect({
        headers: { authorization: "" },
        body: { scheduledFor: ANCHOR },
      }),
      [401],
    );
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });

  it.each([
    ["the collector switch is off", { feature: false }, "feature-disabled"],
    ["the brief is paused", { enabled: false }, "brief-paused"],
    ["the member has no timezone", { timezone: null }, "missing-timezone"],
    ["Slack is not installed", { installed: false }, "slack-not-installed"],
    [
      "the member's Slack account is not connected",
      { connected: false },
      "slack-not-connected",
    ],
    [
      "the installation Agent is private to somebody else",
      { agentVisibility: "private" as const, agentOwner: "user_other" },
      "missing-agent",
    ],
  ])("does not execute when %s", async (_name, options, reason) => {
    const f = await fixture(options);
    const traffic = scriptSlack({});
    const response = await accept(collect(f), [200]);
    expect(response.body).toStrictEqual({ result: "not-executed", reason });
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });

  it("does not execute once the brief is paused between invocations", async () => {
    const f = await fixture();
    await pauseMorningBriefAutomation(f.automationId);
    const traffic = scriptSlack({});
    const response = await accept(collect(f), [200]);
    expect(response.body).toStrictEqual({
      result: "not-executed",
      reason: "brief-paused",
    });
    expect(traffic.requests).toStrictEqual([]);
  });

  it("rejects a credential without the native Slack read capability", async () => {
    const f = await fixture({ capabilities: ["chat-thread:read"] });
    const traffic = scriptSlack({});
    await accept(collect(f), [403]);
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });

  it("only ever collects for the credential's own owner", async () => {
    const owner = await fixture();
    const outsider = await fixture();
    const traffic = scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(outsider), [200]);
    await expect(
      readMorningBriefCollectionOccurrences(owner),
    ).resolves.toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(outsider),
    ).resolves.toHaveLength(1);
    expect(
      traffic.requests.every((request) => {
        return request.token === `Bearer ${outsider.botToken}`;
      }),
    ).toBeTruthy();
  });
});

describe("Morning Brief collection ownership lifetime", () => {
  function removeMembership(f: Fixture) {
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `membership-${randomUUID()}`,
        organization_id: f.orgId,
        user_id: f.userId,
      },
    });
    return webhooks.requestClerkWebhook("{}", {}, [200]);
  }

  function deleteClerkSubject(type: string, f: Fixture) {
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type,
      data: { id: type === "user.deleted" ? f.userId : f.orgId },
    });
    return webhooks.requestClerkWebhook("{}", {}, [200]);
  }

  it("refuses a claim whose membership answer predates revocation, before the parent is deleted", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(survivor), [200]);

    // A positive exact-member answer is resolved and then held, so the claim
    // that resumes below is genuinely one admitted before revocation.
    const lookup = holdMorningBriefMembershipLookup(f, context.signal);
    const traffic = scriptSlack({});
    const request = collect(f);
    await lookup.waitForArrival();

    const remainder = await holdCleanupAfterRevocation(f, context.signal);
    await removeMembership(f);
    // Arrival here means the cleanup's first transaction has committed and the
    // rest of it is parked, so the durable member row still exists.
    await remainder.waitForArrival();
    await expect(readMorningBriefCollectionOwnerRow(f)).resolves.toMatchObject({
      timezone: "Asia/Shanghai",
      revokedAt: expect.any(Date),
    });

    lookup.release();
    const refused = await accept(request, [409]);
    expect(refused.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    );
    // Revocation had no occurrence to delete, yet nothing was inserted after
    // it, and no source request was made on the revoked claim.
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);

    await remainder.release();
    await flushWaitUntilForTest();
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
    await expect(
      readMorningBriefCollectionOwnerRow(survivor),
    ).resolves.toMatchObject({ revokedAt: null });
  });

  it("refuses a claim admitted under a membership generation that was deleted before a rejoin", async () => {
    const f = await fixture({ membershipId: "orgmem_first" });
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(survivor), [200]);

    // The first generation's positive answer is resolved and then held, before
    // anything is claimed.
    const lookup = holdMorningBriefMembershipLookup(f, context.signal);
    const traffic = scriptSlack({});
    const stale = collect(f);
    await lookup.waitForArrival();

    // Real membership cleanup runs to completion, so the durable parent and
    // everything hanging from it are gone rather than merely stamped.
    await removeMembership(f);
    await flushWaitUntilForTest();
    await expect(
      readMorningBriefCollectionOwnerRow(f),
    ).resolves.toBeUndefined();

    // A legitimate rejoin: a new membership generation, preferences restored
    // through the production endpoint, and the native Slack account
    // reconnected. That recreated parent carries no revocation stamp.
    await store.set(
      seedOrgMembership$,
      {
        userId: f.userId,
        orgId: f.orgId,
        role: "admin",
        membershipId: "orgmem_rejoined",
      },
      context.signal,
    );
    await accept(
      preferencesClient().update({
        headers: memberSessionHeaders(f),
        body: { timezone: "Asia/Shanghai" },
      }),
      [200],
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: f.workspaceId,
        userId: f.userId,
        slackUserId: f.slackUserId,
      },
      context.signal,
    );

    lookup.release();
    const refused = await accept(stale, [409]);
    expect(refused.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    );
    // The deleted generation reaches no source and leaves nothing behind.
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);

    // So the rejoined member owns the same anchor rather than colliding with a
    // stale attempt admitted under the generation they replaced.
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    const rejoined = await accept(collect(f), [200]);
    expect(rejoined.body.result).toBe("collected");
    const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toHaveLength(0);
    expect(row).toMatchObject({
      membershipId: "orgmem_rejoined",
      attempt: 1,
      status: "completed",
    });
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });

  it("revokes a committed occurrence inside the cleanup's first transaction", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(survivor), [200]);

    const held = await holdMorningBriefCollectionClaim(f, context.signal);
    const request = collect(f);
    const claimant = await held.waitForArrival();

    const remainder = await holdCleanupAfterRevocation(f, context.signal);
    await removeMembership(f);
    // The revoking transaction has to queue behind the uncommitted claim's
    // FOR KEY SHARE, which is what closes the opposite commit order.
    await waitForDeferredBlocker(claimant);
    await held.release();

    const revoked = await accept(request, [409]);
    expect(revoked.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    );
    await remainder.waitForArrival();
    // The occurrence is already gone while its durable parent still exists, so
    // this is the revoking transaction rather than the eventual cascade.
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(readMorningBriefCollectionOwnerRow(f)).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });

    await remainder.release();
    await flushWaitUntilForTest();
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });

  it.each(["user.deleted", "organization.deleted"])(
    "revokes collection ownership in the first transaction of %s",
    async (type) => {
      const f = await fixture();
      const survivor = await fixture();
      scriptSlack({
        channels: channelPage([{ id: "C1", name: "general" }]),
        history: noMessages(),
      });
      await accept(collect(f), [200]);
      await accept(collect(survivor), [200]);

      const remainder = await holdCleanupAfterRevocation(f, context.signal);
      await deleteClerkSubject(type, f);
      await remainder.waitForArrival();
      // Both deletions revoke inside the run-cancellation transaction they
      // already commit, so the occurrence is gone and the refusal is durable
      // long before the member row it hangs from is removed.
      await expect(
        readMorningBriefCollectionOccurrences(f),
      ).resolves.toStrictEqual([]);
      await expect(
        readMorningBriefCollectionOwnerRow(f),
      ).resolves.toMatchObject({ revokedAt: expect.any(Date) });

      // What a caller actually observes: the owner is refused and no source is
      // read, while the rest of the deletion has still not run.
      const traffic = scriptSlack({});
      const refused = await accept(collect(f), [409]);
      expect(refused.body.error.code).toBe(
        "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
      );
      expect(traffic.requests).toStrictEqual([]);

      await remainder.release();
      await flushWaitUntilForTest();
      await expect(
        readMorningBriefCollectionOccurrences(survivor),
      ).resolves.toHaveLength(1);
    },
  );

  it("cascades a claim that commits before membership cleanup", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(survivor), [200]);

    const held = await holdMorningBriefCollectionClaim(f, context.signal);
    const request = collect(f);
    const claimant = await held.waitForArrival();

    await removeMembership(f);
    // The cleanup's member-row removal has to queue behind the uncommitted
    // claim's FOR KEY SHARE, which is what makes the cascade unavoidable.
    await waitForDeferredBlocker(claimant);
    await held.release();
    await accept(request, [200, 409]);
    await flushWaitUntilForTest();

    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });

  it("never claims after membership cleanup commits, even while the external lookup still answers", async () => {
    const f = await fixture();
    await removeMembership(f);
    await flushWaitUntilForTest();

    // The Clerk fixture deliberately still reports this membership. The durable
    // member row the occurrence hangs from is the same row that supplies the
    // timezone an enabled brief requires, so a committed cleanup is visible to
    // admission and to the claim fence alike.
    const traffic = scriptSlack({});
    const refused = await accept(collect(f), [200]);
    expect(refused.body).toStrictEqual({
      result: "not-executed",
      reason: "missing-timezone",
    });
    expect(traffic.requests).toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
  });

  it("discards a bundle when cleanup wins before finalization", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(survivor), [200]);

    const suspended = scriptSuspendedSlack([
      {
        type: "message",
        ts: FIRST_IN_WINDOW,
        user: "U1",
        text: "collected before revocation",
      },
    ]);
    const request = collect(f);
    await suspended.arrived;

    await removeMembership(f);
    await flushWaitUntilForTest();
    suspended.release();

    const revoked = await accept(request, [409]);
    expect(revoked.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    );
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });

  it("removes a completed occurrence when cleanup runs after it", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(f), [200]);
    await accept(collect(survivor), [200]);

    await removeMembership(f);
    await flushWaitUntilForTest();

    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });

  it("invalidates an owned occurrence when its Agent is deleted", async () => {
    const f = await fixture();
    const survivor = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    await accept(collect(f), [200]);
    await accept(collect(survivor), [200]);

    await deleteMorningBriefAgent(f.agentId);
    await expect(
      readMorningBriefCollectionOccurrences(f),
    ).resolves.toStrictEqual([]);
    await expect(
      readMorningBriefCollectionOccurrences(survivor),
    ).resolves.toHaveLength(1);
  });
});

/**
 * The final admission a completion is accepted by, after its own lock waits.
 *
 * Every case here suspends one attempt on the committed occurrence row — the
 * real `FOR UPDATE` wait finalization queues on — and changes the world while
 * it is blocked there. Comparing the persisted occurrence with the frozen
 * admission cannot answer any of them: both copies are frozen and still agree.
 */
describe("Morning Brief collection completion admission", () => {
  /**
   * Suspend one attempt exactly where its completion waits for its own row.
   *
   * The claim is already committed when the Slack script parks, so the row
   * really exists and holding it is the wait the guarded update queues behind.
   * `pg_blocking_pids` proves the arrival; nothing here sleeps.
   */
  async function heldCompletion(
    f: Fixture,
    controller?: AbortController,
  ): Promise<{
    readonly pending: ReturnType<typeof collect>;
    readonly release: () => Promise<void>;
  }> {
    const suspended = scriptSuspendedSlack();
    const pending = setupApp({
      context,
      routes: morningBriefCollectionPreviewRoutes,
      ...(controller && { signal: controller.signal, rethrowErrors: true }),
    })(morningBriefCollectionPreviewContract).collect({
      headers: f.headers,
      body: { scheduledFor: ANCHOR },
    });
    await suspended.arrived;
    const held = await holdMorningBriefCollectionOccurrence(f, context.signal);
    suspended.release();
    await held.waitForArrival();
    return { pending, release: held.release };
  }

  /** Enable the Settings surface a member changes their own brief through. */
  async function enableSettingsSurface(f: Fixture): Promise<void> {
    await updateFeatureSwitchesForUser(
      context,
      { orgId: f.orgId, userId: f.userId },
      {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.SimpleMorningBrief]: true,
      },
    );
  }

  /**
   * Pause the brief the way its owner does, through the production endpoint.
   *
   * `PUT /api/morning-brief/preference` is the writer for the canonical enabled
   * choice, so this lands the same committed transaction a real Settings
   * disable does rather than a fixture write against the schedule row.
   */
  async function disableBriefThroughSettings(f: Fixture): Promise<void> {
    const disabled = await accept(
      setupApp({ context, routes: morningBriefPreferenceRoutes })(
        morningBriefPreferenceContract,
      ).update({
        headers: memberSessionHeaders(f),
        body: { enabled: false },
      }),
      [200],
    );
    expect(disabled.body).toMatchObject({ enabled: false, status: "paused" });
  }

  it("commits no completion when the caller cancels while it waits for its row", async () => {
    const f = await fixture();
    const cancellation = new Error(`cancelled ${randomUUID()}`);
    const controller = new AbortController();
    const held = await heldCompletion(f, controller);

    // The caller goes away only once the completion is genuinely blocked on the
    // row, which is the window a check after the commit reaches too late.
    controller.abort(cancellation);
    await held.release();
    await expect(held.pending).rejects.toThrow(cancellation.message);

    const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
    expect(extra).toStrictEqual([]);
    expect(row).toMatchObject({ status: "running", attempt: 1 });
    expect(row?.outcome).toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.leaseToken).not.toBeNull();
    // Nothing completed, so the occurrence is still this attempt's: the next
    // explicit invocation is refused as in progress without reaching Slack.
    const traffic = scriptSlack({});
    const retried = await accept(collect(f), [409]);
    expect(retried.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_IN_PROGRESS",
    );
    expect(traffic.requests).toStrictEqual([]);
  });

  it.each([
    [
      "its owner disables the brief in Settings",
      async (f: Fixture) => {
        await disableBriefThroughSettings(f);
      },
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    ],
    [
      "the installation moves onto another Agent",
      async (f: Fixture) => {
        await repointMorningBriefInstallationAgent(f);
      },
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    ],
    [
      "the installation Agent stops being reachable",
      async (f: Fixture) => {
        await restrictMorningBriefAgent(f.agentId);
      },
      "MORNING_BRIEF_COLLECTION_OWNER_REVOKED",
    ],
    [
      "the connected Slack account is rebound",
      async (f: Fixture) => {
        await rebindMorningBriefSlackAccount(
          f.userId,
          `U${randomUUID().slice(0, 8)}`,
        );
      },
      "MORNING_BRIEF_COLLECTION_BINDING_CHANGED",
    ],
  ])(
    "releases no bundle when %s while the completion waits for its row",
    async (_label, mutate, expectedCode) => {
      const f = await fixture();
      await enableSettingsSurface(f);
      const held = await heldCompletion(f);

      // The change commits while the completion is blocked, so only a local
      // re-resolution taken after that wait can refuse it.
      await mutate(f);
      await held.release();

      const refused = await accept(held.pending, [409]);
      expect(refused.body.error.code).toBe(expectedCode);
      const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
      expect(extra).toStrictEqual([]);
      expect(row).toMatchObject({ status: "running", attempt: 1 });
      expect(row?.outcome).toBeNull();
      expect(row?.finishedAt).toBeNull();
    },
  );

  it("completes an unchanged attempt and leaves another owner's brief alone", async () => {
    const f = await fixture();
    const other = await fixture();
    await enableSettingsSurface(f);
    const held = await heldCompletion(f);

    // The positive control: the same suspended wait, with nothing changing
    // underneath it, still accepts the bundle it collected.
    await held.release();
    const collected = await accept(held.pending, [200]);
    if (collected.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${collected.body.result}`,
      );
    }
    expect(collected.body.occurrence).toMatchObject({
      status: "completed",
      attempt: 1,
    });

    // Another owner is unaffected by this owner's suspended completion.
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: noMessages(),
    });
    const unrelated = await accept(collect(other), [200]);
    expect(unrelated.body.result).toBe("collected");
    const [survivor] = await readMorningBriefCollectionOccurrences(other);
    expect(survivor).toMatchObject({ status: "completed", attempt: 1 });
  });
});

describe("Morning Brief Slack live shared scope", () => {
  it("stops reading a channel the member left after discovery", async () => {
    const f = await fixture();
    let discovered = false;
    const traffic = scriptSlack({
      channels: () => {
        const shared = discovered
          ? [{ id: "C1", name: "general", is_private: false }]
          : [
              { id: "C1", name: "general", is_private: false },
              { id: "C2", name: "left", is_private: false },
            ];
        discovered = true;
        return { ok: true, channels: shared, response_metadata: {} };
      },
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "still shared" }]),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    // The bot alone can still see C2; the connected member no longer can, so
    // no protected page is read for it.
    expect(
      traffic.queries.some((query) => {
        return query.get("channel") === "C2";
      }),
    ).toBeFalsy();
    expect(
      bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1"]);
    expect(bundle.limits).toContain("scope-lost");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(
      bundle.entries.map((entry) => {
        return entry.text;
      }),
    ).toStrictEqual(["still shared"]);

    // Every extra authorization call stays on the exact org bot, connected
    // member, workspace scope and allowed Slack methods.
    for (const request of traffic.requests) {
      expect(request.token).toBe(`Bearer ${f.botToken}`);
      expect([
        SLACK_USER_CONVERSATIONS_URL,
        SLACK_HISTORY_URL,
        SLACK_REPLIES_URL,
      ]).toContain(request.url);
    }
    for (const [index, request] of traffic.requests.entries()) {
      if (request.url !== SLACK_USER_CONVERSATIONS_URL) {
        continue;
      }
      const query = traffic.queries[index];
      expect(query?.get("user")).toBe(f.slackUserId);
      expect(query?.get("types")).toBe("public_channel,private_channel");
      expect(query?.get("exclude_archived")).toBe("true");
    }
  });

  it("does not release a held response after the shared scope is lost", async () => {
    const f = await fixture();
    const survivor = await fixture();
    const held = createDeferredPromise<void>(context.signal);
    const arrived = createDeferredPromise<void>(context.signal);
    let lost = false;
    let holding = false;
    scriptSlack({
      channels: () => {
        return {
          ok: true,
          channels: lost
            ? []
            : [{ id: "C1", name: "general", is_private: false }],
          response_metadata: {},
        };
      },
      history: () => {
        return { ok: true, messages: [] };
      },
    });
    server.use(
      http.get(SLACK_HISTORY_URL, async () => {
        if (!holding) {
          holding = true;
          arrived.resolve();
          await held.promise;
        }
        return HttpResponse.json({
          ok: true,
          messages: [
            { type: "message", ts: FIRST_IN_WINDOW, user: "U1", text: "held" },
          ],
        });
      }),
    );

    const request = collect(f);
    await arrived.promise;
    // The member loses the channel while its history response is still held.
    lost = true;
    held.resolve();

    const response = await accept(request, [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("held");
    expect(bundle.entries).toStrictEqual([]);
    expect(bundle.channels).toStrictEqual([]);
    expect(bundle.limits).toContain("scope-lost");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");

    // An owner whose scope never moved still collects normally.
    lost = false;
    holding = true;
    const unaffected = await accept(collect(survivor), [200]);
    if (unaffected.body.result !== "collected") {
      throw new Error("Expected the unaffected owner to collect");
    }
    expect(unaffected.body.bundle.coverage).toBe("complete");
    expect(unaffected.body.bundle.limits).toStrictEqual([]);
  });

  it("fails closed when a bounded authorization lookup proves nothing", async () => {
    const f = await fixture();
    let page = 0;
    const traffic = scriptSlack({
      channels: () => {
        page += 1;
        return page === 1
          ? {
              ok: true,
              channels: [{ id: "C1", name: "general", is_private: false }],
              response_metadata: {},
            }
          : {
              // The member's conversation list keeps advancing without ever
              // naming C1, so no page proves membership either way.
              ok: true,
              channels: [
                { id: `C${page}0`, name: `other-${page}`, is_private: false },
              ],
              response_metadata: { next_cursor: `cursor-${page}` },
            };
      },
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unreachable" }]),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(
      traffic.requests.some((request) => {
        return request.url === SLACK_HISTORY_URL;
      }),
    ).toBeFalsy();
    expect(bundle.limits).toContain("scope-unproven");
    // An unavailable proof is neither an allow nor a healthy empty day.
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(bundle.entries).toStrictEqual([]);
  });
});

describe("Morning Brief Slack final release proof", () => {
  /** Nothing a bundle names may reach the caller without a fresh live proof. */
  function expectNothingReleased(bundle: {
    readonly entries: readonly unknown[];
    readonly channels: readonly unknown[];
    readonly counts: { readonly channels: number; readonly messages: number };
  }): void {
    expect(bundle.entries).toStrictEqual([]);
    expect(bundle.channels).toStrictEqual([]);
    expect(bundle.counts.channels).toBe(0);
    expect(bundle.counts.messages).toBe(0);
  }

  it("withholds content a repeated final cursor cannot confirm", async () => {
    const f = await fixture();
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [{ id: "C1", name: "general" }],
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unconfirmed" }]),
      release: (page) => {
        releasePages = page;
        // The pass keeps answering with somebody else's conversation behind the
        // same cursor, so it never names C1 and never advances.
        return {
          ok: true,
          channels: [{ id: "C900", name: "elsewhere", is_private: false }],
          response_metadata: { next_cursor: "same" },
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("unconfirmed");
    expect(JSON.stringify(bundle)).not.toContain("general");
    expectNothingReleased(bundle);
    expect(bundle.counts.textBytes).toBe(0);
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    // The repeated cursor ends the one bounded pass; nothing tries again to
    // manufacture a confirmation, and no protected page follows it.
    expect(releasePages).toBe(2);
    expect(bundle.counts.requests).toBeLessThanOrEqual(40);
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("withholds content three incomplete final pages cannot confirm", async () => {
    const f = await fixture();
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [{ id: "C1", name: "general" }],
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unconfirmed" }]),
      release: (page) => {
        releasePages = page;
        // Each page advances honestly and still never reaches C1.
        return channelPageBody(
          [{ id: `C90${page}`, name: `other-${page}` }],
          `cursor-${page}`,
        );
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("unconfirmed");
    expectNothingReleased(bundle);
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    // The proof obeys the same three-page enumeration budget as discovery.
    expect(releasePages).toBe(3);
    expect(bundle.counts.requests).toBeLessThanOrEqual(40);
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("withholds content the wall clock leaves unprovable", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [{ id: "C1", name: "general" }],
      history: () => {
        // The attempt's 30 second wall clock passes while this page is read.
        mockNow(ANCHOR_MS + 31_000);
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: FIRST_IN_WINDOW,
              user: "U1",
              text: "unconfirmed",
            },
          ],
        };
      },
      release: (page) => {
        releasePages = page;
        return channelPageBody([{ id: "C1", name: "general" }]);
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("unconfirmed");
    expectNothingReleased(bundle);
    expect(bundle.limits).toContain("deadline");
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    // An expired attempt may not buy the proof its wall clock no longer covers,
    // and it does not start one anyway.
    expect(releasePages).toBe(0);
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
  });

  it("withholds content when the final proof lands after the deadline", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [{ id: "C1", name: "general" }],
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unconfirmed" }]),
      release: (page) => {
        releasePages = page;
        // The request started in time; its answer arrives after the attempt's
        // own wall clock, so it is no longer a current proof.
        mockNow(ANCHOR_MS + 31_000);
        return channelPageBody([{ id: "C1", name: "general" }]);
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("unconfirmed");
    expectNothingReleased(bundle);
    expect(bundle.limits).toContain("deadline");
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    // One held answer, and no second attempt to turn it into a success.
    expect(releasePages).toBe(1);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it.each([
    [
      "the message cap",
      "messages" as const,
      windowTimestamps(501).map((ts) => {
        return { ts, text: "m" };
      }),
    ],
    [
      "the total text cap",
      "text-bytes" as const,
      windowTimestamps(33).map((ts) => {
        return { ts, text: "x".repeat(4 * 1024) };
      }),
    ],
  ])(
    "does not let %s waive the final proof",
    async (_name, limit, messages) => {
      const f = await fixture();
      let releasePages = 0;
      const traffic = scriptHeldRelease({
        channels: [{ id: "C1", name: "general" }],
        history: historyPage(messages),
        release: (page) => {
          releasePages = page;
          // The member's whole intersection is listed without C1, which proves
          // the removal the held content was collected under.
          return channelPageBody([]);
        },
      });

      const response = await accept(collect(f), [200]);
      if (response.body.result !== "collected") {
        throw new Error(
          `Expected a collected bundle, got ${response.body.result}`,
        );
      }
      const { bundle } = response.body;
      expectNothingReleased(bundle);
      expect(bundle.counts.textBytes).toBe(0);
      expect(bundle.limits).toContain(limit);
      expect(bundle.limits).toContain("scope-lost");
      expect(bundle.coverage).toBe("partial");
      expect(response.body.occurrence.outcome).toBe("partial");
      // A content cap stops reading without spending the request allowance the
      // proof still needs, so exactly one bounded proof ran.
      expect(releasePages).toBe(1);
      expect(bundle.counts.requests).toBeLessThanOrEqual(40);
      expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
    },
  );

  it("proves an empty private channel before naming it", async () => {
    const f = await fixture();
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [{ id: "C200", name: "secrets", is_private: true }],
      release: (page) => {
        releasePages = page;
        return channelPageBody([]);
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    // A quiet conversation carries no message, but its name, id and link are
    // still the member's scope, so they need the same live proof.
    expect(JSON.stringify(bundle)).not.toContain("secrets");
    expect(JSON.stringify(bundle)).not.toContain("C200");
    expectNothingReleased(bundle);
    expect(bundle.limits).toContain("scope-lost");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(releasePages).toBe(1);
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
  });

  it("releases only the channels a partial final enumeration confirmed", async () => {
    const f = await fixture();
    let releasePages = 0;
    scriptHeldRelease({
      channels: [
        { id: "C1", name: "general" },
        { id: "C200", name: "secrets", is_private: true },
      ],
      history: (query, request) => {
        const channel = query.get("channel") ?? "";
        return historyPage([
          { ts: FIRST_IN_WINDOW, text: `message in ${channel}` },
        ])(query, request);
      },
      release: (page) => {
        releasePages = page;
        // The first page confirms C1 and promises more; the continuation then
        // repeats itself, so C200 is never resolved either way.
        return {
          ok: true,
          channels:
            page === 1
              ? [{ id: "C1", name: "general", is_private: false }]
              : [],
          response_metadata: { next_cursor: "same" },
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(JSON.stringify(bundle)).not.toContain("secrets");
    expect(JSON.stringify(bundle)).not.toContain("C200");
    expect(
      bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1"]);
    // The confirmed sibling keeps exactly the content its own proof covered.
    expect(
      bundle.entries.map((entry) => {
        return entry.text;
      }),
    ).toStrictEqual(["message in C1"]);
    expect(bundle.counts).toMatchObject({ channels: 1, messages: 1 });
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.limits).not.toContain("scope-lost");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    expect(releasePages).toBe(2);
  });

  /**
   * Two channels, read normally, whose final proof needs a continuation.
   *
   * The first page proves C100 and leaves it with nothing pending of its own.
   * The second page is genuinely held: the test observes its arrival, moves the
   * attempt's own clock, and only then lets Slack answer — so what the release
   * decision does with an earlier proof is the only thing under test.
   */
  function scriptHeldContinuation(barrier: {
    readonly arrived: { readonly resolve: (value: void) => void };
    readonly answer: Promise<void>;
  }): { readonly traffic: SlackTraffic; readonly pages: () => number } {
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [
        { id: "C100", name: "general" },
        { id: "C200", name: "secrets", is_private: true },
      ],
      history: (query, request) => {
        const channel = query.get("channel") ?? "";
        return historyPage([
          { ts: FIRST_IN_WINDOW, text: `message in ${channel}` },
        ])(query, request);
      },
      release: async (page) => {
        releasePages = page;
        if (page === 1) {
          return channelPageBody([{ id: "C100", name: "general" }], "next");
        }
        barrier.arrived.resolve();
        await barrier.answer;
        return channelPageBody([
          { id: "C200", name: "secrets", is_private: true },
        ]);
      },
    });
    return {
      traffic,
      pages: () => {
        return releasePages;
      },
    };
  }

  it.each([
    ["exactly on", 0],
    ["past", 1],
  ])(
    "withholds a channel an earlier final page proved when a later page lands %s the deadline",
    async (_name, offset) => {
      const f = await fixture();
      mockNow(ANCHOR_MS);
      const arrived = createDeferredPromise<void>(context.signal);
      const answer = createDeferredPromise<void>(context.signal);
      const held = scriptHeldContinuation({ arrived, answer: answer.promise });

      const pending = collect(f);
      await arrived.promise;
      mockNow(ANCHOR_MS + COLLECTION_DEADLINE_MS + offset);
      answer.resolve();

      const response = await accept(pending, [200]);
      if (response.body.result !== "collected") {
        throw new Error(
          `Expected a collected bundle, got ${response.body.result}`,
        );
      }
      const { bundle } = response.body;
      // The deadline bounds the attempt, not one channel's proof: C100 was
      // confirmed inside the budget and still may not be published, because the
      // enumeration that would have finished the release expired mid-pass.
      expect(JSON.stringify(bundle)).not.toContain("message in C100");
      expect(JSON.stringify(bundle)).not.toContain("general");
      expect(JSON.stringify(bundle)).not.toContain("secrets");
      expectNothingReleased(bundle);
      expect(bundle.counts.threads).toBe(0);
      expect(bundle.counts.textBytes).toBe(0);
      expect(bundle.limits).toContain("deadline");
      expect(bundle.limits).toContain("scope-unproven");
      expect(bundle.coverage).toBe("partial");
      expect(response.body.occurrence.outcome).toBe("partial");
      // Discovery, a proof and a read for each channel, then the two final
      // pages: the documented caps are untouched, the held answer is not
      // retried, and no protected read follows it.
      expect(held.pages()).toBe(2);
      expect(bundle.counts.requests).toBe(7);
      expect(held.traffic.requests).toHaveLength(7);
      expect(queriesFor(held.traffic, SLACK_HISTORY_URL)).toHaveLength(2);
      expect(held.traffic.requests.at(-1)?.url).toBe(
        SLACK_USER_CONVERSATIONS_URL,
      );
      // The recorded occurrence agrees with the empty bundle, and nothing the
      // attempt withheld is recoverable from it either.
      const [row, ...extra] = await readMorningBriefCollectionOccurrences(f);
      expect(extra).toHaveLength(0);
      expect(row).toMatchObject({
        attempt: 1,
        channelCount: 0,
        messageCount: 0,
      });
      expect(JSON.stringify(row)).not.toContain("general");
    },
  );

  it("still releases both channels when the last final page lands inside the deadline", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const arrived = createDeferredPromise<void>(context.signal);
    const answer = createDeferredPromise<void>(context.signal);
    const held = scriptHeldContinuation({ arrived, answer: answer.promise });

    const pending = collect(f);
    await arrived.promise;
    // One microsecond of budget is still budget, so the same two-page proof
    // that expires above completes here and authorizes the whole bundle.
    mockNow(ANCHOR_MS + COLLECTION_DEADLINE_MS - 1);
    answer.resolve();

    const response = await accept(pending, [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(
      bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C100", "C200"]);
    expect(
      bundle.entries.map((entry) => {
        return entry.text;
      }),
    ).toStrictEqual(["message in C100", "message in C200"]);
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.coverage).toBe("complete");
    expect(response.body.occurrence.outcome).toBe("complete");
    expect(held.pages()).toBe(2);
    expect(bundle.counts).toMatchObject({
      channels: 2,
      messages: 2,
      requests: 7,
    });
  });

  it("releases no bundle when the caller cancels during the final proof", async () => {
    const f = await fixture();
    const cancellation = new Error(`cancelled ${randomUUID()}`);
    const controller = new AbortController();
    const traffic = scriptHeldRelease({
      channels: [{ id: "C1", name: "general" }],
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unconfirmed" }]),
      release: () => {
        controller.abort(cancellation);
        return channelPageBody([{ id: "C1", name: "general" }]);
      },
    });

    await expect(
      setupApp({
        context,
        routes: morningBriefCollectionPreviewRoutes,
        signal: controller.signal,
        rethrowErrors: true,
      })(morningBriefCollectionPreviewContract).collect({
        headers: f.headers,
        body: { scheduledFor: ANCHOR },
      }),
    ).rejects.toThrow(cancellation.message);
    // The cancellation reaches the caller instead of a bundle, and no protected
    // page is read after the proof it interrupted.
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("cancels a held final proof at the provider request and releases no bundle", async () => {
    const f = await fixture();
    const cancellation = new Error(`cancelled ${randomUUID()}`);
    const controller = new AbortController();
    const arrived = createDeferredPromise<void>(context.signal);
    const cancelled = createDeferredPromise<void>(context.signal);
    const traffic = scriptHeldRelease({
      channels: [{ id: "C100", name: "general" }],
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "unconfirmed" }]),
      release: async (_page, request) => {
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        arrived.resolve();
        // Slack never answers on its own: this response is still in flight when
        // the caller goes away, so only a cancellation that actually reaches
        // the provider request can end it.
        await cancelled.promise;
        return HttpResponse.error();
      },
    });

    const pending = setupApp({
      context,
      routes: morningBriefCollectionPreviewRoutes,
      signal: controller.signal,
      rethrowErrors: true,
    })(morningBriefCollectionPreviewContract).collect({
      headers: f.headers,
      body: { scheduledFor: ANCHOR },
    });
    await arrived.promise;
    controller.abort(cancellation);
    // Awaiting the provider request's own abort both proves the cancellation
    // arrived there and joins the held handler before the attempt is judged.
    await cancelled.promise;

    await expect(pending).rejects.toThrow(cancellation.message);
    expect(queriesFor(traffic, SLACK_HISTORY_URL)).toHaveLength(1);
    // The attempt published no bundle and never finalized, so the occurrence it
    // claimed is still held rather than completed: the next explicit
    // invocation is refused as in progress without reaching Slack again.
    const retried = await accept(collect(f), [409]);
    expect(retried.body.error.code).toBe(
      "MORNING_BRIEF_COLLECTION_IN_PROGRESS",
    );
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("keeps a complete positive proof releasing its content unchanged", async () => {
    const f = await fixture();
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels: [
        { id: "C1", name: "general" },
        { id: "C200", name: "secrets", is_private: true },
      ],
      history: (query, request) => {
        const channel = query.get("channel") ?? "";
        return historyPage([
          { ts: FIRST_IN_WINDOW, text: `message in ${channel}` },
        ])(query, request);
      },
      release: (page) => {
        releasePages = page;
        return channelPageBody([
          { id: "C1", name: "general" },
          { id: "C200", name: "secrets", is_private: true },
        ]);
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    expect(
      bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1", "C200"]);
    expect(
      bundle.entries.map((entry) => {
        return entry.text;
      }),
    ).toStrictEqual(["message in C1", "message in C200"]);
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.coverage).toBe("complete");
    expect(response.body.occurrence.outcome).toBe("complete");
    // One page naming every pending conversation is the ordinary cost.
    expect(releasePages).toBe(1);
    for (const request of traffic.requests) {
      expect(request.token).toBe(`Bearer ${f.botToken}`);
    }
  });
});

describe("Morning Brief Slack bounded coverage", () => {
  it("reports the thread cap when one complete page holds more replied roots", async () => {
    const f = await fixture();
    const roots = windowTimestamps(11);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: historyPage(
        roots.map((ts, index) => {
          return {
            ts,
            text: `root ${index}`,
            thread_ts: ts,
            reply_count: 2,
          };
        }),
      ),
      replies: (query) => {
        const root = query.get("ts") ?? "";
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: root,
              user: "U1",
              text: "root",
              thread_ts: root,
            },
          ],
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    // Ten roots are expanded; the eleventh is skipped work and must be named.
    expect(bundle.counts.threads).toBe(10);
    expect(bundle.limits).toContain("threads");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("clips an oversized message on a code point boundary and reports it", async () => {
    const f = await fixture();
    // 4094 single-byte characters plus one three-byte character: one byte over
    // the per-message ceiling, and the overflow splits a code point.
    const oversized = `${"a".repeat(4094)}中`;
    expect(Buffer.byteLength(oversized, "utf8")).toBe(4097);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: oversized }]),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error(
        `Expected a collected bundle, got ${response.body.result}`,
      );
    }
    const { bundle } = response.body;
    const [entry, ...extra] = bundle.entries;
    expect(extra).toHaveLength(0);
    expect(Buffer.byteLength(entry?.text ?? "", "utf8")).toBe(4094);
    expect(entry?.text).not.toContain("�");
    expect(bundle.counts.textBytes).toBe(4094);
    expect(bundle.limits).toContain("entry-text-bytes");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
  });
});

describe("Morning Brief Slack finite budgets", () => {
  it("caps enumeration pages and names the bound", async () => {
    const f = await fixture();
    scriptSlack({
      // Pages stay addressable by cursor, so a later authorization lookup can
      // still walk to whichever page names its conversation.
      channels: (query) => {
        const cursor = query.get("cursor");
        const page = cursor === null ? 1 : Number(cursor);
        return {
          ok: true,
          channels: [{ id: `C${page}`, name: `c${page}`, is_private: false }],
          response_metadata: { next_cursor: String(page + 1) },
        };
      },
      history: noMessages(),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(
      response.body.bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(["C1", "C2", "C3"]);
    expect(response.body.bundle.limits).toContain("channel-pages");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("caps history pages per channel and names the bound", async () => {
    const f = await fixture();
    const [first, second] = windowTimestamps(2);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: (query) => {
        const cursor = query.get("cursor");
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: cursor === null ? first : second,
              user: "U1",
              text: cursor === null ? "page one" : "page two",
            },
          ],
          response_metadata: { next_cursor: cursor === null ? "h2" : "h3" },
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    expect(bundle.counts.messages).toBe(2);
    expect(bundle.limits).toContain("history-pages");
    expect(bundle.channels[0]?.truncated).toBeTruthy();
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("stops a repeated history cursor for one channel", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "looping" }], {
        next_cursor: "same",
      }),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(response.body.bundle.limits).toContain("cursor-anomaly");
    expect(response.body.bundle.channels[0]?.truncated).toBeTruthy();
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("expands exactly one reply page per thread and names a longer thread", async () => {
    const f = await fixture();
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: historyPage([
        {
          ts: THREAD_ROOT,
          text: "root",
          thread_ts: THREAD_ROOT,
          reply_count: 5,
        },
      ]),
      replies: () => {
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: THREAD_REPLY,
              user: "U5",
              text: "reply",
              thread_ts: THREAD_ROOT,
            },
          ],
          has_more: true,
        };
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    expect(bundle.counts.threads).toBe(1);
    expect(bundle.limits).toContain("reply-pages");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("spends the read budget without spending the final proof's reserve", async () => {
    const f = await fixture();
    const channels = Array.from({ length: 20 }, (_value, index) => {
      return { id: `C${index}`, name: `channel-${index}` };
    });
    const traffic = scriptSlack({
      channels: channelPage(channels),
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "collected" }]),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    // Discovery and nine pairs short of the ceiling: the reads stop at 37 so
    // the reserved enumeration can still prove what they collected, and the
    // documented 40-request ceiling is never crossed.
    expect(bundle.counts.requests).toBe(38);
    expect(traffic.requests).toHaveLength(38);
    expect(bundle.limits).toContain("requests");
    expect(response.body.occurrence.outcome).toBe("partial");
    // The single reserved page named every discovered conversation, so the
    // eighteen channels this attempt managed to read are released with their
    // content and the two it never reached are still named as truncated.
    expect(bundle.counts.channels).toBe(18);
    expect(bundle.counts.messages).toBe(18);
    expect(bundle.channels).toHaveLength(20);
    expect(
      bundle.channels.filter((channel) => {
        return channel.truncated;
      }),
    ).toHaveLength(2);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("spends the whole reserved proof allowance without a forty-first request", async () => {
    const f = await fixture();
    const channels = Array.from({ length: 19 }, (_value, index) => {
      return { id: `C${index}`, name: `channel-${index}` };
    });
    let releasePages = 0;
    const traffic = scriptHeldRelease({
      channels,
      // Discovery plus a proof and a read for eighteen channels is the whole
      // 37-request read allowance; the nineteenth channel is never reached.
      historyReads: 18,
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "collected" }]),
      release: (page) => {
        releasePages = page;
        if (page === 1) {
          return channelPageBody(channels.slice(0, 17), "final-2");
        }
        // Each reserved page advances honestly and still never names the
        // channel the reads could not reach.
        return page === 2
          ? channelPageBody([{ id: "C17", name: "channel-17" }], "final-3")
          : channelPageBody([], "final-4");
      },
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    // The reads stop at their own ceiling and the proof then spends all three
    // reserved pages, landing exactly on the documented 40-request ceiling.
    expect(bundle.counts.requests).toBe(40);
    expect(traffic.requests).toHaveLength(40);
    expect(releasePages).toBe(3);
    expect(bundle.limits).toContain("requests");
    expect(bundle.limits).toContain("scope-unproven");
    expect(bundle.coverage).toBe("partial");
    expect(response.body.occurrence.outcome).toBe("partial");
    // Only the freshly confirmed channels survive: the one the pass could not
    // resolve keeps its content, name, id and link inside the collector, and
    // the counts describe exactly what was returned.
    expect(
      bundle.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual(
      channels.slice(0, 18).map((channel) => {
        return channel.id;
      }),
    );
    expect(JSON.stringify(bundle)).not.toContain("channel-18");
    expect(bundle.counts).toMatchObject({ channels: 18, messages: 18 });
    expect(bundle.counts.textBytes).toBe(18 * "collected".length);
    expect(traffic.requests.at(-1)?.url).toBe(SLACK_USER_CONVERSATIONS_URL);
  });

  it("caps normalized messages and names the bound", async () => {
    const f = await fixture();
    const timestamps = windowTimestamps(200);
    scriptSlack({
      channels: channelPage([
        { id: "C1", name: "one" },
        { id: "C2", name: "two" },
        { id: "C3", name: "three" },
      ]),
      history: historyPage(
        timestamps.map((ts) => {
          return { ts, text: "m" };
        }),
      ),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    expect(response.body.bundle.counts.messages).toBe(500);
    expect(response.body.bundle.limits).toContain("messages");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("caps total projected text at the documented ceiling", async () => {
    const f = await fixture();
    const timestamps = windowTimestamps(33);
    scriptSlack({
      channels: channelPage([{ id: "C1", name: "general" }]),
      history: historyPage(
        timestamps.map((ts) => {
          return { ts, text: "x".repeat(4 * 1024) };
        }),
      ),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    expect(bundle.counts.textBytes).toBe(128 * 1024);
    expect(bundle.counts.messages).toBe(32);
    // A message exactly at the per-entry ceiling is carried whole.
    expect(bundle.entries.map(clipping)).not.toContain(true);
    expect(bundle.limits).toContain("text-bytes");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("reads nothing protected once the collection deadline has passed", async () => {
    const f = await fixture();
    mockNow(ANCHOR_MS);
    const traffic = scriptSlack({
      channels: () => {
        // The clock crosses the attempt's 30 second deadline while discovery's
        // own response is being produced.
        mockNow(ANCHOR_MS + 31_000);
        return {
          ok: true,
          channels: [{ id: "C1", name: "general", is_private: false }],
          response_metadata: {},
        };
      },
      history: historyPage([{ ts: FIRST_IN_WINDOW, text: "too late" }]),
    });

    const response = await accept(collect(f), [200]);
    if (response.body.result !== "collected") {
      throw new Error("Expected a collected bundle");
    }
    const { bundle } = response.body;
    expect(
      traffic.requests.some((request) => {
        return request.url === SLACK_HISTORY_URL;
      }),
    ).toBeFalsy();
    expect(bundle.limits).toContain("deadline");
    expect(bundle.entries).toStrictEqual([]);
    // An expired attempt can neither read the conversation nor prove that the
    // member still shares it, so discovery's own list is not released either.
    expect(bundle.channels).toStrictEqual([]);
    expect(bundle.limits).toContain("scope-unproven");
    expect(response.body.occurrence.outcome).toBe("partial");
  });

  it("abandons the attempt when the caller cancels during an authorization lookup", async () => {
    const f = await fixture();
    const cancellation = new Error(`cancelled ${randomUUID()}`);
    const controller = new AbortController();
    const traffic = scriptSlack({ history: historyPage([]) });
    let discovered = false;
    server.use(
      http.get(SLACK_USER_CONVERSATIONS_URL, () => {
        if (discovered) {
          controller.abort(cancellation);
        }
        discovered = true;
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C1", name: "general", is_private: false }],
          response_metadata: {},
        });
      }),
    );

    await expect(
      setupApp({
        context,
        routes: morningBriefCollectionPreviewRoutes,
        signal: controller.signal,
        rethrowErrors: true,
      })(morningBriefCollectionPreviewContract).collect({
        headers: f.headers,
        body: { scheduledFor: ANCHOR },
      }),
    ).rejects.toThrow(cancellation.message);
    expect(
      traffic.requests.some((request) => {
        return request.url === SLACK_HISTORY_URL;
      }),
    ).toBeFalsy();
  });
});
