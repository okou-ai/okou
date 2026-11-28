import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { orgInviteRoutes } from "../org-invite";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  campaignRequest,
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const SETTLEMENT_SECRET =
  "marketing-reward-workflow-settlement-1234567890123456";
const HOUR_MS = 60 * 60 * 1000;

const context = testContext();
const api = createAuthOrgBddApi(context);
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const billingStatusClient = setupApp({
  context,
  routes: billingStatusRoutes,
})(billingStatusContract);
const onboardingCompleteClient = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const orgInviteClient = setupApp({ context, routes: orgInviteRoutes })(
  orgInviteContract,
);
const settlementClient = setupApp({
  context,
  routes: marketingRewardSettlementRoutes,
})(marketingRewardSettlementContract);
const workflowsCollectionClient = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);
const workflowsDetailClient = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsDetailContract);
const webhooksClerkClient = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const webhooksStripeClient = setupApp({
  context,
  routes: webhooksStripeRoutes,
})(webhookStripeContract);
const webhooksAgentCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const runnersHeartbeatClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runDetailClient = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelClient = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPrivateMetadata(callArg: unknown): Record<string, unknown> {
  if (isRecord(callArg) && isRecord(callArg.privateMetadata)) {
    return callArg.privateMetadata;
  }
  return {};
}

async function prepareAcceptedInviteSettlement() {
  mockEnv("ENV", "development");
  const consumer = marketingRewardConsumer();
  const inviter = api.user();
  api.acceptStorageWrites();
  api.mockClerkOrg(inviter);
  await api.bootstrapLimitedFreeOnboarding(inviter);
  const orgId = inviter.orgId;
  if (!orgId) {
    throw new Error("Expected a workspace member");
  }
  const invitationId = `orginv_${randomUUID()}`;
  const inviteeEmail = `invitee_${randomUUID()}@example.test`;
  const inviteeId = `user_${randomUUID()}`;
  const invitedAt = now();
  context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
    { id: invitationId },
  );
  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/invitations/:invitationId",
      () => {
        return HttpResponse.json({
          object: "organization_invitation",
          id: invitationId,
          organization_id: orgId,
          email_address: inviteeEmail,
          role: "org:member",
          status: "pending",
          expires_at: invitedAt + 86_400_000,
          private_metadata: {},
          public_metadata: {},
          created_at: invitedAt,
          updated_at: invitedAt,
        });
      },
    ),
  );
  await accept(
    orgInviteClient.invite({
      headers: api.authenticate(inviter),
      body: { email: inviteeEmail, role: "member" },
    }),
    [200],
  );
  const lastCall: readonly unknown[] =
    context.mocks.clerk.organizations.createOrganizationInvitation.mock.calls.at(
      -1,
    ) ?? [];
  const privateMetadata = extractPrivateMetadata(lastCall[0]);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationInvitation.accepted",
    data: {
      id: invitationId,
      organization_id: orgId,
      user_id: inviteeId,
      email_address: inviteeEmail,
      updated_at: now(),
      private_metadata: privateMetadata,
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
  const accepted = consumer.received.find((event) => {
    return event.type === "invitation.accepted";
  });
  if (accepted?.type !== "invitation.accepted") {
    throw new Error("Expected the accepted invitation fact");
  }
  const terms = {
    version: 1,
    environment: accepted.environment,
    policy: "get-started-v1",
    sourceEventId: accepted.id,
    questKey: "invite",
    sourceKey: accepted.sourceKey,
    rewardKey: `invite:${inviteeId}`,
    orgId,
    actorUserId: inviter.userId,
    beneficiaryUserId: inviter.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: accepted.occurredAt,
  } as const;
  return { inviter, inviteeId, accepted, terms };
}

describe("Marketing reward settlement", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    const previousSettlementSecret = env("MARKETING_REWARDS_SETTLEMENT_SECRET");
    const result = await settleIncludingAbort(async () => {
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_clerk");
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup_stripe");
      mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", SETTLEMENT_SECRET);
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
        new Error("warmup"),
      );
      const warmupId = randomUUID();
      await Promise.all([
        accept(
          orgInviteClient.invite({
            headers: {},
            body: { email: "warmup@example.test", role: "member" },
          }),
          [401],
        ),
        accept(
          workflowsCollectionClient.create({
            headers: {},
            body: { name: "warmup-workflow", visibility: "public" },
          }),
          [401],
        ),
        accept(
          workflowsDetailClient.run({
            headers: {},
            params: { workflowId: warmupId },
          }),
          [401],
        ),
        accept(
          workflowsDetailClient.delete({
            headers: {},
            params: { workflowId: warmupId },
          }),
          [401],
        ),
        accept(billingStatusClient.get({ headers: {} }), [401]),
        accept(
          onboardingCompleteClient.complete({ headers: {}, body: {} }),
          [401],
        ),
        accept(
          runDetailClient.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelClient.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhooksAgentCompleteClient.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          webhooksClerkClient.post({ body: "{}", extraHeaders: {} }),
          [401],
        ),
        accept(
          webhooksStripeClient.post({ body: "{}", extraHeaders: {} }),
          [401],
        ),
        accept(
          runnersHeartbeatClient.heartbeat({
            headers: {},
            body: {
              runnerId: warmupId,
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
          settlementClient.settle({
            headers: {},
            body: campaignRequest({
              version: 1,
              environment: "development",
              policy: "get-started-v1",
              sourceEventId: warmupId,
              questKey: "workflow",
              sourceKey: warmupId,
              rewardKey: "workflow:warmup",
              orgId: "org_warmup",
              actorUserId: "user_warmup_actor",
              beneficiaryUserId: "user_warmup_creator",
              rewardTarget: "user",
              rewardAmount: 1000,
              completedAt: "2026-01-01T00:00:00.000Z",
            }),
          }),
          [401],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", previousSettlementSecret);
    if (!result.ok) {
      throw result.error;
    }
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "marketing-reward-settlement-002 settles for the original creator concurrently and recovers the receipt after deletion and expiry",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("ENV", "development");
      mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", SETTLEMENT_SECRET);
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-marketing-reward-key");
      const consumer = marketingRewardConsumer();
      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      const admin = api.user({ orgRole: "org:admin" });
      const orgId = admin.orgId;
      if (!orgId) {
        throw new Error("Expected a team workspace organization");
      }
      const member = api.user({ orgId, orgRole: "org:member" });

      const runCleanupState: {
        runId?: string;
        sandboxToken?: string;
        runnerGroup?: string;
      } = {};
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const kmsKey = env("SECRETS_KMS_KEY_ID");

      onTestFinished(async () => {
        const runId = runCleanupState.runId;
        if (!runId) {
          return;
        }
        const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
        const cleanupResult = await settleIncludingAbort(async () => {
          mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
          mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
          if (runCleanupState.runnerGroup) {
            mockOptionalEnv(
              "RUNNER_DEFAULT_GROUP",
              runCleanupState.runnerGroup,
            );
          }
          bdd.acceptStorageWrites();
          runs.acceptStorageDownloads();
          runs.acceptTelemetryIngest();
          context.mocks.ably.publish.mockResolvedValue(undefined);
          const current = await accept(
            runDetailClient.getById({
              headers: api.authenticate(member),
              params: { id: runId },
            }),
            [200],
          );
          if (["queued", "pending", "running"].includes(current.body.status)) {
            await accept(
              runsCancelClient.cancel({
                headers: api.authenticate(member),
                params: { id: runId },
              }),
              [200],
            );
          }
          if (
            runCleanupState.sandboxToken &&
            !["completed", "failed", "timeout"].includes(current.body.status)
          ) {
            await accept(
              webhooksAgentCompleteClient.complete({
                headers: {
                  authorization: `Bearer ${runCleanupState.sandboxToken}`,
                },
                body: {
                  runId,
                  exitCode: 1,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            );
          }
          await flushWaitUntilForTest();
        });
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
        if (!cleanupResult.ok) {
          throw cleanupResult.error;
        }
      });

      const periodEnd = nowDate();
      periodEnd.setTime(now() + 30 * 24 * HOUR_MS);
      const [runnerGroup, , createdWorkflow] = await Promise.all([
        runs.configureRunnerGroup(),
        postSubscriptionInvoicePaid(context.signal, {
          orgId,
          userId: admin.userId,
          tier: "team",
          customerId: generatedStripeCustomerId(),
          subscriptionId: generatedStripeSubscriptionId(),
          currentPeriodEnd: periodEnd,
        }),
        accept(
          workflowsCollectionClient.create({
            headers: api.authenticate(admin),
            body: {
              name: `reward-wf-${randomUUID().slice(0, 8)}`,
              visibility: "public",
              instruction: "Summarize the workspace task.",
            },
          }),
          [201],
        ),
      ]);
      runCleanupState.runnerGroup = runnerGroup;
      const workflowId = createdWorkflow.body.id;

      const launched = await accept(
        workflowsDetailClient.run({
          headers: api.authenticate(member),
          params: { workflowId },
        }),
        [200],
      );
      const execution = await runs.nextReceivedExecution(runnerGroup);
      runCleanupState.runId = execution.runId;
      runCleanupState.sandboxToken = execution.sandboxToken;

      await accept(
        webhooksAgentCompleteClient.complete({
          headers: { authorization: `Bearer ${execution.sandboxToken}` },
          body: {
            runId: execution.runId,
            exitCode: 0,
            completion: {
              cliAgentType: execution.cliAgentType,
              cliAgentSessionId:
                execution.piSessionId ?? launched.body.chatThreadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const completed = consumer.received.find((event) => {
        return event.type === "workflow.run-completed";
      });
      if (completed?.type !== "workflow.run-completed") {
        throw new Error("Expected the workflow.run-completed source fact");
      }

      await accept(
        workflowsDetailClient.delete({
          headers: api.authenticate(admin),
          params: { workflowId },
        }),
        [204],
      );

      const intent = campaignRequest({
        version: 1,
        environment: completed.environment,
        policy: "get-started-v1",
        sourceEventId: completed.id,
        questKey: "workflow",
        sourceKey: completed.sourceEventId,
        rewardKey: `workflow:${admin.userId}`,
        orgId,
        actorUserId: member.userId,
        beneficiaryUserId: admin.userId,
        rewardTarget: "user",
        rewardAmount: 1000,
        completedAt: completed.occurredAt,
      });
      const settlementHeaders = {
        authorization: `Bearer ${SETTLEMENT_SECRET}`,
      };

      const concurrent = await Promise.all([
        accept(
          settlementClient.settle({
            headers: settlementHeaders,
            body: intent,
          }),
          [200, 202],
        ),
        accept(
          settlementClient.settle({
            headers: settlementHeaders,
            body: intent,
          }),
          [200, 202],
        ),
      ]);

      const settled = await accept(
        settlementClient.settle({
          headers: settlementHeaders,
          body: intent,
        }),
        [200],
      );

      const grantedAtMs = Date.parse(settled.body.receipt.grantedAt ?? "");
      const expiresAtMs = Date.parse(settled.body.receipt.expiresAt ?? "");
      mockNow(expiresAtMs + 24 * HOUR_MS);

      const afterExpiry = await accept(
        settlementClient.settle({
          headers: settlementHeaders,
          body: intent,
        }),
        [200],
      );

      expect([200, 202]).toContain(concurrent[0].status);
      expect([200, 202]).toContain(concurrent[1].status);
      expect(settled.status).toBe(200);
      expect(settled.body.receipt).toMatchObject({
        status: "granted",
        orgId,
        actorUserId: member.userId,
        beneficiaryUserId: admin.userId,
        rewardAmount: 1000,
        rewardKey: `workflow:${admin.userId}`,
      });
      expect(settled.body.receipt.memberCreditGrantId).toBeTruthy();
      expect(expiresAtMs - grantedAtMs).toBe(168 * HOUR_MS);
      expect(afterExpiry.body).toStrictEqual(settled.body);
    },
  );

  it("marketing-reward-settlement-007 (1/2) captures a signed acceptance and settles the original inviter", async () => {
    const { inviter, inviteeId, accepted, terms } =
      await prepareAcceptedInviteSettlement();

    const first = await settleMarketingRequest(context, terms);

    expect(first.body.receipt).toMatchObject({
      id: accepted.claimId,
      status: "granted",
      beneficiaryUserId: inviter.userId,
      rewardKey: `invite:${inviteeId}`,
    });
  });

  it("marketing-reward-settlement-007 (2/2) returns the exact same settlement body on repeat", async () => {
    const { terms } = await prepareAcceptedInviteSettlement();

    const first = await settleMarketingRequest(context, terms);
    const repeat = await settleMarketingRequest(context, terms);

    expect(repeat.body).toStrictEqual(first.body);
  });
});
