import { randomUUID } from "node:crypto";

import { computerUseAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/computer-use";
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
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  computerUseAuthorizationApplyErasureJobExistsFixture,
  failComputerUseAuthorizationCompletionFixture,
  holdComputerUseAuthorizationApplyThreadRowFixture,
  holdComputerUseAuthorizationRequestRowFixture,
  mutateComputerUseAuthorizationRequestFixture,
  readComputerUseAuthorizationRequestByIdFixture,
  withComputerUseAuthorizationApplyBarrierFixture,
} from "../../../test-fixtures/computer-use-authorization-apply";
import {
  readComputerUseAuthorizationRequestFixture,
  setComputerUseAuthorizationRunTriggerFixture,
} from "../../../test-fixtures/computer-use-authorization";
import {
  readChatThreadTitleStateFixture,
  setChatThreadAgentFixture,
  setChatThreadUserFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { isAbortError, settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  channelsPublishedTo,
  countPublishedTo,
  userOrgChannelName,
} from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { computerUseAuthorizationRoutes } from "../computer-use-authorization";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

type OwnedOperationOutcome<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

function ownSuccessfulOperations(signal: AbortSignal): {
  readonly start: <T>(operation: Promise<T>) => Promise<T>;
  readonly startOwned: <T>(operation: Promise<T>) => void;
  readonly finish: () => Promise<void>;
} {
  const outcomes: Promise<OwnedOperationOutcome>[] = [];
  const startOwned = <T>(operation: Promise<T>) => {
    outcomes.push(settleIncludingAbort(operation));
  };
  const finish = async () => {
    const settled = await Promise.all(outcomes);
    const errors = settled.flatMap((outcome) => {
      if (outcome.ok || (signal.aborted && isAbortError(outcome.error))) {
        return [];
      }
      return [outcome.error];
    });
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Computer Use Apply owned operations failed",
      );
    }
  };
  onTestFinished(finish);
  return {
    start: <T>(operation: Promise<T>) => {
      startOwned(operation);
      return operation;
    },
    startOwned,
    finish,
  };
}

function ownRejectedOperation<T>(
  operation: Promise<T>,
  expectedMessage: RegExp,
): { readonly finish: () => Promise<void> } {
  const outcome = settleIncludingAbort(operation);
  let finished: Promise<void> | undefined;
  const finish = () => {
    finished ??= (async () => {
      const result = await outcome;
      if (result.ok) {
        throw new Error("Expected the owned operation to reject");
      }
      expect(result.error).toStrictEqual(
        expect.objectContaining({
          message: expect.stringMatching(expectedMessage),
        }),
      );
    })();
    return finished;
  };
  onTestFinished(finish);
  return { finish };
}

interface OwnedSubjectClosure {
  readonly closing: Promise<{ readonly jobId: string }>;
  readonly cleanup: () => Promise<void>;
}

function startSubjectClosure(subject: ErasureSubject): OwnedSubjectClosure {
  const closing = closeErasureSubjectFixture(subject);
  const outcome = settleIncludingAbort(closing);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      const result = await outcome;
      if (!result.ok) {
        throw result.error;
      }
      await removeErasureSubjectsFixture([result.value.jobId]);
    })();
    return cleanupPromise;
  };
  onTestFinished(cleanup);
  return { closing, cleanup };
}

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

function authorizationClient(signal?: AbortSignal) {
  return setupApp({ context, routes: computerUseAuthorizationRoutes, signal })(
    computerUseAuthorizationRequestsContract,
  );
}

interface AuthorizationRunFixture {
  readonly actor: ApiTestUser;
  readonly owner: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly runId: string;
}

interface AuthorizationFixture extends AuthorizationRunFixture {
  readonly requestToken: string;
  readonly requestId: string;
  readonly hostId: string;
}

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use authorization requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

async function createAuthorizationRunFixture(options?: {
  readonly sharedAgent?: boolean;
}): Promise<AuthorizationRunFixture> {
  mockEnv("APP_URL", "https://app.okou.ai");
  const orgId = `org_${randomUUID()}`;
  const actor = orgScoped(bdd.user({ orgId }));
  const owner = options?.sharedAgent ? orgScoped(bdd.user({ orgId })) : actor;
  bdd.acceptAgentStorageWrites();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(owner, {
    displayName: `Computer Use Apply ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "Ask the user to authorize Computer Use",
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
  };
}

function requestTokenFromUrl(authorizationUrl: string): string {
  return decodeURIComponent(
    new URL(authorizationUrl).pathname.split("/").at(-1) ?? "",
  );
}

async function createRequest(
  fixture: AuthorizationRunFixture,
): Promise<{ readonly requestToken: string; readonly requestId: string }> {
  const created = await computerUse.createComputerUseAuthorizationRequest({
    bearer: runs.sandboxTokenForRun(fixture.actor, fixture.runId),
  });
  expect(created.source).toBe("chat");
  const requestToken = requestTokenFromUrl(created.authorizationUrl);
  const row = await readComputerUseAuthorizationRequestFixture(requestToken);
  if (!row) {
    throw new Error("Expected a persisted authorization request");
  }
  return { requestToken, requestId: row.id };
}

async function createAuthorizationFixture(options?: {
  readonly sharedAgent?: boolean;
  readonly triggerSource?: "slack" | "teams";
}): Promise<AuthorizationFixture> {
  const fixture = await createAuthorizationRunFixture(options);
  if (options?.triggerSource) {
    await setComputerUseAuthorizationRunTriggerFixture(
      fixture.runId,
      options.triggerSource,
    );
  }
  const host = await computerUse.startComputerUseHost(fixture.actor);
  const request = await createRequest(fixture);
  clearPublications();
  return { ...fixture, ...request, hostId: host.hostId };
}

function applyAuthorization(
  fixture: AuthorizationFixture,
  statuses: readonly (200 | 400 | 401 | 403 | 404 | 410)[],
  options?: {
    readonly actor?: ApiTestUser | null;
    readonly requestToken?: string;
    readonly hostId?: string;
    readonly signal?: AbortSignal;
  },
) {
  const actor = options?.actor === undefined ? fixture.actor : options.actor;
  return accept(
    authorizationClient(options?.signal).apply({
      headers: authenticate(actor),
      params: { requestToken: options?.requestToken ?? fixture.requestToken },
      body: { computerUseHostId: options?.hostId ?? fixture.hostId },
    }),
    statuses,
  );
}

interface SidebarHostEvent {
  readonly seqId: number;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean | null;
  readonly createdAt: string;
}

async function sidebarHostEvents(
  fixture: AuthorizationRunFixture,
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
      return {
        seqId: event.seqId,
        computerUseHostId: event.computerUseHostId,
        cloudBrowserEnabled: event.cloudBrowserEnabled ?? null,
        createdAt: event.createdAt,
      };
    });
}

async function threadDeletionEventCount(
  fixture: AuthorizationRunFixture,
): Promise<number> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events.filter((event) => {
    return event.kind === "deleted" && event.chatThreadId === fixture.threadId;
  }).length;
}

async function lastSidebarSeqId(
  fixture: AuthorizationRunFixture,
): Promise<number> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events.reduce((highest, event) => {
    return Math.max(highest, event.seqId);
  }, 0);
}

async function readSelection(fixture: AuthorizationRunFixture): Promise<{
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

async function readAuthorization(fixture: AuthorizationFixture): Promise<{
  readonly completedAt: string | null;
  readonly computerUseHostId: string | null;
}> {
  const response = await computerUse.readComputerUseAuthorizationRequest(
    fixture.actor,
    fixture.requestToken,
  );
  return {
    completedAt: response.completedAt,
    computerUseHostId: response.computerUseHostId,
  };
}

interface ApplyState {
  readonly selection: Awaited<ReturnType<typeof readSelection>>;
  readonly authorization: Awaited<ReturnType<typeof readAuthorization>>;
  readonly events: readonly SidebarHostEvent[];
  readonly lastSeqId: number;
  readonly threadUpdatedAt: string;
  readonly requestUpdatedAt: string;
}

/**
 * Projects durable Apply state without invoking the independently fenced GET.
 * These race tests inspect MVCC state while Apply or closure deliberately owns
 * a row lock; public GET is now expected to wait or deny at that boundary.
 */
function durableAuthorization(
  request: NonNullable<
    Awaited<ReturnType<typeof readComputerUseAuthorizationRequestFixture>>
  >,
  selection: Awaited<ReturnType<typeof readSelection>>,
): Awaited<ReturnType<typeof readAuthorization>> {
  return {
    completedAt: request.completedAt,
    computerUseHostId: request.completedAt ? selection.computerUseHostId : null,
  };
}

async function readApplyState(
  fixture: AuthorizationFixture,
): Promise<ApplyState> {
  const thread = await readChatThreadTitleStateFixture(fixture.threadId);
  const request = await readComputerUseAuthorizationRequestFixture(
    fixture.requestToken,
  );
  if (!request) {
    throw new Error("Expected the authorization request row");
  }
  const selection = await readSelection(fixture);
  return {
    selection,
    authorization: durableAuthorization(request, selection),
    events: await sidebarHostEvents(fixture),
    lastSeqId: await lastSidebarSeqId(fixture),
    threadUpdatedAt: thread.updatedAt,
    requestUpdatedAt: request.updatedAt,
  };
}

async function readThreadEffects(fixture: AuthorizationFixture) {
  const thread = await readChatThreadTitleStateFixture(fixture.threadId);
  return {
    selection: await readSelection(fixture),
    events: await sidebarHostEvents(fixture),
    lastSeqId: await lastSidebarSeqId(fixture),
    threadUpdatedAt: thread.updatedAt,
  };
}

function clearPublications(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function threadListInvalidations(fixture: AuthorizationRunFixture): number {
  return countPublishedTo(context.mocks, {
    channel: userOrgChannelName({
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
    }),
    topic: "threadListChanged",
  });
}

function threadListInvalidationChannels(): readonly string[] {
  return channelsPublishedTo(context.mocks, "threadListChanged");
}

function expectNoInvalidation(fixture: AuthorizationRunFixture): void {
  expect(threadListInvalidations(fixture)).toBe(0);
  expect(threadListInvalidationChannels()).toStrictEqual([]);
}

function expectOneInvalidation(fixture: AuthorizationRunFixture): void {
  expect(threadListInvalidations(fixture)).toBe(1);
  expect(threadListInvalidationChannels()).toStrictEqual([
    userOrgChannelName({
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
    }),
  ]);
}

function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  return startSubjectClosure(subject).closing;
}

async function expectApplied(
  fixture: AuthorizationFixture,
  before: ApplyState,
  appliedAtMs: number,
  eventCount = 1,
): Promise<void> {
  const appliedAt = new Date(appliedAtMs).toISOString();
  const after = await readApplyState(fixture);
  expect(after.selection).toStrictEqual({
    computerUseHostId: fixture.hostId,
    cloudBrowserEnabled: false,
  });
  expect(after.authorization).toStrictEqual({
    completedAt: appliedAt,
    computerUseHostId: fixture.hostId,
  });
  expect(after.events).toHaveLength(before.events.length + eventCount);
  expect(after.events.at(-1)).toStrictEqual({
    seqId: before.lastSeqId + eventCount,
    computerUseHostId: fixture.hostId,
    cloudBrowserEnabled: false,
    createdAt: appliedAt,
  });
  expect(after.lastSeqId).toBe(before.lastSeqId + eventCount);
  expect(after.threadUpdatedAt).toBe(appliedAt);
  expect(after.requestUpdatedAt).toBe(appliedAt);
}

async function exerciseClosure(
  fixture: AuthorizationFixture,
  subject: ErasureSubject,
): Promise<void> {
  const firstAppliedAt = STARTED_AT_MS + 1000;
  mockNow(firstAppliedAt);
  const initial = await readApplyState(fixture);
  await applyAuthorization(fixture, [200]);
  await expectApplied(fixture, initial, firstAppliedAt);
  const baseline = await readApplyState(fixture);

  const closed = await closeSubject(subject);
  mockNow(STARTED_AT_MS + 2000);
  clearPublications();
  const denied = await applyAuthorization(fixture, [404]);
  expect(denied.status).toBe(404);
  await expect(readApplyState(fixture)).resolves.toStrictEqual(baseline);
  expectNoInvalidation(fixture);

  await removeErasureSubjectsFixture([closed.jobId]);
  const restoredAt = STARTED_AT_MS + 3000;
  mockNow(restoredAt);
  const restored = await applyAuthorization(fixture, [200]);
  expect(restored.body).toStrictEqual({
    ok: true,
    source: "chat",
    computerUseHostId: fixture.hostId,
  });
  await expectApplied(fixture, baseline, restoredAt);
  expectOneInvalidation(fixture);
}

describe("account erasure fences canonical Computer Use authorization Apply", () => {
  it(
    "applies web, Slack and Teams canonical creation through source chat",
    { timeout: 60_000 },
    async () => {
      for (const triggerSource of [undefined, "slack", "teams"] as const) {
        const fixture = await createAuthorizationFixture(
          triggerSource ? { triggerSource } : undefined,
        );
        const before = await readApplyState(fixture);
        clearPublications();
        const applied = await applyAuthorization(fixture, [200]);
        expect(applied.body).toStrictEqual({
          ok: true,
          source: "chat",
          computerUseHostId: fixture.hostId,
        });
        await expectApplied(fixture, before, STARTED_AT_MS);
        expectOneInvalidation(fixture);
      }
    },
  );

  it(
    "admits, closes and restores the thread user without consuming denied state",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      expect(fixture.actor.userId).toBeTruthy();
      await exerciseClosure(fixture, {
        subjectKind: "user",
        subjectId: fixture.actor.userId,
      });
    },
  );

  it(
    "admits, closes and restores a genuine distinct shared-Agent owner",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture({ sharedAgent: true });
      expect(fixture.owner.userId).not.toBe(fixture.actor.userId);
      await exerciseClosure(fixture, {
        subjectKind: "user",
        subjectId: fixture.owner.userId,
      });
    },
  );

  it(
    "admits, closes and restores the canonical Agent organization",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      expect(fixture.orgId).toBeTruthy();
      await exerciseClosure(fixture, {
        subjectKind: "organization",
        subjectId: fixture.orgId,
      });
    },
  );

  it(
    "joins Apply and closure work after an expected early exit",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await expect(
        holdComputerUseAuthorizationApplyThreadRowFixture({
          chatThreadId: randomUUID(),
          signal: context.signal,
        }),
      ).rejects.toThrow("Expected the Computer Use Apply thread row");

      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const operations = ownSuccessfulOperations(context.signal);
      const expectedEarlyExit = new Error("Expected Apply fixture early exit");
      let closure: OwnedSubjectClosure | undefined;
      clearPublications();

      const work = await settleIncludingAbort(
        withComputerUseAuthorizationApplyBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            stopAt: "thread-update",
            work: async (barrier) => {
              operations.startOwned(applyAuthorization(fixture, [200]));
              const updated = await barrier.entered;
              expect(updated.rowCount).toBe(1);
              closure = startSubjectClosure({
                subjectKind: "user",
                subjectId: fixture.actor.userId,
              });
              await expect
                .poll(barrier.blockedWaiterCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);
              throw expectedEarlyExit;
            },
          },
          context.signal,
        ),
      );
      const cleanup = await settleIncludingAbort(
        (async () => {
          await operations.finish();
          if (!closure) {
            throw new Error("Expected the owned closure to start");
          }
          const closed = await closure.closing;
          await closure.cleanup();
          await expect(
            computerUseAuthorizationApplyErasureJobExistsFixture(closed.jobId),
          ).resolves.toBeFalsy();
        })(),
      );
      if (work.ok) {
        throw new Error("Expected the Apply fixture to exit early");
      }
      if (!cleanup.ok) {
        throw new AggregateError(
          [work.error, cleanup.error],
          "Apply fixture work and cleanup both failed",
        );
      }
      expect(work.error).toBe(expectedEarlyExit);

      await expectApplied(fixture, before, STARTED_AT_MS);
      expectOneInvalidation(fixture);
      const probe = await holdComputerUseAuthorizationApplyThreadRowFixture({
        chatThreadId: fixture.threadId,
        signal: context.signal,
      });
      await probe.release();

      const committed = await readApplyState(fixture);
      const repeatedAt = STARTED_AT_MS + 1000;
      mockNow(repeatedAt);
      clearPublications();
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, committed, repeatedAt);
      expectOneInvalidation(fixture);
    },
  );

  it(
    "commits thread, event, sequence and completion atomically ahead of closure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      const appliedAt = STARTED_AT_MS + 1000;
      const operations = ownSuccessfulOperations(context.signal);
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "thread-update",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(fixture, [200]),
            );
            const updated = await barrier.entered;
            expect(updated.rowCount).toBe(1);
            expect(updated.lockTimeout).toBe("1s");
            expect(updated.statementTimeout).toBe("5s");

            // The real UPDATE has executed, but a different connection sees no
            // thread, event, sequence or request-completion change yet.
            await expect(readApplyState(fixture)).resolves.toStrictEqual(
              before,
            );
            expect(threadListInvalidations(fixture)).toBe(0);
            expect(threadListInvalidations(unrelated)).toBe(0);
            expect(threadListInvalidationChannels()).toStrictEqual([]);

            const closing = startSubjectClosure({
              subjectKind: "user",
              subjectId: fixture.actor.userId,
            }).closing;
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            await operations.start(applyAuthorization(unrelated, [200]));
            await expectApplied(unrelated, unrelatedBefore, appliedAt);
            expect(threadListInvalidations(unrelated)).toBe(1);
            expect(threadListInvalidations(fixture)).toBe(0);
            expect(threadListInvalidationChannels()).toStrictEqual([
              userOrgChannelName({
                userId: unrelated.actor.userId,
                orgId: unrelated.orgId,
              }),
            ]);

            barrier.release();
            await applying;
            await closing;
          },
        },
        context.signal,
      );
      await operations.finish();

      await expectApplied(fixture, before, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
        userOrgChannelName({
          userId: fixture.actor.userId,
          orgId: fixture.orgId,
        }),
      ]);

      const committed = await readApplyState(fixture);
      await applyAuthorization(fixture, [404]);
      await expect(readApplyState(fixture)).resolves.toStrictEqual(committed);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
        userOrgChannelName({
          userId: fixture.actor.userId,
          orgId: fixture.orgId,
        }),
      ]);
    },
  );

  it(
    "waits behind closure-first and then observes its committed decision",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        const closing = startSubjectClosure({
          subjectKind: "user",
          subjectId: fixture.actor.userId,
        }).closing;
        await barrier.entered;
        const applying = operations.start(applyAuthorization(fixture, [404]));
        await expect
          .poll(barrier.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
        expect(threadListInvalidations(fixture)).toBe(0);
        expect(threadListInvalidationChannels()).toStrictEqual([]);
        barrier.release();
        await applying;
        await closing;
      }, context.signal);
      await operations.finish();
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "never retargets deleted or mutated request identity fields after preflight",
    { timeout: 120_000 },
    async () => {
      const mutations = [
        "delete",
        "hash",
        "organization",
        "source",
        "thread",
        "user",
      ] as const;
      for (const mutation of mutations) {
        const fixture = await createAuthorizationFixture();
        const beforeEffects = await readThreadEffects(fixture);
        const beforeRequest =
          await readComputerUseAuthorizationRequestByIdFixture(
            fixture.requestId,
          );
        const operations = ownSuccessfulOperations(context.signal);
        clearPublications();
        const requestId = await withComputerUseAuthorizationApplyBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            stopAt: "thread-pin",
            work: async (barrier) => {
              const applying = operations.start(
                applyAuthorization(fixture, [404]),
              );
              const pinned = await barrier.entered;
              expect(pinned.rowCount).toBe(1);
              const id = await operations.start(
                mutateComputerUseAuthorizationRequestFixture({
                  requestToken: fixture.requestToken,
                  mutation,
                  replacementThreadId: randomUUID(),
                }),
              );
              barrier.release();
              await applying;
              return id;
            },
          },
          context.signal,
        );
        await operations.finish();
        await expect(readThreadEffects(fixture)).resolves.toStrictEqual(
          beforeEffects,
        );
        const afterRequest =
          await readComputerUseAuthorizationRequestByIdFixture(requestId);
        if (mutation === "delete") {
          expect(afterRequest).toBeNull();
        } else {
          expect(afterRequest).toMatchObject({
            completedAt: null,
            updatedAt: beforeRequest?.updatedAt,
          });
        }
        expectNoInvalidation(fixture);
      }
    },
  );

  it(
    "denies missing and concurrently deleted canonical threads with only deletion effects",
    { timeout: 60_000 },
    async () => {
      const missing = await createAuthorizationFixture();
      const missingRequest =
        await readComputerUseAuthorizationRequestByIdFixture(missing.requestId);
      clearPublications();
      await chat.deleteThread(missing.actor, missing.threadId);
      await flushWaitUntilForTest();
      await expect(threadDeletionEventCount(missing)).resolves.toBe(1);
      expect(threadListInvalidations(missing)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: missing.actor.userId,
          orgId: missing.orgId,
        }),
      ]);
      await applyAuthorization(missing, [404]);
      await expect(
        readComputerUseAuthorizationRequestByIdFixture(missing.requestId),
      ).resolves.toMatchObject({
        completedAt: null,
        updatedAt: missingRequest?.updatedAt,
      });
      await expect(threadDeletionEventCount(missing)).resolves.toBe(1);
      expect(threadListInvalidations(missing)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: missing.actor.userId,
          orgId: missing.orgId,
        }),
      ]);

      const deleted = await createAuthorizationFixture();
      const deletedRequest =
        await readComputerUseAuthorizationRequestByIdFixture(deleted.requestId);
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: deleted.threadId,
          stopAt: "before-agent-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(deleted, [404]),
            );
            const waiting = await barrier.entered;
            expect(waiting.rowCount).toBeNull();
            expect(threadListInvalidations(deleted)).toBe(0);
            expect(threadListInvalidationChannels()).toStrictEqual([]);

            await chat.deleteThread(deleted.actor, deleted.threadId);
            await flushWaitUntilForTest();
            await expect(threadDeletionEventCount(deleted)).resolves.toBe(1);
            expect(threadListInvalidations(deleted)).toBe(1);
            expect(threadListInvalidationChannels()).toStrictEqual([
              userOrgChannelName({
                userId: deleted.actor.userId,
                orgId: deleted.orgId,
              }),
            ]);
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      await chat.requestReadThread(deleted.actor, deleted.threadId, [404]);
      await expect(
        readComputerUseAuthorizationRequestByIdFixture(deleted.requestId),
      ).resolves.toMatchObject({
        completedAt: null,
        updatedAt: deletedRequest?.updatedAt,
      });
      await expect(threadDeletionEventCount(deleted)).resolves.toBe(1);
      expect(threadListInvalidations(deleted)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: deleted.actor.userId,
          orgId: deleted.orgId,
        }),
      ]);
    },
  );

  it(
    "denies a request relabelled to a foreign canonical thread",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const foreign = await createAuthorizationFixture();
      const fixtureBefore = await readThreadEffects(fixture);
      const foreignBefore = await readThreadEffects(foreign);
      await mutateComputerUseAuthorizationRequestFixture({
        requestToken: fixture.requestToken,
        mutation: "thread",
        replacementThreadId: foreign.threadId,
      });
      const requestBefore =
        await readComputerUseAuthorizationRequestByIdFixture(fixture.requestId);
      clearPublications();

      await applyAuthorization(fixture, [404]);
      await expect(readThreadEffects(fixture)).resolves.toStrictEqual(
        fixtureBefore,
      );
      await expect(readThreadEffects(foreign)).resolves.toStrictEqual(
        foreignBefore,
      );
      await expect(
        readComputerUseAuthorizationRequestByIdFixture(fixture.requestId),
      ).resolves.toStrictEqual(requestBefore);
      expect(threadListInvalidations(fixture)).toBe(0);
      expect(threadListInvalidations(foreign)).toBe(0);
      expect(threadListInvalidationChannels()).toStrictEqual([]);
    },
  );

  it(
    "denies pre-admission and reselected thread-user changes",
    { timeout: 60_000 },
    async () => {
      const preAdmission = await createAuthorizationFixture();
      const preAdmissionBefore = await readApplyState(preAdmission);
      await setChatThreadUserFixture({
        chatThreadId: preAdmission.threadId,
        userId: `user_${randomUUID()}`,
      });
      clearPublications();
      await applyAuthorization(preAdmission, [404]);
      await setChatThreadUserFixture({
        chatThreadId: preAdmission.threadId,
        userId: preAdmission.actor.userId,
      });
      await expect(readApplyState(preAdmission)).resolves.toStrictEqual(
        preAdmissionBefore,
      );
      expectNoInvalidation(preAdmission);

      const reselected = await createAuthorizationFixture();
      const reselectedBefore = await readApplyState(reselected);
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: reselected.threadId,
          stopAt: "before-thread-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(reselected, [404]),
            );
            const waiting = await barrier.entered;
            expect(waiting.rowCount).toBeNull();
            await operations.start(
              setChatThreadUserFixture({
                chatThreadId: reselected.threadId,
                userId: `user_${randomUUID()}`,
              }),
            );
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      await setChatThreadUserFixture({
        chatThreadId: reselected.threadId,
        userId: reselected.actor.userId,
      });
      await expect(readApplyState(reselected)).resolves.toStrictEqual(
        reselectedBefore,
      );
      expectNoInvalidation(reselected);

      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      await applyAuthorization(reselected, [200]);
      await expectApplied(reselected, reselectedBefore, appliedAt);
      expectOneInvalidation(reselected);
    },
  );

  it(
    "denies closed Agent-owner transfers before admission and after reselection",
    { timeout: 60_000 },
    async () => {
      const preAdmission = await createAuthorizationFixture();
      const preAdmissionBefore = await readApplyState(preAdmission);
      const preAdmissionOwner = orgScoped(
        bdd.user({ orgId: preAdmission.orgId }),
      );
      const preAdmissionClosure = await closeSubject({
        subjectKind: "user",
        subjectId: preAdmissionOwner.userId,
      });
      await transferAgentOwnerFixture({
        agentId: preAdmission.agentId,
        owner: preAdmissionOwner.userId,
      });
      clearPublications();
      await applyAuthorization(preAdmission, [404]);
      await transferAgentOwnerFixture({
        agentId: preAdmission.agentId,
        owner: preAdmission.owner.userId,
      });
      await expect(readApplyState(preAdmission)).resolves.toStrictEqual(
        preAdmissionBefore,
      );
      expectNoInvalidation(preAdmission);
      await removeErasureSubjectsFixture([preAdmissionClosure.jobId]);

      const reselected = await createAuthorizationFixture();
      const reselectedBefore = await readApplyState(reselected);
      const reselectedOwner = orgScoped(bdd.user({ orgId: reselected.orgId }));
      const reselectedClosure = await closeSubject({
        subjectKind: "user",
        subjectId: reselectedOwner.userId,
      });
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: reselected.threadId,
          stopAt: "before-agent-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(reselected, [404]),
            );
            const waiting = await barrier.entered;
            expect(waiting.rowCount).toBeNull();
            await operations.start(
              transferAgentOwnerFixture({
                agentId: reselected.agentId,
                owner: reselectedOwner.userId,
              }),
            );
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      await transferAgentOwnerFixture({
        agentId: reselected.agentId,
        owner: reselected.owner.userId,
      });
      await expect(readApplyState(reselected)).resolves.toStrictEqual(
        reselectedBefore,
      );
      expectNoInvalidation(reselected);
      await removeErasureSubjectsFixture([reselectedClosure.jobId]);

      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      await applyAuthorization(reselected, [200]);
      await expectApplied(reselected, reselectedBefore, appliedAt);
      expectOneInvalidation(reselected);
    },
  );

  it(
    "denies Agent organization changes before admission and after reselection",
    { timeout: 60_000 },
    async () => {
      const preAdmission = await createAuthorizationFixture();
      const preAdmissionBefore = await readApplyState(preAdmission);
      await transferAgentOrganizationFixture({
        agentId: preAdmission.agentId,
        orgId: `org_${randomUUID()}`,
      });
      clearPublications();
      await applyAuthorization(preAdmission, [404]);
      await transferAgentOrganizationFixture({
        agentId: preAdmission.agentId,
        orgId: preAdmission.orgId,
      });
      await expect(readApplyState(preAdmission)).resolves.toStrictEqual(
        preAdmissionBefore,
      );
      expectNoInvalidation(preAdmission);

      const reselected = await createAuthorizationFixture();
      const reselectedBefore = await readApplyState(reselected);
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: reselected.threadId,
          stopAt: "before-agent-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(reselected, [404]),
            );
            const waiting = await barrier.entered;
            expect(waiting.rowCount).toBeNull();
            await operations.start(
              transferAgentOrganizationFixture({
                agentId: reselected.agentId,
                orgId: `org_${randomUUID()}`,
              }),
            );
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      await transferAgentOrganizationFixture({
        agentId: reselected.agentId,
        orgId: reselected.orgId,
      });
      await expect(readApplyState(reselected)).resolves.toStrictEqual(
        reselectedBefore,
      );
      expectNoInvalidation(reselected);

      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      await applyAuthorization(reselected, [200]);
      await expectApplied(reselected, reselectedBefore, appliedAt);
      expectOneInvalidation(reselected);
    },
  );

  it(
    "rechecks TTL after waiting for the exact request pin",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const holder = await holdComputerUseAuthorizationRequestRowFixture({
        requestToken: fixture.requestToken,
        signal: context.signal,
      });
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();
      const applying = operations.start(applyAuthorization(fixture, [410]));
      await expect
        .poll(holder.blockedRequestPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      mockNow(STARTED_AT_MS + HOUR_MS + 1);
      await holder.release();
      await applying;
      await operations.finish();
      mockNow(STARTED_AT_MS);

      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "retains thread and Agent identity during an actual request-pin wait",
    { timeout: 60_000 },
    async () => {
      const fixture = await createAuthorizationFixture({ sharedAgent: true });
      const unrelated = await createAuthorizationFixture();
      const replacementAgent = await bdd.createAgent(fixture.actor, {
        displayName: `Request-wait replacement ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const replacementUserId = `user_${randomUUID()}`;
      const replacementOwnerId = `user_${randomUUID()}`;
      const replacementOrgId = `org_${randomUUID()}`;
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      const appliedAt = STARTED_AT_MS + 1000;
      const holder = await holdComputerUseAuthorizationRequestRowFixture({
        requestToken: fixture.requestToken,
        signal: context.signal,
      });
      const operations = ownSuccessfulOperations(context.signal);
      mockNow(appliedAt);
      clearPublications();

      const applying = operations.start(applyAuthorization(fixture, [200]));
      await expect
        .poll(holder.blockedRequestPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      expect(threadListInvalidations(fixture)).toBe(0);
      expect(threadListInvalidations(unrelated)).toBe(0);
      expect(threadListInvalidationChannels()).toStrictEqual([]);

      const mutations = [
        operations.start(
          setChatThreadUserFixture({
            chatThreadId: fixture.threadId,
            userId: replacementUserId,
          }),
        ),
        operations.start(
          setChatThreadAgentFixture({
            chatThreadId: fixture.threadId,
            agentId: replacementAgent.agentId,
          }),
        ),
        operations.start(
          transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: replacementOwnerId,
          }),
        ),
        operations.start(
          transferAgentOrganizationFixture({
            agentId: fixture.agentId,
            orgId: replacementOrgId,
          }),
        ),
      ] as const;
      await expect
        .poll(async () => {
          return (await holder.blockedIdentityMutationCounts())
            .threadWaiterCount;
        }, BLOCKED)
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(async () => {
          return (await holder.blockedIdentityMutationCounts())
            .agentWaiterCount;
        }, BLOCKED)
        .toBeGreaterThanOrEqual(2);

      await operations.start(applyAuthorization(unrelated, [200]));
      await expectApplied(unrelated, unrelatedBefore, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(0);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
      ]);

      await holder.release();
      await applying;
      await Promise.all(mutations);
      await operations.start(
        setChatThreadUserFixture({
          chatThreadId: fixture.threadId,
          userId: fixture.actor.userId,
        }),
      );
      await operations.start(
        setChatThreadAgentFixture({
          chatThreadId: fixture.threadId,
          agentId: fixture.agentId,
        }),
      );
      await operations.start(
        transferAgentOwnerFixture({
          agentId: fixture.agentId,
          owner: fixture.owner.userId,
        }),
      );
      await operations.start(
        transferAgentOrganizationFixture({
          agentId: fixture.agentId,
          orgId: fixture.orgId,
        }),
      );
      await operations.finish();

      await expectApplied(fixture, before, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
        userOrgChannelName({
          userId: fixture.actor.userId,
          orgId: fixture.orgId,
        }),
      ]);
    },
  );

  it(
    "retries a thread rebind against the newly admitted closed owner",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const newOwner = orgScoped(bdd.user({ orgId: fixture.orgId }));
      const rebound = await bdd.createAgent(newOwner, {
        displayName: `Closed rebound ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      await closeSubject({
        subjectKind: "user",
        subjectId: newOwner.userId,
      });
      const before = await readApplyState(fixture);
      const operations = ownSuccessfulOperations(context.signal);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "before-thread-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(fixture, [404]),
            );
            const waiting = await barrier.entered;
            expect(waiting.rowCount).toBeNull();
            await setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: rebound.agentId,
            });
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      const after = await readApplyState(fixture);
      expect(after.selection).toStrictEqual(before.selection);
      expect(after.authorization).toStrictEqual(before.authorization);
      expect(after.events).toStrictEqual(before.events);
      expect(after.lastSeqId).toBe(before.lastSeqId);
      expect(after.threadUpdatedAt).toBe(before.threadUpdatedAt);
      expect(after.requestUpdatedAt).toBe(before.requestUpdatedAt);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "retries a thread rebind and succeeds only after fresh open-owner admission",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const newOwner = orgScoped(bdd.user({ orgId: fixture.orgId }));
      expect(newOwner.userId).not.toBe(fixture.actor.userId);
      const rebound = await bdd.createAgent(newOwner, {
        displayName: `Open rebound ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const before = await readApplyState(fixture);
      const appliedAt = STARTED_AT_MS + 1000;
      const operations = ownSuccessfulOperations(context.signal);
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "before-thread-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(fixture, [200]),
            );
            await barrier.entered;
            await setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: rebound.agentId,
            });
            barrier.release();
            await applying;
          },
        },
        context.signal,
      );
      await operations.finish();
      await expectApplied(fixture, before, appliedAt);
      expectOneInvalidation(fixture);
    },
  );

  it(
    "retains thread and Agent identity after acquiring the request pin",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const replacement = await bdd.createAgent(fixture.actor, {
        displayName: `Pinned replacement ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      const appliedAt = STARTED_AT_MS + 1000;
      const operations = ownSuccessfulOperations(context.signal);
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "request-pin",
          work: async (barrier) => {
            const applying = operations.start(
              applyAuthorization(fixture, [200]),
            );
            const pinned = await barrier.entered;
            expect(pinned.rowCount).toBe(1);

            const movingThread = operations.start(
              setChatThreadAgentFixture({
                chatThreadId: fixture.threadId,
                agentId: replacement.agentId,
              }),
            );
            const movingAgent = operations.start(
              transferAgentOrganizationFixture({
                agentId: fixture.agentId,
                orgId: `org_${randomUUID()}`,
              }),
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(2);

            await operations.start(applyAuthorization(unrelated, [200]));
            await expectApplied(unrelated, unrelatedBefore, appliedAt);
            expect(threadListInvalidations(unrelated)).toBe(1);
            expect(threadListInvalidations(fixture)).toBe(0);
            expect(threadListInvalidationChannels()).toStrictEqual([
              userOrgChannelName({
                userId: unrelated.actor.userId,
                orgId: unrelated.orgId,
              }),
            ]);

            barrier.release();
            await applying;
            await Promise.all([movingThread, movingAgent]);
          },
        },
        context.signal,
      );
      await operations.finish();
      await expectApplied(fixture, before, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
        userOrgChannelName({
          userId: fixture.actor.userId,
          orgId: fixture.orgId,
        }),
      ]);
    },
  );

  it(
    "denies a null-Agent thread before mutation and leaves request completion open",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: null,
      });
      clearPublications();
      await applyAuthorization(fixture, [404]);
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: fixture.agentId,
      });
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "serializes concurrent same-thread requests without a SHARE upgrade deadlock",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const first = await createAuthorizationFixture();
      const secondRequest = await createRequest(first);
      const second: AuthorizationFixture = { ...first, ...secondRequest };
      const before = await readApplyState(first);
      const appliedAt = STARTED_AT_MS + 1000;
      const operations = ownSuccessfulOperations(context.signal);
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: first.threadId,
          stopAt: "thread-update",
          work: async (barrier) => {
            const applyingFirst = operations.start(
              applyAuthorization(first, [200]),
            );
            const updated = await barrier.entered;
            expect(updated.rowCount).toBe(1);
            const applyingSecond = operations.start(
              applyAuthorization(second, [200]),
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            barrier.release();
            await Promise.all([applyingFirst, applyingSecond]);
          },
        },
        context.signal,
      );
      await operations.finish();

      await expectApplied(first, before, appliedAt, 2);
      await expect(readAuthorization(second)).resolves.toStrictEqual({
        completedAt: new Date(appliedAt).toISOString(),
        computerUseHostId: first.hostId,
      });
      expect(threadListInvalidations(first)).toBe(2);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({ userId: first.actor.userId, orgId: first.orgId }),
        userOrgChannelName({ userId: first.actor.userId, orgId: first.orgId }),
      ]);
    },
  );

  it(
    "rolls back thread, event, sequence and request completion on a scoped late failure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      const failure = await failComputerUseAuthorizationCompletionFixture(
        fixture.requestToken,
      );
      clearPublications();

      const failed = ownRejectedOperation(
        applyAuthorization(fixture, [200, 404]),
        /Unknown response status 500/,
      );
      await failed.finish();
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);

      // The trigger is exact-request scoped rather than a shared-table lock:
      // another owner completes normally while it remains installed.
      await applyAuthorization(unrelated, [200]);
      await expectApplied(unrelated, unrelatedBefore, STARTED_AT_MS);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidations(fixture)).toBe(0);
      expect(threadListInvalidationChannels()).toStrictEqual([
        userOrgChannelName({
          userId: unrelated.actor.userId,
          orgId: unrelated.orgId,
        }),
      ]);

      await failure.restore();
      clearPublications();
      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before, appliedAt);
      expectOneInvalidation(fixture);
    },
  );

  it(
    "rolls back an executed completion when the real operation signal aborts",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const cancelled = new AbortController();
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "completion",
          work: async (barrier) => {
            const applying = ownRejectedOperation(
              applyAuthorization(fixture, [200, 404], {
                signal: cancelled.signal,
              }),
              /Unknown response status 500/,
            );
            const completed = await barrier.entered;
            expect(completed.rowCount).toBe(1);
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await applying.finish();
          },
        },
        context.signal,
      );
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);

      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before, appliedAt);
    },
  );

  it(
    "keeps committed state but loses response and publication after the final abort check",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const cancelled = new AbortController();
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            const applying = ownRejectedOperation(
              applyAuthorization(fixture, [200, 404], {
                signal: cancelled.signal,
              }),
              /Unknown response status 500/,
            );
            await barrier.entered;
            await expect(readApplyState(fixture)).resolves.toStrictEqual(
              before,
            );
            expectNoInvalidation(fixture);
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await applying.finish();
          },
        },
        context.signal,
      );
      await expectApplied(fixture, before, STARTED_AT_MS);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "propagates a real thread-lock timeout instead of fabricating a scope 404",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const holder = await holdComputerUseAuthorizationApplyThreadRowFixture({
        chatThreadId: fixture.threadId,
        signal: context.signal,
      });
      clearPublications();
      const failed = ownRejectedOperation(
        applyAuthorization(fixture, [200, 404]),
        /Unknown response status 500/,
      );
      await failed.finish();
      await holder.release();
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "keeps Apply independent of run existence and preserves repeat success",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      await deleteAgentRunRootFixture(fixture.runId);
      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      clearPublications();

      const applied = await applyAuthorization(fixture, [200]);
      expect(applied.body).toStrictEqual({
        ok: true,
        source: "chat",
        computerUseHostId: fixture.hostId,
      });
      await expectApplied(fixture, before, appliedAt);
      expectOneInvalidation(fixture);

      const completed = await readApplyState(fixture);
      clearPublications();
      const repeatedAt = STARTED_AT_MS + 2000;
      mockNow(repeatedAt);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, completed, repeatedAt);
      expectOneInvalidation(fixture);
    },
  );
});
