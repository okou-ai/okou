import { createHash, randomUUID } from "node:crypto";

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
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  countBrowserAuthorizationRequestsFixture,
  deleteBrowserAuthorizationRequestFixture,
  expireBrowserAuthorizationRequestFixture,
  holdBrowserAuthorizationCreationRunFixture,
  holdBrowserAuthorizationRequestInsertFixture,
  holdBrowserAuthorizationRequestRowLockFixture,
  readBrowserAuthorizationRequestFixture,
  setBrowserAuthorizationRunOrganizationFixture,
  setBrowserAuthorizationRunThreadFixture,
  setBrowserAuthorizationRunTriggerFixture,
  setBrowserAuthorizationRunUserFixture,
  withBrowserAuthorizationApplyBarrierFixture,
  withBrowserAuthorizationCreateBarrierFixture,
} from "../../../test-fixtures/browser-authorization";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  readChatThreadTitleStateFixture,
  setChatThreadAgentFixture,
  setChatThreadUserFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  channelsPublishedTo,
  countPublishedTo,
  userOrgChannelName,
} from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { browserAuthorizationRoutes } from "../browser-authorization";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
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

interface AuthorizationRunFixture {
  readonly actor: ApiTestUser;
  /** The canonical Agent owner. It is a second member of the same organization
   * whenever the case asks for a shared Agent, and the actor otherwise. */
  readonly owner: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly runId: string;
}

interface AuthorizationFixture extends AuthorizationRunFixture {
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
async function createAuthorizationRunFixture(options?: {
  readonly sharedAgent?: boolean;
}): Promise<AuthorizationRunFixture> {
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
  };
}

async function createAuthorizationFixture(options?: {
  readonly sharedAgent?: boolean;
}): Promise<AuthorizationFixture> {
  const fixture = await createAuthorizationRunFixture(options);
  return {
    ...fixture,
    requestToken: await createAuthorizationRequest(
      fixture.actor,
      fixture.runId,
    ),
  };
}

function requestAuthorizationCreation(
  fixture: AuthorizationRunFixture,
  statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
  options?: { readonly tokenType?: "agent" | "sandbox" },
  signal?: AbortSignal,
) {
  const token =
    options?.tokenType === "agent"
      ? runs.okouTokenForRunWithCapabilities(fixture.actor, fixture.runId, [])
      : runs.sandboxTokenForRun(fixture.actor, fixture.runId);
  return accept(
    authorizationClient(signal).create({
      headers: { authorization: `Bearer ${token}` },
      body: {},
    }),
    statuses,
  );
}

type AuthorizationCreationResponse = Awaited<
  ReturnType<typeof requestAuthorizationCreation>
>;

function createdAuthorizationBody(response: AuthorizationCreationResponse): {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
} {
  expect(response.status).toBe(200);
  if (!("authorizationUrl" in response.body)) {
    throw new Error("Expected an authorization creation response");
  }
  return response.body;
}

function requestTokenFromUrl(authorizationUrl: string): string {
  return decodeURIComponent(
    new URL(authorizationUrl).pathname.split("/").at(-1) ?? "",
  );
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

/** The persisted selection a production metadata reader returns. */
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

/**
 * Start this case's publication evidence from an empty paired view, so an
 * earlier setup write is never attributed to the request under test. Both spies
 * are cleared together because a publish's channel is recovered from the `get`
 * that produced it, and `mockClear` drops the calls and their invocation order
 * as one.
 */
function clearPublications(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

/**
 * The `threadListChanged` invalidations actually routed to one owner's own
 * `user-org:<userId>:<orgId>` channel. Counting the topic alone cannot tell one
 * publication per owner from two under a single owner or one sent to the wrong
 * channel, because the client mock hands every channel the same `publish` spy;
 * {@link countPublishedTo} binds each publish back to the `channels.get` call
 * that produced it instead of pairing the two spies by position.
 */
function threadListInvalidations(fixture: AuthorizationRunFixture): number {
  return countPublishedTo(context.mocks, {
    channel: userOrgChannelName({
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
    }),
    topic: "threadListChanged",
  });
}

/** Every channel a `threadListChanged` reached, so a case still bounds the
 * total it expects without letting one owner's two publications stand in for
 * one each. */
function threadListInvalidationChannels(): readonly string[] {
  return channelsPublishedTo(context.mocks, "threadListChanged");
}

/** No sidebar invalidation reached this owner, and none reached anyone else
 * either: a denial, rollback or pause must not merely misroute its publication.
 */
function expectNoInvalidation(fixture: AuthorizationRunFixture): void {
  expect(threadListInvalidations(fixture)).toBe(0);
  expect(threadListInvalidationChannels()).toStrictEqual([]);
}

/** Exactly one invalidation, on this owner's own channel and nowhere else. */
function expectOneInvalidation(fixture: AuthorizationRunFixture): void {
  expect(threadListInvalidations(fixture)).toBe(1);
  expect(threadListInvalidationChannels()).toStrictEqual([
    userOrgChannelName({
      userId: fixture.actor.userId,
      orgId: fixture.orgId,
    }),
  ]);
}

/** Every observable effect an accepted apply would have produced. */
interface ApplyState {
  readonly selection: Awaited<ReturnType<typeof readSelection>>;
  readonly authorization: Awaited<ReturnType<typeof readAuthorization>>;
  readonly events: readonly SidebarHostEvent[];
  readonly lastSeqId: number;
}

/**
 * Reads durable apply state without crossing the separately fenced GET path.
 * Apply race tests intentionally inspect MVCC state while Apply or closure owns
 * a business-row lock; the public GET can now correctly wait or deny there.
 */
async function readDurableAuthorization(
  fixture: AuthorizationFixture,
  selection: Awaited<ReturnType<typeof readSelection>>,
): Promise<Awaited<ReturnType<typeof readAuthorization>>> {
  const request = await readBrowserAuthorizationRequestFixture(
    fixture.requestToken,
  );
  if (!request) {
    throw new Error("Expected the browser authorization request row");
  }
  return {
    completedAt: request.completedAt,
    cloudBrowserEnabled: selection.cloudBrowserEnabled,
  };
}

async function readApplyState(
  fixture: AuthorizationFixture,
): Promise<ApplyState> {
  const selection = await readSelection(fixture);
  return {
    selection,
    authorization: await readDurableAuthorization(fixture, selection),
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

/**
 * A highest emitted sequence alone cannot expose a hidden reservation. Follow
 * creation with the production apply writer and require its durable event to
 * consume the immediately next sequence.
 */
async function expectNextSidebarSequenceAfterCreation(
  fixture: AuthorizationFixture,
  previousSeqId: number,
): Promise<void> {
  const beforeApply = await readApplyState(fixture);
  expect(beforeApply.lastSeqId).toBe(previousSeqId);
  clearPublications();
  await applyAuthorization(fixture, [200]);
  await expectApplied(fixture, beforeApply);
  await flushWaitUntilForTest();
  expectOneInvalidation(fixture);
}

interface CreationState {
  readonly requestCount: number;
  readonly selection: Awaited<ReturnType<typeof readSelection>>;
  readonly events: readonly SidebarHostEvent[];
  readonly lastSeqId: number;
  readonly threadState: Awaited<
    ReturnType<typeof readChatThreadTitleStateFixture>
  >;
}

async function readCreationState(
  fixture: AuthorizationRunFixture,
): Promise<CreationState> {
  return {
    requestCount: await countBrowserAuthorizationRequestsFixture(fixture.runId),
    selection: await readSelection(fixture),
    events: await sidebarHostEvents(fixture),
    lastSeqId: await lastSidebarSeqId(fixture),
    threadState: await readChatThreadTitleStateFixture(fixture.threadId),
  };
}

async function expectCreationUnchanged(
  fixture: AuthorizationRunFixture,
  before: CreationState,
): Promise<void> {
  await expect(readCreationState(fixture)).resolves.toStrictEqual(before);
  expectNoInvalidation(fixture);
}

async function createAndInspectOpenRequest(
  fixture: AuthorizationRunFixture,
  options?: {
    readonly tokenType?: "agent" | "sandbox";
    readonly createdAtMs?: number;
  },
): Promise<AuthorizationFixture> {
  const before = await readCreationState(fixture);
  clearPublications();
  const created = await requestAuthorizationCreation(fixture, [200], {
    tokenType: options?.tokenType,
  });
  const createdBody = createdAuthorizationBody(created);
  const requestToken = requestTokenFromUrl(createdBody.authorizationUrl);
  const createdAtMs = options?.createdAtMs ?? STARTED_AT_MS;
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + HOUR_MS).toISOString();

  expect(createdBody.authorizationUrl).toBe(
    `https://app.okou.ai/browser/authorize/${encodeURIComponent(requestToken)}`,
  );
  expect(requestToken).toMatch(/^vm0_browser_authorization_request_[\w-]+$/u);
  expect(createdBody.expiresAt).toBe(expiresAt);

  const row = await readBrowserAuthorizationRequestFixture(requestToken);
  expect(row).toMatchObject({
    requestTokenHash: createHash("sha256").update(requestToken).digest("hex"),
    orgId: fixture.orgId,
    userId: fixture.actor.userId,
    runId: fixture.runId,
    chatThreadId: fixture.threadId,
    expiresAt,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  expect(JSON.stringify(row)).not.toContain(requestToken);
  await expect(
    countBrowserAuthorizationRequestsFixture(fixture.runId),
  ).resolves.toBe(before.requestCount + 1);

  const accepted = { ...fixture, requestToken };
  await expect(readAuthorization(accepted)).resolves.toStrictEqual({
    completedAt: null,
    cloudBrowserEnabled: false,
  });
  const after = await readCreationState(fixture);
  expect(after).toStrictEqual({
    ...before,
    requestCount: before.requestCount + 1,
  });
  expectNoInvalidation(fixture);
  return accepted;
}

async function expectCreationDenied(
  fixture: AuthorizationRunFixture,
  before: CreationState,
  status: 404 | 409 = 404,
): Promise<void> {
  clearPublications();
  const denied = await requestAuthorizationCreation(fixture, [status]);
  expect(denied.status).toBe(status);
  expect("authorizationUrl" in denied.body).toBeFalsy();
  await expectCreationUnchanged(fixture, before);
}

async function expectLocatorMutationDenied(
  fixture: AuthorizationRunFixture,
  mutate: () => Promise<void>,
): Promise<void> {
  const before = await readCreationState(fixture);
  clearPublications();
  await withBrowserAuthorizationCreateBarrierFixture(
    {
      chatThreadId: fixture.threadId,
      runId: fixture.runId,
      stopAt: "locator",
      work: async (barrier) => {
        const creating = requestAuthorizationCreation(fixture, [404]);
        const located = await barrier.entered;
        expect(located.rowCount).toBe(1);
        await mutate();
        barrier.release();
        const denied = await creating;
        expect("authorizationUrl" in denied.body).toBeFalsy();
      },
    },
    context.signal,
  );
  await expectCreationUnchanged(fixture, before);
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
      clearPublications();
      const denied = await applyAuthorization(fixture, [404]);
      expect(denied.status).toBe(404);
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expectNoInvalidation(fixture);

      // The denied attempt consumed no durable sequence, so the next accepted
      // apply takes the very next sidebar sequence id.
      await removeErasureSubjectsFixture([closed.jobId]);
      await applyAuthorization(fixture, [200]);
      await expectApplied(fixture, before);

      // The accepted apply publishes its own invalidation, and it goes to this
      // owner's channel rather than merely somewhere.
      await flushWaitUntilForTest();
      expectOneInvalidation(fixture);
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
      expect(unrelated.actor.userId).not.toBe(fixture.actor.userId);
      expect(unrelated.orgId).not.toBe(fixture.orgId);
      clearPublications();

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
            expectNoInvalidation(fixture);

            // An unrelated owner is not serialized behind that barrier.
            await applyAuthorization(unrelated, [200]);
            await expectApplied(unrelated, unrelatedBefore);
            await flushWaitUntilForTest();

            // The unrelated apply published exactly one invalidation, on its own
            // channel; the still paused target has none. A global count of one
            // could not tell those two owners apart.
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

      await flushWaitUntilForTest();
      await expectApplied(fixture, before);
      // Exactly one invalidation per owner, each on that owner's own channel,
      // and the target's was published only after its COMMIT. A global total of
      // two is also satisfied by two publications under one owner or by either
      // one routed to the wrong channel, so it is asserted per owner here.
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toHaveLength(2);

      // The closure landed behind the admitted write, so the next apply of the
      // same live token is denied and changes nothing.
      const applied = await readApplyState(fixture);
      await applyAuthorization(fixture, [404]);
      await flushWaitUntilForTest();
      await expectUnchanged(fixture, applied);
      // The denied repeat adds no invalidation, for either owner.
      expect(threadListInvalidations(fixture)).toBe(1);
      expect(threadListInvalidations(unrelated)).toBe(1);
      expect(threadListInvalidationChannels()).toHaveLength(2);
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
      clearPublications();
      const refused = await applyAuthorization(fixture, [404]);
      expect(refused.status).toBe(404);
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expectNoInvalidation(fixture);
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
            await flushWaitUntilForTest();
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
      clearPublications();

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
      expectNoInvalidation(fixture);
    },
  );

  it(
    "rechecks a request that expired after the preflight without writing anything",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      clearPublications();

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
      expectNoInvalidation(fixture);
    },
  );

  it(
    "rechecks expiry against a clock read after the request lock, not before it",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const peer = orgScoped(bdd.user({ orgId: fixture.orgId }));
      const before = await readApplyState(fixture);
      clearPublications();

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
      expectNoInvalidation(fixture);

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
      // The accepted control published exactly one invalidation on this owner's
      // own channel, so the lapsed apply's zero above is a real absence rather
      // than a counter that never observes this owner's publications.
      await flushWaitUntilForTest();
      expectOneInvalidation(later);
    },
  );

  it(
    "holds the pinned request's own result while the clock lapses and writes nothing",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      clearPublications();

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
      expectNoInvalidation(fixture);
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
      clearPublications();
      // A genuine transaction failure is neither the accepted 200 nor the
      // closure 404.
      await expect(applyAuthorization(fixture, [200, 404])).rejects.toThrow(
        /Unknown response status 500/,
      );
      holder.release();
      await holder.done;
      await flushWaitUntilForTest();

      await expectUnchanged(fixture, before);
      expectNoInvalidation(fixture);

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
      clearPublications();

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
            // client fetch: the writer's own last in-transaction check still
            // runs after this pause and observes it, so the executed statements
            // roll back.
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
      expectNoInvalidation(fixture);
    },
  );

  it(
    "keeps a committed apply when the operation is cancelled at the commit boundary, publishing nothing",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationFixture();
      const before = await readApplyState(fixture);
      const cancelled = new AbortController();
      clearPublications();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          // This barrier holds the driver's own `COMMIT` before it is dispatched
          // to PostgreSQL, so the server has neither run nor acknowledged it.
          // What it does sit past is the writer's last in-transaction
          // `throwIfAborted`, which is the real end of the rollback guarantee.
          stopAt: "commit",
          work: async (barrier) => {
            const applying = applyAuthorization(fixture, [200, 404], {
              signal: cancelled.signal,
            });
            await barrier.entered;
            // Nothing is visible or published yet, exactly as in the writer-first
            // case: the executed statements are still inside the transaction.
            await expectUnchanged(fixture, before);
            expectNoInvalidation(fixture);

            // An abort that arrives only here is past every in-transaction
            // check, so releasing sends a `COMMIT` that succeeds. The caller
            // loses its response; it does not undo the write.
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

      // The write is durable — the same state an accepted apply leaves — while
      // the 200 and the invalidation that follow the transaction are both lost.
      // The durable sidebar event is what a client reading its cursor still
      // sees; no publication is retried for it.
      await expectApplied(fixture, before);
      expectNoInvalidation(fixture);
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

describe("account erasure fences cloud browser authorization request creation", () => {
  it(
    "creates one open request from sandbox and capability-free Agent credentials without activating the browser",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const sandbox = await createAuthorizationRunFixture();
      const sandboxRequest = await createAndInspectOpenRequest(sandbox, {
        tokenType: "sandbox",
      });
      expect(sandboxRequest.requestToken).toMatch(
        /^vm0_browser_authorization_request_/u,
      );

      const agent = await createAuthorizationRunFixture();
      // Creation has never required an active run. Complete this run through
      // the production sandbox webhook, then prove a capability-free Agent
      // token can still mint a link for the retained terminal identity.
      const completed = await webhooks.requestAgentComplete(
        {
          runId: agent.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `browser-authorization-${agent.runId}`,
            cliAgentSessionHistoryHash: createHash("sha256")
              .update(`bdd chat session history ${agent.runId}`)
              .digest("hex"),
          },
        },
        {
          authorization: `Bearer ${runs.sandboxTokenForRun(
            agent.actor,
            agent.runId,
          )}`,
        },
        [200],
      );
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await flushWaitUntilForTest();
      await expect(
        runs.readRun(agent.actor, agent.runId),
      ).resolves.toMatchObject({ status: "completed" });
      const agentRequest = await createAndInspectOpenRequest(agent, {
        tokenType: "agent",
      });
      expect(agentRequest.requestToken).not.toBe(sandboxRequest.requestToken);
    },
  );

  it(
    "keeps malformed, missing and authenticated-label-foreign runs at 404",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const foreign = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      const foreignBefore = await readCreationState(foreign);
      clearPublications();

      const malformed = await requestAuthorizationCreation(
        { ...fixture, runId: "not-a-run-id" },
        [404],
      );
      const missing = await requestAuthorizationCreation(
        { ...fixture, runId: randomUUID() },
        [404],
      );
      const foreignLabels = await requestAuthorizationCreation(
        { ...fixture, runId: foreign.runId },
        [404],
      );

      expect(malformed.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreignLabels.status).toBe(404);
      expect("authorizationUrl" in malformed.body).toBeFalsy();
      expect("authorizationUrl" in missing.body).toBeFalsy();
      expect("authorizationUrl" in foreignLabels.body).toBeFalsy();
      await expectCreationUnchanged(fixture, before);
      await expect(readCreationState(foreign)).resolves.toStrictEqual(
        foreignBefore,
      );
    },
  );

  it(
    "admits an open thread user, denies its closure, and admits exactly one request after reopening",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const control = await createAndInspectOpenRequest(fixture);
      expect(control.requestToken).toMatch(
        /^vm0_browser_authorization_request_/u,
      );
      const before = await readCreationState(fixture);
      const closed = await closeSubject({
        subjectKind: "user",
        subjectId: fixture.actor.userId,
      });

      await expectCreationDenied(fixture, before);
      await removeErasureSubjectsFixture([closed.jobId]);
      const restored = await createAndInspectOpenRequest(fixture);
      expect(restored.requestToken).not.toBe(control.requestToken);
      await expectNextSidebarSequenceAfterCreation(restored, before.lastSeqId);
    },
  );

  it(
    "admits a real distinct shared-Agent owner, denies its closure, and restores creation",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture({
        sharedAgent: true,
      });
      expect(fixture.owner.userId).not.toBe(fixture.actor.userId);
      await createAndInspectOpenRequest(fixture);
      const before = await readCreationState(fixture);
      const closed = await closeSubject({
        subjectKind: "user",
        subjectId: fixture.owner.userId,
      });

      await expectCreationDenied(fixture, before);
      await removeErasureSubjectsFixture([closed.jobId]);
      const restored = await createAndInspectOpenRequest(fixture);
      await expectNextSidebarSequenceAfterCreation(restored, before.lastSeqId);
    },
  );

  it(
    "admits an open organization, denies its closure, and restores creation",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const control = await createAndInspectOpenRequest(fixture);
      expect(control.requestToken).toMatch(
        /^vm0_browser_authorization_request_/u,
      );
      const before = await readCreationState(fixture);
      const closed = await closeSubject({
        subjectKind: "organization",
        subjectId: fixture.orgId,
      });

      await expectCreationDenied(fixture, before);
      await removeErasureSubjectsFixture([closed.jobId]);
      const restored = await createAndInspectOpenRequest(fixture);
      expect(restored.requestToken).not.toBe(control.requestToken);
      await expectNextSidebarSequenceAfterCreation(restored, before.lastSeqId);
    },
  );

  it(
    "makes closure wait for the actual inserted writer while an unrelated owner creates",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();

      const outcome = await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "insert",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [200]);
            const inserted = await barrier.entered;
            expect(inserted.rowCount).toBe(1);
            expect(inserted.lockTimeout).toBe("1s");
            expect(inserted.statementTimeout).toBe("5s");

            // A different connection cannot observe this executed INSERT while
            // the transaction remains open.
            await expect(
              countBrowserAuthorizationRequestsFixture(fixture.runId),
            ).resolves.toBe(before.requestCount);

            const closing = closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: fixture.actor.userId,
            });
            // The exclusive closure is directly blocked by the transaction
            // that already executed the request INSERT and still retains its
            // shared subject admission.
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await expectCreationUnchanged(fixture, before);

            // A genuinely unrelated owner and organization keep progressing.
            await createAndInspectOpenRequest(unrelated);

            barrier.release();
            return {
              created: await creating,
              closed: await closing,
            };
          },
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([outcome.closed.jobId]);
      });

      const requestToken = requestTokenFromUrl(
        createdAuthorizationBody(outcome.created).authorizationUrl,
      );
      await expect(
        readBrowserAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        runId: fixture.runId,
        chatThreadId: fixture.threadId,
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
      expectNoInvalidation(fixture);

      // Closure committed immediately behind the writer. A repeat creation is
      // denied and cannot leave a second row or a URL.
      const denied = await requestAuthorizationCreation(fixture, [404]);
      expect(denied.status).toBe(404);
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
    },
  );

  it(
    "waits behind a closure-first transaction, then observes the committed closure and inserts zero rows",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();

      const outcome = await withErasureSubjectClosureCommitBarrierFixture(
        async (barrier) => {
          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          await barrier.entered;
          const creating = requestAuthorizationCreation(fixture, [404]);

          // Creation waits on this closure's exclusive subject lock. When the
          // lock is released, READ COMMITTED starts a new closure lookup and
          // sees the job that COMMIT made visible.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await expect(
            countBrowserAuthorizationRequestsFixture(fixture.runId),
          ).resolves.toBe(before.requestCount);

          barrier.release();
          return {
            closed: await closing,
            denied: await creating,
          };
        },
        context.signal,
      );
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([outcome.closed.jobId]);
      });
      expect(outcome.denied.status).toBe(404);
      await expectCreationUnchanged(fixture, before);
    },
  );

  it(
    "denies a run deleted after the locator instead of creating an orphaned request",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(fixture, async () => {
        await deleteAgentRunRootFixture(fixture.runId);
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "denies run user and organization changes after the locator",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const user = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(user, async () => {
        await setBrowserAuthorizationRunUserFixture(
          user.runId,
          `user_${randomUUID()}`,
        );
      });

      const organization = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(organization, async () => {
        await setBrowserAuthorizationRunOrganizationFixture(
          organization.runId,
          `org_${randomUUID()}`,
        );
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(user.runId),
      ).resolves.toBe(0);
      await expect(
        countBrowserAuthorizationRequestsFixture(organization.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "denies two exact trigger changes after their locators",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const changed = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(changed, async () => {
        await setBrowserAuthorizationRunTriggerFixture(changed.runId, "goal");
      });

      const changedAgain = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(changedAgain, async () => {
        await setBrowserAuthorizationRunTriggerFixture(
          changedAgain.runId,
          "schedule",
        );
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(changed.runId),
      ).resolves.toBe(0);
      await expect(
        countBrowserAuthorizationRequestsFixture(changedAgain.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "never follows a run rebound or detachment after its original locator",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const other = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(fixture, async () => {
        await setBrowserAuthorizationRunThreadFixture(
          fixture.runId,
          other.threadId,
        );
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(other.runId),
      ).resolves.toBe(0);

      const detached = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(detached, async () => {
        await setBrowserAuthorizationRunThreadFixture(detached.runId, null);
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(detached.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "finds a thread deleted after the locator and returns 404 rather than the initial null-thread 409",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      clearPublications();
      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "locator",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [404]);
            const located = await barrier.entered;
            expect(located.rowCount).toBe(1);
            await chat.deleteThread(fixture.actor, fixture.threadId);
            await flushWaitUntilForTest();
            expectOneInvalidation(fixture);
            clearPublications();
            barrier.release();
            await creating;
          },
        },
        context.signal,
      );
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(0);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "preserves initial null-thread 409 and denies matching run labels that point at a foreign canonical thread",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const unsupported = await createAuthorizationRunFixture();
      await chat.deleteThread(unsupported.actor, unsupported.threadId);
      await flushWaitUntilForTest();
      clearPublications();
      const conflict = await requestAuthorizationCreation(unsupported, [409]);
      expect(conflict.status).toBe(409);
      await expect(
        countBrowserAuthorizationRequestsFixture(unsupported.runId),
      ).resolves.toBe(0);
      expectNoInvalidation(unsupported);

      const fixture = await createAuthorizationRunFixture();
      const foreign = await createAuthorizationRunFixture();
      const fixtureBefore = await readCreationState(fixture);
      const foreignBefore = await readCreationState(foreign);
      await setBrowserAuthorizationRunThreadFixture(
        fixture.runId,
        foreign.threadId,
      );
      await expectCreationDenied(fixture, fixtureBefore);
      await expect(readCreationState(foreign)).resolves.toStrictEqual(
        foreignBefore,
      );
    },
  );

  it(
    "denies a null-Agent thread without changing its thread or request state",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: null,
      });
      clearPublications();
      const denied = await requestAuthorizationCreation(fixture, [404]);
      expect(denied.status).toBe(404);
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: fixture.agentId,
      });
      await expectCreationUnchanged(fixture, before);
    },
  );

  it(
    "reselects a transferred Agent owner and admits its newly discovered closed subject",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const newOwner = orgScoped(bdd.user({ orgId: fixture.orgId }));
      await closeSubject({
        subjectKind: "user",
        subjectId: newOwner.userId,
      });
      await expectLocatorMutationDenied(fixture, async () => {
        await transferAgentOwnerFixture({
          agentId: fixture.agentId,
          owner: newOwner.userId,
        });
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "denies an Agent organization transfer after the locator without relabelling the request",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();
      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "locator",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [404]);
            await barrier.entered;
            await transferAgentOrganizationFixture({
              agentId: fixture.agentId,
              orgId: `org_${randomUUID()}`,
            });
            barrier.release();
            await creating;
          },
        },
        context.signal,
      );
      await transferAgentOrganizationFixture({
        agentId: fixture.agentId,
        orgId: fixture.orgId,
      });
      await expectCreationUnchanged(fixture, before);
      expectNoInvalidation(fixture);
      expect(threadListInvalidationChannels()).toStrictEqual([]);
    },
  );

  it(
    "retries the whole transaction when the thread user changes under the shared KEY SHARE",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();
      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "thread-share",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [404]);
            await barrier.entered;
            // The shared helper's KEY SHARE permits this non-key update. The
            // creation-only SHARE re-read must detect it and restart before the
            // run is locked or any request is inserted.
            await setChatThreadUserFixture({
              chatThreadId: fixture.threadId,
              userId: `user_${randomUUID()}`,
            });
            barrier.release();
            await creating;
          },
        },
        context.signal,
      );
      await setChatThreadUserFixture({
        chatThreadId: fixture.threadId,
        userId: fixture.actor.userId,
      });
      await expectCreationUnchanged(fixture, before);
      expectNoInvalidation(fixture);
      expect(threadListInvalidationChannels()).toStrictEqual([]);
    },
  );

  it(
    "retries a rebound Agent with freshly admitted closed and open owners",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const newOwner = orgScoped(bdd.user({ orgId: fixture.orgId }));
      const reboundAgent = await bdd.createAgent(newOwner, {
        displayName: `Rebound browser authorization ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      await closeSubject({
        subjectKind: "user",
        subjectId: newOwner.userId,
      });
      const before = await readCreationState(fixture);
      clearPublications();

      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "thread-share",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [404]);
            await barrier.entered;
            await setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: reboundAgent.agentId,
            });
            barrier.release();
            await creating;
          },
        },
        context.signal,
      );
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: fixture.agentId,
      });
      await expectCreationUnchanged(fixture, before);
      expectNoInvalidation(fixture);
      expect(threadListInvalidationChannels()).toStrictEqual([]);

      // A second rebind to a distinct, open same-org owner proves the retry can
      // also succeed after admitting the newly discovered subject set in a
      // fresh transaction; the first attempt never carries stale admission
      // forward or silently follows a different run/thread locator.
      const admitted = await createAuthorizationRunFixture();
      const openOwner = orgScoped(bdd.user({ orgId: admitted.orgId }));
      expect(openOwner.userId).not.toBe(admitted.actor.userId);
      const openAgent = await bdd.createAgent(openOwner, {
        displayName: `Open rebound authorization ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const admittedBefore = await readCreationState(admitted);
      clearPublications();
      const created = await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: admitted.threadId,
          runId: admitted.runId,
          stopAt: "thread-share",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(admitted, [200]);
            await barrier.entered;
            await setChatThreadAgentFixture({
              chatThreadId: admitted.threadId,
              agentId: openAgent.agentId,
            });
            barrier.release();
            return await creating;
          },
        },
        context.signal,
      );
      const requestToken = requestTokenFromUrl(
        createdAuthorizationBody(created).authorizationUrl,
      );
      await expect(
        readBrowserAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        runId: admitted.runId,
        chatThreadId: admitted.threadId,
        userId: admitted.actor.userId,
        orgId: admitted.orgId,
      });
      await expect(readCreationState(admitted)).resolves.toStrictEqual({
        ...admittedBefore,
        requestCount: admittedBefore.requestCount + 1,
      });
      expectNoInvalidation(admitted);
    },
  );

  it(
    "holds the retained run against non-key mutation while an unrelated run progresses",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();

      const created = await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "run-pin",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [200]);
            const pinned = await barrier.entered;
            expect(pinned.rowCount).toBe(1);

            // trigger_source is non-key. FOR KEY SHARE would allow this update
            // to land, so the real blocker edge is sensitivity evidence for the
            // stronger retained pin.
            const mutating = setBrowserAuthorizationRunTriggerFixture(
              fixture.runId,
              "goal",
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            await setBrowserAuthorizationRunTriggerFixture(
              unrelated.runId,
              "goal",
            );
            await createAndInspectOpenRequest(unrelated);

            barrier.release();
            const response = await creating;
            await mutating;
            return response;
          },
        },
        context.signal,
      );
      expect(created.status).toBe(200);
      await expect(readCreationState(fixture)).resolves.toStrictEqual({
        ...before,
        requestCount: before.requestCount + 1,
      });
      expectNoInvalidation(fixture);
    },
  );

  it(
    "holds the retained run against deletion through COMMIT while an unrelated run progresses",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      clearPublications();

      const created = await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "insert",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [200]);
            const inserted = await barrier.entered;
            expect(inserted.rowCount).toBe(1);

            const deleting = deleteAgentRunRootFixture(fixture.runId);
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await createAndInspectOpenRequest(unrelated);

            barrier.release();
            const response = await creating;
            await deleting;
            return response;
          },
        },
        context.signal,
      );
      expect(created.status).toBe(200);
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
      const missing = await requestAuthorizationCreation(fixture, [404]);
      expect(missing.status).toBe(404);
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
    },
  );

  it(
    "holds local thread identity before waiting for the run and starts TTL only after the wait",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      const reboundAgent = await bdd.createAgent(fixture.actor, {
        displayName: `Run-wait rebind ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const holder = await holdBrowserAuthorizationCreationRunFixture(
        { runId: fixture.runId },
        context.signal,
      );
      clearPublications();

      const creating = requestAuthorizationCreation(fixture, [200]);
      await expect
        .poll(holder.blockedCreationRunPinCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);

      const movingThread = setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: reboundAgent.agentId,
      });
      // This is the second real blocker edge: holder -> creation's run pin and
      // creation's already-held thread SHARE -> the non-key Agent rebind.
      await expect
        .poll(holder.blockedThreadMutationCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      await createAndInspectOpenRequest(unrelated);

      const admittedAtMs = STARTED_AT_MS + 5 * 60_000;
      mockNow(admittedAtMs);
      holder.release();
      await holder.done;
      const created = await creating;
      await movingThread;
      await setChatThreadAgentFixture({
        chatThreadId: fixture.threadId,
        agentId: fixture.agentId,
      });

      const createdBody = createdAuthorizationBody(created);
      expect(createdBody.expiresAt).toBe(
        new Date(admittedAtMs + HOUR_MS).toISOString(),
      );
      const requestToken = requestTokenFromUrl(createdBody.authorizationUrl);
      await expect(
        readBrowserAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        createdAt: new Date(admittedAtMs).toISOString(),
        updatedAt: new Date(admittedAtMs).toISOString(),
        expiresAt: new Date(admittedAtMs + HOUR_MS).toISOString(),
      });
      await expect(readCreationState(fixture)).resolves.toStrictEqual({
        ...before,
        requestCount: before.requestCount + 1,
      });
      expectNoInvalidation(fixture);
    },
  );

  it(
    "holds canonical thread deletion behind the inserted request and leaves the winner durable",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      clearPublications();

      const created = await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "insert",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(fixture, [200]);
            const inserted = await barrier.entered;
            expect(inserted.rowCount).toBe(1);
            expectNoInvalidation(fixture);

            const deleting = chat.deleteThread(fixture.actor, fixture.threadId);
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await createAndInspectOpenRequest(unrelated);

            barrier.release();
            const response = await creating;
            await deleting;
            await flushWaitUntilForTest();
            return response;
          },
        },
        context.signal,
      );
      const requestToken = requestTokenFromUrl(
        createdAuthorizationBody(created).authorizationUrl,
      );
      await expect(
        readBrowserAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        runId: fixture.runId,
        chatThreadId: fixture.threadId,
      });
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(1);
      expectOneInvalidation(fixture);
      clearPublications();
      const unsupported = await requestAuthorizationCreation(fixture, [409]);
      expect(unsupported.status).toBe(409);
      await expect(
        countBrowserAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(1);
      expectNoInvalidation(fixture);
    },
  );

  it(
    "rolls back an executed INSERT when the real operation signal aborts before the final transaction check",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      const cancelled = new AbortController();
      clearPublications();

      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "insert",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(
              fixture,
              [200, 404],
              undefined,
              cancelled.signal,
            );
            const inserted = await barrier.entered;
            expect(inserted.rowCount).toBe(1);
            await expect(
              countBrowserAuthorizationRequestsFixture(fixture.runId),
            ).resolves.toBe(before.requestCount);

            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await expect(creating).rejects.toThrow(
              /Unknown response status 500/,
            );
          },
        },
        context.signal,
      );
      await expectCreationUnchanged(fixture, before);
    },
  );

  it(
    "documents the lost-response boundary by committing an abort that arrives after the final transaction check",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      const cancelled = new AbortController();
      clearPublications();

      await withBrowserAuthorizationCreateBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          runId: fixture.runId,
          stopAt: "commit",
          work: async (barrier) => {
            const creating = requestAuthorizationCreation(
              fixture,
              [200, 404],
              undefined,
              cancelled.signal,
            );
            await barrier.entered;
            await expect(
              countBrowserAuthorizationRequestsFixture(fixture.runId),
            ).resolves.toBe(before.requestCount);
            expectNoInvalidation(fixture);

            // The helper's final in-transaction check has passed. COMMIT has
            // not been dispatched yet, but this abort is already too late to
            // guarantee rollback: the row lands and only the response is lost.
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await expect(creating).rejects.toThrow(
              /Unknown response status 500/,
            );
          },
        },
        context.signal,
      );

      await expect(readCreationState(fixture)).resolves.toStrictEqual({
        ...before,
        requestCount: before.requestCount + 1,
      });
      expectNoInvalidation(fixture);
    },
  );

  it(
    "scopes a real INSERT lock timeout to one run while unrelated creation progresses",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      const unrelated = await createAuthorizationRunFixture();
      const before = await readCreationState(fixture);
      const holder = await holdBrowserAuthorizationRequestInsertFixture(
        { runId: fixture.runId },
        context.signal,
      );
      clearPublications();

      const creating = requestAuthorizationCreation(fixture, [200, 404]);
      await expect
        .poll(holder.blockedRequestInsertCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      await createAndInspectOpenRequest(unrelated);
      await expect(creating).rejects.toThrow(/Unknown response status 500/);
      await holder.release();

      await expectCreationUnchanged(fixture, before);
    },
  );
});
