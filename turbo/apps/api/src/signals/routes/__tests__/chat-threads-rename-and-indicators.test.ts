import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadMetadataContract,
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadMarkReadRoutes } from "../chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "../chat-threads-mark-unread";
import { chatThreadRenameRoutes } from "../chat-threads-rename";
import { logsRoutes } from "../logs";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const context = testContext();
const bdd = createBddApi(context);
const fixture = createChatEventsFixture(context);
const routeMocks = createRouteMocks(context);

const chatEventsClient = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const chatThreadsClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadsContract);
const chatThreadByIdClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadByIdContract);
const chatThreadEventsClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const chatThreadMetadataClient = setupApp({
  context,
  routes: chatThreadGetRoutes,
})(chatThreadMetadataContract);
const chatThreadRenameClient = setupApp({
  context,
  routes: chatThreadRenameRoutes,
})(chatThreadRenameContract);
const chatThreadMarkReadClient = setupApp({
  context,
  routes: chatThreadMarkReadRoutes,
})(chatThreadMarkReadContract);
const chatThreadMarkUnreadClient = setupApp({
  context,
  routes: chatThreadMarkUnreadRoutes,
})(chatThreadMarkUnreadContract);
const billingStatusClient = setupApp({
  context,
  routes: billingStatusRoutes,
})(billingStatusContract);
const logsListClient = setupApp({
  context,
  routes: logsRoutes,
})(logsListContract);
const onboardingCompleteClient = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const runnersHeartbeatClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runsByIdClient = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelClient = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const webhookCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmupThreadId = randomUUID();
  const warmupRunId = randomUUID();
  await Promise.all([
    accept(
      chatEventsClient.send({
        headers: {},
        body: {
          prompt: "warmup",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "warmup" }],
          },
        },
      }),
      [401],
    ),
    accept(
      chatThreadsClient.create({
        headers: {},
        body: { title: "warmup", model: null },
      }),
      [401],
    ),
    accept(chatThreadsClient.indicators({ headers: {}, query: {} }), [401]),
    accept(
      chatThreadByIdClient.get({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadEventsClient.rows({
        headers: {},
        params: { threadId: warmupThreadId },
        query: { sinceSeqId: 0 },
      }),
      [401],
    ),
    accept(
      chatThreadMetadataClient.get({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadRenameClient.rename({
        headers: {},
        params: { id: warmupThreadId },
        body: { title: "warmup" },
      }),
      [401],
    ),
    accept(
      chatThreadMarkReadClient.markRead({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadMarkUnreadClient.markUnread({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(billingStatusClient.get({ headers: {} }), [401]),
    accept(logsListClient.list({ headers: {}, query: { limit: 1 } }), [401]),
    accept(onboardingCompleteClient.complete({ headers: {}, body: {} }), [401]),
    accept(
      runnersHeartbeatClient.heartbeat({
        headers: {},
        body: {
          runnerId: warmupRunId,
          group: "vm0/test",
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 8,
          totalMemoryMb: 16_384,
          maxConcurrent: 2,
          allocatedVcpu: 0,
          allocatedMemoryMb: 0,
          runningCount: 0,
          admittableProfiles: ["vm0/default"],
          heldSandboxStates: [],
          heldHomeStates: [],
          activeReuseProducers: [],
          mode: "running",
        },
      }),
      [401],
    ),
    accept(
      runsByIdClient.getById({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      runsCancelClient.cancel({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      webhookCompleteClient.complete({
        headers: {},
        body: { runId: warmupRunId, exitCode: 0 },
      }),
      [401],
    ),
  ]);
});

function configureClerkDirectory(actors: readonly ApiTestUser[]): void {
  const uniqueUsers = new Map<string, ApiTestUser>();
  for (const actor of actors) {
    if (!uniqueUsers.has(actor.userId)) {
      uniqueUsers.set(actor.userId, actor);
    }
  }
  mockClerkUsers(
    context,
    [...uniqueUsers.values()].map((actor) => {
      const emailId = `email_${actor.userId}`;
      return {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "User",
      };
    }),
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (params: unknown) => {
      const requestedUserId =
        typeof params === "object" &&
        params !== null &&
        "userId" in params &&
        typeof params.userId === "string"
          ? params.userId
          : null;
      const matchingActors = actors.filter((actor) => {
        return (
          actor.orgId !== null &&
          (requestedUserId === null || actor.userId === requestedUserId)
        );
      });
      return Promise.resolve({
        data: matchingActors.map((actor) => {
          return {
            role: actor.orgRole ?? "org:admin",
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
          };
        }),
      });
    },
  );
}

function actorSessionHeaders(actor: ApiTestUser): {
  readonly authorization: string;
} {
  return {
    authorization: `Bearer clerk-session:${actor.userId}:${actor.orgId ?? "none"}`,
  };
}

function installMultiActorSessionAuth(actors: readonly ApiTestUser[]): void {
  const byHeader = new Map<string, ApiTestUser>();
  for (const actor of actors) {
    byHeader.set(actorSessionHeaders(actor).authorization, actor);
  }
  configureClerkDirectory(actors);
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const authHeader =
        request instanceof Request
          ? request.headers.get("authorization")
          : null;
      const actor = authHeader === null ? undefined : byHeader.get(authHeader);
      if (!actor) {
        return Promise.resolve({ isAuthenticated: false });
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return {
            userId: actor.userId,
            orgId: actor.orgId,
            orgRole: actor.orgRole ?? "org:admin",
          };
        },
      });
    },
  );
}

function sessionHeaders(
  actor: ApiTestUser,
  directory: readonly ApiTestUser[] = [actor],
) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  configureClerkDirectory(directory);
  return SESSION_HEADERS;
}

function bearerAuthHeaders(
  token: string,
  directory: readonly ApiTestUser[],
): { readonly authorization: string } {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  configureClerkDirectory(directory);
  return { authorization: `Bearer ${token}` };
}

function configureSharedRunMocks(): void {
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  fixture.chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
}

interface SecondaryRunRecord {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  completed: boolean;
}

async function cleanupSecondaryRuns(
  directory: readonly ApiTestUser[],
  records: readonly SecondaryRunRecord[],
): Promise<void> {
  const incomplete = records.filter((entry) => {
    return !entry.completed;
  });
  if (incomplete.length === 0) {
    return;
  }
  installMultiActorSessionAuth(directory);
  await Promise.all(
    incomplete.map(async (entry) => {
      const cancelled = await accept(
        runsCancelClient.cancel({
          headers: actorSessionHeaders(entry.actor),
          params: { id: entry.runId },
        }),
        [200, 400],
      );
      if (cancelled.status === 200) {
        await accept(
          webhookCompleteClient.complete({
            headers: { authorization: `Bearer ${entry.sandboxToken}` },
            body: {
              runId: entry.runId,
              exitCode: 1,
              error: "Run cancelled",
            },
          }),
          [200],
        );
      }
    }),
  );
  await flushWaitUntilForTest();
}

async function prepareLimitedFreeActor(
  options: {
    readonly userOptions?: ApiTestUserOptions;
    readonly maxConcurrent?: number;
    readonly afterRuns?: () => Promise<void>;
  } = {},
) {
  const actor = bdd.user(options.userOptions);
  const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
  configureSharedRunMocks();
  const captured = captureConnectorExternalState(context, [
    "OPENROUTER_API_KEY",
  ]);
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      captured();
      mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
    },
    afterRuns: options.afterRuns,
  });
  await owner.run(async () => {
    await Promise.all([
      bdd.bootstrapLimitedFreeOnboarding(actor),
      fixture.api.configureRunnerGroup({
        maxConcurrent: options.maxConcurrent ?? 4,
      }),
    ]);
  });
  return { actor, owner };
}

async function enqueueAutoPromptWithHeaders(
  headers: Readonly<{ authorization: string }>,
  prompt: string,
): Promise<{ readonly threadId: string; readonly clientEventId: string }> {
  const clientEventId = randomUUID();
  const sent = await accept(
    chatEventsClient.send({
      headers,
      body: {
        prompt,
        hasTextContent: true,
        model: null,
        clientEventId,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: prompt }],
        },
      },
    }),
    [201],
  );
  return { threadId: sent.body.threadId, clientEventId };
}

async function readThreadEventsWithHeaders(
  headers: Readonly<{ authorization: string }>,
  threadId: string,
): Promise<readonly ChatEvent[]> {
  const response = await accept(
    chatThreadEventsClient.rows({
      headers,
      params: { threadId },
      query: { sinceSeqId: 0 },
    }),
    [200],
  );
  return projectChatEventRows(response.body.rows);
}

function launchedRunId(
  events: readonly ChatEvent[],
  clientEventId: string,
): string {
  const launched = events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.revokesEventId === clientEventId &&
      event.runId !== undefined
    );
  });
  if (!launched?.runId) {
    throw new Error(`Expected launched run for clientEventId ${clientEventId}`);
  }
  return launched.runId;
}

function terminalEventCreatedAt(
  events: readonly ChatEvent[],
  eventType: "run.cancelled" | "run.completed",
): string {
  const terminal = events.find((event) => {
    return event.eventType === eventType;
  });
  if (!terminal) {
    throw new Error(`Expected ${eventType} event in thread history`);
  }
  return terminal.createdAt;
}

async function completePiRunOk(
  runId: string,
  threadId: string,
  sandboxToken: string,
): Promise<void> {
  await accept(
    webhookCompleteClient.complete({
      headers: { authorization: `Bearer ${sandboxToken}` },
      body: {
        runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
    }),
    [200],
  );
}

describe("chat-thread-indicators", () => {
  it(
    "chat-thread-indicators-003 reports read-cursor changes through indicators while mark responses carry no unread snapshot",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        maxConcurrent: 4,
      });
      const headers = sessionHeaders(actor);

      const [firstSent, secondSent] = await Promise.all([
        enqueueAutoPromptWithHeaders(headers, "First unread thread"),
        enqueueAutoPromptWithHeaders(headers, "Second unread thread"),
      ]);
      await flushWaitUntilForTest();

      const [firstEventsBefore, secondEventsBefore] = await Promise.all([
        readThreadEventsWithHeaders(headers, firstSent.threadId),
        readThreadEventsWithHeaders(headers, secondSent.threadId),
      ]);
      const firstRunId = launchedRunId(
        firstEventsBefore,
        firstSent.clientEventId,
      );
      const secondRunId = launchedRunId(
        secondEventsBefore,
        secondSent.clientEventId,
      );

      const [firstExecution, secondExecution] = await Promise.all([
        owner.executionInput(firstRunId),
        owner.executionInput(secondRunId),
      ]);

      await Promise.all([
        completePiRunOk(
          firstRunId,
          firstSent.threadId,
          firstExecution.sandboxToken,
        ),
        completePiRunOk(
          secondRunId,
          secondSent.threadId,
          secondExecution.sandboxToken,
        ),
      ]);
      await flushWaitUntilForTest();

      const [firstEventsAfter, secondEventsAfter] = await Promise.all([
        readThreadEventsWithHeaders(headers, firstSent.threadId),
        readThreadEventsWithHeaders(headers, secondSent.threadId),
      ]);
      const firstUnreadAt = terminalEventCreatedAt(
        firstEventsAfter,
        "run.completed",
      );
      const secondUnreadAt = terminalEventCreatedAt(
        secondEventsAfter,
        "run.completed",
      );

      const markRead = await accept(
        chatThreadMarkReadClient.markRead({
          headers,
          params: { id: firstSent.threadId },
        }),
        [200],
      );
      expect(markRead.status).toBe(200);
      expect(Object.keys(markRead.body)).toStrictEqual(["lastReadAt"]);
      expect(markRead.body.lastReadAt).toBe(firstUnreadAt);

      const indicatorsAfterRead = await accept(
        chatThreadsClient.indicators({
          headers,
          query: {},
        }),
        [200],
      );
      expect(indicatorsAfterRead.status).toBe(200);
      expect(indicatorsAfterRead.body).toStrictEqual({
        threads: {
          [secondSent.threadId]: "unread",
        },
        unreadAt: {
          [secondSent.threadId]: secondUnreadAt,
        },
      });

      const markUnread = await accept(
        chatThreadMarkUnreadClient.markUnread({
          headers,
          params: { id: firstSent.threadId },
        }),
        [200],
      );
      expect(markUnread.status).toBe(200);
      expect(Object.keys(markUnread.body)).toStrictEqual(["lastReadAt"]);
      expect(markUnread.body).toStrictEqual({ lastReadAt: null });

      const indicatorsAfterUnread = await accept(
        chatThreadsClient.indicators({
          headers,
          query: {},
        }),
        [200],
      );
      expect(indicatorsAfterUnread.status).toBe(200);
      expect(indicatorsAfterUnread.body).toStrictEqual({
        threads: {
          [firstSent.threadId]: "unread",
          [secondSent.threadId]: "unread",
        },
        unreadAt: {
          [firstSent.threadId]: firstUnreadAt,
          [secondSent.threadId]: secondUnreadAt,
        },
      });
    },
  );

  it(
    "chat-thread-indicators-002 (1/2) excludes a peer's unread thread in the same workspace",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const orgId = `org_${randomUUID()}`;
      const owner = bdd.user({
        orgId,
        orgRole: "org:admin",
      });
      const peer = bdd.user({
        orgId,
        orgRole: "org:member",
      });
      const directory = [owner, peer] as const;
      const secondaryRuns: SecondaryRunRecord[] = [];

      const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
      configureSharedRunMocks();
      const captured = captureConnectorExternalState(context, [
        "OPENROUTER_API_KEY",
      ]);
      const ownerLifecycle = publicRunOwner(context, owner, {
        restoreEnvironment: () => {
          captured();
          mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
        },
        afterRuns: () => {
          return cleanupSecondaryRuns(directory, secondaryRuns);
        },
      });

      await ownerLifecycle.run(async () => {
        await Promise.all([
          fixture.api.configureRunnerGroup({ maxConcurrent: 4 }),
          fixture.api.grantProEntitlement(owner),
        ]);
        installMultiActorSessionAuth(directory);
        await accept(
          onboardingCompleteClient.complete({
            headers: actorSessionHeaders(peer),
            body: {},
          }),
          [200],
        );

        const [ownerSent, peerSent] = await Promise.all([
          enqueueAutoPromptWithHeaders(
            actorSessionHeaders(owner),
            "Owner unread thread",
          ),
          enqueueAutoPromptWithHeaders(
            actorSessionHeaders(peer),
            "Peer unread thread",
          ),
        ]);
        await flushWaitUntilForTest();

        const [ownerEventsBefore, peerEventsBefore] = await Promise.all([
          readThreadEventsWithHeaders(
            actorSessionHeaders(owner),
            ownerSent.threadId,
          ),
          readThreadEventsWithHeaders(
            actorSessionHeaders(peer),
            peerSent.threadId,
          ),
        ]);

        const ownerRunId = launchedRunId(
          ownerEventsBefore,
          ownerSent.clientEventId,
        );
        const peerRunId = launchedRunId(
          peerEventsBefore,
          peerSent.clientEventId,
        );

        const [ownerExecution, peerExecution] = await Promise.all([
          ownerLifecycle.executionInput(ownerRunId),
          fixture.api.executionInput(peerRunId),
        ]);
        const peerEntry: SecondaryRunRecord = {
          actor: peer,
          runId: peerRunId,
          sandboxToken: peerExecution.sandboxToken,
          completed: false,
        };
        secondaryRuns.push(peerEntry);
        const ownerRunToken = okouTokenFromExecution(ownerExecution);

        await Promise.all([
          completePiRunOk(
            ownerRunId,
            ownerSent.threadId,
            ownerExecution.sandboxToken,
          ),
          completePiRunOk(
            peerRunId,
            peerSent.threadId,
            peerExecution.sandboxToken,
          ).then(() => {
            peerEntry.completed = true;
          }),
        ]);
        await flushWaitUntilForTest();

        const [ownerEventsAfter, peerIndicators, scopedIndicators] =
          await Promise.all([
            readThreadEventsWithHeaders(
              actorSessionHeaders(owner),
              ownerSent.threadId,
            ),
            accept(
              chatThreadsClient.indicators({
                headers: actorSessionHeaders(peer),
                query: {},
              }),
              [200],
            ),
            accept(
              chatThreadsClient.indicators({
                headers: { authorization: `Bearer ${ownerRunToken}` },
                query: {},
              }),
              [200],
            ),
          ]);

        const ownerUnreadAt = terminalEventCreatedAt(
          ownerEventsAfter,
          "run.completed",
        );
        expect(peerIndicators.body.threads).toStrictEqual({
          [peerSent.threadId]: "unread",
        });
        expect(scopedIndicators.status).toBe(200);
        expect(scopedIndicators.body).toStrictEqual({
          threads: {
            [ownerSent.threadId]: "unread",
          },
          unreadAt: {
            [ownerSent.threadId]: ownerUnreadAt,
          },
        });
      });
    },
  );

  it(
    "chat-thread-indicators-002 (2/2) excludes the same user's unread thread in another workspace",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const sharedUserId = `user_${randomUUID()}`;
      const ownerOrgId = `org_${randomUUID()}`;
      const otherOrgId = `org_${randomUUID()}`;
      const secondaryRuns: SecondaryRunRecord[] = [];

      const sameUserOtherOrg = bdd.user({
        userId: sharedUserId,
        orgId: otherOrgId,
        orgRole: "org:admin",
      });
      let directory: readonly ApiTestUser[] = [sameUserOtherOrg];

      const { actor: owner, owner: ownerLifecycle } =
        await prepareLimitedFreeActor({
          userOptions: {
            userId: sharedUserId,
            orgId: ownerOrgId,
            orgRole: "org:admin",
          },
          maxConcurrent: 4,
          afterRuns: () => {
            return cleanupSecondaryRuns(directory, secondaryRuns);
          },
        });
      directory = [owner, sameUserOtherOrg];

      await ownerLifecycle.run(async () => {
        await bdd.bootstrapLimitedFreeOnboarding(sameUserOtherOrg);
        installMultiActorSessionAuth(directory);

        const [ownerSent, otherOrgSent] = await Promise.all([
          enqueueAutoPromptWithHeaders(
            actorSessionHeaders(owner),
            "Owner workspace unread thread",
          ),
          enqueueAutoPromptWithHeaders(
            actorSessionHeaders(sameUserOtherOrg),
            "Other workspace unread thread",
          ),
        ]);
        await flushWaitUntilForTest();

        const [ownerEventsBefore, otherOrgEventsBefore] = await Promise.all([
          readThreadEventsWithHeaders(
            actorSessionHeaders(owner),
            ownerSent.threadId,
          ),
          readThreadEventsWithHeaders(
            actorSessionHeaders(sameUserOtherOrg),
            otherOrgSent.threadId,
          ),
        ]);

        const ownerRunId = launchedRunId(
          ownerEventsBefore,
          ownerSent.clientEventId,
        );
        const otherOrgRunId = launchedRunId(
          otherOrgEventsBefore,
          otherOrgSent.clientEventId,
        );

        const [ownerExecution, otherOrgExecution] = await Promise.all([
          ownerLifecycle.executionInput(ownerRunId),
          fixture.api.executionInput(otherOrgRunId),
        ]);
        const otherOrgEntry: SecondaryRunRecord = {
          actor: sameUserOtherOrg,
          runId: otherOrgRunId,
          sandboxToken: otherOrgExecution.sandboxToken,
          completed: false,
        };
        secondaryRuns.push(otherOrgEntry);
        const ownerRunToken = okouTokenFromExecution(ownerExecution);

        await Promise.all([
          completePiRunOk(
            ownerRunId,
            ownerSent.threadId,
            ownerExecution.sandboxToken,
          ),
          completePiRunOk(
            otherOrgRunId,
            otherOrgSent.threadId,
            otherOrgExecution.sandboxToken,
          ).then(() => {
            otherOrgEntry.completed = true;
          }),
        ]);
        await flushWaitUntilForTest();

        const [ownerEventsAfter, otherOrgIndicators, scopedIndicators] =
          await Promise.all([
            readThreadEventsWithHeaders(
              actorSessionHeaders(owner),
              ownerSent.threadId,
            ),
            accept(
              chatThreadsClient.indicators({
                headers: actorSessionHeaders(sameUserOtherOrg),
                query: {},
              }),
              [200],
            ),
            accept(
              chatThreadsClient.indicators({
                headers: { authorization: `Bearer ${ownerRunToken}` },
                query: {},
              }),
              [200],
            ),
          ]);

        const ownerUnreadAt = terminalEventCreatedAt(
          ownerEventsAfter,
          "run.completed",
        );
        expect(otherOrgIndicators.body.threads).toStrictEqual({
          [otherOrgSent.threadId]: "unread",
        });
        expect(scopedIndicators.status).toBe(200);
        expect(scopedIndicators.body).toStrictEqual({
          threads: {
            [ownerSent.threadId]: "unread",
          },
          unreadAt: {
            [ownerSent.threadId]: ownerUnreadAt,
          },
        });
      });
    },
  );

  it(
    "chat-thread-indicators-001 reports unread timestamps for an Okou token without changing read state",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        maxConcurrent: 4,
      });
      const headers = sessionHeaders(actor);

      const [unreadSent, readSent] = await Promise.all([
        enqueueAutoPromptWithHeaders(headers, "Cancelled unread thread"),
        enqueueAutoPromptWithHeaders(headers, "Cancelled read thread"),
      ]);
      await flushWaitUntilForTest();

      const [unreadEventsBefore, readEventsBefore] = await Promise.all([
        readThreadEventsWithHeaders(headers, unreadSent.threadId),
        readThreadEventsWithHeaders(headers, readSent.threadId),
      ]);
      const unreadRunId = launchedRunId(
        unreadEventsBefore,
        unreadSent.clientEventId,
      );
      const readRunId = launchedRunId(readEventsBefore, readSent.clientEventId);

      const [unreadExecution] = await Promise.all([
        owner.executionInput(unreadRunId),
        owner.executionInput(readRunId),
      ]);
      const okouRunToken = okouTokenFromExecution(unreadExecution);

      await Promise.all([
        accept(
          runsCancelClient.cancel({
            headers,
            params: { id: unreadRunId },
          }),
          [200],
        ),
        accept(
          runsCancelClient.cancel({
            headers,
            params: { id: readRunId },
          }),
          [200],
        ),
      ]);
      await flushWaitUntilForTest();

      const markedRead = await accept(
        chatThreadMarkReadClient.markRead({
          headers,
          params: { id: readSent.threadId },
        }),
        [200],
      );
      expect(markedRead.body.lastReadAt).not.toBeNull();

      const [unreadEventsAfter, unreadDetailBefore, readDetailBefore] =
        await Promise.all([
          readThreadEventsWithHeaders(headers, unreadSent.threadId),
          accept(
            chatThreadByIdClient.get({
              headers,
              params: { id: unreadSent.threadId },
            }),
            [200],
          ),
          accept(
            chatThreadByIdClient.get({
              headers,
              params: { id: readSent.threadId },
            }),
            [200],
          ),
        ]);
      const unreadCancelledAt = terminalEventCreatedAt(
        unreadEventsAfter,
        "run.cancelled",
      );
      expect(unreadDetailBefore.body.lastReadAt).toBeNull();
      expect(readDetailBefore.body.lastReadAt).toBe(markedRead.body.lastReadAt);

      const indicators = await accept(
        chatThreadsClient.indicators({
          headers: bearerAuthHeaders(okouRunToken, [actor]),
          query: {},
        }),
        [200],
      );
      expect(indicators.status).toBe(200);
      expect(indicators.body).toStrictEqual({
        threads: {
          [unreadSent.threadId]: "unread",
        },
        unreadAt: {
          [unreadSent.threadId]: unreadCancelledAt,
        },
      });

      const refreshedHeaders = sessionHeaders(actor);
      const [unreadDetailAfter, readDetailAfter] = await Promise.all([
        accept(
          chatThreadByIdClient.get({
            headers: refreshedHeaders,
            params: { id: unreadSent.threadId },
          }),
          [200],
        ),
        accept(
          chatThreadByIdClient.get({
            headers: refreshedHeaders,
            params: { id: readSent.threadId },
          }),
          [200],
        ),
      ]);
      expect(unreadDetailAfter.body.lastReadAt).toBeNull();
      expect(readDetailAfter.body.lastReadAt).toBe(markedRead.body.lastReadAt);
    },
  );
});

describe("chat-threads-rename", () => {
  it(
    "chat-threads-rename-001 renames a thread with an Okou run token carrying chat-thread:write",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor();
      const headers = sessionHeaders(actor);

      const [targetThread, runSent] = await Promise.all([
        accept(
          chatThreadsClient.create({
            headers,
            body: { title: "Original title", model: null },
          }),
          [201],
        ),
        enqueueAutoPromptWithHeaders(headers, "Issue workspace run token"),
      ]);
      await flushWaitUntilForTest();

      const runEvents = await readThreadEventsWithHeaders(
        headers,
        runSent.threadId,
      );
      const runId = launchedRunId(runEvents, runSent.clientEventId);
      const execution = await owner.executionInput(runId);
      const okouRunToken = okouTokenFromExecution(execution);

      const renamed = await accept(
        chatThreadRenameClient.rename({
          headers: bearerAuthHeaders(okouRunToken, [actor]),
          params: { id: targetThread.body.id },
          body: { title: "CLI renamed title" },
        }),
        [204],
      );
      expect(renamed.status).toBe(204);

      const metadata = await accept(
        chatThreadMetadataClient.get({
          headers: bearerAuthHeaders(okouRunToken, [actor]),
          params: { id: targetThread.body.id },
        }),
        [200],
      );
      expect(metadata.status).toBe(200);
      expect(metadata.body).toStrictEqual({
        id: targetThread.body.id,
        title: "CLI renamed title",
        selectedModel: "auto",
        modelSettings: {},
        serviceTier: null,
        pinnedAt: null,
        archived: false,
        hidden: false,
        muted: false,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      });
    },
  );

  it(
    "chat-threads-rename-004 does not rename a same-user thread from another org",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const sharedUserId = `user_${randomUUID()}`;
      const owningOrgId = `org_${randomUUID()}`;
      const otherOrgId = `org_${randomUUID()}`;

      const { actor: otherOrgActor, owner: otherOrgLifecycle } =
        await prepareLimitedFreeActor({
          userOptions: {
            userId: sharedUserId,
            orgId: otherOrgId,
            orgRole: "org:admin",
          },
        });
      const owningActor = bdd.user({
        userId: sharedUserId,
        orgId: owningOrgId,
        orgRole: "org:admin",
      });
      const directory = [owningActor, otherOrgActor] as const;
      installMultiActorSessionAuth(directory);

      const [owningThread, otherOrgSent] = await Promise.all([
        accept(
          chatThreadsClient.create({
            headers: actorSessionHeaders(owningActor),
            body: { title: "Original title", model: null },
          }),
          [201],
        ),
        enqueueAutoPromptWithHeaders(
          actorSessionHeaders(otherOrgActor),
          "Issue other org run token",
        ),
      ]);
      await flushWaitUntilForTest();

      const otherOrgEvents = await readThreadEventsWithHeaders(
        actorSessionHeaders(otherOrgActor),
        otherOrgSent.threadId,
      );
      const otherOrgRunId = launchedRunId(
        otherOrgEvents,
        otherOrgSent.clientEventId,
      );
      const otherOrgExecution =
        await otherOrgLifecycle.executionInput(otherOrgRunId);
      const otherOrgRunToken = okouTokenFromExecution(otherOrgExecution);

      const crossOrgRename = await accept(
        chatThreadRenameClient.rename({
          headers: { authorization: `Bearer ${otherOrgRunToken}` },
          params: { id: owningThread.body.id },
          body: { title: "Cross-org renamed title" },
        }),
        [404],
      );
      expect(crossOrgRename.status).toBe(404);
      expect(crossOrgRename.body).toStrictEqual({
        error: {
          code: "NOT_FOUND",
          message: "Chat thread not found",
        },
      });

      const owningMetadata = await accept(
        chatThreadMetadataClient.get({
          headers: actorSessionHeaders(owningActor),
          params: { id: owningThread.body.id },
        }),
        [200],
      );
      expect(owningMetadata.status).toBe(200);
      expect(owningMetadata.body.id).toBe(owningThread.body.id);
      expect(owningMetadata.body.title).toBe("Original title");
    },
  );
});
