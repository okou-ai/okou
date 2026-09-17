import { randomUUID } from "node:crypto";

import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOrganizationFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  deleteBrowserAuthorizationRequestFixture,
  expireBrowserAuthorizationRequestFixture,
  holdBrowserAuthorizationRequestRowLockFixture,
  withBrowserAuthorizationApplyBarrierFixture,
} from "../../../test-fixtures/browser-authorization";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { browserAuthorizationRoutes } from "../browser-authorization";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-17T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
/** Polling a live PostgreSQL wait state, never a sleep standing in for one. */
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
/** Every case drives the real create and apply routes, real PostgreSQL and the
 * dormant B1 projector, and the barrier-driven ones additionally pause a real
 * transaction while a second session observes it. */
const CASE_TIMEOUT_MS = 30_000;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function authenticate(actor: ApiTestUser | null): { authorization?: string } {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

/** `signal` replaces the app-level request signal, which is how a caller
 * cancels this route. */
function authorizationClient(signal?: AbortSignal) {
  return setupApp({ context, routes: browserAuthorizationRoutes, signal })(
    browserAuthorizationRequestsContract,
  );
}

interface AuthorizationFixture {
  readonly actor: ApiTestUser;
  /** The canonical Agent owner. It is a second member of the same organization
   * whenever the case asks for a shared Agent, and the actor otherwise. */
  readonly owner: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly requestToken: string;
}

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Cloud browser authorization requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

async function createAuthorizationRequest(
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const created = await accept(
    authorizationClient().create({
      headers: {
        authorization: `Bearer ${runs.sandboxTokenForRun(actor, runId)}`,
      },
      body: {},
    }),
    [200],
  );
  const requestToken = decodeURIComponent(
    new URL(created.body.authorizationUrl).pathname.split("/").at(-1) ?? "",
  );
  if (!requestToken.startsWith("vm0_browser_authorization_request_")) {
    throw new Error("Expected an opaque authorization request token");
  }
  return requestToken;
}

/**
 * One chat run whose authorization link is outstanding. With `sharedAgent` the
 * Agent belongs to another member of the same organization from the moment it
 * is created, so the Agent owner is a user subject genuinely distinct from the
 * thread user before any request runs. A closure case can then never be
 * satisfied by an identity mismatch introduced by a later transfer instead of
 * by the shared admission.
 */
async function createAuthorizationFixture(options?: {
  readonly sharedAgent?: boolean;
}): Promise<AuthorizationFixture> {
  mockEnv("APP_URL", "https://app.okou.ai");
  const orgId = `org_${randomUUID()}`;
  const actor = orgScoped(bdd.user({ orgId }));
  const owner =
    options?.sharedAgent === true ? orgScoped(bdd.user({ orgId })) : actor;
  bdd.acceptAgentStorageWrites();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  // Shared visibility: a private Agent can only be run by its owner, so a
  // thread user distinct from the Agent owner cannot exist for one.
  const agent = await bdd.createAgent(owner, {
    displayName: `Browser authorization ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "Ask the user to enable a cloud browser",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected a chat run");
  }
  return {
    actor,
    owner,
    orgId,
    agentId: agent.agentId,
    threadId: sent.body.threadId,
    runId: sent.body.runId,
    requestToken: await createAuthorizationRequest(actor, sent.body.runId),
  };
}

/** Projects one dormant B1 closure and retires it with the test. */
function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

function applyAuthorization(
  fixture: AuthorizationFixture,
  statuses: readonly (200 | 400 | 401 | 403 | 404 | 410)[],
  options?: {
    readonly actor?: ApiTestUser | null;
    readonly requestToken?: string;
    readonly signal?: AbortSignal;
  },
) {
  const actor = options?.actor === undefined ? fixture.actor : options.actor;
  return accept(
    authorizationClient(options?.signal).apply({
      headers: authenticate(actor),
      params: { requestToken: options?.requestToken ?? fixture.requestToken },
      body: {},
    }),
    statuses,
  );
}

/** The request state its own read endpoint reports. */
async function readAuthorization(fixture: AuthorizationFixture): Promise<{
  readonly completedAt: string | null;
  readonly cloudBrowserEnabled: boolean;
}> {
  const response = await accept(
    authorizationClient().get({
      headers: authenticate(fixture.actor),
      params: { requestToken: fixture.requestToken },
    }),
    [200],
  );
  return {
    completedAt: response.body.completedAt,
    cloudBrowserEnabled: response.body.cloudBrowserEnabled,
  };
}

interface SidebarHostEvent {
  readonly seqId: number;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean | null;
}

/** The thread's own durable selection events, as a sidebar client reads them. */
async function sidebarHostEvents(
  fixture: AuthorizationFixture,
): Promise<readonly SidebarHostEvent[]> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events
    .filter((event) => {
      return (
        event.kind === "computer_use_host_updated" &&
        event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      // An absent key and a null flag both mean "no projected flag".
      return {
        seqId: event.seqId,
        computerUseHostId: event.computerUseHostId,
        cloudBrowserEnabled: event.cloudBrowserEnabled ?? null,
      };
    });
}

/** The highest durable sidebar sequence id this owner has consumed. */
async function lastSidebarSeqId(
  fixture: AuthorizationFixture,
): Promise<number> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events.reduce((highest, event) => {
    return Math.max(highest, event.seqId);
  }, 0);
}

/** The persisted selection a production metadata reader returns. */
async function readSelection(fixture: AuthorizationFixture): Promise<{
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return {
    computerUseHostId: metadata.computerUseHostId,
    cloudBrowserEnabled: metadata.cloudBrowserEnabled,
  };
}

/** The `threadListChanged` invalidations published so far, counted from a
 * cleared mock so an earlier setup write is never attributed to this request. */
function countThreadListInvalidations(): number {
  return context.mocks.ably.publish.mock.calls.filter((call) => {
    return call[0] === "threadListChanged";
  }).length;
}

/** Every observable effect an accepted apply would have produced. */
interface ApplyState {
  readonly selection: Awaited<ReturnType<typeof readSelection>>;
  readonly authorization: Awaited<ReturnType<typeof readAuthorization>>;
  readonly events: readonly SidebarHostEvent[];
  readonly lastSeqId: number;
}

async function readApplyState(
  fixture: AuthorizationFixture,
): Promise<ApplyState> {
  return {
    selection: await readSelection(fixture),
    authorization: await readAuthorization(fixture),
    events: await sidebarHostEvents(fixture),
    lastSeqId: await lastSidebarSeqId(fixture),
  };
}

async function expectUnchanged(
  fixture: AuthorizationFixture,
  before: ApplyState,
): Promise<void> {
  await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
}

/** The state an accepted apply leaves: the cloud browser on, any selected
 * Computer Use host cleared, one further durable event and a completion stamp. */
async function expectApplied(
  fixture: AuthorizationFixture,
  before: ApplyState,
): Promise<void> {
  const after = await readApplyState(fixture);
  expect(after.selection).toStrictEqual({
    computerUseHostId: null,
    cloudBrowserEnabled: true,
  });
  expect(after.authorization.completedAt).not.toBeNull();
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(after.events.at(-1)).toStrictEqual({
    seqId: before.lastSeqId + 1,
    computerUseHostId: null,
    cloudBrowserEnabled: true,
  });
}

describe("account erasure fences cloud browser authorization apply", () => {
  it(
    "denies apply for a closed thread user and leaves every durable effect alone",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      expect(before.selection).toStrictEqual({
        computerUseHostId: null,
        cloudBrowserEnabled: false,
      });
      expect(before.authorization.completedAt).toBeNull();

      const closed = await closeSubject({
        subjectKind: "user",
        subjectId: fixture.actor.userId,
      });
      context.mocks.ably.publish.mockClear();
      const denied = await applyAuthorization(fixture, [404]);
      expect(denied.status).toBe(404);
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);

      // The denied attempt consumed no durable sequence, so the next accepted
      // apply takes the very next sidebar sequence id.
      await removeErasureSubjectsFixture([closed.jobId]);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before);
    },
  );

  it(
    "denies apply for a closed distinct Agent owner and for a closed organization",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const shared = await createAuthorizationFixture({ sharedAgent: true });
      expect(shared.owner.userId).not.toBe(shared.actor.userId);
      const sharedBefore = await readApplyState(shared);
      await closeSubject({
        subjectKind: "user",
        subjectId: shared.owner.userId,
      });
      await applyAuthorization(shared, [404]);
      await expectUnchanged(shared, sharedBefore);

      const organization = await createAuthorizationFixture();
      const organizationBefore = await readApplyState(organization);
      await closeSubject({
        subjectKind: "organization",
        subjectId: organization.orgId,
      });
      await applyAuthorization(organization, [404]);
      await expectUnchanged(organization, organizationBefore);
    },
  );

  it(
    "keeps an unrelated eligible owner applying while another subject is closed",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const closed = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const closedBefore = await readApplyState(closed);
      const unrelatedBefore = await readApplyState(unrelated);
      await closeSubject({
        subjectKind: "user",
        subjectId: closed.actor.userId,
      });

      const denied = await applyAuthorization(closed, [404]);
      expect(denied.status).toBe(404);
      await expectUnchanged(closed, closedBefore);

      const accepted = await applyAuthorization(unrelated, [200]);
      expect(accepted.status).toBe(200);
      await expectApplied(unrelated, unrelatedBefore);
    },
  );

  it(
    "keeps a completed request from bypassing a later closure on repeat",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before);
      const completed = await readApplyState(fixture);

      // The token is not consumed by a first apply, so a completed request is
      // still a live writer; closure denies it like any other, rather than
      // letting it through as a harmless no-op.
      await closeSubject({
        subjectKind: "user",
        subjectId: fixture.actor.userId,
      });
      const denied = await applyAuthorization(fixture, [404]);
      expect(denied.status).toBe(404);
      await expectUnchanged(fixture, completed);
    },
  );

  it(
    "blocks an exclusive closure until the admitted apply commits while an unrelated owner keeps applying",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      context.mocks.ably.publish.mockClear();

      const closed = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200]);
            const settings = await barrier.entered;
            expect(settings.lockTimeout).toBe("1s");
            expect(settings.statementTimeout).toBe("5s");

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: fixture.actor.userId,
            });
            // The admitted apply holds its shared subject barrier with the
            // thread update, the durable sequence, the event and the completion
            // stamp already written, so the exclusive closure cannot commit
            // ahead of it.
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            // An independent reader still sees the pre-commit state and no
            // outbound invalidation has been published for it.
            await expectUnchanged(fixture, before);
            expect(countThreadListInvalidations()).toBe(0);

            // An unrelated owner is not serialized behind that barrier.
            await applyAuthorization(unrelated, [200]);
            await expectApplied(unrelated, unrelatedBefore);

            barrier.release();
            await applying;
            return await closing;
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });

      await flushWaitUntilForTest();
      await expectApplied(fixture, before);
      // Exactly one invalidation for this apply, published only after COMMIT.
      // The unrelated owner's accepted apply published the other.
      expect(countThreadListInvalidations()).toBe(2);

      // The closure landed behind the admitted write, so the next apply of the
      // same live token is denied and changes nothing.
      const applied = await readApplyState(fixture);
      await applyAuthorization(fixture, [404]);
      await expectUnchanged(fixture, applied);
    },
  );

  it(
    "re-resolves a transferred Agent owner under the locks instead of applying under a stale label",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const newOwner = `user_${randomUUID()}`;
      await closeSubject({ subjectKind: "user", subjectId: newOwner });

      const denied = await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [404]);
            await barrier.entered;
            await transferAgentOwnerFixture({
              agentId: fixture.agentId,
              owner: newOwner,
            });
            barrier.release();
            return await applying;
          },
        },
        context.signal,
      );

      expect(denied.status).toBe(404);
      await expectUnchanged(fixture, before);
    },
  );

  it(
    "refuses a stale request whose thread moved to another organization",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);

      // The request's own organization is no longer the thread's canonical
      // organization. Before this fence the UPDATE had no organization
      // predicate, so the apply committed and published a selection event under
      // the organization the request was minted in; it is now out of scope.
      await transferAgentOrganizationFixture({
        agentId: fixture.agentId,
        orgId: `org_${randomUUID()}`,
      });
      context.mocks.ably.publish.mockClear();
      await applyAuthorization(fixture, [404]);
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);
    },
  );

  it(
    "finds a thread deleted under the locks and applies nothing",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [404]);
            await barrier.entered;
            await chat.deleteThread(fixture.actor, fixture.threadId);
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );

      await chat.requestReadThread(fixture.actor, fixture.threadId, [404]);
      await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual([]);
    },
  );

  it(
    "rechecks a request that disappeared after the preflight without writing anything",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      context.mocks.ably.publish.mockClear();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "thread-lock",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [404]);
            await barrier.entered;
            await deleteBrowserAuthorizationRequestFixture(
              fixture.requestToken,
            );
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await flushWaitUntilForTest();

      // The revalidation runs before any content mutation, so a request that
      // vanished between the preflight and the write leaves no partial commit.
      await expect(readSelection(fixture)).resolves.toStrictEqual(
        before.selection,
      );
      await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(
        before.events,
      );
      expect(countThreadListInvalidations()).toBe(0);
    },
  );

  it(
    "rechecks a request that expired after the preflight without writing anything",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      context.mocks.ably.publish.mockClear();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "thread-lock",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [410]);
            await barrier.entered;
            await expireBrowserAuthorizationRequestFixture({
              requestToken: fixture.requestToken,
              expiresAt: new Date(STARTED_AT_MS - 1),
            });
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await flushWaitUntilForTest();

      await expect(readSelection(fixture)).resolves.toStrictEqual(
        before.selection,
      );
      await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(
        before.events,
      );
      expect(countThreadListInvalidations()).toBe(0);
    },
  );

  it(
    "rechecks expiry against a clock read after the request lock, not before it",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const peer = orgScoped(bdd.user({ orgId: fixture.orgId }));
      const before = await readApplyState(fixture);
      context.mocks.ably.publish.mockClear();

      // A second real session owns this exact request row, so the apply's own
      // `FOR NO KEY UPDATE` pin waits on a lock this test holds. The stored
      // `expires_at` is never touched: the request is live when the apply
      // starts and lapses only because the clock moves while that wait is
      // outstanding, which is the window a reading taken before the pin cannot
      // see.
      const holder = await holdBrowserAuthorizationRequestRowLockFixture({
        requestToken: fixture.requestToken,
        signal: context.signal,
      });
      const applying = applyAuthorization(fixture, [410]);
      // `pg_blocking_pids` reporting the pin itself is what proves this exact
      // apply reached the request lock before the clock moved.
      await expect
        .poll(holder.blockedRequestPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      mockNow(STARTED_AT_MS + HOUR_MS + 1);
      holder.release();
      await holder.done;
      await applying;

      // A lapsed request keeps token and ownership ahead of its own expiry:
      // neither another member nor an unknown token learns that it exists.
      await applyAuthorization(fixture, [404], { actor: peer });
      await applyAuthorization(fixture, [404], {
        requestToken: `vm0_browser_authorization_request_${randomUUID()}`,
      });

      // Only this test's clock moved. Restoring it lets the unchanged read
      // endpoint report the request's own `completed_at` instead of refusing
      // it as lapsed.
      mockNow(STARTED_AT_MS);
      await flushWaitUntilForTest();
      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);

      // The unexpired control: a later link minted from the same run waits on
      // the very same pin and still applies. A wait is not an expiry, and the
      // accepted apply takes the sidebar sequence id the denial never consumed.
      const later = {
        ...fixture,
        requestToken: await createAuthorizationRequest(
          fixture.actor,
          fixture.runId,
        ),
      };
      const laterBefore = await readApplyState(later);
      expect(laterBefore.lastSeqId).toBe(before.lastSeqId);
      const laterHolder = await holdBrowserAuthorizationRequestRowLockFixture({
        requestToken: later.requestToken,
        signal: context.signal,
      });
      const applyingLater = applyAuthorization(later, [200]);
      await expect
        .poll(laterHolder.blockedRequestPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      laterHolder.release();
      await laterHolder.done;
      await applyingLater;
      await expectApplied(later, laterBefore);
    },
  );

  it(
    "holds the pinned request's own result while the clock lapses and writes nothing",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      context.mocks.ably.publish.mockClear();

      await withBrowserAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "request-pin",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [410]);
            const pinned = await barrier.entered;
            // The pin matched the live request row and holds it, and its result
            // has not reached the service yet, so the same lapse is observed
            // with the backend idle and no budget of its own running.
            expect(pinned.rowCount).toBe(1);

            mockNow(STARTED_AT_MS + HOUR_MS + 1);
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      mockNow(STARTED_AT_MS);
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);
    },
  );

  it(
    "pins the request row so it cannot be removed between validation and completion",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);

      await withBrowserAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "request-pin",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200]);
            const pinned = await barrier.entered;
            // The revalidation matched the live request row and holds it.
            expect(pinned.rowCount).toBe(1);

            const removing = deleteBrowserAuthorizationRequestFixture(
              fixture.requestToken,
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            await applying;
            // The removal could only land after this apply committed, so it
            // never interleaved between the validation and the completion.
            await removing;
          },
        },
        context.signal,
      );

      await expect(readSelection(fixture)).resolves.toStrictEqual({
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      });
      await expect(sidebarHostEvents(fixture)).resolves.toHaveLength(
        before.events.length + 1,
      );
    },
  );

  it(
    "rolls the thread update, sidebar event, sequence and completion back on a late failure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);

      // Holding the very next `(user_id, org_id, seq_id)` slot makes the event
      // insert block: it runs after the thread UPDATE and after the durable
      // sequence reservation, so the transaction fails on its own bounded
      // budget with those writes already executed and COMMIT never sent.
      const holder = await holdChatThreadEventIdFixture({
        seqId: before.lastSeqId + 1,
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
        chatThreadId: fixture.threadId,
        signal: context.signal,
      });
      context.mocks.ably.publish.mockClear();
      // A genuine transaction failure is neither the accepted 200 nor the
      // closure 404.
      await expect(applyAuthorization(fixture, [200, 404])).rejects.toThrow(
        /Unknown response status 500/,
      );
      holder.release();
      await holder.done;
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);

      // The reserved sequence rolled back with it: the next accepted apply
      // still takes the id this attempt had already allocated for itself.
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before);
    },
  );

  it(
    "rolls an executed apply back when the operation is cancelled before COMMIT",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const cancelled = new AbortController();
      context.mocks.ably.publish.mockClear();

      await withBrowserAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "completion",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200, 404], {
              signal: cancelled.signal,
            });
            const completed = await barrier.entered;
            // The completion stamp is the write's last statement, so this pause
            // proves the thread update, the durable sequence, the event and the
            // completion all executed and are still uncommitted.
            expect(completed.rowCount).toBe(1);

            // Real server-side cancellation of the operation, not an abandoned
            // client fetch: the writer's own pre-COMMIT check observes it and
            // rolls the executed statements back.
            cancelled.abort();
            barrier.release();
            await expect(applying).rejects.toThrow(
              /Unknown response status 500/,
            );
          },
        },
        context.signal,
      );
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expect(countThreadListInvalidations()).toBe(0);
    },
  );

  it(
    "propagates a held parent lock as a failure rather than a closure 404",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);

      const holder = await holdChatThreadRowLockFixture({
        threadId: fixture.threadId,
        signal: context.signal,
      });
      // Neither the accepted 200 nor the closure 404: a real blocked parent
      // lock keeps its own database failure instead of being reported as
      // erasure.
      await expect(applyAuthorization(fixture, [200, 404])).rejects.toThrow(
        /Unknown response status 500/,
      );
      holder.release();
      await holder.done;

      await expectUnchanged(fixture, before);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before);
    },
  );

  it(
    "keeps the token, ownership, expiry and Agent dispositions unchanged",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const foreign = await createAuthorizationFixture();
      const peer = orgScoped(bdd.user({ orgId: fixture.orgId }));

      // An unknown token, another user's token and an unauthenticated caller.
      await applyAuthorization(fixture, [404], {
        requestToken: `vm0_browser_authorization_request_${randomUUID()}`,
      });
      await applyAuthorization(fixture, [404], { actor: peer });
      await applyAuthorization(fixture, [404], { actor: foreign.actor });
      await applyAuthorization(fixture, [401], { actor: null });
      // The same token from an organization-less session keeps the 401 the
      // route's unchanged `requireOrganization` produces, not a 404.
      await applyAuthorization(fixture, [401], {
        actor: bdd.user({ orgId: null }),
      });
      await expectUnchanged(fixture, before);

      // A thread without an Agent keeps the scope-not-found disposition.
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: null,
      });
      await applyAuthorization(fixture, [404]);
      await expect(sidebarHostEvents(fixture)).resolves.toStrictEqual(
        before.events,
      );

      // A lapsed TTL is still 410, evaluated before any scope decision.
      mockNow(STARTED_AT_MS + HOUR_MS + 1);
      await applyAuthorization(fixture, [410]);
      await applyAuthorization(foreign, [410]);
    },
  );

  it(
    "keeps run-token creation, host clearing and repeat apply working beside the fence",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const host = await computerUse.startComputerUseHost(fixture.actor);
      await chat.updateThreadComputerUseHost(
        fixture.actor,
        fixture.threadId,
        host.hostId,
      );
      await expect(readSelection(fixture)).resolves.toStrictEqual({
        computerUseHostId: host.hostId,
        cloudBrowserEnabled: false,
      });
      const before = await readApplyState(fixture);

      const applied = await applyAuthorization(fixture, [200]);
      expect(applied.body).toStrictEqual({
        ok: true,
        cloudBrowserEnabled: true,
      });
      // Approving the link clears the selected Computer Use host and turns the
      // cloud browser on, in one durable event.
      await expectApplied(fixture, before);
      await expect(readAuthorization(fixture)).resolves.toStrictEqual({
        completedAt: new Date(STARTED_AT_MS).toISOString(),
        cloudBrowserEnabled: true,
      });

      // Repeat apply is unchanged: the token is not one-shot, so the same link
      // applies again and appends its own durable event.
      const completed = await readApplyState(fixture);
      const repeated = await applyAuthorization(fixture, [200]);
      expect(repeated.body).toStrictEqual({
        ok: true,
        cloudBrowserEnabled: true,
      });
      await expectApplied(fixture, completed);

      // A second link minted from the same run still works.
      const second = {
        ...fixture,
        requestToken: await createAuthorizationRequest(
          fixture.actor,
          fixture.runId,
        ),
      };
      const secondBefore = await readApplyState(second);
      expect(secondBefore.authorization.completedAt).toBeNull();
      await applyAuthorization(second, [200]);
      await expectApplied(second, secondBefore);
    },
  );
});
