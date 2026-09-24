import { randomUUID } from "node:crypto";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import {
  morningBriefPreferenceContract,
  type MorningBriefLastRun,
  type MorningBriefRunSource,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { seedInstalledMorningBrief } from "../../../test-fixtures/morning-brief-collection";
import {
  countEmailOutboxRows,
  makeNativeOccurrenceDue,
  readNativeDeliveries,
  readNativeGenerations,
  readNativeOccurrences,
  readNativeSchedule,
  readThreadEventTypes,
  seedRecipientAddress,
} from "../../../test-fixtures/morning-brief-native-schedule";
import { createScopedInlineMorningBriefCronRoutesForTest } from "../cron-execute-morning-briefs";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { mockGoogleCalendarConnectorOAuth } from "./helpers/api-bdd-workflows";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedRetainedNativeMorningBriefForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * What a settled native Morning Brief occurrence is able to say afterwards.
 *
 * A real production run (#35656) collected from all five sources and delivered
 * nothing: no model request, no generation row, no Chat message, no email. The
 * occurrence settled, so the owner saw silence rather than an error, and from
 * outside that run was indistinguishable from a genuinely quiet morning.
 *
 * Two slot-engine behaviors are under test here through a test-only inline
 * route with the real generation, Chat and shared-outbox engines behind it:
 *
 * - a healthy multi-source collection reaches its single model request even
 *   when the final authority check has real work to do, because that check is
 *   bounded by the attempt's own absolute deadline rather than by a second,
 *   fixed budget that ignores how many sources answered;
 * - a delivered brief, a genuinely empty one and a failed collection each
 *   record a distinguishable durable account, readable through the member's
 *   own `GET /api/preferences/morning-brief`.
 *
 * Only the provider HTTP boundaries are doubled. The membership boundary is
 * additionally given a deterministic, controlled latency, because the defect is
 * about how much authority work fits inside a budget — with an instant Clerk,
 * no ceiling is ever reached and the defect is invisible.
 */

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const store = createStore();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);

const CRON_SECRET = "collection-account-cron-secret";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";
const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events";

/**
 * The deterministic cost this fixture charges one membership answer.
 *
 * The defect is about how much authority work fits inside a budget, so the
 * clock moves by a fixed amount per membership answer rather than by however
 * long a real network happened to take. Production measured roughly 120 ms per
 * Clerk membership fetch and 92 of them in one run; this fixture carries fewer
 * sources and retained endpoints than that owner did, so it charges more per
 * answer to reach a comparable total authority cost. It stands in for that
 * cost and is not a claim about the observed per-call latency.
 */
const MEMBERSHIP_LATENCY_MS = 500;

/**
 * The fixed ceiling the retained-authority check used to give itself.
 *
 * Nothing reads it any more; it is stated here because it is the quantity the
 * reproduction has to exceed for the defect to appear at all.
 */
const RETIRED_REVALIDATION_CEILING_MS = 5000;

const TEST_TIMEOUT_MS = 120_000;

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly actor: ApiTestUser;
}

interface SourceOptions {
  readonly connectors?: boolean;
  readonly slack?: boolean;
}

beforeEach(async () => {
  context.mocks.resend.send.mockReset();
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `resend-${randomUUID()}` },
    error: null,
  });
  await installApiTestConnectorCatalog();
});

afterEach(() => {
  clearMockNow();
});

function cronClient(owner: Fixture) {
  return setupApp({
    context,
    routes: createScopedInlineMorningBriefCronRoutesForTest(owner),
  })(cronExecuteMorningBriefsContract);
}

function tick(owner: Fixture) {
  return cronClient(owner).execute({
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

function preferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

/** Read the member's own Settings answer, through the deployed endpoint. */
async function readPreference(f: Fixture) {
  mocks.clerk.session(f.userId, f.orgId, "org:admin");
  const response = await accept(
    preferenceClient().get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body;
}

async function connectGmail(actor: ApiTestUser, agentId: string) {
  const subject = `gmail-${randomUUID()}`;
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: "owner@example.test",
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: `gmail-code-${subject}`,
    state,
  });
}

async function connectCalendar(actor: ApiTestUser, agentId: string) {
  const subject = `calendar-${randomUUID()}`;
  mockGoogleCalendarConnectorOAuth({
    accessToken: "calendar-access-token",
    email: "owner@example.test",
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "google-calendar",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Calendar OAuth state");
  }
  await connectorsApi.completeOauthCallback("google-calendar", {
    code: `calendar-code-${subject}`,
    state,
  });
}

async function connectGithub(actor: ApiTestUser, agentId: string) {
  const suffix = randomUUID();
  mockGitHubConnectorOAuth({ userId: 424_242, login: `owner-${suffix}` });
  const start = await connectorsApi.startOauth(
    actor,
    "github",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a GitHub OAuth state");
  }
  await connectorsApi.completeOauthCallback("github", {
    code: `github-code-${suffix}`,
    state,
  });
}

async function fixture(options: SourceOptions = {}): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { userId, orgId, role: "admin" },
    context.signal,
  );
  const brief = await seedInstalledMorningBrief({ orgId, userId });
  const actor = bdd.user({ userId, orgId, orgRole: "org:admin" });
  if (options.connectors === true) {
    await connectGmail(actor, brief.agentId);
    await connectCalendar(actor, brief.agentId);
    await connectGithub(actor, brief.agentId);
    await runsApi.enableAgentConnectors(actor, brief.agentId, [
      "gmail",
      "google-calendar",
      "github",
    ]);
    // Message bodies are not allowed by default, so a working Gmail read needs
    // the real grant rather than a relaxed authorizer.
    await runsApi.applyUserPermissionGrant(actor, {
      agentId: brief.agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "allow",
    });
  }
  await seedRetainedNativeMorningBriefForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.NativeMorningBrief]: true },
  );
  if (options.slack !== false) {
    const installation = await store.set(
      seedSlackOrgInstallation$,
      { orgId, botToken: `xoxb-test-${randomUUID()}` },
      context.signal,
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: installation.slackWorkspaceId, userId },
      context.signal,
    );
  }
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("OPENROUTER_API_KEY", "platform-openrouter-key");
  mockOptionalEnv("RESEND_API_KEY", "platform-resend-key");
  mockOptionalEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
  mockClerkUsers(context, [
    {
      id: userId,
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        { id: "idn_primary", emailAddress: `${userId}@example.test` },
      ],
    },
  ]);
  await seedRecipientAddress(userId, `${userId}@example.test`);
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    workflowId: brief.workflowId,
    automationId: brief.automationId,
    actor,
  };
}

/** Drive the real cutover to completion through ordinary ticks. */
async function tickUntilNative(f: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await accept(tick(f), [200]);
    if ((await readNativeSchedule(f))?.phase === "native") {
      return;
    }
  }
  throw new Error("The native cutover did not converge within five ticks");
}

interface ProviderCalls {
  readonly generation: string[];
}

/** One platform request boundary, counted. */
function scriptModel(): ProviderCalls {
  const calls: ProviderCalls = { generation: [] };
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      calls.generation.push(await request.text());
      return HttpResponse.json({
        id: "gen-01HCOLLECTIONACCOUNT",
        model: "google/gemini-3.8-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                decision: "deliver",
                language: "en-US",
                title: "Release readiness",
                sections: [
                  {
                    heading: "Decisions",
                    items: [
                      { text: "The release ships today.", citations: ["c1"] },
                    ],
                  },
                ],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost: 0.0001,
        },
      });
    }),
  );
  return calls;
}

/** Every source answers with real, in-window material. */
function scriptBusySources(): void {
  const at = now();
  const mid = at - 2 * 60 * 60 * 1000;
  server.use(
    http.get(GMAIL_LIST_URL, () => {
      return HttpResponse.json({
        messages: [{ id: "m-1", threadId: "thread-m-1" }],
      });
    }),
    http.get(GMAIL_MESSAGE_URL, () => {
      return HttpResponse.json({
        id: "m-1",
        threadId: "thread-m-1",
        internalDate: String(mid),
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "Subject m-1" },
            { name: "From", value: "sender@example.test" },
            { name: "To", value: "owner@example.test" },
            { name: "Date", value: new Date(mid).toUTCString() },
          ],
          body: { data: Buffer.from("Body m-1").toString("base64url") },
        },
      });
    }),
    http.get(CALENDAR_LIST_URL, () => {
      return HttpResponse.json({
        items: [{ id: "primary", primary: true, accessRole: "owner" }],
      });
    }),
    http.get(CALENDAR_EVENTS_URL, () => {
      return HttpResponse.json({
        items: [
          {
            id: "evt-1",
            status: "confirmed",
            summary: "Standup",
            start: { dateTime: new Date(at + 3_600_000).toISOString() },
            end: { dateTime: new Date(at + 5_400_000).toISOString() },
          },
        ],
      });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({ id: 424_242, login: "owner" });
    }),
    http.get("https://api.github.com/notifications", () => {
      return HttpResponse.json([
        {
          id: "acme/api-7",
          reason: "review_requested",
          unread: true,
          updated_at: new Date(mid).toISOString(),
          subject: {
            title: "subject 7",
            type: "PullRequest",
            url: "https://api.github.com/repos/acme/api/pulls/7",
          },
          repository: { full_name: "acme/api" },
        },
      ]);
    }),
    http.get("https://api.github.com/search/issues", () => {
      return HttpResponse.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 7,
            title: "item 7",
            state: "open",
            updated_at: new Date(mid).toISOString(),
            repository_url: "https://api.github.com/repos/acme/api",
            body: "body text",
            user: { login: "someone-else" },
            pull_request: { url: "ignored" },
            draft: false,
          },
        ],
      });
    }),
    http.get("https://api.github.com/repos/:owner/:repo/pulls/:number", () => {
      return HttpResponse.json({
        number: 7,
        state: "open",
        draft: false,
        updated_at: new Date(mid).toISOString(),
        head: { sha: "a".repeat(40) },
      });
    }),
    http.get(
      "https://api.github.com/repos/:owner/:repo/commits/:ref/check-runs",
      () => {
        return HttpResponse.json({ total_count: 0, check_runs: [] });
      },
    ),
    http.get(
      "https://api.github.com/repos/:owner/:repo/commits/:ref/status",
      () => {
        return HttpResponse.json({
          state: "success",
          total_count: 0,
          statuses: [],
        });
      },
    ),
    http.get(SLACK_CONVERSATIONS_URL, () => {
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C100", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      });
    }),
    http.get(SLACK_REPLIES_URL, () => {
      return HttpResponse.json({ ok: true, messages: [] });
    }),
    http.get(SLACK_HISTORY_URL, () => {
      return HttpResponse.json({
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            ts: `${String(Math.floor(mid / 1000))}.000100`,
            user: "U1",
            text: "ship the release",
          },
        ],
      });
    }),
  );
}

/** Every configured source answers, and every one of them is empty. */
function scriptQuietSources(): void {
  server.use(
    http.get(SLACK_CONVERSATIONS_URL, () => {
      return HttpResponse.json({
        ok: true,
        channels: [],
        response_metadata: { next_cursor: "" },
      });
    }),
  );
}

/** Every connector-backed source refuses, so nothing knows the owner's day. */
function scriptFailingSources(): void {
  server.use(
    http.get(GMAIL_LIST_URL, () => {
      return HttpResponse.json({ error: { code: 500 } }, { status: 500 });
    }),
    http.get(CALENDAR_LIST_URL, () => {
      return HttpResponse.json({ error: { code: 500 } }, { status: 500 });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({ message: "unavailable" }, { status: 500 });
    }),
    http.get("https://api.github.com/notifications", () => {
      return HttpResponse.json({ message: "unavailable" }, { status: 500 });
    }),
    http.get("https://api.github.com/search/issues", () => {
      return HttpResponse.json({ message: "unavailable" }, { status: 500 });
    }),
    http.get(SLACK_CONVERSATIONS_URL, () => {
      return HttpResponse.json({ ok: false, error: "internal_error" });
    }),
  );
}

/**
 * Give the membership boundary a deterministic cost, and count the answers.
 *
 * The clock moves by a fixed amount per answer rather than by however long a
 * real network took, so the reproduction is a statement about how much
 * authority work fits inside a budget instead of a race.
 */
function chargeMembershipLatency(): { calls: () => number } {
  let calls = 0;
  const membership = context.mocks.clerk.organizations
    .getOrganizationMembershipList as unknown as {
    getMockImplementation: () => ((...args: unknown[]) => unknown) | undefined;
    mockImplementation: (fn: (...args: unknown[]) => unknown) => unknown;
  };
  const answered = membership.getMockImplementation();
  membership.mockImplementation((...args: unknown[]) => {
    calls += 1;
    mockNow(now() + MEMBERSHIP_LATENCY_MS);
    return answered?.(...args);
  });
  return {
    calls: () => {
      return calls;
    },
  };
}

/** One source's line in the account the member's own endpoint returned. */
function sourceFact(
  lastRun: MorningBriefLastRun | null | undefined,
  source: string,
): MorningBriefRunSource | undefined {
  return lastRun?.sources?.find((entry) => {
    return entry.source === source;
  });
}

describe("native Morning Brief collection account", () => {
  it(
    "delivers a multi-source brief whose authority revalidation outlives a fixed budget",
    async () => {
      const f = await fixture({ connectors: true });
      scriptBusySources();
      const calls = scriptModel();
      await tickUntilNative(f);
      const due = await makeNativeOccurrenceDue(f);

      // Only now, so the cutover ticks above are not charged for it.
      const membership = chargeMembershipLatency();
      const executed = await accept(tick(f), [200]);
      expect(executed.body.claimed).toBe(1);
      expect(executed.body.settled).toBe(1);

      // A guard on the fixture, not the proof: the tick has to charge more for
      // membership answers than the retired ceiling allowed, or the scenario
      // never reaches the bound it is about. The proof that this reproduces
      // #35656 is that every assertion below fails on the parent commit.
      expect(membership.calls() * MEMBERSHIP_LATENCY_MS).toBeGreaterThan(
        RETIRED_REVALIDATION_CEILING_MS,
      );

      // Exactly one reservation, exactly one model request.
      const generations = await readNativeGenerations(f);
      expect(generations).toHaveLength(1);
      expect(generations[0]?.state).toBe("succeeded");
      expect(generations[0]?.executionPurpose).toBe("production");
      expect(calls.generation).toHaveLength(1);

      // One Chat receipt and one logical email for that accepted result.
      const deliveries = await readNativeDeliveries(f);
      expect(deliveries).toHaveLength(1);
      await expect(
        readThreadEventTypes(deliveries[0]?.chatThreadId ?? ""),
      ).resolves.toStrictEqual(["output.message"]);
      await expect(
        countEmailOutboxRows(deliveries[0]?.emailOutboxId ?? randomUUID()),
      ).resolves.toBe(1);

      // The collection occurrence was finalized, which is precisely what the
      // production signature showed never happening.
      const occurrences = await readNativeOccurrences(f);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.outcome).toBe("delivered");
      expect(occurrences[0]?.scheduledFor.getTime()).toBe(due.getTime());
      expect(occurrences[0]?.settledAt).not.toBeNull();

      // And the account says what it had to work with, through the member's
      // own Settings endpoint rather than through a trace.
      const preference = await readPreference(f);
      expect(preference.lastDeliveredAt).toBe(
        deliveries[0]?.deliveredAt.toISOString(),
      );
      const lastRun = preference.lastRun;
      expect(lastRun?.state).toBe("settled");
      expect(lastRun?.outcome).toBe("delivered");
      expect(lastRun?.reason).toBeNull();
      expect(sourceFact(lastRun, "gmail")).toMatchObject({
        coverage: "complete",
        items: 1,
        includedInRequest: 1,
      });
      expect(sourceFact(lastRun, "github")?.items).toBe(1);
      expect(sourceFact(lastRun, "slack")?.items).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records a genuinely quiet morning as an empty skip nobody can mistake for a failure",
    async () => {
      const f = await fixture();
      scriptQuietSources();
      const calls = scriptModel();
      await tickUntilNative(f);
      await makeNativeOccurrenceDue(f);

      await accept(tick(f), [200]);

      // A quiet morning costs no model request and no delivery.
      expect(calls.generation).toHaveLength(0);
      await expect(readNativeDeliveries(f)).resolves.toHaveLength(0);
      const occurrences = await readNativeOccurrences(f);
      expect(occurrences[0]?.outcome).toBe("empty-skip");

      const preference = await readPreference(f);
      expect(preference.lastDeliveredAt).toBeNull();
      const lastRun = preference.lastRun;
      expect(lastRun?.outcome).toBe("empty-skip");
      expect(lastRun?.reason).toBeNull();
      // Every applicable source answered, and every one of them held nothing.
      expect(sourceFact(lastRun, "slack")).toMatchObject({
        coverage: "empty",
        items: 0,
      });
      expect(sourceFact(lastRun, "chat")?.items).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records a failed collection as a failure rather than as a quiet morning",
    async () => {
      const f = await fixture({ connectors: true });
      scriptFailingSources();
      const calls = scriptModel();
      await tickUntilNative(f);
      await makeNativeOccurrenceDue(f);

      await accept(tick(f), [200]);

      expect(calls.generation).toHaveLength(0);
      await expect(readNativeDeliveries(f)).resolves.toHaveLength(0);
      const occurrences = await readNativeOccurrences(f);
      expect(occurrences[0]?.outcome).toBe("collection-failed");

      const preference = await readPreference(f);
      expect(preference.lastDeliveredAt).toBeNull();
      const lastRun = preference.lastRun;
      expect(lastRun?.outcome).toBe("collection-failed");
      // The three settlements are distinguishable: this one names the sources
      // that could not answer, where the quiet morning had no reason at all.
      expect(lastRun?.reason).not.toBeNull();
      expect(sourceFact(lastRun, "gmail")).toMatchObject({
        coverage: "failed",
        items: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
