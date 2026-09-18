import { createHash, randomUUID } from "node:crypto";

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
  countComputerUseAuthorizationRequestsFixture,
  holdComputerUseAuthorizationCreationRunFixture,
  holdComputerUseAuthorizationRequestInsertFixture,
  readComputerUseAuthorizationRequestFixture,
  setComputerUseAuthorizationRunOrganizationFixture,
  setComputerUseAuthorizationRunThreadFixture,
  setComputerUseAuthorizationRunTriggerFixture,
  setComputerUseAuthorizationRunUserFixture,
  withComputerUseAuthorizationCreateBarrierFixture,
} from "../../../test-fixtures/computer-use-authorization";
import {
  readChatThreadTitleStateFixture,
  setChatThreadAgentFixture,
  setChatThreadUserFixture,
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
import { computerUseAuthorizationRoutes } from "../computer-use-authorization";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T04:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

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
  const agent = await bdd.createAgent(owner, {
    displayName: `Computer Use authorization ${randomUUID().slice(0, 8)}`,
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
  readonly source: "chat" | "slack" | "teams";
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

async function sidebarHostEvents(
  fixture: AuthorizationRunFixture,
): Promise<readonly { readonly seqId: number }[]> {
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
      return { seqId: event.seqId };
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

interface CreationState {
  readonly requestCount: number;
  readonly selection: Awaited<ReturnType<typeof readSelection>>;
  readonly events: readonly { readonly seqId: number }[];
  readonly lastSeqId: number;
  readonly threadState: Awaited<
    ReturnType<typeof readChatThreadTitleStateFixture>
  >;
}

async function readCreationState(
  fixture: AuthorizationRunFixture,
): Promise<CreationState> {
  return {
    requestCount: await countComputerUseAuthorizationRequestsFixture(
      fixture.runId,
    ),
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
  await expect(
    computerUse.listComputerUseHosts(fixture.actor),
  ).resolves.toStrictEqual({
    hosts: [],
  });
  clearPublications();
  const created = await requestAuthorizationCreation(fixture, [200], {
    tokenType: options?.tokenType,
  });
  const createdBody = createdAuthorizationBody(created);
  const requestToken = requestTokenFromUrl(createdBody.authorizationUrl);
  const createdAtMs = options?.createdAtMs ?? STARTED_AT_MS;
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + HOUR_MS).toISOString();

  expect(createdBody).toMatchObject({ source: "chat", expiresAt });
  expect(createdBody.authorizationUrl).toBe(
    `https://app.okou.ai/computer-use/authorize/${encodeURIComponent(requestToken)}`,
  );
  expect(requestToken).toMatch(
    /^vm0_computer_use_authorization_request_[\w-]+$/u,
  );

  const row = await readComputerUseAuthorizationRequestFixture(requestToken);
  expect(row).toMatchObject({
    requestTokenHash: createHash("sha256").update(requestToken).digest("hex"),
    orgId: fixture.orgId,
    userId: fixture.actor.userId,
    runId: fixture.runId,
    source: "chat",
    chatThreadId: fixture.threadId,
    slackConnectionId: null,
    slackChannelId: null,
    slackThreadTs: null,
    teamsConnectionId: null,
    teamsConversationId: null,
    teamsThreadId: null,
    expiresAt,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  expect(JSON.stringify(row)).not.toContain(requestToken);
  await expect(
    countComputerUseAuthorizationRequestsFixture(fixture.runId),
  ).resolves.toBe(before.requestCount + 1);

  const readable = await computerUse.readComputerUseAuthorizationRequest(
    fixture.actor,
    requestToken,
  );
  expect(readable).toStrictEqual({
    source: "chat",
    expiresAt,
    completedAt: null,
    computerUseHostId: null,
    hosts: [],
  });
  await expect(
    computerUse.listComputerUseHosts(fixture.actor),
  ).resolves.toStrictEqual({
    hosts: [],
  });
  const after = await readCreationState(fixture);
  expect(after).toStrictEqual({
    ...before,
    requestCount: before.requestCount + 1,
  });
  expectNoInvalidation(fixture);
  return { ...fixture, requestToken };
}

async function expectNextSidebarSequenceAfterCreation(
  fixture: AuthorizationRunFixture,
  previousSeqId: number,
): Promise<void> {
  await expect(lastSidebarSeqId(fixture)).resolves.toBe(previousSeqId);
  clearPublications();
  const title = `Next write ${randomUUID().slice(0, 8)}`;
  await chat.renameThread(fixture.actor, fixture.threadId, title);
  await expect(lastSidebarSeqId(fixture)).resolves.toBe(previousSeqId + 1);
  await expect(
    readChatThreadTitleStateFixture(fixture.threadId),
  ).resolves.toMatchObject({
    title,
  });
  await flushWaitUntilForTest();
  expectOneInvalidation(fixture);
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
  await withComputerUseAuthorizationCreateBarrierFixture(
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

describe("account erasure fences Computer Use authorization request creation", () => {
  it(
    "creates one open request from sandbox and capability-free Agent credentials without activating the browser",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const sandbox = await createAuthorizationRunFixture();
      const sandboxRequest = await createAndInspectOpenRequest(sandbox, {
        tokenType: "sandbox",
      });
      expect(sandboxRequest.requestToken).toMatch(
        /^vm0_computer_use_authorization_request_/u,
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
    "keeps canonical Slack and Teams creation classified as chat with null legacy locators",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const slack = await createAuthorizationRunFixture();
      await setComputerUseAuthorizationRunTriggerFixture(slack.runId, "slack");
      const slackRequest = await createAndInspectOpenRequest(slack);

      const teams = await createAuthorizationRunFixture();
      await setComputerUseAuthorizationRunTriggerFixture(teams.runId, "teams");
      const teamsRequest = await createAndInspectOpenRequest(teams);
      expect(teamsRequest.requestToken).not.toBe(slackRequest.requestToken);
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
        /^vm0_computer_use_authorization_request_/u,
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
        /^vm0_computer_use_authorization_request_/u,
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

      const outcome = await withComputerUseAuthorizationCreateBarrierFixture(
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
              countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
        readComputerUseAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        runId: fixture.runId,
        chatThreadId: fixture.threadId,
        userId: fixture.actor.userId,
        orgId: fixture.orgId,
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
      expectNoInvalidation(fixture);

      // Closure committed immediately behind the writer. A repeat creation is
      // denied and cannot leave a second row or a URL.
      const denied = await requestAuthorizationCreation(fixture, [404]);
      expect(denied.status).toBe(404);
      await expect(
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
            countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "denies run user and organization changes after the locator",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const user = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(user, async () => {
        await setComputerUseAuthorizationRunUserFixture(
          user.runId,
          `user_${randomUUID()}`,
        );
      });

      const organization = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(organization, async () => {
        await setComputerUseAuthorizationRunOrganizationFixture(
          organization.runId,
          `org_${randomUUID()}`,
        );
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(user.runId),
      ).resolves.toBe(0);
      await expect(
        countComputerUseAuthorizationRequestsFixture(organization.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "denies two exact trigger changes after their locators",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const changed = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(changed, async () => {
        await setComputerUseAuthorizationRunTriggerFixture(
          changed.runId,
          "goal",
        );
      });

      const changedAgain = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(changedAgain, async () => {
        await setComputerUseAuthorizationRunTriggerFixture(
          changedAgain.runId,
          "schedule",
        );
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(changed.runId),
      ).resolves.toBe(0);
      await expect(
        countComputerUseAuthorizationRequestsFixture(changedAgain.runId),
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
        await setComputerUseAuthorizationRunThreadFixture(
          fixture.runId,
          other.threadId,
        );
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(other.runId),
      ).resolves.toBe(0);

      const detached = await createAuthorizationRunFixture();
      await expectLocatorMutationDenied(detached, async () => {
        await setComputerUseAuthorizationRunThreadFixture(detached.runId, null);
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(detached.runId),
      ).resolves.toBe(0);
    },
  );

  it(
    "finds a thread deleted after the locator and returns 404 rather than the initial null-thread 409",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fixture = await createAuthorizationRunFixture();
      clearPublications();
      await withComputerUseAuthorizationCreateBarrierFixture(
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
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
        countComputerUseAuthorizationRequestsFixture(unsupported.runId),
      ).resolves.toBe(0);
      expectNoInvalidation(unsupported);

      const fixture = await createAuthorizationRunFixture();
      const foreign = await createAuthorizationRunFixture();
      const fixtureBefore = await readCreationState(fixture);
      const foreignBefore = await readCreationState(foreign);
      await setComputerUseAuthorizationRunThreadFixture(
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
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
      await withComputerUseAuthorizationCreateBarrierFixture(
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
      await withComputerUseAuthorizationCreateBarrierFixture(
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
        displayName: `Rebound Computer Use authorization ${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      await closeSubject({
        subjectKind: "user",
        subjectId: newOwner.userId,
      });
      const before = await readCreationState(fixture);
      clearPublications();

      await withComputerUseAuthorizationCreateBarrierFixture(
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
      const created = await withComputerUseAuthorizationCreateBarrierFixture(
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
        readComputerUseAuthorizationRequestFixture(requestToken),
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

      const created = await withComputerUseAuthorizationCreateBarrierFixture(
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
            const mutating = setComputerUseAuthorizationRunTriggerFixture(
              fixture.runId,
              "goal",
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            await setComputerUseAuthorizationRunTriggerFixture(
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

      const created = await withComputerUseAuthorizationCreateBarrierFixture(
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
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(before.requestCount + 1);
      const missing = await requestAuthorizationCreation(fixture, [404]);
      expect(missing.status).toBe(404);
      await expect(
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
      const holder = await holdComputerUseAuthorizationCreationRunFixture(
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
        readComputerUseAuthorizationRequestFixture(requestToken),
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

      const created = await withComputerUseAuthorizationCreateBarrierFixture(
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
        readComputerUseAuthorizationRequestFixture(requestToken),
      ).resolves.toMatchObject({
        runId: fixture.runId,
        chatThreadId: fixture.threadId,
      });
      await expect(
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
      ).resolves.toBe(1);
      expectOneInvalidation(fixture);
      clearPublications();
      const unsupported = await requestAuthorizationCreation(fixture, [409]);
      expect(unsupported.status).toBe(409);
      await expect(
        countComputerUseAuthorizationRequestsFixture(fixture.runId),
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

      await withComputerUseAuthorizationCreateBarrierFixture(
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
              countComputerUseAuthorizationRequestsFixture(fixture.runId),
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

      await withComputerUseAuthorizationCreateBarrierFixture(
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
              countComputerUseAuthorizationRequestsFixture(fixture.runId),
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
      const holder = await holdComputerUseAuthorizationRequestInsertFixture(
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
