import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { countDatabaseStatements } from "../../../test-fixtures/database-statements";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
  selectThreadGmailAccountFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import {
  makeNativeOccurrenceDue,
  readNativeGenerations,
  readNativeSchedule,
  seedRecipientAddress,
} from "../../../test-fixtures/morning-brief-native-schedule";
import { createScopedInlineMorningBriefCronRoutesForTest } from "../cron-execute-morning-briefs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedRetainedNativeMorningBriefForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * How much authority work one native attempt spends, through the real cron.
 *
 * The member's organization membership is one immutable answer that the whole
 * attempt already speaks for: the occurrence pins it, admission revalidates the
 * pinned value, and nothing a source returns can change it. Re-deriving it once
 * per collected item is invisible in the delivered brief and very visible in
 * the attempt's latency, so the contract these cases hold is a quantity: the
 * authority work an attempt spends does not grow with the number of items its
 * sources returned.
 *
 * Both attempts below are the same production attempt — the same registered
 * cron route, the same cutover, the same real collection, generation and
 * delivery — and differ only in how many Gmail messages the provider answers
 * with. Anything that scales with that difference is per-item authority work.
 *
 * **Stated boundary exception.** The membership resolutions counted here are
 * crossings of the Clerk provider boundary, which is external and doubled like
 * any other provider in this suite. The statement counts are not: they are
 * internal, and `docs/testing/testing-external-behavior.md` allows leaving the
 * external boundary only for a case the production interface cannot construct,
 * with the reason recorded at the test. The reason is that no endpoint reports
 * how much authority work one attempt spent — the brief is delivered either
 * way, so the defect this covers is invisible in every response the attempt
 * produces, and a test written at the endpoint would pass while an attempt
 * re-asked one immutable question once per collected message. The exception is
 * deliberately narrow: it covers how often the authority path repeats itself,
 * never what it decided, which every other case in these suites still proves
 * through the endpoint.
 */

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const store = createStore();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

const CRON_SECRET = "native-member-authority-cron-secret";
const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Real OAuth setup, a real cutover and four collectors do not fit the
 * five-second default. The barriers below are still request arrivals and
 * durable rows, never elapsed time.
 */
const TEST_TIMEOUT_MS = 120_000;

/**
 * The ceiling one attempt's membership resolutions live under.
 *
 * It counts fences, never items: the collection admission, each source's own
 * admission and release, the retained-source re-proof and each settlement
 * boundary observe the member once. Asserting a ceiling as well as equality is
 * deliberate — two equally inflated attempts would satisfy equality alone.
 */
const MAX_MEMBERSHIP_RESOLUTIONS_PER_ATTEMPT = 32;

/**
 * Installed before this suite opens its first pooled connection, so the pool's
 * own instrumentation binds the counted method rather than the bare one.
 */
const statements = countDatabaseStatements();

afterEach(() => {
  clearMockNow();
});

afterAll(() => {
  statements.restore();
});

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
}

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

async function tickUntilNative(owner: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await accept(tick(owner), [200]);
    if ((await readNativeSchedule(owner))?.phase === "native") {
      return;
    }
  }
  throw new Error("The native cutover did not converge within five ticks");
}

/**
 * Keep the bytes this suite's production writes publish, so they read back.
 *
 * Creating an Agent publishes its instructions volume, and the composition's
 * language context reads that volume back. The shared default answers every
 * command with a fixed size and no body, so the read fails and the attempt
 * reports an unreadable Agent instead of running.
 */
function stubObjectStorage(objects: Map<string, Buffer>): void {
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

function gmailMessagePayload(id: string, anchorMs: number) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(anchorMs),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "sender@example.test" },
        { name: "To", value: "owner@example.test" },
        { name: "Date", value: new Date(anchorMs).toUTCString() },
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

interface ProviderCalls {
  readonly gmailDetails: string[];
  readonly generation: string[];
}

/** Script every provider this attempt reads, with `messages` Gmail items. */
function scriptProviders(messages: number): ProviderCalls {
  const calls: ProviderCalls = { gmailDetails: [], generation: [] };
  const ids = Array.from({ length: messages }, (_, index) => {
    return `m${String(index + 1)}`;
  });
  server.use(
    http.get(GMAIL_LIST_URL, ({ request }) => {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      return HttpResponse.json({
        messages:
          query === "is:unread"
            ? []
            : ids.map((id) => {
                return { id, threadId: `thread-${id}` };
              }),
      });
    }),
    http.get(GMAIL_MESSAGE_URL, ({ params }) => {
      const id = String(params["messageId"]);
      calls.gmailDetails.push(id);
      return HttpResponse.json(gmailMessagePayload(id, now() - 60 * 60 * 1000));
    }),
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
        messages: [
          {
            type: "message",
            ts: `${String(Math.floor(now() / 1000) - 3600)}.000100`,
            user: "U1",
            text: "ship the release",
          },
        ],
      });
    }),
    http.post(OPENROUTER_URL, async ({ request }) => {
      calls.generation.push(await request.text());
      return HttpResponse.json({
        id: "gen-01HNATIVEAUTHORITY",
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

async function connectGmail(
  actor: ApiTestUser,
  agentId: string,
): Promise<string> {
  const subject = `gmail-${randomUUID()}`;
  mockGmailConnectorOAuth({
    accessToken: `gmail-token-${subject}`,
    email: "owner@example.test",
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
    {
      intent: "add",
      displayName: "owner@example.test",
    },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: `gmail-code-${subject}`,
    state,
  });
  const account = (
    await connectorsApi.listBuiltinConnectorAccounts(actor, "gmail")
  ).find((candidate) => {
    return candidate.externalId === subject;
  });
  if (!account) {
    throw new Error("Expected the connected Gmail account");
  }
  return account.id;
}

/** One owner whose native brief reads Gmail, Slack and Chat. */
async function setupOwner(objectStorage: Map<string, Buffer>): Promise<{
  readonly fixture: Fixture;
  readonly actor: ApiTestUser & { readonly orgId: string };
}> {
  const timezone = "Asia/Shanghai";
  const { actor } = await workflowBdd.setupWorkflowOrg({ timezone });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  stubObjectStorage(objectStorage);
  const agent = await bdd.createAgent(actor, {
    displayName: `brief-${randomUUID().slice(0, 8)}`,
  });
  const agentId = agent.agentId;
  await bdd.updateAgentInstructions(actor, agentId, "Summarize the morning.");
  const gmailAccountId = await connectGmail(actor, agentId);
  await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
  await runsApi.applyUserPermissionGrant(actor, {
    agentId,
    connectorSlug: "gmail",
    permission: "messages.detail",
    action: "allow",
  });
  const owner = { orgId: actor.orgId, userId: actor.userId };
  const installation = await installMorningBriefFixture(owner, {
    agentId,
    timezone,
  });
  const chatThreadId = await bindMorningBriefThreadFixture(owner, {
    workflowId: installation.workflowId,
    agentId,
  });
  await selectThreadGmailAccountFixture({
    chatThreadId,
    connectorId: gmailAccountId,
  });
  const slack = await store.set(
    seedSlackOrgInstallation$,
    { orgId: actor.orgId, botToken: `xoxb-test-${randomUUID()}` },
    context.signal,
  );
  await store.set(
    seedSlackOrgConnection$,
    { slackWorkspaceId: slack.slackWorkspaceId, userId: actor.userId },
    context.signal,
  );
  await seedRetainedNativeMorningBriefForUser(context, owner, {
    [FeatureSwitchKey.NativeMorningBrief]: true,
  });
  await store.set(
    seedOrgMembership$,
    { ...owner, role: "admin", membershipId: `orgmem_${randomUUID()}` },
    context.signal,
  );
  mockClerkUsers(context, [
    {
      id: actor.userId,
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        { id: "idn_primary", emailAddress: `${actor.userId}@example.test` },
      ],
    },
  ]);
  await seedRecipientAddress(actor.userId, `${actor.userId}@example.test`);
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("OPENROUTER_API_KEY", "platform-openrouter-key");
  mockOptionalEnv("RESEND_API_KEY", "platform-resend-key");
  mockOptionalEnv("RESEND_FROM_DOMAIN", "mail.okou.test");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
  // Connector and permission setup reinstall their own doubles, so the store
  // the composition reads through is restored last.
  stubObjectStorage(objectStorage);
  return {
    fixture: {
      orgId: actor.orgId,
      userId: actor.userId,
      agentId,
      workflowId: installation.workflowId,
      automationId: installation.automationId,
    },
    actor: { ...actor, orgId: actor.orgId },
  };
}

/** Every live membership resolution this owner's authority path performed. */
function countMembershipResolutions(fixture: Fixture): () => number {
  return () => {
    return context.mocks.clerk.organizations.getOrganizationMembershipList.mock.calls.filter(
      (call) => {
        const args = call[0];
        return (
          typeof args === "object" &&
          args !== null &&
          "organizationId" in args &&
          args.organizationId === fixture.orgId &&
          "userId" in args &&
          Array.isArray(args.userId) &&
          args.userId.includes(fixture.userId)
        );
      },
    ).length;
  };
}

interface AttemptCost {
  readonly membershipResolutions: number;
  readonly gmailDetails: number;
  readonly connectorReads: number;
  readonly catalogReads: number;
  readonly scheduleReads: number;
  readonly agentReads: number;
  readonly membershipRowReads: number;
}

/** Run one complete native attempt and report what its authority path spent. */
async function runNativeAttempt(messages: number): Promise<AttemptCost> {
  const objectStorage = new Map<string, Buffer>();
  const { fixture } = await setupOwner(objectStorage);
  const calls = scriptProviders(messages);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  await tickUntilNative(fixture);
  await makeNativeOccurrenceDue(fixture);

  // Only the due attempt is measured. Cutover ticks resolve authority too, and
  // counting them would hide the per-item growth this case is about.
  const membershipResolutions = countMembershipResolutions(fixture);
  const before = membershipResolutions();
  statements.reset();
  const executed = await accept(tick(fixture), [200]);
  expect(executed.body.claimed).toBe(1);
  expect(executed.body.settled).toBe(1);

  // The attempt really produced a brief from those items, so the counts below
  // describe a completed production attempt rather than an early refusal.
  const generations = await readNativeGenerations(fixture);
  expect(generations).toHaveLength(1);
  expect(generations[0]?.executionPurpose).toBe("production");
  expect(generations[0]?.state).toBe("succeeded");

  return {
    membershipResolutions: membershipResolutions() - before,
    gmailDetails: calls.gmailDetails.length,
    connectorReads: statements.reads("connectors"),
    catalogReads: statements.reads("connector_catalog_active_snapshot"),
    scheduleReads: statements.reads("morning_brief_native_schedules"),
    agentReads: statements.reads("agents"),
    membershipRowReads: statements.reads("org_members_cache"),
  };
}

describe("native Morning Brief member authority", () => {
  it(
    "resolves the member's authority a constant number of times whatever the sources returned",
    async () => {
      await installApiTestConnectorCatalog();
      const small = await runNativeAttempt(1);
      const large = await runNativeAttempt(12);

      // The two attempts really did collect different amounts of material.
      expect(small.gmailDetails).toBe(1);
      expect(large.gmailDetails).toBe(12);

      // AC1: the membership generation is resolved a small constant number of
      // times, and that constant does not move with the item count.
      expect(large.membershipResolutions).toBe(small.membershipResolutions);
      expect(small.membershipResolutions).toBeLessThanOrEqual(
        MAX_MEMBERSHIP_RESOLUTIONS_PER_ATTEMPT,
      );

      // The authority path performs no read that is amplified more than once
      // per provider request. The accepted catalog was read twice per request
      // — once to decide identity and once to decide the endpoint — so this
      // bound is what a memo on the Clerk call alone would not have reached.
      const extraItems = large.gmailDetails - small.gmailDetails;
      expect(large.catalogReads - small.catalogReads).toBeLessThanOrEqual(
        extraItems,
      );
      expect(large.connectorReads - small.connectorReads).toBeLessThanOrEqual(
        extraItems,
      );
      expect(large.scheduleReads - small.scheduleReads).toBeLessThanOrEqual(
        extraItems,
      );
      expect(large.agentReads - small.agentReads).toBeLessThanOrEqual(
        extraItems,
      );

      // The local reads above and this one are the fence a membership
      // withdrawn mid-read is caught by, so they are deliberately still per
      // request. Each is a single indexed lookup, which is what makes keeping
      // them affordable once the live generation read is observed per phase.
      expect(large.membershipRowReads).toBeGreaterThan(
        small.membershipRowReads,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
