import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import type { z } from "zod";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrant,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  cronProcessUsageEventsContract,
  cronTelegramCleanupContract,
} from "@okouai/api-contracts/contracts/cron";
import { testBillingReconciliationStateContract } from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import {
  runnersActiveInputsContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersModelProviderFailuresContract,
  runnersPollContract,
  type CanonicalStorageManifest,
  type StorageManifest,
} from "@okouai/api-contracts/contracts/runners";
import {
  runsCancelContract,
  runCreateBodySchema,
  runContextContract,
  runRunnerContract,
  runsByIdContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { createAppWithRoutes } from "../../../../app-factory-core";
import {
  setupAppWithRoutes,
  setupRawAppRequestWithRoutes,
} from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now, withNowScopeForTest } from "../../../../lib/time";
import { createDeferredPromise } from "../../../utils";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import type { SystemSkillStorageResolution } from "../../../context/system-skill-storage-resolution";
import {
  createDirectAgentExecutionFixture,
  createDirectRunFixture,
  listAgentRunsFixture,
  type DirectAgentExecutionConfig,
  type DirectRunFixtureRequest,
} from "../../../../test-fixtures/agent-runs";
import {
  generateSandboxToken,
  signSandboxJwtForTests,
} from "../../../auth/tokens";
import { mockStripeClient } from "../../../external/stripe-client";
import { cliAuthRoutes } from "../../cli-auth";
import { cronProcessUsageEventsRoutes } from "../../cron-process-usage-events";
import { cronTelegramCleanupRoutes } from "../../cron-telegram-cleanup";
import { runnersRoutes } from "../../runners";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { agentsRoutes } from "../../agents";
import { billingStatusRoutes } from "../../billing-status";
import { modelPoliciesRoutes } from "../../model-policies";
import { modelProvidersRoutes } from "../../model-providers";
import { runDetailRoutes } from "../../run-detail";
import { runsCancelRoutes } from "../../runs-cancel";
import { runsRoutes } from "../../runs";
import { runFixtureContract, runFixtureRoutes } from "../../test-run-fixture";
import { testBillingReconciliationStateRoutes } from "../../test-billing-reconciliation-state";
import { userPermissionGrantsRoutes } from "../../user-permission-grants";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

type AuthHeaders = { readonly authorization?: string };
type AgentRunRequest = z.infer<typeof runCreateBodySchema>;
type DirectRunRequest = DirectRunFixtureRequest;
interface RunsListQuery {
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}
type RunnerJobClaimRequestBody = z.infer<
  (typeof runnersJobClaimContract.claim)["body"]
>;
/** Test claims advertise every current Pi model-config generation unless a scenario narrows them. */
function defaultClaimCapabilities(): RunnerJobClaimRequestBody["capabilities"] {
  return { piModelConfigGenerations: [1, 2, 3, 4] };
}
type RunnerJobClaimRequest = Omit<RunnerJobClaimRequestBody, "capabilities"> & {
  readonly capabilities?: RunnerJobClaimRequestBody["capabilities"];
};
type RunnerModelProviderFailureRequest = z.infer<
  (typeof runnersModelProviderFailuresContract.report)["body"]
>;
type RunnerConnectorRuntimeSyncRequest = z.input<
  (typeof runnersConnectorRuntimeSyncContract.sync)["body"]
>;
type RunnerConnectorRuntimeSyncStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
type RunnerActiveInputDeliveryStatus = 200 | 400 | 401 | 403 | 500;
type OrgModelPolicyRequest = z.infer<
  (typeof modelPoliciesMainContract.update)["body"]
>;
type OrgModelProviderUpsertRequest = z.infer<
  (typeof modelProvidersMainContract.upsert)["body"]
>;
type RunnerHeartbeatBody = z.infer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;
type RunnerPollBody = z.infer<(typeof runnersPollContract.poll)["body"]>;
type RunnerRealtimeTokenBody = z.infer<
  (typeof runnerRealtimeTokenContract.create)["body"]
>;

export function expectCanonicalStorageManifest(
  manifest: StorageManifest | null | undefined,
): CanonicalStorageManifest | null | undefined {
  if (manifest === null || manifest === undefined) {
    return manifest;
  }
  if (!("storageMounts" in manifest)) {
    throw new Error("Expected a canonical Storage manifest");
  }
  return manifest;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

interface ClerkOrganizationMembership {
  readonly id: string;
  readonly createdAt: number;
  readonly role: string;
  readonly organization: { readonly id: string };
  readonly publicUserData: {
    readonly userId: string;
  };
}

const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const runRoutes = [
  ...cliAuthRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronTelegramCleanupRoutes,
  ...runnersRoutes,
  ...webhooksStripeRoutes,
  ...billingStatusRoutes,
  ...modelPoliciesRoutes,
  ...modelProvidersRoutes,
  ...runDetailRoutes,
  ...runFixtureRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...agentsRoutes,
  ...userPermissionGrantsRoutes,
] as const;

function runApp(
  context: TestContext,
  usagePricingResolution?: UsagePricingResolution,
  systemSkillStorageResolution?: SystemSkillStorageResolution,
) {
  return setupAppWithRoutes({
    context,
    routes: runRoutes,
    ...(usagePricingResolution === undefined ? {} : { usagePricingResolution }),
    systemSkillStorageResolution,
  });
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Runner",
  };
}

function clerkOrganizationMemberships(
  actor: ApiTestUser,
): readonly ClerkOrganizationMembership[] {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      id: `membership-${actor.userId}-${actor.orgId}`,
      createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
      role: actor.orgRole ?? "org:member",
      organization: { id: actor.orgId },
      publicUserData: { userId: actor.userId },
    },
  ];
}

function authenticate(
  context: TestContext,
  nextActor: ApiTestUser | null,
): AuthHeaders {
  if (!nextActor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    nextActor.userId,
    nextActor.orgId,
    nextActor.orgRole,
  );
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(nextActor)],
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: clerkOrganizationMemberships(nextActor),
    },
  );
  return { authorization: "Bearer clerk-session" };
}

function runnerHeaders(valid: boolean): AuthHeaders {
  return valid ? { authorization: OFFICIAL_RUNNER_AUTHORIZATION } : {};
}

function runnerHeartbeatBody(
  args: {
    readonly runnerId?: string;
    readonly group?: string;
    readonly snapshotGeneration?: RunnerHeartbeatBody["snapshotGeneration"];
    readonly snapshotSequence?: RunnerHeartbeatBody["snapshotSequence"];
    readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
    readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
    readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
    readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
    readonly runningCount?: RunnerHeartbeatBody["runningCount"];
    readonly heldSandboxStates?: RunnerHeartbeatBody["heldSandboxStates"];
    readonly heldWorkspaceStates?: RunnerHeartbeatBody["heldWorkspaceStates"];
    readonly mode?: RunnerHeartbeatBody["mode"];
  } = {},
): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId ?? randomUUID(),
    group: args.group ?? "vm0/test",
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: args.snapshotSequence ?? 1,
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: args.maxConcurrent ?? 2,
    allocatedVcpu: args.allocatedVcpu ?? 0,
    allocatedMemoryMb: args.allocatedMemoryMb ?? 0,
    runningCount: args.runningCount ?? 0,
    admittableProfiles: args.admittableProfiles ?? ["vm0/default"],
    heldSandboxStates: args.heldSandboxStates ?? [],
    heldWorkspaceStates: args.heldWorkspaceStates ?? [],
    mode: args.mode ?? "running",
  };
}

export function createRunsApi(
  context: TestContext,
  systemSkillStorageResolution?: SystemSkillStorageResolution,
) {
  const defaultRunnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 1,
  };
  const applyUserPermissionGrantRequestBody = (
    body: {
      readonly agentId: string;
      readonly connectorSlug: string;
    } & ApplyUserPermissionGrant,
  ): ApplyUserPermissionGrantsRequest => {
    const grant: ApplyUserPermissionGrant =
      body.action === "allow"
        ? {
            permission: body.permission,
            action: "allow",
            ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
          }
        : {
            permission: body.permission,
            action: "deny",
          };
    return {
      agentId: body.agentId,
      connectorSlug: body.connectorSlug,
      mode: "patch",
      grants: [grant],
    };
  };

  async function createDirectRunThroughService(
    actor: ApiTestUser | null,
    body: DirectRunRequest,
  ) {
    if (!actor?.orgId) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated",
            code: "UNAUTHORIZED" as const,
          },
        },
      };
    }
    return await createDirectRunFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      body,
      signal: context.signal,
    });
  }

  return {
    configureRunnerGroup(): string {
      const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
      return group;
    },

    acceptStorageDownloads(): void {
      context.mocks.s3.getSignedUrl.mockImplementation(
        (_client: unknown, command: unknown) => {
          return Promise.resolve(apiTestS3PresignedUrl(command));
        },
      );
    },

    acceptTelemetryIngest(): void {
      context.mocks.axiom.ingest.mockResolvedValue(true);
      context.mocks.axiom.query.mockResolvedValue([]);
    },

    // `periodEndUnix` moves the granted subscription period (and therefore
    // the credit expiry, period end + 1 month) — a far-past period end yields
    // an org whose entire credit balance is already expired.
    async grantProEntitlement(
      actor: ApiTestUser,
      options: {
        readonly customerId?: string;
        readonly subscriptionId?: string;
        readonly tier?: "pro" | "team";
        readonly periodEndUnix?: number;
        readonly subscriptionMetadata?: Record<string, string>;
        readonly cancelAtUnix?: number | null;
      } = {},
    ): Promise<{
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly invoiceId: string;
    }> {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv("OKOU_PRICE_PRO", "price_bdd_pro");
      mockEnv("OKOU_PRICE_TEAM", "price_bdd_team");
      mockEnv("ATOM_GRANT_PRICE", "price_bdd_atom_grant");
      mockEnv("OKOU_PRICE_CONCURRENCY", "price_bdd_concurrency");
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
      const tier = options.tier ?? "pro";

      const suffix = randomUUID().slice(0, 8);
      const customerId = options.customerId ?? `cus_bdd_${suffix}`;
      const subscriptionId = options.subscriptionId ?? `sub_bdd_${suffix}`;
      const invoiceId = `in_bdd_${suffix}`;
      const periodEndUnix =
        options.periodEndUnix ?? Math.floor(now() / 1000) + 30 * 86_400;
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: actor.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        status: "active",
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: options.cancelAtUnix ?? null,
        schedule: null,
        trial_end: null,
        metadata: options.subscriptionMetadata ?? {},
        items: {
          data: [
            {
              price: {
                id: tier === "team" ? "price_bdd_team" : "price_bdd_pro",
              },
            },
          ],
        },
      });
      if (tier === "team") {
        context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
      }
      const invoicePaidEvent = {
        type: "invoice.paid",
        data: {
          object: {
            id: invoiceId,
            customer: customerId,
            metadata: {},
            parent: { subscription_details: { subscription: subscriptionId } },
            lines: {
              has_more: false,
              data: [
                {
                  price: {
                    id: tier === "team" ? "price_bdd_team" : "price_bdd_pro",
                  },
                  parent: { type: "subscription_item_details" },
                  period: {
                    start: periodEndUnix - 30 * 86_400,
                    end: periodEndUnix,
                  },
                },
              ],
            },
          },
        },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
        invoicePaidEvent,
      );
      await accept(
        runApp(context)(webhookStripeContract).post({
          body: JSON.stringify(invoicePaidEvent),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );

      const billingStatus = await accept(
        runApp(context)(billingStatusContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (billingStatus.body.tier !== tier) {
        throw new Error(
          `Entitlement grant did not reach ${tier} tier: ${billingStatus.body.tier}`,
        );
      }

      // Bootstrap only after the paid entitlement exists. Onboarding status
      // then creates a default agent without granting limited-free credits or
      // replacing metadata on an existing default agent.
      const bdd = createBddApi(context);
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected paid onboarding to create a default agent");
      }
      const completed = await bdd.completeOnboarding(actor);
      if (completed.status !== 200) {
        throw new Error(
          `Expected paid onboarding completion, got ${completed.status}`,
        );
      }

      return { customerId, subscriptionId, invoiceId };
    },

    async createRun(actor: ApiTestUser, body: AgentRunRequest) {
      const response = await accept(
        runApp(
          context,
          undefined,
          systemSkillStorageResolution,
        )(runFixtureContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async claimRunnerJob(
      runId: string,
      body: RunnerJobClaimRequest = {},
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      const response = await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(true),
          ...(extraHeaders ? { extraHeaders } : {}),
          params: { id: runId },
          body: {
            runnerIdentity: defaultRunnerIdentity,
            capabilities: defaultClaimCapabilities(),
            ...body,
          },
        }),
        [200],
      );
      return response.body;
    },

    async reportRunnerModelProviderFailure(
      runId: string,
      body: RunnerModelProviderFailureRequest,
    ) {
      const response = await accept(
        runApp(context)(runnersModelProviderFailuresContract).report({
          headers: runnerHeaders(true),
          params: { runId },
          body,
        }),
        [200],
      );
      return response.body;
    },

    async startRunnerModelProviderFailureWithDelayedBody(
      runId: string,
      body: RunnerModelProviderFailureRequest,
    ) {
      const bodyRequested = createDeferredPromise<void>(context.signal);
      const bodyReleased = createDeferredPromise<void>(context.signal);
      const encodedBody = new TextEncoder().encode(JSON.stringify(body));
      const requestBody = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (!bodyRequested.settled()) {
              bodyRequested.resolve(undefined);
            }
            await bodyReleased.promise;
            controller.enqueue(encodedBody);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = setupRawAppRequestWithRoutes({
        context,
        routes: runRoutes,
      })(`/api/runners/runs/${runId}/model-provider-failures`, {
        method: "POST",
        headers: {
          authorization: OFFICIAL_RUNNER_AUTHORIZATION,
          "content-type": "application/json",
        },
        body: requestBody,
        duplex: "half",
      } as RequestInit & { readonly duplex: "half" });
      await bodyRequested.promise;
      return {
        releaseBody: () => {
          if (!bodyReleased.settled()) {
            bodyReleased.resolve(undefined);
          }
        },
        response,
      };
    },

    async requestRunnerModelProviderFailureAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
      body: RunnerModelProviderFailureRequest,
    ) {
      return await accept(
        runApp(context)(runnersModelProviderFailuresContract).report({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
          body,
        }),
        statuses,
      );
    },

    async requestRawRunnerModelProviderFailure(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
      body: unknown,
    ) {
      return await accept(
        runApp(context)(runnersModelProviderFailuresContract).report({
          headers: runnerHeaders(validAuth),
          params: { runId },
          body: body as RunnerModelProviderFailureRequest,
        }),
        statuses,
      );
    },

    async requestReserveRunnerActiveInputsAs<
      TStatus extends RunnerActiveInputDeliveryStatus,
    >(
      authorization: string | undefined,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersActiveInputsContract).reserve({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
          body: {},
        }),
        statuses,
      );
    },

    async reserveRunnerActiveInputs(sandboxToken: string, runId: string) {
      const response = await accept(
        runApp(context)(runnersActiveInputsContract).reserve({
          headers: { authorization: `Bearer ${sandboxToken}` },
          params: { runId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestRecordRunnerActiveInputDeliveryAs<
      TStatus extends RunnerActiveInputDeliveryStatus,
    >(
      authorization: string | undefined,
      runId: string,
      deliveryId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersActiveInputsContract).receipt({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId, deliveryId },
          body: {},
        }),
        statuses,
      );
    },

    async recordRunnerActiveInputDelivery(
      sandboxToken: string,
      runId: string,
      deliveryId: string,
    ) {
      const response = await accept(
        runApp(context)(runnersActiveInputsContract).receipt({
          headers: { authorization: `Bearer ${sandboxToken}` },
          params: { runId, deliveryId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestSyncConnectorRuntimeAs<
      TStatus extends RunnerConnectorRuntimeSyncStatus,
    >(
      authorization: string | undefined,
      runId: string,
      body: RunnerConnectorRuntimeSyncRequest,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersConnectorRuntimeSyncContract).sync({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
          body,
        }),
        statuses,
      );
    },

    async syncConnectorRuntime(
      runId: string,
      body: RunnerConnectorRuntimeSyncRequest,
    ) {
      const response = await accept(
        runApp(context)(runnersConnectorRuntimeSyncContract).sync({
          headers: runnerHeaders(true),
          params: { runId },
          body,
        }),
        [200],
      );
      return response.body.results;
    },

    async createCliToken(actor: ApiTestUser): Promise<{
      readonly token: string;
    }> {
      const device = await accept(
        runApp(context)(cliAuthDeviceContract).create({ body: {} }),
        [200],
      );
      await accept(
        runApp(context)(cliAuthApproveContract).approve({
          headers: authenticate(context, actor),
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      const token = await accept(
        runApp(context)(cliAuthTokenContract).exchange({
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      return { token: token.body.access_token };
    },

    async requestPollRunnerAs(
      authorization: string | undefined,
      body: RunnerPollBody,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJobAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: RunnerJobClaimRequest = {},
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: authorization === undefined ? {} : { authorization },
          ...(extraHeaders ? { extraHeaders } : {}),
          params: { id: runId },
          body: { capabilities: defaultClaimCapabilities(), ...body },
        }),
        statuses,
      );
    },

    async requestRawClaimRunnerJobAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: unknown,
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: authorization === undefined ? {} : { authorization },
          ...(extraHeaders ? { extraHeaders } : {}),
          params: { id: runId },
          body: body as RunnerJobClaimRequestBody,
        }),
        statuses,
      );
    },

    async requestRunnerRealtimeTokenAs(
      authorization: string | undefined,
      body: RunnerRealtimeTokenBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnerRealtimeTokenContract).create({
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
        statuses,
      );
    },

    /**
     * Signs a sandbox webhook token for an API-created run, so sandbox
     * report webhooks (heartbeat/complete/...) can act on runs that were
     * never claimed by a runner.
     */
    sandboxTokenForRun(actor: ApiTestUser, runId: string): string {
      if (!actor.orgId) {
        throw new Error("Sandbox run tokens require an org-scoped actor");
      }
      return generateSandboxToken(actor.userId, runId, actor.orgId);
    },

    /** Mints a route-test token without changing production capability issuance. */
    okouTokenForRunWithCapabilities(
      actor: ApiTestUser,
      runId: string,
      capabilities: readonly Capability[],
    ): string {
      if (!actor.orgId) {
        throw new Error("Agent run tokens require an org-scoped actor");
      }
      const seconds = Math.floor(now() / 1000);
      return signSandboxJwtForTests({
        scope: "okou",
        userId: actor.userId,
        orgId: actor.orgId,
        runId,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 3600,
      });
    },

    async createDirectAgent(
      actor: ApiTestUser,
      content: DirectAgentExecutionConfig,
    ): Promise<{ readonly agentId: string; readonly name: string }> {
      if (!actor.orgId) {
        throw new Error("Direct Agent fixtures require an org-scoped actor");
      }
      return await createDirectAgentExecutionFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        content,
        signal: context.signal,
      });
    },

    async createDirectRun(actor: ApiTestUser, body: DirectRunRequest) {
      const response = await accept(
        createDirectRunThroughService(actor, body),
        [201],
      );
      return response.body;
    },

    async requestDirectRun(
      actor: ApiTestUser | null,
      body: DirectRunRequest,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 429
        | 503
      )[],
    ) {
      return await accept(createDirectRunThroughService(actor, body), statuses);
    },

    async listAgentRuns(actor: ApiTestUser, query: RunsListQuery) {
      if (!actor.orgId) {
        throw new Error("Agent run list service requires an organization");
      }
      const result = await listAgentRunsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        status: query.status,
        agent: query.agent,
        since: query.since,
        until: query.until,
        limit: query.limit,
      });
      if (result.kind === "bad-request") {
        throw new Error(result.message);
      }
      return result.body;
    },

    async applyUserPermissionGrant(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
      } & ApplyUserPermissionGrant,
    ): Promise<UserPermissionGrantResponse> {
      const response = await accept(
        runApp(context)(userPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: applyUserPermissionGrantRequestBody(body),
        }),
        [200],
      );
      const grant = response.body[0];
      if (!grant) {
        throw new Error("User permission grant apply did not return a grant");
      }
      return grant;
    },

    async requestUserPermissionGrant(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
      } & ApplyUserPermissionGrant,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        runApp(context)(userPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: applyUserPermissionGrantRequestBody(body),
        }),
        statuses,
      );
    },

    async replaceUserPermissionGrants(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
        readonly grants: readonly ApplyUserPermissionGrant[];
      },
    ): Promise<readonly UserPermissionGrantResponse[]> {
      const response = await accept(
        runApp(context)(userPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            connectorSlug: body.connectorSlug,
            mode: "replace",
            grants: [...body.grants],
          },
        }),
        [200],
      );
      return response.body;
    },

    async listUserPermissionGrants(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly UserPermissionGrantResponse[]> {
      const response = await accept(
        runApp(context)(userPermissionGrantsContract).list({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body;
    },

    /**
     * Replaces the caller's enabled connector slugs for an agent through
     * PUT /api/agents/:id/user-connectors and returns the visible set.
     */
    async enableAgentConnectors(
      actor: ApiTestUser,
      agentId: string,
      connectorSlugs: readonly string[],
    ): Promise<readonly string[]> {
      const response = await accept(
        runApp(context)(userConnectorsContract).update({
          headers: authenticate(context, actor),
          params: { id: agentId },
          body: { enabledConnectorSlugs: [...connectorSlugs] },
        }),
        [200],
      );
      return response.body.enabledConnectorSlugs;
    },

    async listOrgModelProviders(
      actor: ApiTestUser,
    ): Promise<readonly ModelProviderResponse[]> {
      const response = await accept(
        runApp(context)(modelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body.modelProviders;
    },

    /**
     * Upserts an org-level model provider with an arbitrary contract body
     * (single secret or multi-auth secrets map) and returns the provider id.
     */
    async createOrgModelProvider(
      actor: ApiTestUser,
      body: OrgModelProviderUpsertRequest,
    ): Promise<{ readonly providerId: string }> {
      const response = await accept(
        runApp(context)(modelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body,
        }),
        [200, 201],
      );
      return { providerId: response.body.provider.id };
    },

    /**
     * Replaces the org model-first policies with the given request-shaped
     * list (the PUT is a wholesale replace of supported-run-model rows).
     */
    async updateOrgModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPolicyRequest["policies"],
    ): Promise<void> {
      const snapshot = await accept(
        runApp(context)(modelPoliciesMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      await accept(
        runApp(context)(modelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies, revision: snapshot.body.revision },
        }),
        [200],
      );
    },

    async ensureOrgModelProvider(
      actor: ApiTestUser,
    ): Promise<{ readonly providerId: string }> {
      const providerResponse = await accept(
        runApp(context)(modelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body: {
            type: "anthropic-api-key",
            secret: "test-anthropic-key",
          },
        }),
        [200, 201],
      );

      const providerId = providerResponse.body.provider.id;
      const policies: OrgModelPolicyRequest["policies"] = [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ];

      const snapshot = await accept(
        runApp(context)(modelPoliciesMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      await accept(
        runApp(context)(modelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies, revision: snapshot.body.revision },
        }),
        [200],
      );

      return { providerId };
    },

    async readBillingStatus(actor: ApiTestUser) {
      const response = await accept(
        runApp(context)(billingStatusContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateRun(
      actor: ApiTestUser | null,
      body: AgentRunRequest,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 429
        | 503
      )[],
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runFixtureContract).create({
          headers: {
            ...authenticate(context, actor),
            ...extraHeaders,
          },
          body,
        }),
        statuses,
      );
    },

    async requestCreateRunUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 429
        | 503
      )[],
    ) {
      return await accept(
        runApp(context)(runFixtureContract).create({
          headers: authenticate(context, actor),
          body: body as AgentRunRequest,
        }),
        statuses,
      );
    },

    async readRun(actor: ApiTestUser, runId: string) {
      const response = await accept(
        runApp(context)(runsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadRun(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(runsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestRunContext(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(runContextContract).getContext({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestRunRunner(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(runRunnerContract).getRunner({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async readRunQueue(actor: ApiTestUser) {
      return await accept(
        runApp(context)(runsQueueContract).getQueue({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async requestReadRunQueue(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        runApp(context)(runsQueueContract).getQueue({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestCancelRun(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
      usagePricingResolution?: UsagePricingResolution,
    ) {
      return await accept(
        runApp(
          context,
          usagePricingResolution,
        )(runsCancelContract).cancel({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestCancelRunAs(
      authorization: string,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(runsCancelContract).cancel({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestCancelRunWithSignal(
      actor: ApiTestUser,
      runId: string,
      signal: AbortSignal,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createAppWithRoutes({
        signal,
        routes: runRoutes,
      });
      const response = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },

    async heartbeatRunner(group?: string) {
      // Claim setup must not let a feature-specific mocked clock prune runner
      // rows owned by parallel files in the shared test database.
      return await withNowScopeForTest(async () => {
        return await accept(
          runApp(context)(runnersHeartbeatContract).heartbeat({
            headers: runnerHeaders(true),
            body: runnerHeartbeatBody({ group }),
          }),
          [200],
        );
      });
    },

    async requestHeartbeatRunner(
      validAuth: boolean,
      statuses: readonly (200 | 400 | 401 | 500)[],
      args: {
        readonly runnerId?: string;
        readonly group?: string;
        readonly snapshotGeneration?: RunnerHeartbeatBody["snapshotGeneration"];
        readonly snapshotSequence?: RunnerHeartbeatBody["snapshotSequence"];
        readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
        readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
        readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
        readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
        readonly runningCount?: RunnerHeartbeatBody["runningCount"];
        readonly heldSandboxStates?: RunnerHeartbeatBody["heldSandboxStates"];
        readonly heldWorkspaceStates?: RunnerHeartbeatBody["heldWorkspaceStates"];
        readonly mode?: RunnerHeartbeatBody["mode"];
      } = {},
    ) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: runnerHeartbeatBody(args),
        }),
        statuses,
      );
    },

    async requestRawHeartbeatRunner(
      validAuth: boolean,
      statuses: readonly (200 | 400 | 401 | 500)[],
      body: unknown,
    ) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: body as RunnerHeartbeatBody,
        }),
        statuses,
      );
    },

    async pollRunner(group?: string) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(true),
          body: {
            group: group ?? "vm0/test",
            supportedProfiles: ["vm0/default"],
          },
        }),
        [200],
      );
    },

    async requestPollRunner(
      validAuth: boolean,
      body: RunnerPollBody,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    async requestRawPollRunner(
      validAuth: boolean,
      body: unknown,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          body: body as RunnerPollBody,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJob(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: RunnerJobClaimRequest = {},
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          ...(extraHeaders ? { extraHeaders } : {}),
          params: { id: runId },
          body: {
            runnerIdentity: defaultRunnerIdentity,
            capabilities: defaultClaimCapabilities(),
            ...body,
          },
        }),
        statuses,
      );
    },

    async requestRawClaimRunnerJob(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: unknown,
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          ...(extraHeaders ? { extraHeaders } : {}),
          params: { id: runId },
          body: body as RunnerJobClaimRequestBody,
        }),
        statuses,
      );
    },

    async requestRunnerRealtimeToken(
      validAuth: boolean,
      body: RunnerRealtimeTokenBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnerRealtimeTokenContract).create({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    // Valid cron coverage belongs in the file that owns each global sweep.
    // This helper only checks auth rejection, so route handlers never scan the
    // shared test database.
    async requestSharedCronRoutesWithoutAuth() {
      const headers: AuthHeaders = {};
      const processUsageEvents = await accept(
        runApp(context)(cronProcessUsageEventsContract).process({
          headers,
        }),
        [401],
      );
      const telegramCleanup = await accept(
        runApp(context)(cronTelegramCleanupContract).cleanup({
          headers,
        }),
        [401],
      );

      return {
        processUsageEvents,
        telegramCleanup,
      };
    },

    async reconcileBillingOrganizations(orgIds: readonly string[]) {
      const client = setupAppWithRoutes({
        context,
        routes: testBillingReconciliationStateRoutes,
      })(testBillingReconciliationStateContract);
      return await accept(
        client.reconcile({
          body: { orgIds: [...orgIds] },
        }),
        [200],
      );
    },
  };
}
