import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { cliAuthApproveContract } from "@okouai/api-contracts/contracts/cli-auth";
import {
  computerUseCommandContract,
  computerUseSessionHostsContract,
  DIRECT_APP_STATE_CAPABILITY,
  runnerAppStateContract,
} from "@okouai/api-contracts/contracts/computer-use";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runContextContract,
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import {
  webhookCompleteContract,
  webhookStripeContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { cliAuthRoutes } from "../cli-auth";
import { computerUseRoutes } from "../computer-use";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runDetailRoutes } from "../run-detail";
import { runnerAppStateRoutes } from "../runner-app-state";
import { runnerSshRoutes } from "../runner-ssh";
import { runnerVncRoutes } from "../runner-vnc";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncProfiles,
  vncRunnerHeaders,
  vncSessionHeaders,
} from "./helpers/vnc-runtime";

interface RecordedRealtimePublication {
  readonly channel: string;
  readonly topic: unknown;
  readonly payload: unknown;
}

const NATIVE_CLAUDE_MODEL = "claude-fable-5-1";
const FNV1A_OFFSET_BASIS = 2_166_136_261;
const FNV1A_PRIME = 16_777_619;
const FNV1A_PRIME_INVERSE = 899_433_627;
// Hash matching STAFF_ORG_ID_HASHES so staffOptInOnly switches can be exercised
// on a fresh isolated org ID per test run without touching shared workspaces.
const STAFF_ORG_FNV1A_TARGET = 0xaf_ce_21_0e;
const HEX_DIGITS = "0123456789abcdef";
const DIRECT_APP_STATE_CAPABILITIES = Object.freeze([
  "apps.list",
  "app.state",
  DIRECT_APP_STATE_CAPABILITY,
]);

function fnv1aStep(seed: number, text: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function buildStaffOrgSuffixTable(): ReadonlyMap<number, string> {
  const table = new Map<number, string>();
  for (let a = 0; a < 16; a += 1) {
    const h1 =
      (Math.imul(STAFF_ORG_FNV1A_TARGET, FNV1A_PRIME_INVERSE) >>> 0) ^
      HEX_DIGITS.charCodeAt(a);
    for (let b = 0; b < 16; b += 1) {
      const h2 =
        (Math.imul(h1, FNV1A_PRIME_INVERSE) >>> 0) ^ HEX_DIGITS.charCodeAt(b);
      for (let c = 0; c < 16; c += 1) {
        const h3 =
          (Math.imul(h2, FNV1A_PRIME_INVERSE) >>> 0) ^ HEX_DIGITS.charCodeAt(c);
        for (let d = 0; d < 16; d += 1) {
          const h4 =
            (Math.imul(h3, FNV1A_PRIME_INVERSE) >>> 0) ^
            HEX_DIGITS.charCodeAt(d);
          table.set(
            h4,
            `${HEX_DIGITS[d]}${HEX_DIGITS[c]}${HEX_DIGITS[b]}${HEX_DIGITS[a]}`,
          );
        }
      }
    }
  }
  return table;
}

function solveUniqueStaffOrgId(table: ReadonlyMap<number, string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const prefix = `org_as_${randomUUID()}_`;
    const base = fnv1aStep(FNV1A_OFFSET_BASIS, prefix);
    for (let mid = 0; mid < 65_536; mid += 1) {
      const midHex = mid.toString(16).padStart(4, "0");
      const suffix = table.get(fnv1aStep(base, midHex));
      if (suffix !== undefined) {
        return `${prefix}${midHex}${suffix}`;
      }
    }
  }
  throw new Error("Failed to generate an isolated staff-hash organization ID");
}

function officialRunnerAuthHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

describe("Runner runtime operations", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const authDevice = createAuthDeviceApiActions(context);
  const computerUse = createComputerUseBddApi(context);
  const vncRuntime = createVncRuntimeApi(context);
  const routeMocks = createRouteMocks(context);
  const staffOrgSuffixTable = new Map<number, string>();
  const preparedStaffOrgIds: string[] = [];

  const chatEventsApi = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatRemoteAccessApi = setupAppWithRoutes({
    context,
    routes: chatRemoteAccessRoutes,
  })(chatRemoteAccessContract);
  const cliAuthApproveApi = setupAppWithRoutes({
    context,
    routes: cliAuthRoutes,
  })(cliAuthApproveContract);
  const computerUseCommandApi = setupAppWithRoutes({
    context,
    routes: computerUseRoutes,
  })(computerUseCommandContract);
  const computerUseSessionHostsApi = setupAppWithRoutes({
    context,
    routes: computerUseRoutes,
  })(computerUseSessionHostsContract);
  const featureSwitchesApi = setupAppWithRoutes({
    context,
    routes: featureSwitchesRoutes,
  })(featureSwitchesContract);
  const onboardingCompleteApi = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const personalModelProvidersApi = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const runContextApi = setupAppWithRoutes({
    context,
    routes: runDetailRoutes,
  })(runContextContract);
  const runnerAppStateApi = setupAppWithRoutes({
    context,
    routes: runnerAppStateRoutes,
  })(runnerAppStateContract);
  const runnerSshApi = setupAppWithRoutes({
    context,
    routes: runnerSshRoutes,
  })(runnerSshContract);
  const runnerVncApi = setupAppWithRoutes({
    context,
    routes: runnerVncRoutes,
  })(runnerVncContract);
  const runnersHeartbeatApi = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const runsByIdApi = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsCancelApi = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const sshConnectionsApi = setupAppWithRoutes({
    context,
    routes: sshConnectionsRoutes,
  })(sshConnectionsContract);
  const vncConnectionsApi = setupAppWithRoutes({
    context,
    routes: vncConnectionsRoutes,
  })(vncConnectionsContract);
  const webhookCompleteApi = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookStripeApi = setupAppWithRoutes({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const webhookTelemetryApi = setupAppWithRoutes({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);

  function recordedRealtimePublications(): readonly RecordedRealtimePublication[] {
    const gets = context.mocks.ably.channelGet.mock;
    const publishes = context.mocks.ably.publish.mock;
    return publishes.calls.map((call, index) => {
      const publishedAt = publishes.invocationCallOrder[index] ?? 0;
      let channel = "";
      for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
        if (order < publishedAt) {
          channel = String(gets.calls[getIndex]?.[0] ?? "");
        }
      }
      return { channel, topic: call[0], payload: call[1] };
    });
  }

  function clearRealtimePublications(): void {
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
  }

  function useAgentToken(token: string) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return { bearer: token } as const;
  }

  function nextUniqueStaffOrgId(): string {
    return (
      preparedStaffOrgIds.pop() ?? solveUniqueStaffOrgId(staffOrgSuffixTable)
    );
  }

  function sessionHeadersFor(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return vncSessionHeaders;
  }

  async function grantProTierViaStripeWebhook(orgId: string): Promise<void> {
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
    const priceId = env("OKOU_PRICE_PRO")?.[0];
    if (!priceId) {
      throw new Error("Expected a configured Pro subscription price");
    }
    const suffix = randomUUID();
    const customerId = `cus_bdd_${suffix}`;
    const subscriptionId = `sub_bdd_${suffix}`;
    const invoiceId = `in_bdd_${suffix}`;
    const periodEndUnix = Math.floor(now() / 1000) + 30 * 86_400;
    const customer = {
      id: customerId,
      object: "customer",
      metadata: { orgId },
    };
    const subscription = {
      id: subscriptionId,
      object: "subscription",
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        object: "list",
        has_more: false,
        url: `/v1/subscription_items?subscription=${subscriptionId}`,
        data: [
          {
            id: `si_bdd_${suffix}`,
            object: "subscription_item",
            price: { id: priceId, object: "price" },
            current_period_start: periodEndUnix - 30 * 86_400,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    const invoicePaidEvent = {
      id: `evt_bdd_${suffix}`,
      object: "event",
      created: Math.floor(now() / 1000),
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          customer: customerId,
          metadata: {},
          parent: { subscription_details: { subscription: subscriptionId } },
          lines: {
            has_more: false,
            data: [
              {
                price: { id: priceId },
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
    context.mocks.stripe.customers.retrieve.mockResolvedValue(customer);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      invoicePaidEvent,
    );
    await accept(
      webhookStripeApi.post({
        body: JSON.stringify(invoicePaidEvent),
        extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
      }),
      [200],
    );
  }

  function registerRunCleanup(
    actor: ApiTestUser,
    runId: string,
    sandboxToken: string,
  ): void {
    onTestFinished(async () => {
      useSecretKmsProbe();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await accept(
        runsCancelApi.cancel({
          headers: sessionHeadersFor(actor),
          params: { id: runId },
        }),
        [200, 400, 404],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: { authorization: `Bearer ${sandboxToken}` },
          body: {
            runId,
            exitCode: 137,
            error: "Run cancelled by test cleanup",
          },
        }),
        [200, 400, 404],
      );
      await flushWaitUntilForTest();
    });
  }

  beforeAll(async () => {
    for (const [key, value] of buildStaffOrgSuffixTable()) {
      staffOrgSuffixTable.set(key, value);
    }
    preparedStaffOrgIds.push(solveUniqueStaffOrgId(staffOrgSuffixTable));
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    await Promise.all([
      accept(
        webhookCompleteApi.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        webhookTelemetryApi.send({
          headers: {},
          body: {
            sandboxOperations: [
              {
                ts: "2026-01-01T00:00:00.000Z",
                action_type: "runner_home_image_removal",
                duration_ms: 1,
                success: true,
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        cliAuthApproveApi.approve({
          headers: {},
          body: { device_code: "warmup-device-code" },
        }),
        [401],
      ),
      accept(
        chatEventsApi.send({
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
        chatRemoteAccessApi.updateHostDefault({
          headers: {},
          params: { protocol: "vnc", connectionId: warmupId },
          body: { enabled: true },
        }),
        [401],
      ),
      accept(
        chatRemoteAccessApi.setThreadOverride({
          headers: {},
          params: {
            threadId: warmupId,
            protocol: "vnc",
            connectionId: warmupId,
          },
          body: { enabled: false },
        }),
        [401],
      ),
      accept(
        chatRemoteAccessApi.clearThreadOverride({
          headers: {},
          params: {
            threadId: warmupId,
            protocol: "vnc",
            connectionId: warmupId,
          },
        }),
        [401],
      ),
      accept(
        computerUseCommandApi.create({
          headers: {},
          body: { kind: "apps.list", timeoutMs: 60_000 },
        }),
        [401],
      ),
      accept(
        computerUseCommandApi.get({
          headers: {},
          params: { commandId: warmupId },
        }),
        [401],
      ),
      accept(
        computerUseSessionHostsApi.register({
          headers: {},
          body: {
            installationId: warmupId,
            hostName: "Warmup Desktop",
            appVersion: "0.54.0",
            osVersion: "macOS 15",
            supportedCapabilities: ["apps.list", "app.state"],
            permissions: { accessibility: true, screenRecording: true },
          },
        }),
        [401],
      ),
      accept(
        computerUseSessionHostsApi.next({
          headers: {},
          params: { hostId: warmupId },
          body: {
            connectionGeneration: 1,
            supportedCapabilities: ["apps.list", "app.state"],
          },
        }),
        [401],
      ),
      accept(
        computerUseSessionHostsApi.complete({
          headers: {},
          params: { hostId: warmupId, commandId: warmupId },
          body: {
            connectionGeneration: 1,
            status: "succeeded",
            result: { apps: [] },
          },
        }),
        [401],
      ),
      accept(
        computerUseSessionHostsApi.stop({
          headers: {},
          params: { hostId: warmupId },
          body: { connectionGeneration: 1 },
        }),
        [401],
      ),
      accept(
        featureSwitchesApi.update({
          headers: {},
          body: {
            switches: {
              [FeatureSwitchKey.ComputerUseAppStateDirectTransfer]: true,
            },
          },
        }),
        [401],
      ),
      accept(
        onboardingCompleteApi.complete({
          headers: {},
          body: {},
        }),
        [401],
      ),
      accept(
        personalModelProvidersApi.upsert({
          headers: {},
          body: {
            type: "claude-code-oauth-token",
            secret: "warmup-secret",
          },
        }),
        [401],
      ),
      accept(
        runContextApi.getContext({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runnerAppStateApi.check({
          headers: {},
          params: { runId: warmupId, commandId: warmupId },
          body: { runnerId: warmupId, heartbeatGeneration: 1 },
        }),
        [401],
      ),
      accept(
        runnerSshApi.resolve({
          headers: {},
          params: { runId: warmupId },
          body: {
            connectionId: warmupId,
            runnerIdentity: { runnerId: warmupId, heartbeatGeneration: 1 },
          },
        }),
        [401],
      ),
      accept(
        runnerVncApi.resolve({
          headers: {},
          params: { runId: warmupId },
          body: {
            connectionId: warmupId,
            runnerIdentity: { runnerId: warmupId, heartbeatGeneration: 1 },
            supportedProfiles: [...vncProfiles],
          },
        }),
        [401],
      ),
      accept(
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: warmupId,
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 1,
            totalMemoryMb: 1024,
            maxConcurrent: 1,
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
        runsByIdApi.getById({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runsCancelApi.cancel({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        sshConnectionsApi.create({
          headers: {},
          body: {
            id: warmupId,
            displayName: "Warmup Bastion",
            host: "bastion.example.com",
            credential: inlineSshKey("ops", "warmup-key"),
          },
        }),
        [401],
      ),
      accept(
        vncConnectionsApi.create({
          headers: {},
          body: vncConnectionBody(warmupId),
        }),
        [401],
      ),
    ]);
  });

  describe("Runner sandbox operations without a Run", () => {
    it("runner-home-operations-001 accepts GC from a real user Runner token and rejects unowned Run correlation", async () => {
      const user = bdd.user();
      const device = await authDevice.startCliDevice();
      const approved = await authDevice.requestCliApproval(
        user,
        { device_code: device.device_code },
        [200],
      );
      expect(approved.status).toBe(200);

      const exchanged = await authDevice.requestCliToken(
        device.device_code,
        [200],
      );
      if (!("access_token" in exchanged.body)) {
        throw new Error("Expected CLI OAuth access token");
      }
      const cliAuthHeaders = {
        authorization: `Bearer ${exchanged.body.access_token}`,
      };
      const operationTime = nowDate().toISOString();

      const runlessGc = await accept(
        webhookTelemetryApi.send({
          headers: cliAuthHeaders,
          body: {
            runnerHostname: "runner-user-home-gc.okou.app",
            runnerVersion: "1.0.0",
            sandboxOperations: [
              {
                ts: operationTime,
                action_type: "runner_home_image_removal",
                duration_ms: 18,
                success: true,
                outcome: "removed",
                reason: "gc",
              },
            ],
          },
        }),
        [200],
      );
      expect(runlessGc.body).toStrictEqual({ success: true });

      const unownedRunGc = await accept(
        webhookTelemetryApi.send({
          headers: cliAuthHeaders,
          body: {
            runnerHostname: "runner-user-home-gc.okou.app",
            runnerVersion: "1.0.0",
            sandboxOperations: [
              {
                ts: operationTime,
                action_type: "runner_home_image_removal",
                duration_ms: 18,
                success: true,
                outcome: "removed",
                reason: "gc",
                run_id: randomUUID(),
              },
            ],
          },
        }),
        [401],
      );
      expect(unownedRunGc.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Protocol-specific remote runtime invalidation", () => {
    function sendAutoPrompt(actor: ApiTestUser, prompt: string) {
      return accept(
        chatEventsApi.send({
          headers: sessionHeadersFor(actor),
          body: {
            prompt,
            model: null,
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          },
        }),
        [201],
      );
    }

    async function resolveRemoteProtocols(args: {
      readonly runId: string;
      readonly vncConnectionId: string;
      readonly sshConnectionId: string;
      readonly runnerIdentity: {
        readonly runnerId: string;
        readonly heartbeatGeneration: number;
      };
    }) {
      const [vnc, ssh] = await Promise.all([
        accept(
          runnerVncApi.resolve({
            headers: vncRunnerHeaders,
            params: { runId: args.runId },
            body: {
              connectionId: args.vncConnectionId,
              runnerIdentity: args.runnerIdentity,
              supportedProfiles: [...vncProfiles],
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: vncRunnerHeaders,
            params: { runId: args.runId },
            body: {
              connectionId: args.sshConnectionId,
              runnerIdentity: args.runnerIdentity,
            },
          }),
          [200],
        ),
      ]);
      return { vnc: vnc.body.outcome, ssh: ssh.body.outcome };
    }

    function expectVncInvalidationPublications(args: {
      readonly owner: { readonly userId: string; readonly orgId: string };
      readonly runnerGroup: string;
      readonly vncConnectionId: string;
      readonly expectedRunIds: readonly string[];
    }) {
      const published = recordedRealtimePublications();
      const ownerChangeSignals = published.filter((entry) => {
        return (
          entry.channel === `user:${args.owner.userId}` &&
          entry.topic === "ssh:changed"
        );
      });
      expect(ownerChangeSignals).toContainEqual({
        channel: `user:${args.owner.userId}`,
        topic: "ssh:changed",
        payload: { orgId: args.owner.orgId },
      });

      const vncInvalidations = published
        .filter((entry) => {
          return entry.topic === "vnc-authority-invalidated";
        })
        .map((entry) => {
          return { channel: entry.channel, payload: entry.payload };
        });
      const expectedInvalidations = [...args.expectedRunIds]
        .sort()
        .map((runId) => {
          return {
            channel: `runner-group:${args.runnerGroup}`,
            payload: { runId, connectionId: args.vncConnectionId },
          };
        });
      const actualSorted = [...vncInvalidations].sort((left, right) => {
        const leftId =
          typeof left.payload === "object" &&
          left.payload !== null &&
          "runId" in left.payload
            ? String(left.payload.runId)
            : "";
        const rightId =
          typeof right.payload === "object" &&
          right.payload !== null &&
          "runId" in right.payload
            ? String(right.payload.runId)
            : "";
        return leftId.localeCompare(rightId);
      });
      expect(actualSorted).toStrictEqual(expectedInvalidations);

      const sshInvalidations = published.filter((entry) => {
        return entry.topic === "ssh-authority-invalidated";
      });
      expect(sshInvalidations).toStrictEqual([]);
    }

    it(
      "remote-runtime-invalidation-001 (1/2) isolates VNC invalidation and protocol access from same-workspace peer and cross-workspace owner Runs",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        initializeVncRuntimeTest();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();

        const ownerActor = bdd.user({ orgRole: "org:admin" });
        if (!ownerActor.orgId) {
          throw new Error("Expected an owner organization");
        }
        const owner = { orgId: ownerActor.orgId, userId: ownerActor.userId };
        const peerActor = bdd.user({
          orgId: owner.orgId,
          orgRole: "org:member",
        });
        const otherOrgActor = bdd.user({
          userId: owner.userId,
          orgRole: "org:admin",
        });
        if (!otherOrgActor.orgId) {
          throw new Error("Expected a second organization for the owner");
        }

        const runnerIdentity = {
          runnerId: randomUUID(),
          heartbeatGeneration: 5_000_000_000,
        };
        const [runnerGroup] = await Promise.all([
          runs.configureRunnerGroup({
            maxConcurrent: 3,
            runnerIdentity,
            heartbeatAuthorization: vncRunnerHeaders.authorization,
          }),
          grantProTierViaStripeWebhook(owner.orgId),
          deliverOrganizationCreated(context, otherOrgActor),
        ]);

        mockClerkUsers(context, [
          {
            id: ownerActor.userId,
            emailAddresses: [
              {
                id: `email_${ownerActor.userId}`,
                emailAddress: ownerActor.email,
              },
            ],
            primaryEmailAddressId: `email_${ownerActor.userId}`,
            firstName: "BDD",
            lastName: "Owner",
          },
          {
            id: peerActor.userId,
            emailAddresses: [
              {
                id: `email_${peerActor.userId}`,
                emailAddress: peerActor.email,
              },
            ],
            primaryEmailAddressId: `email_${peerActor.userId}`,
            firstName: "BDD",
            lastName: "Peer",
          },
        ]);

        vncRuntime.authenticate(owner);
        const vncConnectionId = randomUUID();
        const sshConnectionId = randomUUID();
        const [createdVnc, createdSsh, ownerSend] = await Promise.all([
          accept(
            vncConnectionsApi.create({
              headers: vncSessionHeaders,
              body: vncConnectionBody(vncConnectionId),
            }),
            [201],
          ),
          accept(
            sshConnectionsApi.create({
              headers: vncSessionHeaders,
              body: {
                id: sshConnectionId,
                displayName: "Primary Bastion",
                host: "bastion.example.com",
                credential: inlineSshKey("ops", `key-${randomUUID()}`),
              },
            }),
            [201],
          ),
          sendAutoPrompt(ownerActor, "Owner thread with remote hosts"),
        ]);
        expect(createdVnc.body.id).toBe(vncConnectionId);
        expect(createdSsh.body.id).toBe(sshConnectionId);

        await accept(
          chatRemoteAccessApi.updateHostDefault({
            headers: vncSessionHeaders,
            params: { protocol: "ssh", connectionId: sshConnectionId },
            body: { enabled: true },
          }),
          [200],
        );

        const peerSend = await sendAutoPrompt(
          peerActor,
          "Peer thread in the same workspace",
        );
        const otherOrgSend = await sendAutoPrompt(
          otherOrgActor,
          "Owner thread in another workspace",
        );
        await flushWaitUntilForTest();

        const dispatches = runs.receivedDispatches(runnerGroup);
        async function requireRunForThread(
          threadId: string,
          actor: ApiTestUser,
        ) {
          const dispatch = dispatches.find((entry) => {
            return (
              entry.executionContext.platformEnvironment.OKOU_CHAT_THREAD_ID ===
              threadId
            );
          });
          if (!dispatch) {
            const threadEvents = await chat.listThreadEvents(actor, threadId);
            throw new Error(
              `Expected active dispatched Run for ${threadId}: ${JSON.stringify(threadEvents.events)}`,
            );
          }
          return {
            actor,
            runId: dispatch.executionContext.runId,
            sandboxToken: dispatch.executionContext.sandboxToken,
            threadId,
            runnerIdentity: {
              runnerId: dispatch.runnerId,
              heartbeatGeneration: dispatch.heartbeatGeneration,
            },
          };
        }

        const ownerRun = await requireRunForThread(
          ownerSend.body.threadId,
          ownerActor,
        );
        const peerRun = await requireRunForThread(
          peerSend.body.threadId,
          peerActor,
        );
        const otherOrgRun = await requireRunForThread(
          otherOrgSend.body.threadId,
          otherOrgActor,
        );
        const allRuns = [ownerRun, peerRun, otherOrgRun] as const;

        onTestFinished(async () => {
          useSecretKmsProbe();
          context.mocks.ably.publish.mockResolvedValue(undefined);
          await accept(
            runsCancelApi.cancel({
              headers: sessionHeadersFor(ownerActor),
              params: { id: ownerRun.runId },
            }),
            [200, 400, 404],
          );
          await accept(
            runsCancelApi.cancel({
              headers: sessionHeadersFor(peerActor),
              params: { id: peerRun.runId },
            }),
            [200, 400, 404],
          );
          await accept(
            runsCancelApi.cancel({
              headers: sessionHeadersFor(otherOrgActor),
              params: { id: otherOrgRun.runId },
            }),
            [200, 400, 404],
          );
          await Promise.all(
            allRuns.map((target) => {
              return accept(
                webhookCompleteApi.complete({
                  headers: { authorization: `Bearer ${target.sandboxToken}` },
                  body: {
                    runId: target.runId,
                    exitCode: 137,
                    error: "Run cancelled by test cleanup",
                  },
                }),
                [200, 400, 404],
              );
            }),
          );
          await flushWaitUntilForTest();
        });

        const resolveAll = () => {
          return Promise.all(
            allRuns.map((target) => {
              return resolveRemoteProtocols({
                ...target,
                vncConnectionId,
                sshConnectionId,
              });
            }),
          );
        };

        // Enable VNC default -> only owner's Run resolves VNC and receives invalidation.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.updateHostDefault({
            headers: vncSessionHeaders,
            params: { protocol: "vnc", connectionId: vncConnectionId },
            body: { enabled: true },
          }),
          [200],
        );
        const [, afterDefaultOn] = await Promise.all([
          flushWaitUntilForTest(),
          resolveAll(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun.runId],
        });
        expect(afterDefaultOn).toStrictEqual([
          { vnc: "resolved_transport", ssh: "resolved" },
          { vnc: "unavailable", ssh: "unavailable" },
          { vnc: "unavailable", ssh: "unavailable" },
        ]);

        // Disable VNC default -> only owner's Run is invalidated; peer & cross-org stay unaffected.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.updateHostDefault({
            headers: vncSessionHeaders,
            params: { protocol: "vnc", connectionId: vncConnectionId },
            body: { enabled: false },
          }),
          [200],
        );
        const [, afterDefaultOff] = await Promise.all([
          flushWaitUntilForTest(),
          resolveAll(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun.runId],
        });
        expect(afterDefaultOff).toStrictEqual([
          { vnc: "unavailable", ssh: "resolved" },
          { vnc: "unavailable", ssh: "unavailable" },
          { vnc: "unavailable", ssh: "unavailable" },
        ]);

        // All three Runs remain running when read by their authorized members.
        const ownerStatus = await accept(
          runsByIdApi.getById({
            headers: sessionHeadersFor(ownerActor),
            params: { id: ownerRun.runId },
          }),
          [200],
        );
        const peerStatus = await accept(
          runsByIdApi.getById({
            headers: sessionHeadersFor(peerActor),
            params: { id: peerRun.runId },
          }),
          [200],
        );
        const otherOrgStatus = await accept(
          runsByIdApi.getById({
            headers: sessionHeadersFor(otherOrgActor),
            params: { id: otherOrgRun.runId },
          }),
          [200],
        );
        expect([
          ownerStatus.body.status,
          peerStatus.body.status,
          otherOrgStatus.body.status,
        ]).toStrictEqual(["running", "running", "running"]);
      },
    );

    it(
      "remote-runtime-invalidation-001 (2/2) isolates VNC defaults and thread overrides across two owner Runs while SSH stays authorized",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        initializeVncRuntimeTest();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();

        const ownerActor = bdd.user({ orgRole: "org:admin" });
        if (!ownerActor.orgId) {
          throw new Error("Expected an owner organization");
        }
        const owner = { orgId: ownerActor.orgId, userId: ownerActor.userId };
        const runnerIdentity = {
          runnerId: randomUUID(),
          heartbeatGeneration: 5_000_000_000,
        };
        const [runnerGroup] = await Promise.all([
          runs.configureRunnerGroup({
            maxConcurrent: 2,
            runnerIdentity,
            heartbeatAuthorization: vncRunnerHeaders.authorization,
          }),
          deliverOrganizationCreated(context, ownerActor),
        ]);

        vncRuntime.authenticate(owner);
        const vncConnectionId = randomUUID();
        const sshConnectionId = randomUUID();
        const [createdVnc, createdSsh, ownerSend1, ownerSend2] =
          await Promise.all([
            accept(
              vncConnectionsApi.create({
                headers: vncSessionHeaders,
                body: vncConnectionBody(vncConnectionId),
              }),
              [201],
            ),
            accept(
              sshConnectionsApi.create({
                headers: vncSessionHeaders,
                body: {
                  id: sshConnectionId,
                  displayName: "Primary Bastion",
                  host: "bastion.example.com",
                  credential: inlineSshKey("ops", `key-${randomUUID()}`),
                },
              }),
              [201],
            ),
            sendAutoPrompt(ownerActor, "First owner thread with remote hosts"),
            sendAutoPrompt(ownerActor, "Second owner thread with remote hosts"),
          ]);
        expect(createdVnc.body.id).toBe(vncConnectionId);
        expect(createdSsh.body.id).toBe(sshConnectionId);

        await Promise.all([
          accept(
            chatRemoteAccessApi.updateHostDefault({
              headers: vncSessionHeaders,
              params: { protocol: "ssh", connectionId: sshConnectionId },
              body: { enabled: true },
            }),
            [200],
          ),
          flushWaitUntilForTest(),
        ]);

        const dispatches = runs.receivedDispatches(runnerGroup);
        function requireRun(threadId: string) {
          const dispatch = dispatches.find((entry) => {
            return (
              entry.executionContext.platformEnvironment.OKOU_CHAT_THREAD_ID ===
              threadId
            );
          });
          if (!dispatch) {
            throw new Error(`Expected active dispatched Run for ${threadId}`);
          }
          return {
            runId: dispatch.executionContext.runId,
            sandboxToken: dispatch.executionContext.sandboxToken,
            threadId,
            runnerIdentity: {
              runnerId: dispatch.runnerId,
              heartbeatGeneration: dispatch.heartbeatGeneration,
            },
          };
        }

        const ownerRun1 = requireRun(ownerSend1.body.threadId);
        const ownerRun2 = requireRun(ownerSend2.body.threadId);

        onTestFinished(async () => {
          useSecretKmsProbe();
          context.mocks.ably.publish.mockResolvedValue(undefined);
          await Promise.all([
            accept(
              runsCancelApi.cancel({
                headers: sessionHeadersFor(ownerActor),
                params: { id: ownerRun1.runId },
              }),
              [200, 400, 404],
            ),
            accept(
              runsCancelApi.cancel({
                headers: sessionHeadersFor(ownerActor),
                params: { id: ownerRun2.runId },
              }),
              [200, 400, 404],
            ),
          ]);
          await Promise.all([
            accept(
              webhookCompleteApi.complete({
                headers: { authorization: `Bearer ${ownerRun1.sandboxToken}` },
                body: {
                  runId: ownerRun1.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200, 400, 404],
            ),
            accept(
              webhookCompleteApi.complete({
                headers: { authorization: `Bearer ${ownerRun2.sandboxToken}` },
                body: {
                  runId: ownerRun2.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200, 400, 404],
            ),
          ]);
          await flushWaitUntilForTest();
        });

        const resolvePair = () => {
          return Promise.all([
            resolveRemoteProtocols({
              ...ownerRun1,
              vncConnectionId,
              sshConnectionId,
            }),
            resolveRemoteProtocols({
              ...ownerRun2,
              vncConnectionId,
              sshConnectionId,
            }),
          ]);
        };

        // 1. Enable VNC default -> both owner Runs resolve VNC; both invalidated.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.updateHostDefault({
            headers: vncSessionHeaders,
            params: { protocol: "vnc", connectionId: vncConnectionId },
            body: { enabled: true },
          }),
          [200],
        );
        const [, afterDefaultOn] = await Promise.all([
          flushWaitUntilForTest(),
          resolvePair(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun1.runId, ownerRun2.runId],
        });
        expect(afterDefaultOn).toStrictEqual([
          { vnc: "resolved_transport", ssh: "resolved" },
          { vnc: "resolved_transport", ssh: "resolved" },
        ]);

        // 2. Disable VNC in thread 1 -> only thread 2 resolves VNC; only thread 1 invalidated.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.setThreadOverride({
            headers: vncSessionHeaders,
            params: {
              threadId: ownerRun1.threadId,
              protocol: "vnc",
              connectionId: vncConnectionId,
            },
            body: { enabled: false },
          }),
          [200],
        );
        const [, afterThread1Off] = await Promise.all([
          flushWaitUntilForTest(),
          resolvePair(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun1.runId],
        });
        expect(afterThread1Off).toStrictEqual([
          { vnc: "unavailable", ssh: "resolved" },
          { vnc: "resolved_transport", ssh: "resolved" },
        ]);

        // 3. Clear thread 1 override -> both owner Runs resolve VNC; only thread 1 invalidated.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.clearThreadOverride({
            headers: vncSessionHeaders,
            params: {
              threadId: ownerRun1.threadId,
              protocol: "vnc",
              connectionId: vncConnectionId,
            },
          }),
          [200],
        );
        const [, afterOverrideCleared] = await Promise.all([
          flushWaitUntilForTest(),
          resolvePair(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun1.runId],
        });
        expect(afterOverrideCleared).toStrictEqual([
          { vnc: "resolved_transport", ssh: "resolved" },
          { vnc: "resolved_transport", ssh: "resolved" },
        ]);

        // 4. Disable VNC default -> neither owner Run resolves VNC; both invalidated.
        clearRealtimePublications();
        vncRuntime.authenticate(owner);
        await accept(
          chatRemoteAccessApi.updateHostDefault({
            headers: vncSessionHeaders,
            params: { protocol: "vnc", connectionId: vncConnectionId },
            body: { enabled: false },
          }),
          [200],
        );
        const [, afterDefaultOff] = await Promise.all([
          flushWaitUntilForTest(),
          resolvePair(),
        ]);
        expectVncInvalidationPublications({
          owner,
          runnerGroup,
          vncConnectionId,
          expectedRunIds: [ownerRun1.runId, ownerRun2.runId],
        });
        expect(afterDefaultOff).toStrictEqual([
          { vnc: "unavailable", ssh: "resolved" },
          { vnc: "unavailable", ssh: "resolved" },
        ]);

        const [ownerStatus1, ownerStatus2] = await Promise.all([
          accept(
            runsByIdApi.getById({
              headers: sessionHeadersFor(ownerActor),
              params: { id: ownerRun1.runId },
            }),
            [200],
          ),
          accept(
            runsByIdApi.getById({
              headers: sessionHeadersFor(ownerActor),
              params: { id: ownerRun2.runId },
            }),
            [200],
          ),
        ]);
        expect([
          ownerStatus1.body.status,
          ownerStatus2.body.status,
        ]).toStrictEqual(["running", "running"]);
      },
    );
  });

  describe("Runner direct app-state transfer", () => {
    it(
      "runner-app-state-002 only the assigned Runner and claimed Mac can deliver an opted-in capture",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = bdd.user({
          orgId: nextUniqueStaffOrgId(),
          orgRole: "org:admin",
        });
        if (!actor.orgId) {
          throw new Error("Expected a computer-use host owner organization");
        }
        const orgId = actor.orgId;
        const desktopSessionId = `sess_${actor.userId}`;
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();

        function authenticateDesktopHost() {
          context.mocks.clerk.authenticateRequest.mockResolvedValue({
            isAuthenticated: true,
            toAuth: () => {
              return { ...actor, sessionId: desktopSessionId };
            },
          });
          context.mocks.clerk.sessions.getSession.mockResolvedValue({
            id: desktopSessionId,
            userId: actor.userId,
            status: "active",
          });
          context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
            {
              data: [
                {
                  organization: { id: orgId },
                  publicUserData: { userId: actor.userId },
                  role: actor.orgRole ?? "org:admin",
                },
              ],
              totalCount: 1,
            },
          );
          return vncSessionHeaders;
        }

        function setDirectTransferSwitch(enabled: boolean) {
          return accept(
            featureSwitchesApi.update({
              headers: sessionHeadersFor(actor),
              body: {
                switches: {
                  [FeatureSwitchKey.ComputerUseAppStateDirectTransfer]: enabled,
                },
              },
            }),
            [200],
          );
        }

        const runnerIdentity = {
          runnerId: randomUUID(),
          heartbeatGeneration: 7,
        };
        const runnerHostname = `runner-${runnerIdentity.runnerId}.okou.app`;
        const [runnerGroup, , registeredHost] = await Promise.all([
          runs.configureRunnerGroup({
            runnerIdentity,
            hostname: runnerHostname,
          }),
          deliverOrganizationCreated(context, actor),
          accept(
            computerUseSessionHostsApi.register({
              headers: authenticateDesktopHost(),
              body: {
                installationId: randomUUID(),
                hostName: "BDD Mac",
                appVersion: "0.54.0",
                osVersion: "macOS 15",
                supportedCapabilities: [...DIRECT_APP_STATE_CAPABILITIES],
                permissions: { accessibility: true, screenRecording: true },
              },
            }),
            [200],
          ),
        ]);
        const hostId = registeredHost.body.hostId;
        const connectionGeneration = registeredHost.body.connectionGeneration;
        let hostStopped = false;
        onTestFinished(async () => {
          if (!hostStopped) {
            await accept(
              computerUseSessionHostsApi.stop({
                headers: authenticateDesktopHost(),
                params: { hostId },
                body: { connectionGeneration },
              }),
              [200, 409],
            );
          }
        });

        await setDirectTransferSwitch(false);

        const sent = await accept(
          chatEventsApi.send({
            headers: sessionHeadersFor(actor),
            body: {
              prompt: "Inspect TextEdit on the bound Mac",
              clientEventId: randomUUID(),
              computerUseHostId: hostId,
              model: null,
              hasTextContent: true,
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "Inspect TextEdit on the bound Mac" },
                ],
              },
            },
          }),
          [201],
        );
        expect(sent.status).toBe(201);
        const execution = await runs.nextReceivedExecution(runnerGroup);
        const runId = execution.runId;
        const agentToken = execution.platformEnvironment.OKOU_TOKEN;
        if (!agentToken) {
          throw new Error("Expected an agent OKOU_TOKEN for the bound Run");
        }
        registerRunCleanup(actor, runId, execution.sandboxToken);

        const s3Fake = computerUse.installComputerUseS3Fake();
        const runnerHeaders = officialRunnerAuthHeaders();
        const agentHeaders = () => {
          useAgentToken(agentToken);
          return { authorization: `Bearer ${agentToken}` };
        };

        // 1. Direct transfer disabled: ordinary command has no directAppState and claims normally.
        const ordinaryCreated = await accept(
          computerUseCommandApi.create({
            headers: agentHeaders(),
            body: {
              kind: "app.state",
              app: "TextEdit",
              timeoutMs: 60_000,
              appStateRunner: runnerIdentity,
            },
          }),
          [200],
        );
        expect(ordinaryCreated.body.directAppState).toBeUndefined();

        const ordinaryClaimed = await accept(
          computerUseSessionHostsApi.next({
            headers: authenticateDesktopHost(),
            params: { hostId },
            body: {
              connectionGeneration,
              supportedCapabilities: [...DIRECT_APP_STATE_CAPABILITIES],
            },
          }),
          [200],
        );
        expect(ordinaryClaimed.body.status).toBe("command");
        if (ordinaryClaimed.body.status !== "command") {
          throw new Error("Expected the Mac to claim the ordinary command");
        }
        expect(ordinaryClaimed.body.command.id).toBe(
          ordinaryCreated.body.commandId,
        );
        expect("appStateUpload" in ordinaryClaimed.body.command).toBeFalsy();

        await accept(
          computerUseSessionHostsApi.complete({
            headers: authenticateDesktopHost(),
            params: { hostId, commandId: ordinaryCreated.body.commandId },
            body: {
              connectionGeneration,
              status: "succeeded",
              result: { app: "TextEdit", windows: [] },
            },
          }),
          [200],
        );

        // 2. Enable direct transfer and create an opted-in TextEdit capture.
        await setDirectTransferSwitch(true);
        const directCreated = await accept(
          computerUseCommandApi.create({
            headers: agentHeaders(),
            body: {
              kind: "app.state",
              app: "TextEdit",
              timeoutMs: 60_000,
              appStateRunner: runnerIdentity,
            },
          }),
          [200],
        );
        expect(directCreated.body.directAppState).toBeTruthy();

        const [checkBeforeClaim, wrongGenBeforeClaim] = await Promise.all([
          accept(
            runnerAppStateApi.check({
              headers: runnerHeaders,
              params: { runId, commandId: directCreated.body.commandId },
              body: runnerIdentity,
            }),
            [200],
          ),
          accept(
            runnerAppStateApi.check({
              headers: runnerHeaders,
              params: { runId, commandId: directCreated.body.commandId },
              body: {
                runnerId: runnerIdentity.runnerId,
                heartbeatGeneration: runnerIdentity.heartbeatGeneration + 1,
              },
            }),
            [404],
          ),
        ]);
        expect(checkBeforeClaim.body).toStrictEqual({
          hostId,
          claimed: false,
        });
        expect(wrongGenBeforeClaim.status).toBe(404);

        // 3. Opt out before claim: Mac still receives upload URL & token; Run read omits upload fields.
        await setDirectTransferSwitch(false);
        const directClaimed = await accept(
          computerUseSessionHostsApi.next({
            headers: authenticateDesktopHost(),
            params: { hostId },
            body: {
              connectionGeneration,
              supportedCapabilities: [...DIRECT_APP_STATE_CAPABILITIES],
            },
          }),
          [200],
        );
        expect(directClaimed.body.status).toBe("command");
        if (directClaimed.body.status !== "command") {
          throw new Error("Expected the Mac to claim the direct command");
        }
        expect(directClaimed.body.command.appStateUpload).toStrictEqual({
          url: `https://${runnerHostname}/runners/${runnerIdentity.runnerId}/sandbox/runs/${runId}/app-state/${directCreated.body.commandId}`,
          token: expect.stringContaining(`${hostId}.`),
        });

        const [checkAfterClaim, wrongGenAfterClaim, runReadAfterClaim] =
          await Promise.all([
            accept(
              runnerAppStateApi.check({
                headers: runnerHeaders,
                params: { runId, commandId: directCreated.body.commandId },
                body: runnerIdentity,
              }),
              [200],
            ),
            accept(
              runnerAppStateApi.check({
                headers: runnerHeaders,
                params: { runId, commandId: directCreated.body.commandId },
                body: {
                  runnerId: runnerIdentity.runnerId,
                  heartbeatGeneration: runnerIdentity.heartbeatGeneration + 1,
                },
              }),
              [404],
            ),
            accept(
              computerUseCommandApi.get({
                headers: agentHeaders(),
                params: { commandId: directCreated.body.commandId },
              }),
              [200],
            ),
          ]);
        expect(checkAfterClaim.body).toStrictEqual({
          hostId,
          claimed: true,
        });
        expect(wrongGenAfterClaim.status).toBe(404);
        expect("appStateUpload" in runReadAfterClaim.body).toBeFalsy();

        // 4. Completion returns the receipt without S3 upload and retires the grant.
        const receipt = {
          snapshotId: randomUUID(),
          sha256: "a".repeat(64),
        };
        await accept(
          computerUseSessionHostsApi.complete({
            headers: authenticateDesktopHost(),
            params: { hostId, commandId: directCreated.body.commandId },
            body: {
              connectionGeneration,
              status: "succeeded",
              result: receipt,
            },
          }),
          [200],
        );
        const [completedRead, checkAfterComplete] = await Promise.all([
          accept(
            computerUseCommandApi.get({
              headers: agentHeaders(),
              params: { commandId: directCreated.body.commandId },
            }),
            [200],
          ),
          accept(
            runnerAppStateApi.check({
              headers: runnerHeaders,
              params: { runId, commandId: directCreated.body.commandId },
              body: runnerIdentity,
            }),
            [404],
          ),
        ]);
        expect(completedRead.body).toMatchObject({
          status: "succeeded",
          result: receipt,
        });
        expect(s3Fake.puts).toStrictEqual([]);
        expect(checkAfterComplete.status).toBe(404);

        // 5. Re-enable direct transfer, create another direct command, stop host -> retires grant.
        await setDirectTransferSwitch(true);
        const secondDirect = await accept(
          computerUseCommandApi.create({
            headers: agentHeaders(),
            body: {
              kind: "app.state",
              app: "TextEdit",
              timeoutMs: 60_000,
              appStateRunner: runnerIdentity,
            },
          }),
          [200],
        );
        expect(secondDirect.body.directAppState).toBeTruthy();

        const checkBeforeStop = await accept(
          runnerAppStateApi.check({
            headers: runnerHeaders,
            params: { runId, commandId: secondDirect.body.commandId },
            body: runnerIdentity,
          }),
          [200],
        );
        expect(checkBeforeStop.body).toStrictEqual({
          hostId,
          claimed: false,
        });

        await accept(
          computerUseSessionHostsApi.stop({
            headers: authenticateDesktopHost(),
            params: { hostId },
            body: { connectionGeneration },
          }),
          [200],
        );
        hostStopped = true;

        const checkAfterStop = await accept(
          runnerAppStateApi.check({
            headers: runnerHeaders,
            params: { runId, commandId: secondDirect.body.commandId },
            body: runnerIdentity,
          }),
          [404],
        );
        expect(checkAfterStop.status).toBe(404);
      },
    );
  });

  describe("Runner environment ownership", () => {
    it(
      "runner-environment-ownership-001 separates trusted platform environment from untrusted entries",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = bdd.user({ orgRole: "org:admin" });
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();

        const capturedRunContextSnapshots: Record<string, unknown>[] = [];
        context.mocks.axiom.ingest.mockImplementation(
          (dataset: unknown, events: unknown) => {
            if (
              typeof dataset === "string" &&
              dataset.includes("run-context") &&
              Array.isArray(events)
            ) {
              for (const event of events) {
                if (typeof event === "object" && event !== null) {
                  capturedRunContextSnapshots.push(
                    event as Record<string, unknown>,
                  );
                }
              }
            }
            return true;
          },
        );
        context.mocks.axiom.query.mockImplementation((apl: unknown) => {
          if (typeof apl === "string" && apl.includes("run-context")) {
            const matched = capturedRunContextSnapshots.filter((snapshot) => {
              return (
                typeof snapshot.runId === "string" &&
                apl.includes(`"${snapshot.runId.toLowerCase()}"`)
              );
            });
            return Promise.resolve(matched.slice(-1));
          }
          return Promise.resolve([]);
        });

        const [runnerGroup] = await Promise.all([
          runs.configureRunnerGroup(),
          runs.grantProEntitlement(actor),
        ]);
        await runs.ensurePersonalSubscriptionModel(actor, {
          model: NATIVE_CLAUDE_MODEL,
        });

        const sent = await accept(
          chatEventsApi.send({
            headers: sessionHeadersFor(actor),
            body: {
              prompt: "Inspect separated platform and Agent environments",
              clientEventId: randomUUID(),
              model: NATIVE_CLAUDE_MODEL,
              hasTextContent: true,
              userMessage: {
                version: 1,
                parts: [
                  {
                    type: "text",
                    text: "Inspect separated platform and Agent environments",
                  },
                ],
              },
            },
          }),
          [201],
        );
        const execution = await runs.nextReceivedExecution(runnerGroup);
        registerRunCleanup(actor, execution.runId, execution.sandboxToken);

        const issuedToken = execution.platformEnvironment.OKOU_TOKEN;
        expect(issuedToken).toBeTruthy();
        expect(execution.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
          sent.body.threadId,
        );
        expect(execution.secretValues).toContain(issuedToken);

        const agentEnvKeys = Object.keys(execution.environment ?? {});
        for (const platformKey of Object.keys(execution.platformEnvironment)) {
          expect(agentEnvKeys).not.toContain(platformKey);
        }
        expect(
          agentEnvKeys.filter((key) => {
            return key.startsWith("OKOU_");
          }),
        ).toStrictEqual([]);

        const runContext = await accept(
          runContextApi.getContext({
            headers: sessionHeadersFor(actor),
            params: { id: execution.runId },
          }),
          [200],
        );
        expect(JSON.stringify(runContext.body)).not.toContain(issuedToken);
        expect(runContext.body.environment.OKOU_TOKEN).toBe("***");
        expect(runContext.body.environment.OKOU_CHAT_THREAD_ID).toBe(
          sent.body.threadId,
        );

        const cancelled = await accept(
          runsCancelApi.cancel({
            headers: sessionHeadersFor(actor),
            params: { id: execution.runId },
          }),
          [200],
        );
        expect(cancelled.status).toBe(200);
      },
    );
  });
});
