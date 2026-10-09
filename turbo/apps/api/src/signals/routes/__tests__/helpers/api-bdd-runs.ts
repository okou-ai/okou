import { randomUUID } from "node:crypto";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { mockClaudeCodeTokenEndpoint } from "./api-bdd-auth-device";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { mockClerkUsers } from "./clerk-users";

import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import {
  cronProcessUsageEventsContract,
  cronTelegramCleanupContract,
} from "@okouai/api-contracts/contracts/cron";
import type { UpsertModelProviderRequest } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  runContextContract,
  runRunnerContract,
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersCancellationContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  runnersSteerContract,
  type CanonicalStorageManifest,
  type StorageManifest,
} from "@okouai/api-contracts/contracts/runners";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrant,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import type StripeSDK from "stripe";
import type { z } from "zod";

import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now, withNowScopeForTest } from "../../../../lib/time";
import {
  generateSandboxToken,
  signSandboxJwtForTests,
} from "../../../auth/tokens";
import type { SystemSkillStorageResolution } from "../../../context/system-skill-storage-resolution";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import { mockStripeClient } from "../../../external/stripe-client";
import { agentsRoutes } from "../../agents";
import { billingStatusRoutes } from "../../billing-status";
import { billingUsagePackCreditsRoutes } from "../../billing-usage-pack-credits";
import { cliAuthRoutes } from "../../cli-auth";
import { cronProcessUsageEventsRoutes } from "../../cron-process-usage-events";
import { cronTelegramCleanupRoutes } from "../../cron-telegram-cleanup";
import { meModelProvidersUpsertRoutes } from "../../me-model-providers-upsert";
import { runDetailRoutes } from "../../run-detail";
import { runModelsRoutes } from "../../run-models";
import { runnerCancellationRoutes } from "../../runner-cancellation";
import { runnersRoutes } from "../../runners";
import { runsRoutes } from "../../runs";
import { runsCancelRoutes } from "../../runs-cancel";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import { userPermissionGrantsRoutes } from "../../user-permission-grants";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

type AuthHeaders = { readonly authorization?: string };
type RunnerJobClaimRequestBody = z.infer<
  (typeof runnersJobClaimContract.claim)["body"]
>;
/** Test claims advertise every current Pi model-config generation unless a scenario narrows them. */
function defaultClaimCapabilities(): RunnerJobClaimRequestBody["capabilities"] {
  return { piModelConfigGenerations: [1, 2, 3, 5] };
}
type RunnerJobClaimRequest = Omit<RunnerJobClaimRequestBody, "capabilities"> & {
  readonly capabilities?: RunnerJobClaimRequestBody["capabilities"];
};
type RunnerConnectorRuntimeSyncRequest = z.input<
  (typeof runnersConnectorRuntimeSyncContract.sync)["body"]
>;
type RunnerConnectorRuntimeSyncStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
type RunnerNextSteerableInputStatus = 200 | 400 | 401 | 403 | 500;
type RunnerSteeredInputStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
export type RunModel = z.infer<
  (typeof runModelsMainContract.list)["responses"][200]
>["models"][number]["model"];
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
  ...billingUsagePackCreditsRoutes,
  ...runModelsRoutes,
  ...meModelProvidersUpsertRoutes,
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...agentsRoutes,
  ...userPermissionGrantsRoutes,
  ...userModelPreferenceRoutes,
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
  mockClerkUsers(context, [clerkUserProfile(nextActor)]);
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
    readonly heldHomeStates?: RunnerHeartbeatBody["heldHomeStates"];
    readonly homeAffinityVersion?: RunnerHeartbeatBody["homeAffinityVersion"];
    readonly activeReuseProducers?: RunnerHeartbeatBody["activeReuseProducers"];
    readonly wssIngressServiceActive?: boolean;
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
    heldHomeStates: args.heldHomeStates ?? [],
    ...(args.homeAffinityVersion === undefined
      ? {}
      : { homeAffinityVersion: args.homeAffinityVersion }),
    activeReuseProducers: args.activeReuseProducers ?? [],
    ...(args.wssIngressServiceActive === undefined
      ? {}
      : { wssIngressServiceActive: args.wssIngressServiceActive }),
    mode: args.mode ?? "running",
  };
}

export function createRunsApi(
  context: TestContext,
  systemSkillStorageResolution?: SystemSkillStorageResolution,
) {
  /**
   * A run started through the real Thread entrypoint: a chat send on a new
   * thread, picked once its enqueue-owned background work completes.
   */
  async function createThreadRun(
    actor: ApiTestUser,
    body: {
      readonly agentId: string;
      readonly prompt: string;
      /**
       * An explicit send model (null is Auto); omitted, the thread or member
       * selection applies.
       */
      readonly model?: string | null;
      /** Continue an existing thread, which resumes its Agent session. */
      readonly threadId?: string;
      /** Request staff-only network body capture for the run. */
      readonly captureNetworkBodies?: boolean;
    },
  ) {
    const chat = createChatFilesBddApi(context);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: body.agentId,
        prompt: body.prompt,
        clientEventId,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
        ...(body.captureNetworkBodies === undefined
          ? {}
          : { captureNetworkBodies: body.captureNetworkBodies }),
      },
      [201],
      systemSkillStorageResolution === undefined
        ? {}
        : { systemSkillStorageResolution },
    );
    if (sent.status !== 201) {
      throw new Error("Expected the Thread run send to be accepted");
    }
    let runId = sent.body.runId;
    if (runId === null) {
      await flushWaitUntilForTest();
      const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
      runId =
        events.find((event) => {
          return event.revokesEventId === clientEventId;
        })?.runId ?? null;
    }
    if (!runId) {
      throw new Error("Expected the Thread run send to launch a run");
    }
    const run = await accept(
      runApp(context)(runsByIdContract).getById({
        headers: authenticate(context, actor),
        params: { id: runId },
      }),
      [200],
    );
    return {
      runId,
      threadId: sent.body.threadId,
      status: run.body.status,
      createdAt: run.body.createdAt,
      ...(run.body.error === undefined ? {} : { error: run.body.error }),
    };
  }

  /**
   * A Thread send the background pick rejects: no run is created and the
   * thread records the rejection error on the revoked input.
   */
  async function readThreadRunRejection(
    actor: ApiTestUser,
    body: {
      readonly agentId: string;
      readonly prompt: string;
      /** Null selects Auto. */
      readonly model?: string | null;
      readonly captureNetworkBodies?: boolean;
    },
  ): Promise<string | undefined> {
    const chat = createChatFilesBddApi(context);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: body.agentId,
        prompt: body.prompt,
        clientEventId,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.captureNetworkBodies === undefined
          ? {}
          : { captureNetworkBodies: body.captureNetworkBodies }),
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId !== null) {
      throw new Error("Expected the Thread send to be queued without a run");
    }
    await flushWaitUntilForTest();
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
    const rejection = events.find((event) => {
      return event.revokesEventId === clientEventId;
    });
    if (!rejection || rejection.runId !== undefined) {
      throw new Error("Expected the Thread send to be rejected without a run");
    }
    return "error" in rejection ? rejection.error : undefined;
  }

  /**
   * A Thread send whose pick fails before creating a run: returns the pick's
   * error message and the error the thread records on the rejected input.
   */
  async function readThreadLaunchFailure(
    actor: ApiTestUser,
    body: {
      readonly agentId: string;
      readonly prompt: string;
      /** Null selects Auto. */
      readonly model?: string | null;
      readonly threadId?: string;
    },
  ): Promise<{
    readonly pickError: string;
    readonly inputError: string | undefined;
  }> {
    const chat = createChatFilesBddApi(context);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: body.agentId,
        prompt: body.prompt,
        clientEventId,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId !== null) {
      throw new Error("Expected the Thread send to be queued without a run");
    }
    const pickError = await flushWaitUntilForTest().then(
      () => {
        throw new Error("Expected the Thread pick to fail");
      },
      (error: unknown) => {
        return error instanceof Error ? error.message : String(error);
      },
    );
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
    const rejection = events.find((event) => {
      return event.revokesEventId === clientEventId;
    });
    if (!rejection || rejection.runId !== undefined) {
      throw new Error("Expected the failed pick to reject the input");
    }
    return {
      pickError,
      inputError: "error" in rejection ? rejection.error : undefined,
    };
  }

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

      // Stripe identities persist across files in the shared test database.
      const suffix = randomUUID();
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
          {
            cause: {
              orgId: actor.orgId,
              customerId,
              subscriptionId,
              invoiceId,
              billingStatus: billingStatus.body,
            },
          },
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

    /** Start an Agent run through the real Thread entrypoint (chat send + pick). */
    createThreadRun,
    readThreadRunRejection,
    readThreadLaunchFailure,

    async claimRunnerJob(
      runId: string,
      body: RunnerJobClaimRequest = {},
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      const response = await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(true),
          extraHeaders,
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

    async readRunnerCancellation(
      sandboxToken: string,
      runId: string,
      runnerGroup: string,
    ) {
      const response = await accept(
        setupAppWithRoutes({ context, routes: runnerCancellationRoutes })(
          runnersCancellationContract,
        ).get({
          headers: { authorization: `Bearer ${sandboxToken}` },
          params: { runId },
          query: { runnerGroup, ...defaultRunnerIdentity },
        }),
        [200],
      );
      return response.body;
    },

    async requestNextSteerableInputAs<
      TStatus extends RunnerNextSteerableInputStatus,
    >(
      authorization: string | undefined,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersSteerContract).next({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
        }),
        statuses,
      );
    },

    async nextSteerableInput(sandboxToken: string, runId: string) {
      const response = await accept(
        runApp(context)(runnersSteerContract).next({
          headers: { authorization: `Bearer ${sandboxToken}` },
          params: { runId },
        }),
        [200],
      );
      return response.body;
    },

    async requestDeclareSteeredInputAs<
      TStatus extends RunnerSteeredInputStatus,
    >(
      authorization: string | undefined,
      runId: string,
      eventId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersSteerContract).steered({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId, eventId },
          body: {},
        }),
        statuses,
      );
    },

    async declareSteeredInput(
      sandboxToken: string,
      runId: string,
      eventId: string,
    ) {
      const response = await accept(
        runApp(context)(runnersSteerContract).steered({
          headers: { authorization: `Bearer ${sandboxToken}` },
          params: { runId, eventId },
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
        runApp(context)(userBuiltinConnectorsContract).update({
          headers: authenticate(context, actor),
          params: { id: agentId },
          body: { enabledConnectorSlugs: [...connectorSlugs] },
        }),
        [200],
      );
      return response.body.enabledConnectorSlugs;
    },

    /** Stores the member's model preference, used when a run names no model. */
    async updateUserModelPreference(
      actor: ApiTestUser,
      selectedModel: RunModel,
    ): Promise<void> {
      await accept(
        runApp(context)(userModelPreferenceContract).update({
          headers: authenticate(context, actor),
          body: { selectedModel, serviceTier: null },
        }),
        [200],
      );
    },

    async listRunModels(actor: ApiTestUser) {
      const response = await accept(
        runApp(context)(runModelsMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async createPersonalModelProvider(
      actor: ApiTestUser,
      body: UpsertModelProviderRequest,
    ) {
      const response = await accept(
        runApp(context)(personalModelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body,
        }),
        [200, 201],
      );
      return { providerId: response.body.provider.id };
    },

    /** Native Runner prerequisites come from a connected personal subscription. */
    async ensurePersonalSubscriptionModel(
      actor: ApiTestUser,
      options: { readonly model?: RunModel } = {},
    ) {
      mockClaudeCodeTokenEndpoint();
      const { providerId } = await this.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "bdd-personal-claude-token",
      });
      await this.updateUserModelPreference(
        actor,
        options.model ?? "claude-fable-5-1",
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

    async readUsagePackCredits(actor: ApiTestUser) {
      const response = await accept(
        runApp(context)(billingUsagePackCreditsContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
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
        readonly heldHomeStates?: RunnerHeartbeatBody["heldHomeStates"];
        readonly homeAffinityVersion?: RunnerHeartbeatBody["homeAffinityVersion"];
        readonly activeReuseProducers?: RunnerHeartbeatBody["activeReuseProducers"];
        readonly wssIngressServiceActive?: boolean;
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

    async requestHeartbeatRunnerAs(
      authorization: string,
      statuses: readonly (200 | 400 | 401 | 500)[],
      args: Parameters<typeof runnerHeartbeatBody>[0] = {},
    ) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: { authorization },
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

    async pollRunner(
      group?: string,
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(true),
          ...(extraHeaders ? { extraHeaders } : {}),
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
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          ...(extraHeaders ? { extraHeaders } : {}),
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
  };
}
