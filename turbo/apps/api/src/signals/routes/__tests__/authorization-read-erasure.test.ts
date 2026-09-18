import { randomUUID } from "node:crypto";

import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
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
  expireComputerUseAuthorizationReadRequestFixture,
  holdBrowserAuthorizationReadRequestFixture,
  holdComputerUseAuthorizationReadRequestFixture,
  mutateBrowserAuthorizationReadRequestFixture,
  mutateComputerUseAuthorizationReadRequestFixture,
  withBrowserAuthorizationReadBarrierFixture,
  withComputerUseAuthorizationReadBarrierFixture,
} from "../../../test-fixtures/authorization-read";
import {
  expireBrowserAuthorizationRequestFixture,
  readBrowserAuthorizationRequestFixture,
  setBrowserAuthorizationRunTriggerFixture,
  withBrowserAuthorizationApplyBarrierFixture,
} from "../../../test-fixtures/browser-authorization";
import { withComputerUseAuthorizationApplyBarrierFixture } from "../../../test-fixtures/computer-use-authorization-apply";
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
import { settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { browserAuthorizationRoutes } from "../browser-authorization";
import { computerUseAuthorizationRoutes } from "../computer-use-authorization";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

type ReadKind = "browser" | "computer-use";
type Settled<T> = Awaited<ReturnType<typeof settleIncludingAbort<T>>>;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Authorization reads require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

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

function browserAuthorizationClient(signal?: AbortSignal) {
  return setupApp({ context, routes: browserAuthorizationRoutes, signal })(
    browserAuthorizationRequestsContract,
  );
}

function computerUseAuthorizationClient(signal?: AbortSignal) {
  return setupApp({ context, routes: computerUseAuthorizationRoutes, signal })(
    computerUseAuthorizationRequestsContract,
  );
}

interface AuthorizationReadFixture {
  readonly kind: ReadKind;
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly owner: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly requestToken: string;
  readonly expiresAt: string;
  readonly hostId: string | null;
}

function requestTokenFromUrl(authorizationUrl: string): string {
  return decodeURIComponent(
    new URL(authorizationUrl).pathname.split("/").at(-1) ?? "",
  );
}

async function createAuthorizationReadFixture(args: {
  readonly kind: ReadKind;
  readonly sharedAgent?: boolean;
  readonly triggerSource?: "slack" | "teams";
  readonly withHost?: boolean;
}): Promise<AuthorizationReadFixture> {
  mockEnv("APP_URL", "https://app.okou.ai");
  const orgId = `org_${randomUUID()}`;
  const actor = orgScoped(bdd.user({ orgId }));
  const owner = args.sharedAgent ? orgScoped(bdd.user({ orgId })) : actor;
  bdd.acceptAgentStorageWrites();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(owner, {
    displayName: `Authorization read ${randomUUID().slice(0, 8)}`,
    visibility: "public",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "Ask the user to authorize remote browser access",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected an authorization read chat run");
  }
  if (args.triggerSource) {
    if (args.kind === "browser") {
      await setBrowserAuthorizationRunTriggerFixture(
        sent.body.runId,
        args.triggerSource,
      );
    } else {
      await setComputerUseAuthorizationRunTriggerFixture(
        sent.body.runId,
        args.triggerSource,
      );
    }
  }

  const host =
    args.kind === "computer-use" && args.withHost !== false
      ? await computerUse.startComputerUseHost(actor, {
          hostName: `Read host ${randomUUID().slice(0, 8)}`,
        })
      : null;
  const bearer = runs.sandboxTokenForRun(actor, sent.body.runId);
  const created =
    args.kind === "browser"
      ? await accept(
          browserAuthorizationClient().create({
            headers: { authorization: `Bearer ${bearer}` },
            body: {},
          }),
          [200],
        )
      : await accept(
          computerUseAuthorizationClient().create({
            headers: { authorization: `Bearer ${bearer}` },
            body: {},
          }),
          [200],
        );
  const requestToken = requestTokenFromUrl(created.body.authorizationUrl);
  const expectedPrefix =
    args.kind === "browser"
      ? "vm0_browser_authorization_request_"
      : "vm0_computer_use_authorization_request_";
  expect(requestToken.startsWith(expectedPrefix)).toBeTruthy();
  if (args.kind === "computer-use") {
    expect("source" in created.body && created.body.source).toBe("chat");
  }
  return {
    kind: args.kind,
    actor,
    owner,
    agentId: agent.agentId,
    threadId: sent.body.threadId,
    runId: sent.body.runId,
    requestToken,
    expiresAt: created.body.expiresAt,
    hostId: host?.hostId ?? null,
  };
}

async function createAuthorizationRequestForKind(
  fixture: AuthorizationReadFixture,
  kind: ReadKind,
): Promise<AuthorizationReadFixture> {
  const bearer = runs.sandboxTokenForRun(fixture.actor, fixture.runId);
  const created =
    kind === "browser"
      ? await accept(
          browserAuthorizationClient().create({
            headers: { authorization: `Bearer ${bearer}` },
            body: {},
          }),
          [200],
        )
      : await accept(
          computerUseAuthorizationClient().create({
            headers: { authorization: `Bearer ${bearer}` },
            body: {},
          }),
          [200],
        );
  if (kind === "computer-use") {
    expect("source" in created.body && created.body.source).toBe("chat");
  }
  return {
    ...fixture,
    kind,
    requestToken: requestTokenFromUrl(created.body.authorizationUrl),
    expiresAt: created.body.expiresAt,
  };
}

async function readAuthorization(
  fixture: AuthorizationReadFixture,
  statuses: readonly (200 | 401 | 403 | 404 | 410)[],
  options?: {
    readonly actor?: ApiTestUser | null;
    readonly signal?: AbortSignal;
  },
) {
  const actor = options?.actor === undefined ? fixture.actor : options.actor;
  if (fixture.kind === "browser") {
    return await accept(
      browserAuthorizationClient(options?.signal).get({
        headers: authenticate(actor),
        params: { requestToken: fixture.requestToken },
      }),
      statuses,
    );
  }
  return await accept(
    computerUseAuthorizationClient(options?.signal).get({
      headers: authenticate(actor),
      params: { requestToken: fixture.requestToken },
    }),
    statuses,
  );
}

async function applyAuthorization(
  fixture: AuthorizationReadFixture,
): Promise<void> {
  if (fixture.kind === "browser") {
    await accept(
      browserAuthorizationClient().apply({
        headers: authenticate(fixture.actor),
        params: { requestToken: fixture.requestToken },
        body: {},
      }),
      [200],
    );
    return;
  }
  if (!fixture.hostId) {
    throw new Error("Computer Use Apply requires the fixture host");
  }
  await accept(
    computerUseAuthorizationClient().apply({
      headers: authenticate(fixture.actor),
      params: { requestToken: fixture.requestToken },
      body: { computerUseHostId: fixture.hostId },
    }),
    [200],
  );
}

function expectFoundProjection(
  response: Awaited<ReturnType<typeof readAuthorization>>,
  fixture: AuthorizationReadFixture,
  completed: boolean,
): void {
  expect(response.status).toBe(200);
  if (response.status !== 200) {
    throw new Error("Expected a successful authorization projection");
  }
  expect(response.body.expiresAt).toBe(fixture.expiresAt);
  if (completed) {
    expect(response.body.completedAt).not.toBeNull();
  } else {
    expect(response.body.completedAt).toBeNull();
  }
  if (fixture.kind === "browser") {
    expect("cloudBrowserEnabled" in response.body).toBeTruthy();
    if ("cloudBrowserEnabled" in response.body) {
      expect(response.body.cloudBrowserEnabled).toBe(completed);
    }
    return;
  }
  expect("hosts" in response.body).toBeTruthy();
  if ("hosts" in response.body) {
    expect(response.body.source).toBe("chat");
    expect(response.body.computerUseHostId).toBe(
      completed ? fixture.hostId : null,
    );
    if (fixture.hostId) {
      expect(response.body.hosts).toContainEqual(
        expect.objectContaining({ id: fixture.hostId, status: "online" }),
      );
    }
  }
}

async function sidebarSequence(fixture: AuthorizationReadFixture) {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  const events = response.body.events.filter((event) => {
    return event.chatThreadId === fixture.threadId;
  });
  return {
    events,
    lastSeqId: response.body.events.reduce((highest, event) => {
      return Math.max(highest, event.seqId);
    }, 0),
  };
}

async function durableReadState(fixture: AuthorizationReadFixture) {
  const request =
    fixture.kind === "browser"
      ? await readBrowserAuthorizationRequestFixture(fixture.requestToken)
      : await readComputerUseAuthorizationRequestFixture(fixture.requestToken);
  if (!request) {
    throw new Error("Expected the authorization request durable state");
  }
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return {
    request,
    thread: await readChatThreadTitleStateFixture(fixture.threadId),
    selection: {
      computerUseHostId: metadata.computerUseHostId,
      cloudBrowserEnabled: metadata.cloudBrowserEnabled,
    },
    sidebar: await sidebarSequence(fixture),
  };
}

function clearPublications(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function expectNoPublications(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

function closeSubject(subject: ErasureSubject) {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

function subjectFor(
  fixture: AuthorizationReadFixture,
  subject: "agent-owner" | "organization" | "thread-user",
): ErasureSubject {
  if (subject === "organization") {
    return { subjectKind: "organization", subjectId: fixture.actor.orgId };
  }
  return {
    subjectKind: "user",
    subjectId:
      subject === "agent-owner" ? fixture.owner.userId : fixture.actor.userId,
  };
}

function expectDeniedBody(body: unknown, fixture: AuthorizationReadFixture) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(fixture.expiresAt);
  expect(serialized).not.toContain(fixture.requestToken);
  if (fixture.hostId) {
    expect(serialized).not.toContain(fixture.hostId);
  }
  expect(serialized).not.toContain("completedAt");
  expect(serialized).not.toContain("cloudBrowserEnabled");
  expect(serialized).not.toContain("hosts");
}

function valueOf<T>(outcome: Settled<T>): T {
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

interface OwnedOperationScope {
  readonly start: <T>(
    operation: Promise<T>,
    inspect?: (outcome: Settled<T>) => void,
  ) => Promise<Settled<T>>;
  readonly own: <T>(
    operation: Promise<T>,
    inspect?: (outcome: Settled<T>) => void,
  ) => void;
  readonly release: () => Promise<void>;
}

/**
 * Owns every finite operation started around a database barrier. The barrier is
 * released before joins on every exit, and all settled outcomes are inspected
 * even when the work body throws first.
 */
async function withOwnedOperations<T>(
  release: () => void | Promise<void>,
  work: (scope: OwnedOperationScope) => Promise<T>,
): Promise<T> {
  const joins: (() => Promise<void>)[] = [];
  let released: Promise<void> | undefined;
  const releaseOnce = async () => {
    released ??= Promise.resolve(release());
    await released;
  };
  const worked = await settleIncludingAbort(
    work({
      start: <T>(
        operation: Promise<T>,
        inspect: (outcome: Settled<T>) => void = valueOf,
      ) => {
        const outcome = settleIncludingAbort(operation);
        joins.push(async () => {
          inspect(await outcome);
        });
        return outcome;
      },
      own: <T>(
        operation: Promise<T>,
        inspect: (outcome: Settled<T>) => void = valueOf,
      ) => {
        const outcome = settleIncludingAbort(operation);
        joins.push(async () => {
          inspect(await outcome);
        });
      },
      release: releaseOnce,
    }),
  );
  const releaseOutcome = await settleIncludingAbort(releaseOnce());
  const joined = await Promise.all(
    joins.map(async (join) => {
      return await settleIncludingAbort(join());
    }),
  );
  const errors: unknown[] = [];
  if (!worked.ok) {
    errors.push(worked.error);
  }
  if (!releaseOutcome.ok) {
    errors.push(releaseOutcome.error);
  }
  for (const outcome of joined) {
    if (!outcome.ok) {
      errors.push(outcome.error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Owned authorization operations failed");
  }
  if (!worked.ok) {
    throw worked.error;
  }
  return worked.value;
}

function expectOperationFailure(pattern: RegExp) {
  return <T>(outcome: Settled<T>): void => {
    expect(outcome.ok).toBeFalsy();
    if (!outcome.ok) {
      expect(String(outcome.error)).toMatch(pattern);
    }
  };
}

async function expectNextProductionWrite(
  fixture: AuthorizationReadFixture,
  baselineSeqId: number,
): Promise<void> {
  await applyAuthorization(fixture);
  const after = await sidebarSequence(fixture);
  expect(after.lastSeqId).toBe(baselineSeqId + 1);
}

describe.each(["browser", "computer-use"] as const)(
  "%s authorization GET account-erasure fence",
  (kind) => {
    it.each(["thread-user", "agent-owner", "organization"] as const)(
      "keeps open/closed/restored controls for the %s and consumes no hidden sequence",
      { timeout: CASE_TIMEOUT_MS },
      async (subjectName) => {
        const fixture = await createAuthorizationReadFixture({
          kind,
          sharedAgent: subjectName === "agent-owner",
        });
        if (subjectName === "agent-owner") {
          expect(fixture.owner.userId).not.toBe(fixture.actor.userId);
          expect(fixture.owner.orgId).toBe(fixture.actor.orgId);
        }
        const open = await readAuthorization(fixture, [200]);
        expect(open.status).toBe(200);
        const baseline = await durableReadState(fixture);
        const closed = await closeSubject(subjectFor(fixture, subjectName));
        clearPublications();

        const denied = await readAuthorization(fixture, [404]);
        expect(denied.status).toBe(404);
        expectDeniedBody(denied.body, fixture);
        await expect(durableReadState(fixture)).resolves.toStrictEqual(
          baseline,
        );
        expectNoPublications();

        await removeErasureSubjectsFixture([closed.jobId]);
        const restored = await readAuthorization(fixture, [200]);
        expect(restored.status).toBe(200);
        await expectNextProductionWrite(fixture, baseline.sidebar.lastSeqId);
      },
    );

    it.each(["slack", "teams"] as const)(
      "reads canonical %s-triggered source:chat without requiring the original run",
      { timeout: CASE_TIMEOUT_MS },
      async (triggerSource) => {
        const fixture = await createAuthorizationReadFixture({
          kind,
          triggerSource,
        });
        await deleteAgentRunRootFixture(fixture.runId);
        clearPublications();
        const response = await readAuthorization(fixture, [200]);
        expect(response.status).toBe(200);
        if (
          kind === "computer-use" &&
          response.status === 200 &&
          "source" in response.body
        ) {
          expect(response.body.source).toBe("chat");
        }
        expectNoPublications();
      },
    );

    it(
      "preserves authentication, exact actor/org 404, expiry 410 and expiry-before-scope precedence",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const foreign = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
        const unauthenticated = await readAuthorization(fixture, [401], {
          actor: null,
        });
        expect(unauthenticated.status).toBe(401);
        const wrongActor = await readAuthorization(fixture, [404], {
          actor: foreign,
        });
        expectDeniedBody(wrongActor.body, fixture);

        if (kind === "browser") {
          await expireBrowserAuthorizationRequestFixture({
            requestToken: fixture.requestToken,
            expiresAt: new Date(STARTED_AT_MS - 1),
          });
        } else {
          await expireComputerUseAuthorizationReadRequestFixture({
            requestToken: fixture.requestToken,
            expiresAt: new Date(STARTED_AT_MS - 1),
          });
        }
        await closeSubject({
          subjectKind: "user",
          subjectId: fixture.actor.userId,
        });
        const expired = await readAuthorization(fixture, [410]);
        expect(expired.status).toBe(410);
        const stillOpaque = await readAuthorization(fixture, [404], {
          actor: foreign,
        });
        expect(stillOpaque.status).toBe(404);
      },
    );

    it(
      "returns incomplete and completed projections without publishing or changing durable state",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const before = await durableReadState(fixture);
        clearPublications();
        const incomplete = await readAuthorization(fixture, [200]);
        expect(incomplete.status).toBe(200);
        if (incomplete.status === 200) {
          expect(incomplete.body.completedAt).toBeNull();
          if (kind === "browser") {
            expect("cloudBrowserEnabled" in incomplete.body).toBeTruthy();
          } else {
            expect("computerUseHostId" in incomplete.body).toBeTruthy();
          }
        }
        await expect(durableReadState(fixture)).resolves.toStrictEqual(before);
        expectNoPublications();

        await applyAuthorization(fixture);
        const applied = await durableReadState(fixture);
        clearPublications();
        const completed = await readAuthorization(fixture, [200]);
        expect(completed.status).toBe(200);
        if (completed.status === 200) {
          expect(completed.body.completedAt).not.toBeNull();
        }
        await expect(durableReadState(fixture)).resolves.toStrictEqual(applied);
        expectNoPublications();
      },
    );

    it(
      "returns 404 for a missing or Agent-less canonical scope",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        expect.hasAssertions();
        const agentless = await createAuthorizationReadFixture({ kind });
        await setChatThreadAgentFixture({
          chatThreadId: agentless.threadId,
          agentId: null,
        });
        const noAgent = await readAuthorization(agentless, [404]);
        expectDeniedBody(noAgent.body, agentless);

        const missing = await createAuthorizationReadFixture({ kind });
        await chat.deleteThread(missing.actor, missing.threadId);
        const noThread = await readAuthorization(missing, [404]);
        expectDeniedBody(noThread.body, missing);
      },
    );

    it(
      "retries a non-null thread Agent rebind against the newly admitted closed owner",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const nextOwner = orgScoped(bdd.user({ orgId: fixture.actor.orgId }));
        const rebound = await bdd.createAgent(nextOwner, {
          displayName: `Closed read rebind ${randomUUID().slice(0, 8)}`,
          visibility: "public",
        });
        await closeSubject({
          subjectKind: "user",
          subjectId: nextOwner.userId,
        });
        const run = async (barrier: {
          readonly entered: Promise<unknown>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(readAuthorization(fixture, [404]));
            await barrier.entered;
            await setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: rebound.agentId,
            });
            await scope.release();
            const denied = valueOf(await reading);
            expect(denied.status).toBe(404);
            expectDeniedBody(denied.body, fixture);
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-identity-thread-lock",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-identity-thread-lock",
              work: run,
            },
            context.signal,
          );
        }
      },
    );

    it(
      "retries a thread identity change before the local pin and denies the moved scope",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const movedUserId = `user_${randomUUID()}`;
        const run = async (barrier: {
          readonly entered: Promise<unknown>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(readAuthorization(fixture, [404]));
            await barrier.entered;
            await setChatThreadUserFixture({
              chatThreadId: fixture.threadId,
              userId: movedUserId,
            });
            await scope.release();
            const denied = valueOf(await reading);
            expect(denied.status).toBe(404);
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-identity-thread-lock",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-identity-thread-lock",
              work: run,
            },
            context.signal,
          );
        }
      },
    );

    it(
      "reselects a transferred Agent owner, then admits that real new subject",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({
          kind,
          sharedAgent: true,
        });
        const nextOwner = orgScoped(bdd.user({ orgId: fixture.actor.orgId }));
        const run = async (barrier: {
          readonly entered: Promise<unknown>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(readAuthorization(fixture, [200]));
            await barrier.entered;
            await transferAgentOwnerFixture({
              agentId: fixture.agentId,
              owner: nextOwner.userId,
            });
            await scope.release();
            expect(valueOf(await reading).status).toBe(200);
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-agent-lock",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-agent-lock",
              work: run,
            },
            context.signal,
          );
        }
        await closeSubject({
          subjectKind: "user",
          subjectId: nextOwner.userId,
        });
        await expect(readAuthorization(fixture, [404])).resolves.toMatchObject({
          status: 404,
        });
      },
    );

    it(
      "denies an Agent organization transfer selected before its identity lock",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const run = async (barrier: {
          readonly entered: Promise<unknown>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(readAuthorization(fixture, [404]));
            await barrier.entered;
            await transferAgentOrganizationFixture({
              agentId: fixture.agentId,
              orgId: `org_${randomUUID()}`,
            });
            await scope.release();
            expect(valueOf(await reading).status).toBe(404);
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-agent-lock",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "before-agent-lock",
              work: run,
            },
            context.signal,
          );
        }
      },
    );

    it(
      "retains thread identity through a real request-pin wait",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const holder =
          kind === "browser"
            ? await holdBrowserAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              })
            : await holdComputerUseAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              });
        await withOwnedOperations(holder.release, async (scope) => {
          const reading = scope.start(readAuthorization(fixture, [200]));
          await expect
            .poll(holder.blockedRequestPinCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          const moving = scope.start(
            setChatThreadUserFixture({
              chatThreadId: fixture.threadId,
              userId: `user_${randomUUID()}`,
            }),
          );
          const blocked = scope.start(
            (async () => {
              await expect
                .poll(holder.blockedIdentityMutationCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);
            })(),
          );
          valueOf(await blocked);
          await scope.release();
          expect(valueOf(await reading).status).toBe(200);
          valueOf(await moving);
        });
        await expect(readAuthorization(fixture, [404])).resolves.toMatchObject({
          status: 404,
        });
      },
    );

    it(
      "rechecks exact request identity after a meaningful request-pin wait",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const holder =
          kind === "browser"
            ? await holdBrowserAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
                mutateBeforeCommit: "hash",
              })
            : await holdComputerUseAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
                mutateBeforeCommit: "hash",
              });
        await withOwnedOperations(holder.release, async (scope) => {
          const reading = scope.start(readAuthorization(fixture, [404]));
          await expect
            .poll(holder.blockedRequestPinCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await scope.release();
          const denied = valueOf(await reading);
          expect(denied.status).toBe(404);
          expectDeniedBody(denied.body, fixture);
        });
      },
    );

    it(
      "rechecks TTL after the request-pin wait",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const holder =
          kind === "browser"
            ? await holdBrowserAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              })
            : await holdComputerUseAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              });
        await withOwnedOperations(holder.release, async (scope) => {
          const reading = scope.start(readAuthorization(fixture, [410]));
          await expect
            .poll(holder.blockedRequestPinCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          mockNow(STARTED_AT_MS + HOUR_MS + 1);
          await scope.release();
          expect(valueOf(await reading).status).toBe(410);
        });
      },
    );

    it(
      "lets read-first finish while real closure waits, then denies subsequent reads",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const unrelated = await createAuthorizationReadFixture({ kind });
        const run = async (barrier: {
          readonly entered: Promise<{
            readonly lockTimeout: string;
            readonly statementTimeout: string;
            readonly transactionTimeout: string;
          }>;
          readonly blockedWaiterCount: () => Promise<number>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(readAuthorization(fixture, [200]));
            const entered = await barrier.entered;
            expect(entered).toMatchObject({
              lockTimeout: "1s",
              statementTimeout: "5s",
              transactionTimeout: "0",
            });
            const closing = scope.start(
              closeSubject({
                subjectKind: "user",
                subjectId: fixture.actor.userId,
              }),
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await expect(
              readAuthorization(unrelated, [200]),
            ).resolves.toMatchObject({
              status: 200,
            });
            await scope.release();
            expect(valueOf(await reading).status).toBe(200);
            valueOf(await closing);
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "request-pin",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "hosts",
              work: run,
            },
            context.signal,
          );
        }
        const denied = await readAuthorization(fixture, [404]);
        expect(denied.status).toBe(404);
      },
    );

    it(
      "makes closure-first wait on the real admission edge and return no projection",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const closing = scope.start(
              closeSubject({
                subjectKind: "organization",
                subjectId: fixture.actor.orgId,
              }),
            );
            await barrier.entered;
            const reading = scope.start(readAuthorization(fixture, [404]));
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            await scope.release();
            valueOf(await closing);
            const denied = valueOf(await reading);
            expect(denied.status).toBe(404);
            expectDeniedBody(denied.body, fixture);
          });
        }, context.signal);
      },
    );

    it(
      "propagates request-lock timeout while unrelated owner progress continues",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const unrelated = await createAuthorizationReadFixture({ kind });
        const baseline = await durableReadState(fixture);
        const holder =
          kind === "browser"
            ? await holdBrowserAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              })
            : await holdComputerUseAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                signal: context.signal,
              });
        await withOwnedOperations(holder.release, async (scope) => {
          const reading = scope.start(
            readAuthorization(fixture, [200, 404]),
            expectOperationFailure(/Unknown response status 500/),
          );
          await expect
            .poll(holder.blockedRequestPinCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await expect(
            readAuthorization(unrelated, [200]),
          ).resolves.toMatchObject({
            status: 200,
          });
          const failed = await reading;
          expectOperationFailure(/Unknown response status 500/)(failed);
        });
        await expect(durableReadState(fixture)).resolves.toStrictEqual(
          baseline,
        );
      },
    );

    it(
      "rolls back cleanly when the operation signal aborts before the final transaction check",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const fixture = await createAuthorizationReadFixture({ kind });
        const baseline = await durableReadState(fixture);
        const cancelled = new AbortController();
        const run = async (barrier: {
          readonly entered: Promise<unknown>;
          readonly release: () => void;
        }) => {
          await withOwnedOperations(barrier.release, async (scope) => {
            const reading = scope.start(
              readAuthorization(fixture, [200], {
                signal: cancelled.signal,
              }),
              expectOperationFailure(/Unknown response status 500/),
            );
            await barrier.entered;
            cancelled.abort(new DOMException("Operation ended", "AbortError"));
            await scope.release();
            expectOperationFailure(/Unknown response status 500/)(
              await reading,
            );
          });
        };
        if (kind === "browser") {
          await withBrowserAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "request-pin",
              work: run,
            },
            context.signal,
          );
        } else {
          await withComputerUseAuthorizationReadBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              requestToken: fixture.requestToken,
              stopAt: "hosts",
              work: run,
            },
            context.signal,
          );
        }
        await expect(durableReadState(fixture)).resolves.toStrictEqual(
          baseline,
        );
        await expect(readAuthorization(fixture, [200])).resolves.toMatchObject({
          status: 200,
        });
      },
    );
  },
);

describe("authorization GET same-thread concurrency and operation ownership", () => {
  it.each([
    ["browser/browser", "browser", "browser"],
    ["computer-use/computer-use", "computer-use", "computer-use"],
    ["mixed", "computer-use", "browser"],
  ] as const)(
    "serializes %s before the caller-local thread pin without writes",
    { timeout: 60_000 },
    async (_label, firstKind, secondKind) => {
      const first = await createAuthorizationReadFixture({ kind: firstKind });
      const second =
        firstKind === secondKind
          ? first
          : await createAuthorizationRequestForKind(first, secondKind);
      const unrelated = await createAuthorizationReadFixture({
        kind: firstKind,
      });
      const baseline = await durableReadState(first);
      clearPublications();
      const run = async (barrier: {
        readonly entered: Promise<{
          readonly lockTimeout: string;
          readonly statementTimeout: string;
          readonly transactionTimeout: string;
        }>;
        readonly blockedWaiterCount: () => Promise<number>;
        readonly release: () => void;
      }) => {
        await withOwnedOperations(barrier.release, async (scope) => {
          const firstRead = scope.start(readAuthorization(first, [200]));
          const entered = await barrier.entered;
          expect(entered).toMatchObject({
            lockTimeout: "1s",
            statementTimeout: "5s",
            transactionTimeout: "0",
          });
          const secondRead = scope.start(readAuthorization(second, [200]));
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await expect(
            readAuthorization(unrelated, [200]),
          ).resolves.toMatchObject({ status: 200 });
          await scope.release();
          expectFoundProjection(valueOf(await firstRead), first, false);
          expectFoundProjection(valueOf(await secondRead), second, false);
        });
      };
      if (first.kind === "browser") {
        await withBrowserAuthorizationReadBarrierFixture(
          {
            chatThreadId: first.threadId,
            requestToken: first.requestToken,
            stopAt: "before-thread-pin",
            work: run,
          },
          context.signal,
        );
      } else {
        await withComputerUseAuthorizationReadBarrierFixture(
          {
            chatThreadId: first.threadId,
            requestToken: first.requestToken,
            stopAt: "before-thread-pin",
            work: run,
          },
          context.signal,
        );
      }
      await expect(durableReadState(first)).resolves.toStrictEqual(baseline);
      expectNoPublications();
    },
  );

  it.each(["browser", "computer-use"] as const)(
    "lets %s GET finish before a waiting Apply without an upgrade cycle",
    { timeout: 60_000 },
    async (kind) => {
      const fixture = await createAuthorizationReadFixture({ kind });
      const baseline = await durableReadState(fixture);
      const run = async (barrier: {
        readonly entered: Promise<unknown>;
        readonly blockedWaiterCount: () => Promise<number>;
        readonly release: () => void;
      }) => {
        await withOwnedOperations(barrier.release, async (scope) => {
          const reading = scope.start(readAuthorization(fixture, [200]));
          await barrier.entered;
          const applying = scope.start(applyAuthorization(fixture));
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await scope.release();
          expectFoundProjection(valueOf(await reading), fixture, false);
          valueOf(await applying);
        });
      };
      if (kind === "browser") {
        await withBrowserAuthorizationReadBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            requestToken: fixture.requestToken,
            stopAt: "before-thread-pin",
            work: run,
          },
          context.signal,
        );
      } else {
        await withComputerUseAuthorizationReadBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            requestToken: fixture.requestToken,
            stopAt: "before-thread-pin",
            work: run,
          },
          context.signal,
        );
      }
      const after = await durableReadState(fixture);
      expect(after.sidebar.lastSeqId).toBe(baseline.sidebar.lastSeqId + 1);
      expect(after.request.completedAt).not.toBeNull();
    },
  );

  it.each(["browser", "computer-use"] as const)(
    "lets %s Apply finish before a waiting GET without an upgrade cycle",
    { timeout: 60_000 },
    async (kind) => {
      const fixture = await createAuthorizationReadFixture({ kind });
      const baseline = await durableReadState(fixture);
      const run = async (barrier: {
        readonly entered: Promise<unknown>;
        readonly blockedWaiterCount: () => Promise<number>;
        readonly release: () => void;
      }) => {
        await withOwnedOperations(barrier.release, async (scope) => {
          const applying = scope.start(applyAuthorization(fixture));
          await barrier.entered;
          const reading = scope.start(readAuthorization(fixture, [200]));
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await scope.release();
          valueOf(await applying);
          expectFoundProjection(valueOf(await reading), fixture, true);
        });
      };
      if (kind === "browser") {
        await withBrowserAuthorizationApplyBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            stopAt: "request-pin",
            work: run,
          },
          context.signal,
        );
      } else {
        await withComputerUseAuthorizationApplyBarrierFixture(
          {
            chatThreadId: fixture.threadId,
            stopAt: "request-pin",
            work: run,
          },
          context.signal,
        );
      }
      const after = await durableReadState(fixture);
      expect(after.sidebar.lastSeqId).toBe(baseline.sidebar.lastSeqId + 1);
      expect(after.request.completedAt).not.toBeNull();
    },
  );

  it.each(["browser", "computer-use"] as const)(
    "releases and joins a blocked %s GET after a deliberate early exit",
    { timeout: 60_000 },
    async (kind) => {
      const fixture = await createAuthorizationReadFixture({ kind });
      const holder =
        kind === "browser"
          ? await holdBrowserAuthorizationReadRequestFixture({
              requestToken: fixture.requestToken,
              signal: context.signal,
            })
          : await holdComputerUseAuthorizationReadRequestFixture({
              requestToken: fixture.requestToken,
              signal: context.signal,
            });
      const earlyExit = new Error("deliberate authorization read early exit");
      let joined = false;
      const outcome = await settleIncludingAbort(
        withOwnedOperations(holder.release, async (scope) => {
          scope.own(readAuthorization(fixture, [200]), (read) => {
            expectFoundProjection(valueOf(read), fixture, false);
            joined = true;
          });
          await expect
            .poll(holder.blockedRequestPinCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          throw earlyExit;
        }),
      );
      expect(outcome.ok).toBeFalsy();
      if (!outcome.ok) {
        expect(outcome.error).toBe(earlyExit);
      }
      expect(joined).toBeTruthy();
      await expect(readAuthorization(fixture, [200])).resolves.toMatchObject({
        status: 200,
      });
    },
  );

  it.each(["browser", "computer-use"] as const)(
    "joins a %s request holder whose readiness fails",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fixture = await createAuthorizationReadFixture({ kind });
      const holding =
        kind === "browser"
          ? holdBrowserAuthorizationReadRequestFixture({
              requestToken: `${fixture.requestToken}-missing`,
              signal: context.signal,
            })
          : holdComputerUseAuthorizationReadRequestFixture({
              requestToken: `${fixture.requestToken}-missing`,
              signal: context.signal,
            });
      const failed = await settleIncludingAbort(holding);
      expect(failed.ok).toBeFalsy();
      if (!failed.ok) {
        expect(String(failed.error)).toMatch(
          /Expected the authorization read request row/,
        );
      }
      await expect(readAuthorization(fixture, [200])).resolves.toMatchObject({
        status: 200,
      });
    },
  );
});

describe("authorization GET exact locator and host projection", () => {
  it.each(["delete", "hash", "organization", "run", "thread", "user"] as const)(
    "browser rejects request %s after its unlocked locator",
    { timeout: CASE_TIMEOUT_MS },
    async (mutation) => {
      const fixture = await createAuthorizationReadFixture({ kind: "browser" });
      await withBrowserAuthorizationReadBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          requestToken: fixture.requestToken,
          stopAt: "locator",
          work: async (barrier) => {
            await withOwnedOperations(barrier.release, async (scope) => {
              const reading = scope.start(readAuthorization(fixture, [404]));
              const located = await barrier.entered;
              expect(located.rowCount).toBe(1);
              await mutateBrowserAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                mutation,
              });
              await scope.release();
              expect(valueOf(await reading).status).toBe(404);
            });
          },
        },
        context.signal,
      );
    },
  );

  it.each([
    "delete",
    "hash",
    "organization",
    "run",
    "source",
    "thread",
    "user",
  ] as const)(
    "computer use rejects request %s after its unlocked locator",
    { timeout: CASE_TIMEOUT_MS },
    async (mutation) => {
      const fixture = await createAuthorizationReadFixture({
        kind: "computer-use",
      });
      await withComputerUseAuthorizationReadBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          requestToken: fixture.requestToken,
          stopAt: "locator",
          work: async (barrier) => {
            await withOwnedOperations(barrier.release, async (scope) => {
              const reading = scope.start(readAuthorization(fixture, [404]));
              const located = await barrier.entered;
              expect(located.rowCount).toBe(1);
              await mutateComputerUseAuthorizationReadRequestFixture({
                requestToken: fixture.requestToken,
                mutation,
              });
              await scope.release();
              expect(valueOf(await reading).status).toBe(404);
            });
          },
        },
        context.signal,
      );
    },
  );

  it(
    "returns the complete empty canonical host projection",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationReadFixture({
        kind: "computer-use",
        withHost: false,
      });
      const response = await readAuthorization(fixture, [200]);
      expectFoundProjection(response, fixture, false);
      if (response.status === 200 && "hosts" in response.body) {
        expect(response.body.hosts).toStrictEqual([]);
        expect(response.body.computerUseHostId).toBeNull();
      }
    },
  );

  it(
    "returns every eligible online host with standalone fields and order beyond three subjects",
    { timeout: 60_000 },
    async () => {
      const fixture = await createAuthorizationReadFixture({
        kind: "computer-use",
        withHost: false,
      });
      const eligible: {
        readonly hostId: string;
        readonly hostToken: string;
      }[] = [];
      for (let index = 0; index < 5; index++) {
        mockNow(STARTED_AT_MS + index * 1000);
        eligible.push(
          await computerUse.startComputerUseHost(fixture.actor, {
            hostName: `Complete host ${index}`,
            supportedCapabilities: ["apps.list", `capability.${index}`],
            permissions: {
              accessibility: index % 2 === 0,
              screenRecording: index % 2 === 1,
            },
          }),
        );
      }
      mockNow(STARTED_AT_MS + 5000);
      const offline = await computerUse.startComputerUseHost(fixture.actor, {
        installationId: randomUUID(),
        hostName: "Offline retained host",
      });
      await computerUse.stopComputerUseHost(offline.hostToken);
      const revoked = await computerUse.startComputerUseHost(fixture.actor, {
        hostName: "Revoked host",
      });
      await computerUse.stopComputerUseHost(revoked.hostToken);
      const sameOrgForeignUser = orgScoped(
        bdd.user({ orgId: fixture.actor.orgId }),
      );
      await computerUse.startComputerUseHost(sameOrgForeignUser, {
        hostName: "Foreign user host",
      });
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      await computerUse.startComputerUseHost(foreignOrg, {
        hostName: "Foreign organization host",
      });

      mockNow(STARTED_AT_MS + 6000);
      const standalone = await computerUse.listComputerUseHosts(fixture.actor);
      const expected = standalone.hosts.filter((host) => {
        return host.status === "online";
      });
      expect(expected).toHaveLength(5);
      expect(
        expected.map((host) => {
          return host.id;
        }),
      ).toStrictEqual(
        [...eligible].reverse().map((host) => {
          return host.hostId;
        }),
      );
      expect(expected[0]).toStrictEqual({
        id: eligible.at(-1)?.hostId,
        hostName: "Complete host 4",
        displayName: "Complete host 4",
        appVersion: "0.1.0",
        osVersion: "macOS 15",
        supportedCapabilities: ["apps.list", "capability.4"],
        permissions: {
          accessibility: true,
          screenRecording: false,
          automation: {
            chrome: {
              status: "unknown",
              updatedAt: null,
              reason: null,
            },
            safari: {
              status: "unknown",
              updatedAt: null,
              reason: null,
            },
          },
        },
        status: "online",
        lastSeenAt: new Date(STARTED_AT_MS + 4000).toISOString(),
        createdAt: new Date(STARTED_AT_MS + 4000).toISOString(),
      });
      clearPublications();
      const response = await readAuthorization(fixture, [200]);
      expect(response.status).toBe(200);
      if (response.status === 200 && "hosts" in response.body) {
        expect(response.body.hosts).toStrictEqual(expected);
        expect(response.body.computerUseHostId).toBeNull();
        expect(Buffer.byteLength(JSON.stringify(response.body), "utf8")).toBe(
          2605,
        );
      }
      expectNoPublications();
    },
  );
});
