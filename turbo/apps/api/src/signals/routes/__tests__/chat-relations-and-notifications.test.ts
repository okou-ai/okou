import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatRelationsRoutes } from "../chat-relations";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { emailSubscriptionRoutes } from "../email-subscription";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { notificationsRoutes } from "../notifications";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const WARMUP_UUID = "00000000-0000-4000-8000-000000000000";

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  alreadyCancelled: boolean;
}

interface TrackedQueuedInput {
  readonly actor: ApiTestUser;
  readonly threadId: string;
  readonly eventId: string;
}

function clerkUserProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Member",
    imageUrl: null,
  };
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected actor to belong to an organization");
  }
  return actor.orgId;
}

function textUserMessage(prompt: string) {
  return {
    version: 1 as const,
    parts: [{ type: "text" as const, text: prompt }],
  };
}

describe("chat relations and mail notifications", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const fixture = createChatEventsFixture(context);
  const routeMocks = createRouteMocks(context);

  const chatRelationsClient = setupAppWithRoutes({
    context,
    routes: chatRelationsRoutes,
  })(chatRelationsContract);
  const chatThreadsCreateClient = setupAppWithRoutes({
    context,
    routes: chatThreadCreateRoutes,
  })(chatThreadsContract);
  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const notificationsClient = setupAppWithRoutes({
    context,
    routes: notificationsRoutes,
  })(notificationsContract);
  const emailSubscriptionClient = setupAppWithRoutes({
    context,
    routes: emailSubscriptionRoutes,
  })(emailSubscriptionContract);
  const clerkWebhookClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const agentCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const runsSteerClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersSteerContract);
  const runsHeartbeatClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const onboardingCompleteClient = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const billingStatusClient = setupAppWithRoutes({
    context,
    routes: billingStatusRoutes,
  })(billingStatusContract);
  const stripeWebhookClient = setupAppWithRoutes({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const personalModelProvidersClient = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);

  function sessionHeaders(actor: ApiTestUser): {
    readonly authorization: string;
  } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function bearerHeaders(token: string): { readonly authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  function configureClerkDirectory(
    actors: readonly ApiTestUser[],
    memberships: ReadonlyMap<string, readonly string[]>,
  ): void {
    const uniqueUsers = new Map<string, ApiTestUser>();
    for (const actor of actors) {
      if (!uniqueUsers.has(actor.userId)) {
        uniqueUsers.set(actor.userId, actor);
      }
    }
    mockClerkUsers(
      context,
      [...uniqueUsers.values()].map((actor) => {
        return clerkUserProfile(actor);
      }),
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      (args: unknown) => {
        const userId =
          typeof args === "object" &&
          args !== null &&
          "userId" in args &&
          typeof args.userId === "string"
            ? args.userId
            : "";
        const orgIds = memberships.get(userId) ?? [];
        return Promise.resolve({
          data: orgIds.map((orgId) => {
            return {
              role: "org:admin",
              organization: { id: orgId },
              publicUserData: { userId },
            };
          }),
        });
      },
    );
  }

  function configureMailDelivery(): void {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("RESEND_API_KEY", "test-resend-key");
    mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
    mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
    context.mocks.resend.send.mockReset();
    context.mocks.resend.send.mockResolvedValue({
      data: { id: `email-${randomUUID()}` },
      error: null,
    });
  }

  function createRunTracker() {
    const tracked: TrackedRun[] = [];
    const queuedInputs: TrackedQueuedInput[] = [];
    onTestFinished(async () => {
      if (tracked.length === 0 && queuedInputs.length === 0) {
        return;
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settleIncludingAbort(flushWaitUntilForTest);

      // Revoke unconsumed follow-up inputs first so cancelling/completing the
      // active Runs does not promote them into fresh Runs during teardown.
      const queuedByActor = new Map<string, TrackedQueuedInput[]>();
      for (const item of queuedInputs) {
        const key = `${item.actor.userId}:${item.actor.orgId ?? ""}`;
        const list = queuedByActor.get(key) ?? [];
        list.push(item);
        queuedByActor.set(key, list);
      }
      for (const items of queuedByActor.values()) {
        const first = items[0];
        if (!first) {
          continue;
        }
        const headers = sessionHeaders(first.actor);
        await Promise.all(
          items.map((item) => {
            return settleIncludingAbort(() => {
              return accept(
                chatEventsClient.send({
                  headers,
                  body: {
                    threadId: item.threadId,
                    revokesEventId: item.eventId,
                  },
                }),
                [201, 409],
              );
            });
          }),
        );
      }

      const activeByActor = new Map<string, TrackedRun[]>();
      for (const entry of tracked) {
        if (entry.alreadyCancelled) {
          continue;
        }
        const key = `${entry.actor.userId}:${entry.actor.orgId ?? ""}`;
        const list = activeByActor.get(key) ?? [];
        list.push(entry);
        activeByActor.set(key, list);
      }
      for (const entries of activeByActor.values()) {
        const first = entries[0];
        if (!first) {
          continue;
        }
        const headers = sessionHeaders(first.actor);
        await Promise.all(
          entries.map((entry) => {
            return settleIncludingAbort(() => {
              return accept(
                runsCancelClient.cancel({
                  headers,
                  params: { id: entry.runId },
                }),
                [200, 400],
              );
            });
          }),
        );
      }
      await Promise.all(
        tracked.map((entry) => {
          return settleIncludingAbort(() => {
            return accept(
              agentCompleteClient.complete({
                headers: bearerHeaders(entry.sandboxToken),
                body: {
                  runId: entry.runId,
                  exitCode: 1,
                  error: "Run cancelled",
                },
              }),
              [200],
            );
          });
        }),
      );
      await settleIncludingAbort(flushWaitUntilForTest);
    });
    return {
      track(
        actor: ApiTestUser,
        runId: string,
        sandboxToken: string,
      ): TrackedRun {
        const entry: TrackedRun = {
          actor,
          runId,
          sandboxToken,
          alreadyCancelled: false,
        };
        tracked.push(entry);
        return entry;
      },
      trackQueuedInput(
        actor: ApiTestUser,
        threadId: string,
        eventId: string,
      ): void {
        queuedInputs.push({ actor, threadId, eventId });
      },
    };
  }

  async function prepareRunner(maxConcurrent = 2): Promise<string> {
    fixture.chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    fixture.chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    return await runs.configureRunnerGroup({ maxConcurrent });
  }

  async function launchThreadRun(
    actor: ApiTestUser,
    runnerGroup: string,
    tracker: ReturnType<typeof createRunTracker>,
    options: {
      readonly prompt: string;
      readonly model: string | null;
    },
  ) {
    const sent = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(actor),
        body: {
          prompt: options.prompt,
          model: options.model,
          clientEventId: randomUUID(),
          hasTextContent: true,
          userMessage: textUserMessage(options.prompt),
        },
      }),
      [201],
    );
    const execution = await runs.nextReceivedExecution(runnerGroup);
    const tracked = tracker.track(
      actor,
      execution.runId,
      execution.sandboxToken,
    );
    return {
      threadId: sent.body.threadId,
      runId: execution.runId,
      execution,
      okouToken: okouTokenFromExecution(execution),
      tracked,
    };
  }

  async function deliverMembershipDeleted(actor: ApiTestUser): Promise<void> {
    const orgId = requireOrgId(actor);
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organizationMembership.deleted",
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: actor.userId },
      },
    });
    await accept(
      clerkWebhookClient.post({ body: "{}", extraHeaders: {} }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function deliverMembershipCreated(actor: ApiTestUser): Promise<void> {
    const orgId = requireOrgId(actor);
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organizationMembership.created",
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: actor.userId },
      },
    });
    await accept(
      clerkWebhookClient.post({ body: "{}", extraHeaders: {} }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    await Promise.all([
      accept(
        chatEventsClient.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            userMessage: textUserMessage("warmup"),
          },
        }),
        [401],
      ),
      accept(
        chatThreadsCreateClient.create({
          headers: {},
          body: { title: "warmup" },
        }),
        [401],
      ),
      accept(
        chatRelationsClient.children({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        chatRelationsClient.communications({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        chatRelationsClient.messages({
          headers: {},
          params: { id: WARMUP_UUID, peerId: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        notificationsClient.mail({
          headers: {},
          body: {
            kind: "notification",
            to: "me",
            subject: "warmup",
            text: "warmup",
            idempotencyKey: "warmup",
          },
        }),
        [401],
      ),
      accept(
        notificationsClient.get({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        emailSubscriptionClient.update({
          headers: {},
          body: { subscribed: false },
        }),
        [401],
      ),
      accept(
        clerkWebhookClient.post({
          body: "{}",
          extraHeaders: {},
        }),
        [401],
      ),
      accept(
        runsCancelClient.cancel({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        agentCompleteClient.complete({
          headers: {},
          body: { runId: WARMUP_UUID, exitCode: 1, error: "warmup" },
        }),
        [401],
      ),
      accept(
        runsSteerClient.steered({
          headers: {},
          params: { runId: WARMUP_UUID, eventId: WARMUP_UUID },
          body: {},
        }),
        [401],
      ),
      accept(
        runsHeartbeatClient.heartbeat({
          headers: {},
          body: {
            runnerId: WARMUP_UUID,
            group: "vm0/warmup",
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
        onboardingCompleteClient.complete({
          headers: {},
          body: {},
        }),
        [401],
      ),
      accept(
        billingStatusClient.get({
          headers: {},
        }),
        [401],
      ),
      accept(
        stripeWebhookClient.post({
          body: "{}",
          extraHeaders: {},
        }),
        [401, 503],
      ),
      accept(
        personalModelProvidersClient.upsert({
          headers: {},
          body: {
            type: "claude-code-oauth-token",
            secret: "warmup",
          },
        }),
        [401],
      ),
    ]);
  });

  describe("chat relationships", () => {
    it(
      "chat-relations-002 (1/2) records bidirectional messages between existing chats and attributes steered replies once",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const tracker = createRunTracker();
        const actor = bdd.user();
        const orgId = requireOrgId(actor);
        const [runnerGroup] = await Promise.all([
          prepareRunner(4),
          bdd.bootstrapLimitedFreeOnboarding(actor),
        ]);
        configureClerkDirectory([actor], new Map([[actor.userId, [orgId]]]));

        const [sourceRun, peerCreated] = await Promise.all([
          launchThreadRun(actor, runnerGroup, tracker, {
            prompt: "Coordinate with the peer thread",
            model: null,
          }),
          accept(
            chatThreadsCreateClient.create({
              headers: sessionHeaders(actor),
              body: { title: "Peer thread", model: null },
            }),
            [201],
          ),
        ]);
        const peerThreadId = peerCreated.body.id;

        const toPeerEventId = randomUUID();
        const toPeerBody = {
          threadId: peerThreadId,
          clientEventId: toPeerEventId,
          prompt: "Check deployment health",
          hasTextContent: true,
          userMessage: textUserMessage("Check deployment health"),
        };
        const [firstToPeer, secondToPeer] = await Promise.all([
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: toPeerBody,
            }),
            [201],
          ),
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: toPeerBody,
            }),
            [201],
          ),
        ]);
        expect(firstToPeer.body.threadId).toBe(peerThreadId);
        expect(secondToPeer.body.threadId).toBe(peerThreadId);

        const peerExecution = await runs.nextReceivedExecution(runnerGroup);
        tracker.track(actor, peerExecution.runId, peerExecution.sandboxToken);
        const peerRunId = peerExecution.runId;
        const peerOkouToken = okouTokenFromExecution(peerExecution);

        const replyEventId = randomUUID();
        await accept(
          chatEventsClient.send({
            headers: bearerHeaders(peerOkouToken),
            body: {
              threadId: sourceRun.threadId,
              clientEventId: replyEventId,
              prompt: "Deployment health is green",
              hasTextContent: true,
              userMessage: textUserMessage("Deployment health is green"),
            },
          }),
          [201],
        );

        const beforeSteer = await accept(
          chatRelationsClient.messages({
            headers: sessionHeaders(actor),
            params: { id: sourceRun.threadId, peerId: peerThreadId },
          }),
          [200],
        );
        expect(beforeSteer.body.items).toHaveLength(2);
        expect(beforeSteer.body.items).toContainEqual(
          expect.objectContaining({
            direction: "sent",
            sourceChatThreadId: sourceRun.threadId,
            targetChatThreadId: peerThreadId,
            sourceRunId: sourceRun.runId,
            targetRunId: peerRunId,
            messageEventId: toPeerEventId,
            userMessage: expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({
                  type: "text",
                  text: "Check deployment health",
                }),
              ]),
            }),
          }),
        );
        expect(beforeSteer.body.items).toContainEqual(
          expect.objectContaining({
            direction: "received",
            sourceChatThreadId: peerThreadId,
            targetChatThreadId: sourceRun.threadId,
            sourceRunId: peerRunId,
            targetRunId: null,
            messageEventId: replyEventId,
          }),
        );

        const steerHeaders = bearerHeaders(sourceRun.execution.sandboxToken);
        await accept(
          runsSteerClient.steered({
            headers: steerHeaders,
            params: { runId: sourceRun.runId, eventId: replyEventId },
            body: {},
          }),
          [200],
        );
        await accept(
          runsSteerClient.steered({
            headers: steerHeaders,
            params: { runId: sourceRun.runId, eventId: replyEventId },
            body: {},
          }),
          [200],
        );

        const afterSteer = await accept(
          chatRelationsClient.messages({
            headers: sessionHeaders(actor),
            params: { id: sourceRun.threadId, peerId: peerThreadId },
          }),
          [200],
        );
        expect(afterSteer.body.items).toHaveLength(2);
        expect(afterSteer.body.items[0]).toMatchObject({
          direction: "received",
          sourceRunId: peerRunId,
          targetRunId: sourceRun.runId,
          messageEventId: replyEventId,
        });
      },
    );

    it(
      "chat-relations-002 (2/2) leaves recalled messages unattributed, ignores self follow-ups and forwards, and reports exact communication counts",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const tracker = createRunTracker();
        const actor = bdd.user();
        const orgId = requireOrgId(actor);
        const [runnerGroup] = await Promise.all([
          prepareRunner(4),
          bdd.bootstrapLimitedFreeOnboarding(actor),
        ]);
        configureClerkDirectory([actor], new Map([[actor.userId, [orgId]]]));

        const [sourceRun, peerCreated] = await Promise.all([
          launchThreadRun(actor, runnerGroup, tracker, {
            prompt: "Coordinate with the peer thread",
            model: null,
          }),
          accept(
            chatThreadsCreateClient.create({
              headers: sessionHeaders(actor),
              body: { title: "Peer thread", model: null },
            }),
            [201],
          ),
        ]);
        const peerThreadId = peerCreated.body.id;

        await accept(
          chatEventsClient.send({
            headers: bearerHeaders(sourceRun.okouToken),
            body: {
              threadId: peerThreadId,
              clientEventId: randomUUID(),
              prompt: "Check deployment health",
              hasTextContent: true,
              userMessage: textUserMessage("Check deployment health"),
            },
          }),
          [201],
        );

        const peerExecution = await runs.nextReceivedExecution(runnerGroup);
        tracker.track(actor, peerExecution.runId, peerExecution.sandboxToken);
        const peerOkouToken = okouTokenFromExecution(peerExecution);

        const replyEventId = randomUUID();
        const recalledEventId = randomUUID();
        const selfFollowupEventId = randomUUID();
        const forwardedEventId = randomUUID();
        tracker.trackQueuedInput(actor, sourceRun.threadId, replyEventId);
        tracker.trackQueuedInput(
          actor,
          sourceRun.threadId,
          selfFollowupEventId,
        );
        tracker.trackQueuedInput(actor, peerThreadId, forwardedEventId);

        await Promise.all([
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(peerOkouToken),
              body: {
                threadId: sourceRun.threadId,
                clientEventId: replyEventId,
                prompt: "Deployment health is green",
                hasTextContent: true,
                userMessage: textUserMessage("Deployment health is green"),
              },
            }),
            [201],
          ),
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: {
                threadId: peerThreadId,
                clientEventId: recalledEventId,
                prompt: "Draft message to recall",
                hasTextContent: true,
                userMessage: textUserMessage("Draft message to recall"),
              },
            }),
            [201],
          ),
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: {
                threadId: sourceRun.threadId,
                clientEventId: selfFollowupEventId,
                prompt: "Self follow-up note",
                hasTextContent: true,
                userMessage: textUserMessage("Self follow-up note"),
              },
            }),
            [201],
          ),
          accept(
            chatEventsClient.send({
              headers: sessionHeaders(actor),
              body: {
                threadId: peerThreadId,
                clientEventId: forwardedEventId,
                prompt: "Member-forwarded note",
                sourceRunId: sourceRun.runId,
                hasTextContent: true,
                userMessage: textUserMessage("Member-forwarded note"),
              },
            }),
            [201],
          ),
        ]);

        await accept(
          chatEventsClient.send({
            headers: sessionHeaders(actor),
            body: {
              threadId: peerThreadId,
              revokesEventId: recalledEventId,
            },
          }),
          [201],
        );

        const [afterRecall, sourceComms, peerComms, sourceChildren] =
          await Promise.all([
            accept(
              chatRelationsClient.messages({
                headers: sessionHeaders(actor),
                params: { id: sourceRun.threadId, peerId: peerThreadId },
              }),
              [200],
            ),
            accept(
              chatRelationsClient.communications({
                headers: sessionHeaders(actor),
                params: { id: sourceRun.threadId },
              }),
              [200],
            ),
            accept(
              chatRelationsClient.communications({
                headers: sessionHeaders(actor),
                params: { id: peerThreadId },
              }),
              [200],
            ),
            accept(
              chatRelationsClient.children({
                headers: sessionHeaders(actor),
                params: { id: sourceRun.threadId },
              }),
              [200],
            ),
          ]);

        expect(afterRecall.body.items).toContainEqual(
          expect.objectContaining({
            direction: "sent",
            sourceRunId: sourceRun.runId,
            targetRunId: null,
            messageEventId: recalledEventId,
          }),
        );
        expect(sourceComms.body.items).toStrictEqual([
          expect.objectContaining({
            threadId: peerThreadId,
            sentCount: 2,
            receivedCount: 1,
          }),
        ]);
        expect(peerComms.body.items).toStrictEqual([
          expect.objectContaining({
            threadId: sourceRun.threadId,
            sentCount: 1,
            receivedCount: 2,
          }),
        ]);
        expect(sourceChildren.body.items).toStrictEqual([]);
      },
    );

    it(
      "chat-relations-005 records implicit creation and enforces user and organization boundaries",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const tracker = createRunTracker();
        const actor = bdd.user();
        const orgId = requireOrgId(actor);
        const sameOrgOtherUser = bdd.user({ orgId, orgRole: "org:member" });
        const sameUserOtherOrg = bdd.user({ userId: actor.userId });

        const [runnerGroup] = await Promise.all([
          prepareRunner(4),
          bdd.bootstrapLimitedFreeOnboarding(actor),
        ]);
        configureClerkDirectory(
          [actor, sameOrgOtherUser, sameUserOtherOrg],
          new Map([
            [actor.userId, [orgId, requireOrgId(sameUserOtherOrg)]],
            [sameOrgOtherUser.userId, [orgId]],
          ]),
        );

        const sourceRun = await launchThreadRun(actor, runnerGroup, tracker, {
          prompt: "Implicitly create a child chat",
          model: null,
        });

        const implicitThreadId = randomUUID();
        const messageEventId = randomUUID();
        const implicitBody = {
          clientThreadId: implicitThreadId,
          clientEventId: messageEventId,
          prompt: "Start implicit child work",
          hasTextContent: true,
          userMessage: textUserMessage("Start implicit child work"),
        };
        const [firstSend, secondSend] = await Promise.all([
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: implicitBody,
            }),
            [201],
          ),
          accept(
            chatEventsClient.send({
              headers: bearerHeaders(sourceRun.okouToken),
              body: implicitBody,
            }),
            [201],
          ),
        ]);
        expect(firstSend.body.threadId).toBe(implicitThreadId);
        expect(secondSend.body.threadId).toBe(implicitThreadId);

        const childExecution = await runs.nextReceivedExecution(runnerGroup);
        tracker.track(actor, childExecution.runId, childExecution.sandboxToken);

        const [children, messages] = await Promise.all([
          accept(
            chatRelationsClient.children({
              headers: sessionHeaders(actor),
              params: { id: sourceRun.threadId },
            }),
            [200],
          ),
          accept(
            chatRelationsClient.messages({
              headers: sessionHeaders(actor),
              params: { id: sourceRun.threadId, peerId: implicitThreadId },
            }),
            [200],
          ),
        ]);

        expect(children.body.items).toStrictEqual([
          expect.objectContaining({
            threadId: implicitThreadId,
            sourceRunId: sourceRun.runId,
          }),
        ]);
        expect(messages.body.items).toStrictEqual([
          expect.objectContaining({
            direction: "sent",
            sourceChatThreadId: sourceRun.threadId,
            targetChatThreadId: implicitThreadId,
            sourceRunId: sourceRun.runId,
            messageEventId,
          }),
        ]);

        const sameOrgOnSource = await accept(
          chatRelationsClient.children({
            headers: sessionHeaders(sameOrgOtherUser),
            params: { id: sourceRun.threadId },
          }),
          [404],
        );
        const sameOrgOnUnknown = await accept(
          chatRelationsClient.children({
            headers: sessionHeaders(sameOrgOtherUser),
            params: { id: randomUUID() },
          }),
          [404],
        );
        const otherOrgComms = await accept(
          chatRelationsClient.communications({
            headers: sessionHeaders(sameUserOtherOrg),
            params: { id: sourceRun.threadId },
          }),
          [404],
        );

        expect(sameOrgOnSource.body).toStrictEqual({
          error: { code: "NOT_FOUND", message: "Chat thread not found" },
        });
        expect(sameOrgOnUnknown.body).toStrictEqual({
          error: { code: "NOT_FOUND", message: "Chat thread not found" },
        });
        expect(otherOrgComms.body).toStrictEqual({
          error: { code: "NOT_FOUND", message: "Chat thread not found" },
        });
      },
    );

    it(
      "chat-relations-001 returns all created chats once without inferring human-created children",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const tracker = createRunTracker();
        const actor = bdd.user();
        const orgId = requireOrgId(actor);
        mockClaudeCodeTokenEndpoint();
        const [runnerGroup] = await Promise.all([
          prepareRunner(2),
          bdd.provisionWorkspace(actor),
        ]);
        const actorSessionHeaders = sessionHeaders(actor);
        configureClerkDirectory([actor], new Map([[actor.userId, [orgId]]]));
        const [humanCreated] = await Promise.all([
          accept(
            chatThreadsCreateClient.create({
              headers: actorSessionHeaders,
              body: { title: "Human created thread", model: null },
            }),
            [201],
          ),
          accept(
            onboardingCompleteClient.complete({
              headers: actorSessionHeaders,
              body: {},
            }),
            [200],
          ),
          accept(
            personalModelProvidersClient.upsert({
              headers: actorSessionHeaders,
              body: {
                type: "claude-code-oauth-token",
                secret: "bdd-personal-claude-token",
              },
            }),
            [200, 201],
          ),
        ]);
        const humanThreadId = humanCreated.body.id;

        const sourceRun = await launchThreadRun(actor, runnerGroup, tracker, {
          prompt: "Spawn child threads",
          model: "claude-fable-5-1",
        });
        const agentHeaders = bearerHeaders(sourceRun.okouToken);
        const fiftyFirstId = randomUUID();

        const [fiftyFirstA, fiftyFirstB, humanReplay, ...fiftyCreated] =
          await Promise.all([
            accept(
              chatThreadsCreateClient.create({
                headers: agentHeaders,
                body: {
                  title: "Child 51",
                  clientThreadId: fiftyFirstId,
                  model: null,
                },
              }),
              [201],
            ),
            accept(
              chatThreadsCreateClient.create({
                headers: agentHeaders,
                body: {
                  title: "Child 51",
                  clientThreadId: fiftyFirstId,
                  model: null,
                },
              }),
              [201],
            ),
            accept(
              chatThreadsCreateClient.create({
                headers: agentHeaders,
                body: {
                  title: "Attempted human hijack",
                  clientThreadId: humanThreadId,
                  model: null,
                },
              }),
              [201],
            ),
            ...Array.from({ length: 50 }, (_, index) => {
              return accept(
                chatThreadsCreateClient.create({
                  headers: agentHeaders,
                  body: { title: `Child ${index + 1}`, model: null },
                }),
                [201],
              );
            }),
          ]);

        expect(fiftyFirstA.body.id).toBe(fiftyFirstId);
        expect(fiftyFirstB.body.id).toBe(fiftyFirstId);
        expect(humanReplay.body.id).toBe(humanThreadId);

        const [children, communications] = await Promise.all([
          accept(
            chatRelationsClient.children({
              headers: sessionHeaders(actor),
              params: { id: sourceRun.threadId },
            }),
            [200],
          ),
          accept(
            chatRelationsClient.communications({
              headers: sessionHeaders(actor),
              params: { id: sourceRun.threadId },
            }),
            [200],
          ),
        ]);

        const expectedChildIds = new Set([
          ...fiftyCreated.map((response) => {
            return response.body.id;
          }),
          fiftyFirstId,
        ]);
        const actualChildIds = new Set(
          children.body.items.map((item) => {
            return item.threadId;
          }),
        );

        expect(children.body.items).toHaveLength(51);
        expect(actualChildIds).toStrictEqual(expectedChildIds);
        expect(actualChildIds.has(humanThreadId)).toBeFalsy();
        expect(children.body.items[0]).toMatchObject({
          sourceRunId: sourceRun.runId,
          status: "idle",
        });
        expect(communications.body.items).toStrictEqual([]);
      },
    );
  });

  describe("agent mail notifications", () => {
    it(
      "notifications-013 scopes lookup to the owner and workspace and rejects missing membership",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        configureMailDelivery();
        const tracker = createRunTracker();
        const member = bdd.user();
        const orgId = requireOrgId(member);
        const otherUser = bdd.user();
        const sameUserOtherOrg = bdd.user({ userId: member.userId });
        const otherOrgId = requireOrgId(sameUserOtherOrg);

        const [runnerGroup] = await Promise.all([
          prepareRunner(2),
          runs.grantProEntitlement(member),
        ]);
        const memberships = new Map<string, readonly string[]>([
          [member.userId, [orgId, otherOrgId]],
          [otherUser.userId, [requireOrgId(otherUser)]],
        ]);
        configureClerkDirectory(
          [member, otherUser, sameUserOtherOrg],
          memberships,
        );

        const memberRun = await launchThreadRun(member, runnerGroup, tracker, {
          prompt: "Queue a member notification",
          model: null,
        });

        configureClerkDirectory(
          [member, otherUser, sameUserOtherOrg],
          memberships,
        );
        const queued = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(memberRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Private update",
              text: "Visible only to owner in this workspace",
              idempotencyKey: `scoped-${randomUUID()}`,
            },
          }),
          [200],
        );
        await flushWaitUntilForTest();

        const otherUserRead = await accept(
          notificationsClient.get({
            headers: sessionHeaders(otherUser),
            params: { id: queued.body.notificationId },
          }),
          [404],
        );
        const sameUserOtherOrgRead = await accept(
          notificationsClient.get({
            headers: sessionHeaders(sameUserOtherOrg),
            params: { id: queued.body.notificationId },
          }),
          [404],
        );
        expect(otherUserRead.status).toBe(404);
        expect(sameUserOtherOrgRead.status).toBe(404);

        memberships.set(member.userId, [otherOrgId]);
        configureClerkDirectory(
          [member, otherUser, sameUserOtherOrg],
          memberships,
        );
        await deliverMembershipDeleted(member);
        memberRun.tracked.alreadyCancelled = true;

        const afterDeparture = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(memberRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Post-departure update",
              text: "Must be rejected without org membership",
              idempotencyKey: `after-departure-${randomUUID()}`,
            },
          }),
          [400],
        );
        expect(afterDeparture.status).toBe(400);
      },
    );

    it(
      "notifications-014 (1/3) erases queued and skipped receipts on departure and permits a living member to rejoin",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        configureMailDelivery();
        const tracker = createRunTracker();
        const member = bdd.user();
        const orgId = requireOrgId(member);
        const [runnerGroup] = await Promise.all([
          prepareRunner(2),
          runs.grantProEntitlement(member),
        ]);
        const memberships = new Map<string, readonly string[]>([
          [member.userId, [orgId]],
        ]);
        configureClerkDirectory([member], memberships);

        const memberRun = await launchThreadRun(member, runnerGroup, tracker, {
          prompt: "Send queued and skipped notifications",
          model: null,
        });

        context.mocks.resend.send.mockResolvedValueOnce({
          data: null,
          error: {
            name: "rate_limit_exceeded",
            statusCode: 429,
            message: "Too many requests",
          },
        });
        configureClerkDirectory([member], memberships);
        const queued = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(memberRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Rate limited notification",
              text: "Stays queued until retry",
              idempotencyKey: `queued-${randomUUID()}`,
            },
          }),
          [200],
        );
        await flushWaitUntilForTest();

        const [beforeDeparture] = await Promise.all([
          accept(
            notificationsClient.get({
              headers: sessionHeaders(member),
              params: { id: queued.body.notificationId },
            }),
            [200],
          ),
          accept(
            emailSubscriptionClient.update({
              headers: sessionHeaders(member),
              body: { subscribed: false },
            }),
            [200],
          ),
        ]);
        expect(beforeDeparture.body).toMatchObject({
          notificationId: queued.body.notificationId,
          status: "queued",
          reason: null,
        });

        configureClerkDirectory([member], memberships);
        const skipped = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(memberRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Unsubscribed notification",
              text: "Skipped due to preference",
              idempotencyKey: `skipped-${randomUUID()}`,
            },
          }),
          [200],
        );
        expect(skipped.body).toMatchObject({
          status: "skipped",
          reason: "unsubscribed",
        });

        memberships.set(member.userId, []);
        configureClerkDirectory([member], memberships);
        await deliverMembershipDeleted(member);
        memberRun.tracked.alreadyCancelled = true;
        await deliverMembershipDeleted(member);

        memberships.set(member.userId, [orgId]);
        configureClerkDirectory([member], memberships);
        await deliverMembershipCreated(member);

        const [queuedAfterRejoin, skippedAfterRejoin] = await Promise.all([
          accept(
            notificationsClient.get({
              headers: sessionHeaders(member),
              params: { id: queued.body.notificationId },
            }),
            [404],
          ),
          accept(
            notificationsClient.get({
              headers: sessionHeaders(member),
              params: { id: skipped.body.notificationId },
            }),
            [404],
          ),
        ]);

        expect(queuedAfterRejoin.status).toBe(404);
        expect(skippedAfterRejoin.status).toBe(404);
      },
    );

    it(
      "notifications-014 (2/3) preserves a same-workspace peer member receipt across member departure and rejoin",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        configureMailDelivery();
        const tracker = createRunTracker();
        const peer = bdd.user();
        const orgId = requireOrgId(peer);
        const departed = bdd.user({ orgId, orgRole: "org:member" });

        const [runnerGroup] = await Promise.all([
          prepareRunner(2),
          runs.grantProEntitlement(peer),
        ]);
        const memberships = new Map<string, readonly string[]>([
          [peer.userId, [orgId]],
          [departed.userId, [orgId]],
        ]);
        configureClerkDirectory([peer, departed], memberships);

        const peerRun = await launchThreadRun(peer, runnerGroup, tracker, {
          prompt: "Send peer notification",
          model: null,
        });

        configureClerkDirectory([peer, departed], memberships);
        const peerSent = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(peerRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Peer update",
              text: "Peer notification body",
              idempotencyKey: `peer-${randomUUID()}`,
            },
          }),
          [200],
        );
        await flushWaitUntilForTest();

        memberships.set(departed.userId, []);
        configureClerkDirectory([peer, departed], memberships);
        await deliverMembershipDeleted(departed);
        await deliverMembershipDeleted(departed);

        memberships.set(departed.userId, [orgId]);
        configureClerkDirectory([peer, departed], memberships);
        await deliverMembershipCreated(departed);

        const peerReceipt = await accept(
          notificationsClient.get({
            headers: sessionHeaders(peer),
            params: { id: peerSent.body.notificationId },
          }),
          [200],
        );
        expect(peerReceipt.body).toMatchObject({
          notificationId: peerSent.body.notificationId,
          status: "sent",
          reason: null,
        });
      },
    );

    it(
      "notifications-014 (3/3) preserves the same user receipt in another workspace across departure and rejoin",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        configureMailDelivery();
        const tracker = createRunTracker();
        const sameUserOtherOrg = bdd.user();
        const otherOrgId = requireOrgId(sameUserOtherOrg);
        const departed = bdd.user({ userId: sameUserOtherOrg.userId });
        const departedOrgId = requireOrgId(departed);

        const [runnerGroup] = await Promise.all([
          prepareRunner(2),
          runs.grantProEntitlement(sameUserOtherOrg),
        ]);
        await bdd.provisionWorkspace(departed);

        const memberships = new Map<string, readonly string[]>([
          [sameUserOtherOrg.userId, [otherOrgId, departedOrgId]],
        ]);
        configureClerkDirectory([sameUserOtherOrg], memberships);

        const otherOrgRun = await launchThreadRun(
          sameUserOtherOrg,
          runnerGroup,
          tracker,
          {
            prompt: "Send other-workspace notification",
            model: null,
          },
        );

        configureClerkDirectory([sameUserOtherOrg], memberships);
        const otherOrgSent = await accept(
          notificationsClient.mail({
            headers: bearerHeaders(otherOrgRun.okouToken),
            body: {
              kind: "notification",
              to: "me",
              subject: "Other workspace update",
              text: "Other workspace notification body",
              idempotencyKey: `other-org-${randomUUID()}`,
            },
          }),
          [200],
        );
        await flushWaitUntilForTest();

        memberships.set(sameUserOtherOrg.userId, [otherOrgId]);
        configureClerkDirectory([sameUserOtherOrg], memberships);
        await deliverMembershipDeleted(departed);
        await deliverMembershipDeleted(departed);

        memberships.set(sameUserOtherOrg.userId, [otherOrgId, departedOrgId]);
        configureClerkDirectory([sameUserOtherOrg], memberships);
        await deliverMembershipCreated(departed);

        const otherOrgReceipt = await accept(
          notificationsClient.get({
            headers: sessionHeaders(sameUserOtherOrg),
            params: { id: otherOrgSent.body.notificationId },
          }),
          [200],
        );
        expect(otherOrgReceipt.body).toMatchObject({
          notificationId: otherOrgSent.body.notificationId,
          status: "sent",
          reason: null,
        });
      },
    );
  });
});
