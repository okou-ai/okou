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
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  failComputerUseAuthorizationCompletionFixture,
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
} from "../../../test-fixtures/chat-thread-content-erasure";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
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
  return {
    selection: await readSelection(fixture),
    authorization: await readAuthorization(fixture),
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
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
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
    "commits thread, event, sequence and completion atomically ahead of closure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const unrelated = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const unrelatedBefore = await readApplyState(unrelated);
      const appliedAt = STARTED_AT_MS + 1000;
      mockNow(appliedAt);
      clearPublications();

      const closed = await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "thread-update",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200]);
            const updated = await barrier.entered;
            expect(updated.rowCount).toBe(1);
            expect(updated.lockTimeout).toBe("1s");
            expect(updated.statementTimeout).toBe("5s");

            // The real UPDATE has executed, but a different connection sees no
            // thread, event, sequence or request-completion change yet.
            await expect(readApplyState(fixture)).resolves.toStrictEqual(
              before,
            );
            expectNoInvalidation(fixture);

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: fixture.actor.userId,
            });
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            await applyAuthorization(unrelated, [200]);
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
            return await closing;
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });

      await expectApplied(fixture, before, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toHaveLength(2);

      const committed = await readApplyState(fixture);
      await applyAuthorization(fixture, [404]);
      await expect(readApplyState(fixture)).resolves.toStrictEqual(committed);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
    },
  );

  it(
    "waits behind closure-first and then observes its committed decision",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      clearPublications();
      const closed = await withErasureSubjectClosureCommitBarrierFixture(
        async (barrier) => {
          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          await barrier.entered;
          const applying = applyAuthorization(fixture, [404]);
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
          barrier.release();
          await applying;
          return await closing;
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });
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
        clearPublications();
        const requestId = await withComputerUseAuthorizationApplyBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            stopAt: "thread-pin",
            work: async (barrier) => {
              const applying = applyAuthorization(fixture, [404]);
              const pinned = await barrier.entered;
              expect(pinned.rowCount).toBe(1);
              const id = await mutateComputerUseAuthorizationRequestFixture({
                requestToken: fixture.requestToken,
                mutation,
                replacementThreadId: randomUUID(),
              });
              barrier.release();
              await applying;
              return id;
            },
          },
          context.signal,
        );
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
    "rechecks TTL after waiting for the exact request pin",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const holder = await holdComputerUseAuthorizationRequestRowFixture({
        requestToken: fixture.requestToken,
        signal: context.signal,
      });
      clearPublications();
      const applying = applyAuthorization(fixture, [410]);
      await expect
        .poll(holder.blockedRequestPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      mockNow(STARTED_AT_MS + HOUR_MS + 1);
      await holder.release();
      await applying;
      mockNow(STARTED_AT_MS);

      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);
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
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "before-thread-pin",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [404]);
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
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "before-thread-pin",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200]);
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
      await expectApplied(fixture, before, appliedAt);
      expectOneInvalidation(fixture);
    },
  );

  it(
    "retains thread and Agent identity while waiting on the request pin",
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
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "request-pin",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200]);
            const pinned = await barrier.entered;
            expect(pinned.rowCount).toBe(1);

            const movingThread = setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: replacement.agentId,
            });
            const movingAgent = transferAgentOrganizationFixture({
              agentId: fixture.agentId,
              orgId: `org_${randomUUID()}`,
            });
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(2);

            await applyAuthorization(unrelated, [200]);
            await expectApplied(unrelated, unrelatedBefore, appliedAt);
            expect(threadListInvalidations(unrelated)).toBe(1);
            expect(threadListInvalidations(fixture)).toBe(0);

            barrier.release();
            await applying;
            await Promise.all([movingThread, movingAgent]);
          },
        },
        context.signal,
      );
      await expectApplied(fixture, before, appliedAt);
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toHaveLength(2);
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
      mockNow(appliedAt);
      clearPublications();

      await withComputerUseAuthorizationApplyBarrierFixture(
        {
          chatThreadId: first.threadId,
          stopAt: "thread-update",
          work: async (barrier) => {
            const applyingFirst = applyAuthorization(first, [200]);
            const updated = await barrier.entered;
            expect(updated.rowCount).toBe(1);
            const applyingSecond = applyAuthorization(second, [200]);
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            barrier.release();
            await Promise.all([applyingFirst, applyingSecond]);
          },
        },
        context.signal,
      );

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

      await expect(applyAuthorization(fixture, [200, 404])).rejects.toThrow(
        /Unknown response status 500/,
      );
      await expect(readApplyState(fixture)).resolves.toStrictEqual(before);
      expectNoInvalidation(fixture);

      // The trigger is exact-request scoped rather than a shared-table lock:
      // another owner completes normally while it remains installed.
      await applyAuthorization(unrelated, [200]);
      await expectApplied(unrelated, unrelatedBefore, STARTED_AT_MS);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidations(fixture)).toBe(0);

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
            const applying = applyAuthorization(fixture, [200, 404], {
              signal: cancelled.signal,
            });
            const completed = await barrier.entered;
            expect(completed.rowCount).toBe(1);
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await expect(applying).rejects.toThrow(
              /Unknown response status 500/,
            );
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
            const applying = applyAuthorization(fixture, [200, 404], {
              signal: cancelled.signal,
            });
            await barrier.entered;
            await expect(readApplyState(fixture)).resolves.toStrictEqual(
              before,
            );
            expectNoInvalidation(fixture);
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await expect(applying).rejects.toThrow(
              /Unknown response status 500/,
            );
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
      const holder = await holdChatThreadRowLockFixture({
        threadId: fixture.threadId,
        signal: context.signal,
      });
      clearPublications();
      await expect(applyAuthorization(fixture, [200, 404])).rejects.toThrow(
        /Unknown response status 500/,
      );
      holder.release();
      await holder.done;
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
