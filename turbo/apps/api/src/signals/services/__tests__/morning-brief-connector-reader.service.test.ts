import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { delay } from "signal-timers";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { installMorningBriefFixture } from "../../../test-fixtures/morning-brief-gmail-collection";
import { clerk$ } from "../../external/clerk";
import {
  createBddApi,
  type ApiTestUser,
} from "../../routes/__tests__/helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "../../routes/__tests__/helpers/api-bdd-connectors";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "../../routes/__tests__/helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "../../routes/__tests__/helpers/feature-switches";
import { seedOrgMembership$ } from "../../routes/__tests__/helpers/org-membership";
import {
  createDeferredPromise,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../../utils";
import {
  admitMorningBriefCollection,
  startMorningBriefSourceDeadline,
  type MorningBriefSourceDeadline,
} from "../morning-brief-connector-reader.service";
import { collectMorningBriefGmail } from "../morning-brief-gmail-collection.service";

/**
 * The source deadline and the caller's cancellation reaching a provider body
 * that is already streaming.
 *
 * Every other reader contract is proven through the Gmail preview endpoint.
 * This one cannot be: the source budget is a deployed 20-second constant rather
 * than a request input, a test cannot wait it out, and adding a production
 * parameter or endpoint to shorten it would ship a debug surface instead of a
 * contract. So this suite drives the exact composition the route performs —
 * `admitMorningBriefCollection` then `collectMorningBriefGmail`, in that order,
 * returning the same envelope the route answers with — and supplies the real
 * budget argument with a value it can spend. Authorization, the database and
 * the provider HTTP boundary all stay the deployed ones.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
/** The collector's own concurrency, which bounds how many bodies can be open. */
const READER_CONCURRENCY = 3;
/** Short enough to expire while a provider body is still open. */
const SOURCE_BUDGET_MS = 3000;
/** The deployed budget, for the case where the deadline must not be the actor. */
const DEPLOYED_SOURCE_BUDGET_MS = 20_000;
/** Room for the real budget above plus this suite's ordinary fixture setup. */
const TEST_TIMEOUT_MS = 30_000;
/** How long one socket lags its siblings while tearing down. */
const SLOW_TEARDOWN_MS = 150;

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

/** Finish a socket's teardown a known step behind its siblings. */
async function lateTeardown(
  tearDown: () => void,
  signal: AbortSignal,
): Promise<void> {
  await delay(SLOW_TEARDOWN_MS, { signal });
  tearDown();
}

interface GmailStub {
  readonly detailCalls: () => number;
  /** Bodies whose transport has finished tearing down. */
  readonly settledBodies: () => number;
}

/**
 * A Gmail whose message bodies open, deliver one chunk and never finish.
 *
 * The body is failed with the client's own abort reason, because a real socket
 * is what breaks a delivered body when its request is aborted and the mocked
 * transport does not do that by itself. The reason is always the request's,
 * never an invented one, so the reader still tells its own timeout from its
 * caller's cancellation by what actually aborted. No `Content-Length` is
 * advertised, so the bounded reader takes its streaming path rather than
 * refusing the response up front.
 */
function stubStallingGmail(
  messageIds: readonly string[],
  options: { readonly slowTeardownId?: string } = {},
): GmailStub {
  let detailCalls = 0;
  let settledBodies = 0;
  server.use(
    http.get(GMAIL_LIST_URL, ({ request }) => {
      const query = new URL(request.url).searchParams.get("q") ?? "";
      return HttpResponse.json({
        messages:
          query === "is:unread"
            ? []
            : messageIds.map((id) => {
                return { id, threadId: `thread-${id}` };
              }),
      });
    }),
    http.get(GMAIL_MESSAGE_URL, ({ request, params }) => {
      detailCalls += 1;
      const messageId = String(params["messageId"]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"'));
          request.signal.addEventListener("abort", () => {
            const tearDown = () => {
              settledBodies += 1;
              controller.error(request.signal.reason);
            };
            // One socket is allowed to finish tearing down after its siblings.
            // A join that propagates the first rejection would let the public
            // operation complete while this one was still unravelling.
            if (messageId === options.slowTeardownId) {
              startUntrackedBestEffortCleanup(
                lateTeardown(tearDown, context.signal),
              );
              return;
            }
            tearDown();
          });
        },
      });
      return new HttpResponse(stream, {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return {
    detailCalls: () => {
      return detailCalls;
    },
    settledBodies: () => {
      return settledBodies;
    },
  };
}

/**
 * Hold the next live membership read, which is the preflight's own.
 *
 * `admitMorningBriefCollection` is the first thing here to ask the membership
 * authority who this member currently is. Seeding a membership reinstalls this
 * mock, so the hold wraps whatever implementation is current and delegates to
 * it once released.
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

/** Wait for a known number of provider arrivals, never for a duration. */
async function waitForOpenBodies(
  stub: GmailStub,
  count: number,
): Promise<void> {
  await expect.poll(stub.detailCalls, { timeout: 10_000 }).toBe(count);
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
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
  await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
  // Message bodies are not allowed by default, so an open body needs a grant.
  await runsApi.applyUserPermissionGrant(actor, {
    agentId,
    connectorSlug: "gmail",
    permission: "messages.detail",
    action: "allow",
  });
  await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  await store.set(
    seedOrgMembership$,
    {
      orgId: actor.orgId,
      userId: actor.userId,
      role: "admin",
      membershipId: `orgmem_${randomUUID()}`,
    },
    context.signal,
  );
  return { actor: { ...actor, orgId: actor.orgId } };
}

/** The route's own preflight, with a budget this test can spend. */
async function admitWithSourceBudget(
  fixture: Fixture,
  deadline: MorningBriefSourceDeadline,
  signal: AbortSignal,
) {
  return await admitMorningBriefCollection(
    {
      db: db(),
      clerk: store.get(clerk$),
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
      anchor: new Date(ANCHOR_ISO),
      deadline,
    },
    signal,
  );
}

/** The route's own composition, with a budget this test can spend. */
async function collectWithSourceBudget(
  fixture: Fixture,
  budgetMs: number,
  signal: AbortSignal,
) {
  const deadline = startMorningBriefSourceDeadline(budgetMs);
  const admission = await admitWithSourceBudget(fixture, deadline, signal);
  if (admission.kind !== "ok") {
    throw new Error(`Expected admission, received ${admission.reason}`);
  }
  return await collectMorningBriefGmail(
    { db: db(), clerk: store.get(clerk$), scope: admission.scope, deadline },
    signal,
  );
}

beforeEach(async () => {
  await installApiTestConnectorCatalog();
});

describe("Morning Brief source deadline and cancellation in flight", () => {
  it(
    "reports the source deadline that fired while provider bodies were streaming",
    async () => {
      const fixture = await setupOwner();
      // One more candidate than the concurrency, so a refused next request
      // would be visible as a fourth arrival.
      const stub = stubStallingGmail([
        "stalled-1",
        "stalled-2",
        "stalled-3",
        "stalled-4",
      ]);

      const startedAt = now();
      const collection = collectWithSourceBudget(
        fixture,
        SOURCE_BUDGET_MS,
        context.signal,
      );
      // Exactly the reader's concurrency is open and mid-stream when the wall
      // clock runs out; this is the body deadline, not a refused next page.
      await waitForOpenBodies(stub, READER_CONCURRENCY);

      const response = await collection;
      const elapsed = now() - startedAt;
      expect(stub.detailCalls()).toBe(READER_CONCURRENCY);
      // These bodies never finish on their own, so the invocation returning at
      // all is the deadline reaching work already in flight. It returns the
      // documented source outcome, not a provider failure and not an empty day.
      expect(elapsed).toBeGreaterThanOrEqual(SOURCE_BUDGET_MS);
      expect(elapsed).toBeLessThan(SOURCE_BUDGET_MS * 3);
      expect(response).toMatchObject({
        source: "gmail",
        status: "unavailable",
        failure: "deadline-exceeded",
        items: [],
      });
      // The budget above is real wall-clock time, so this case needs more than
      // the default per-test allowance.
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps caller cancellation a cancellation rather than a source failure",
    async () => {
      const fixture = await setupOwner();
      const stub = stubStallingGmail(["stalled-1", "stalled-2", "stalled-3"], {
        slowTeardownId: "stalled-3",
      });
      const caller = new AbortController();

      const collection = collectWithSourceBudget(
        fixture,
        DEPLOYED_SOURCE_BUDGET_MS,
        caller.signal,
      );
      await waitForOpenBodies(stub, READER_CONCURRENCY);
      caller.abort();

      // Read the settled count at the instant the operation completes, not
      // afterwards: the question is whether it waited, not whether the sockets
      // eventually closed.
      const settledWhenComplete = collection.then(
        () => {
          return stub.settledBodies();
        },
        () => {
          return stub.settledBodies();
        },
      );

      // Cancellation stays cancellation: it never resolves into an envelope
      // claiming the source failed or had nothing to report, and the deadline
      // is nowhere near. Every sibling body is joined before the failure
      // propagates, so none of their rejections is left unobserved.
      const settled = await settleIncludingAbort(collection);
      expect(settled).toMatchObject({
        ok: false,
        error: { name: "AbortError" },
      });
      expect(stub.detailCalls()).toBe(READER_CONCURRENCY);
      // Every started body had finished tearing down before the caller's
      // cancellation surfaced, including the one whose socket lagged. A join
      // that propagated the first rejection would have completed with that one
      // still unravelling.
      await expect(settledWhenComplete).resolves.toBe(READER_CONCURRENCY);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a preflight whose source budget expired while a membership answer was held",
    async () => {
      const fixture = await setupOwner();
      const stub = stubStallingGmail(["never-read"]);
      const release = createDeferredPromise<void>(context.signal);
      const membership = holdNextMembershipRead(release.promise);
      const deadline = startMorningBriefSourceDeadline(SOURCE_BUDGET_MS);

      const admission = admitWithSourceBudget(
        fixture,
        deadline,
        context.signal,
      );
      await membership.arrived;
      // Let the source's real budget run out while the membership authority is
      // still answering, then release it.
      await delay(SOURCE_BUDGET_MS + 250, { signal: context.signal });
      release.resolve();

      // The spent budget is its own outcome: not a refusal of authority this
      // member could act on, and not a cancellation.
      await expect(admission).resolves.toStrictEqual({
        kind: "unavailable",
        reason: "deadline-exceeded",
      });
      // Nothing was retried and no source was read under the expired budget.
      expect(membership.calls()).toBe(1);
      expect(stub.detailCalls()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it("keeps a cancelled preflight a cancellation, not an expired budget", async () => {
    const fixture = await setupOwner();
    const stub = stubStallingGmail(["never-read"]);
    const release = createDeferredPromise<void>(context.signal);
    const membership = holdNextMembershipRead(release.promise);
    const caller = new AbortController();
    const deadline = startMorningBriefSourceDeadline(DEPLOYED_SOURCE_BUDGET_MS);

    const admission = settleIncludingAbort(
      admitWithSourceBudget(fixture, deadline, caller.signal),
    );
    await membership.arrived;
    caller.abort();
    release.resolve();

    // The budget is nowhere near spent, so the same held answer surfaces as the
    // caller's cancellation rather than as a source timeout.
    await expect(admission).resolves.toMatchObject({
      ok: false,
      error: { name: "AbortError" },
    });
    expect(stub.detailCalls()).toBe(0);
  });
});
