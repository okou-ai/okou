import { randomUUID } from "node:crypto";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import type { infer as zInfer } from "zod";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { desktopShellAuthorizationContract } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import type { desktopShellSessionSchema } from "@okouai/api-contracts/contracts/desktop-shell-schemas";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  computerUseCommandResultChangedEvent,
  computerUseCommandResultChannelName,
  computerUseCommandsChangedEvent,
  computerUseHostChannelName,
} from "@okouai/api-contracts/contracts/realtime";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import {
  clearMockNow,
  mockNow,
  now,
  withMockNowForTest,
} from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { computerUseRoutes } from "../computer-use";
import { desktopShellAuthorizationRoutes } from "../desktop-shell-authorization";
import { featureSwitchesRoutes } from "../feature-switches";
import { remoteDevicesRoutes } from "../remote-devices";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createPublicComputerUseHosts } from "./helpers/public-computer-use-hosts";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const SHELL_COMMAND_KINDS = Object.freeze([
  "shell.cmd",
  "shell.list",
  "shell.status",
  "shell.close",
] as const);

const ONE_HOUR_MS = 60 * 60 * 1000;

function shellCapabilities(permissionId: string): readonly string[] {
  return [...SHELL_COMMAND_KINDS, `shell.permission:${permissionId}`];
}

function shellHostOptions(
  permissionId: string,
  overrides: {
    readonly hostName?: string;
    readonly installationId?: string;
    readonly permissions?: {
      readonly accessibility: boolean;
      readonly screenRecording: boolean;
    };
  } = {},
) {
  return {
    supportedCapabilities: shellCapabilities(permissionId),
    ...overrides,
  };
}

function shellSessionFixture(
  id: string,
  overrides: Partial<zInfer<typeof desktopShellSessionSchema>> = {},
) {
  return {
    id,
    state: "open" as const,
    initialCwd: "/Users/test",
    cwd: "/Users/test",
    commandState: "running" as const,
    exitCode: null,
    shellExitCode: null,
    shellExitSignal: null,
    closeReason: null,
    oldestCursor: 0,
    endCursor: 12,
    idleRemainingSeconds: 600,
    cols: 120,
    rows: 40,
    ...overrides,
  };
}

function orgActor(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: actor.orgRole,
  };
}

function sessionHeaders(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function extractTrailingPathSegment(url: string): string {
  const segment = new URL(url).pathname.split("/").at(-1);
  if (!segment) {
    throw new Error("Expected a trailing token segment in authorization URL");
  }
  return decodeURIComponent(segment);
}

function expectShellAuth<T extends { readonly id: string }>(response: {
  readonly body: T | { readonly error: { readonly code: string } };
}): T {
  if ("id" in response.body) {
    return response.body;
  }
  throw new Error(
    `Expected Desktop Shell authorization body, got ${response.body.error.code}`,
  );
}

function expectShellQueued<T extends { readonly commandId: string }>(response: {
  readonly body: T | { readonly error: { readonly code: string } };
}): T {
  if ("commandId" in response.body) {
    return response.body;
  }
  throw new Error(
    `Expected queued Shell command body, got ${response.body.error.code}`,
  );
}

function expectApiError(response: {
  readonly body:
    | { readonly error: { readonly code: string; readonly message: string } }
    | object;
}): { readonly code: string; readonly message: string } {
  if ("error" in response.body) {
    return response.body.error;
  }
  throw new Error("Expected API error body");
}

interface DesktopShellSuiteApis {
  readonly bdd: ReturnType<typeof createBddApi>;
  readonly runs: ReturnType<typeof createRunsApi>;
  readonly chat: ReturnType<typeof createChatFilesBddApi>;
  readonly chatFixture: ReturnType<typeof createChatEventsFixture>;
  readonly webhooks: ReturnType<typeof createWebhookCallbackApi>;
  readonly authOrg: ReturnType<typeof createAuthOrgBddApi>;
}

/** Lightweight Desktop Shell scenario using built-in limited-free Runs and one direct runner. */
function createDesktopShellFixture(
  context: TestContext,
  apis: DesktopShellSuiteApis,
) {
  const { bdd, runs, chat, chatFixture, webhooks, authOrg } = apis;
  const hosts = createPublicComputerUseHosts(context);
  const member = bdd.user();

  let restoreExternal = captureConnectorExternalState(context);
  let acceptedTime = now();
  const activeRuns = new Map<string, string>();

  onTestFinished(async () => {
    const previous = captureConnectorExternalState(context);
    restoreExternal();
    const errors: unknown[] = [];
    const cleaned = await settleIncludingAbort(() => {
      return withMockNowForTest(acceptedTime, async () => {
        for (const [runId, sandboxToken] of activeRuns) {
          const cancelled = await settleIncludingAbort(async () => {
            const cancelResponse = await runs.requestCancelRun(
              member,
              runId,
              [200, 400],
            );
            if (cancelResponse.status === 200) {
              await webhooks.requestAgentComplete(
                { runId, exitCode: 1, error: "Run cancelled" },
                { authorization: `Bearer ${sandboxToken}` },
                [200],
              );
            }
          });
          if (!cancelled.ok) {
            errors.push(cancelled.error);
          }
        }
        activeRuns.clear();
        const stoppedHosts = await settleIncludingAbort(() => {
          return hosts.cleanup();
        });
        if (!stoppedHosts.ok) {
          errors.push(stoppedHosts.error);
        }
      });
    });
    previous();
    if (!cleaned.ok) {
      errors.push(cleaned.error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Desktop Shell fixture cleanup failed");
    }
  });

  function run<T>(operation: () => Promise<T>): Promise<T> {
    acceptedTime = now();
    return operation();
  }

  const computerUseBase = createComputerUseBddApi(context, run);
  const computerUse = {
    ...computerUseBase,
    startComputerUseHost(
      actor: ApiTestUser,
      options?: Parameters<typeof computerUseBase.startComputerUseHost>[1],
    ) {
      return hosts.start(actor, run, options);
    },
  };

  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: member.orgId
      ? [
          {
            role: member.orgRole ?? "org:admin",
            organization: { id: member.orgId },
          },
        ]
      : [],
  });
  chatFixture.chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-desktop-shell-key");
  const readyPromise = run(async () => {
    await Promise.all([
      runs.configureRunnerGroup({ maxConcurrent: 4 }),
      deliverOrganizationCreated(context, member),
    ]);
    restoreExternal = captureConnectorExternalState(context);
  });

  function ensurePrepared(): Promise<void> {
    return readyPromise;
  }

  async function cancelRun(runId: string, sandboxToken: string) {
    await run(async () => {
      await runs.requestCancelRun(member, runId, [200]);
      await webhooks.requestAgentComplete(
        { runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${sandboxToken}` },
        [200],
      );
      activeRuns.delete(runId);
    });
  }

  async function launchRun(hostId?: string, threadId?: string) {
    await ensurePrepared();
    for (const [previousRunId, previousSandboxToken] of activeRuns) {
      await cancelRun(previousRunId, previousSandboxToken);
    }
    return await run(async () => {
      const launched = await chatFixture.sendChatRun(member, {
        prompt: "Use the selected Desktop",
        model: null,
        computerUseHostId: hostId ?? null,
        ...(threadId ? { threadId } : {}),
      });
      const execution = await runs.executionInput(launched.runId);
      const token = execution.platformEnvironment.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected the execution's Okou token");
      }
      activeRuns.set(launched.runId, execution.sandboxToken);
      return {
        token,
        runId: launched.runId,
        threadId: launched.threadId,
        sandboxToken: execution.sandboxToken,
      };
    });
  }

  return {
    member,
    memberIdentity: orgActor(member),
    bdd,
    chat,
    computerUse,
    run,
    launchRun,
    cancelRun,
    createCliToken(actor: ApiTestUser) {
      return run(() => {
        return authOrg.createCliToken(actor, run);
      });
    },
  };
}

describe("Desktop Shell command pipeline", () => {
  const context = testContext();
  const suiteApis: DesktopShellSuiteApis = {
    bdd: createBddApi(context),
    runs: createRunsApi(context),
    chat: createChatFilesBddApi(context),
    chatFixture: createChatEventsFixture(context),
    webhooks: createWebhookCallbackApi(context),
    authOrg: createAuthOrgBddApi(context),
  };
  const computerUseClient = setupApp({ context, routes: computerUseRoutes })(
    computerUseHostsContract,
  );
  const shellAuthClient = setupApp({
    context,
    routes: desktopShellAuthorizationRoutes,
  })(desktopShellAuthorizationContract);
  const remoteDevicesClient = setupApp({
    context,
    routes: remoteDevicesRoutes,
  })(remoteDevicesContract);
  const chatEventsClient = setupApp({ context, routes: chatEventsRoutes })(
    chatEventsContract,
  );
  const featureSwitchesClient = setupApp({
    context,
    routes: featureSwitchesRoutes,
  })(featureSwitchesContract);
  const runnersHeartbeatClient = setupApp({ context, routes: runnersRoutes })(
    runnersHeartbeatContract,
  );
  const runsByIdClient = setupApp({ context, routes: runsRoutes })(
    runsByIdContract,
  );
  const runsCancelClient = setupApp({ context, routes: runsCancelRoutes })(
    runsCancelContract,
  );
  const webhookCompleteClient = setupApp({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookClerkClient = setupApp({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(
          webhookClerkClient.post({
            body: "{}",
            extraHeaders: {},
          }),
          [401],
        ),
        accept(computerUseClient.list({ headers: {} }), [401]),
        accept(
          shellAuthClient.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(remoteDevicesClient.list({ headers: {} }), [401]),
        accept(featureSwitchesClient.get({ headers: {} }), [401]),
        accept(
          chatEventsClient.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
          }),
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
          runsByIdClient.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelClient.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhookCompleteClient.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "desktop-shell-007 (2/2) renews revoked Shell access with a new ID and routes input to the existing terminal",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();
      const capabilities = shellCapabilities(permissionId);
      const sessionId = randomUUID();

      const [, host] = await Promise.all([
        fixture.run(() => {
          return updateFeatureSwitchesForUser(context, memberIdentity, {
            [FeatureSwitchKey.DesktopShell]: true,
          });
        }),
        fixture.computerUse.startComputerUseHost(
          member,
          shellHostOptions(permissionId, { hostName: "Renew Test Desktop" }),
        ),
      ]);
      const run1 = await fixture.launchRun(host.hostId);
      const auth1 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Start interactive command",
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [200],
      );
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "revoke",
        [200],
      );

      const run2 = await fixture.launchRun(host.hostId, run1.threadId);
      const auth2 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run2.token },
        "Resume existing terminal",
      );
      expect(expectShellAuth(auth2).id).not.toBe(expectShellAuth(auth1).id);

      await fixture.cancelRun(run2.runId, run2.sandboxToken);
      const renewed = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
        "approve",
        [200],
      );
      expect(expectShellAuth(renewed).status).toBe("approved");

      const run3 = await fixture.launchRun(host.hostId, run1.threadId);
      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      const terminalInput =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run3.token },
          { kind: "shell.cmd", sessionId, input: "yes\n", waitMs: 10_000 },
          [200],
        );
      const claimedInput =
        await fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        );
      expect(claimedInput.status).toBe("command");
      if (claimedInput.status === "command") {
        expect(claimedInput.command.id).toBe(
          expectShellQueued(terminalInput).commandId,
        );
        expect(claimedInput.command.payload).toMatchObject({
          sessionId,
          input: "yes\n",
          shellPermissionId: permissionId,
        });
      }
    },
  );

  it(
    "pf-077 (2/2) enforces Remote Device revocation on queued and new Shell commands while the chat grant remains approved",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();
      const capabilities = shellCapabilities(permissionId);

      const [, host] = await Promise.all([
        fixture.run(() => {
          return updateFeatureSwitchesForUser(context, memberIdentity, {
            [FeatureSwitchKey.DesktopShell]: true,
            [FeatureSwitchKey.RemoteDevices]: true,
          });
        }),
        fixture.computerUse.startComputerUseHost(
          member,
          shellHostOptions(permissionId, {
            hostName: "Remote Device Revoke Desktop",
          }),
        ),
      ]);

      const directory = await fixture.run(() => {
        return accept(
          remoteDevicesClient.list({
            headers: sessionHeaders(context, member),
          }),
          [200],
        );
      });
      const device = directory.body.devices.find((candidate) => {
        return candidate.channels.some((channel) => {
          return channel.kind === "desktop" && channel.id === host.hostId;
        });
      });
      if (!device) {
        throw new Error("Expected the Desktop host's Remote Device entry");
      }

      const [, run1] = await Promise.all([
        fixture.run(() => {
          return accept(
            remoteDevicesClient.setAccess({
              headers: sessionHeaders(context, member),
              params: { deviceId: device.id },
              body: { mode: "always" },
            }),
            [200],
          );
        }),
        fixture.launchRun(),
      ]);

      const requested = await fixture.run(() => {
        return accept(
          shellAuthClient.create({
            headers: { authorization: `Bearer ${run1.token}` },
            body: { reason: "Inspect workspace", hostId: host.hostId },
          }),
          [200],
        );
      });
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      const approved = await fixture.computerUse.actDesktopShellAccess(
        member,
        requested.body.id,
        "approve",
        [200],
      );
      expect(expectShellAuth(approved).status).toBe("approved");

      // With both Remote Device policy and Shell grant active, a follow-up Run
      // dispatches and the Desktop host claims the Shell command.
      const run2 = await fixture.launchRun(undefined, run1.threadId);
      const firstCommand =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { hostId: host.hostId, kind: "shell.list", waitMs: 10_000 },
          [200],
        );
      const claimed = await fixture.computerUse.claimNextComputerUseCommand(
        host.connection,
        capabilities,
      );
      expect(claimed.status).toBe("command");
      if (claimed.status === "command") {
        expect(claimed.command.id).toBe(
          expectShellQueued(firstCommand).commandId,
        );
      }
      await fixture.computerUse.completeComputerUseCommandWith(
        host.connection,
        expectShellQueued(firstCommand).commandId,
        { status: "succeeded", result: { sessions: [] } },
      );

      // Denying the Remote Device while the Shell grant remains approved blocks
      // both claiming queued Shell commands and submitting new Shell commands.
      const queuedBeforeDeny =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { hostId: host.hostId, kind: "shell.list", waitMs: 10_000 },
          [200],
        );
      expect(expectShellQueued(queuedBeforeDeny).status).toBe("queued");

      await fixture.run(() => {
        return accept(
          remoteDevicesClient.setAccess({
            headers: sessionHeaders(context, member),
            params: { deviceId: device.id },
            body: { mode: "denied" },
          }),
          [200],
        );
      });

      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      await fixture.computerUse.requestCreateDesktopShellCommand(
        { bearer: run2.token },
        { hostId: host.hostId, kind: "shell.list", waitMs: 10_000 },
        [404],
      );
    },
  );

  it(
    "desktop-shell-006 (1/2) scopes approval to the owning member and only accepts human decisions",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const otherMember = fixture.bdd.user({ orgId: member.orgId });
      const permissionId = randomUUID();

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });
      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, orgActor(otherMember), {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });

      const host = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId, { hostName: "Scoped Desktop" }),
      );
      const run1 = await fixture.launchRun(host.hostId);

      const auth1 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Inspect build environment",
      );
      expect(auth1.body).toMatchObject({
        status: "pending",
        approvalBlockedReason: "run_active",
      });
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [409],
      );

      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      const approved = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [200],
      );
      const approvedAuth = expectShellAuth(approved);
      expect(approvedAuth.status).toBe("approved");
      if (!approvedAuth.approvedAt || !approvedAuth.grantExpiresAt) {
        throw new Error("Expected approval and grant expiry timestamps");
      }
      expect(
        Date.parse(approvedAuth.grantExpiresAt) -
          Date.parse(approvedAuth.approvedAt),
      ).toBe(ONE_HOUR_MS);

      const run2 = await fixture.launchRun(host.hostId, run1.threadId);
      const cliToken = await fixture.createCliToken(member);

      await fixture.computerUse.readDesktopShellAccess(
        otherMember,
        expectShellAuth(auth1).id,
        [404],
      );
      await fixture.computerUse.actDesktopShellAccess(
        otherMember,
        expectShellAuth(auth1).id,
        "revoke",
        [404],
      );
      await fixture.computerUse.actDesktopShellAccess(
        { bearer: run2.token },
        expectShellAuth(auth1).id,
        "approve",
        [403],
      );
      await fixture.computerUse.requestDesktopShellAccess(
        member,
        "Direct session attempt",
        [403],
      );
      await fixture.computerUse.requestCreateDesktopShellCommand(
        member,
        { kind: "shell.list", waitMs: 10_000 },
        [403],
      );
      await fixture.computerUse.requestCreateDesktopShellCommand(
        { bearer: cliToken.token },
        { kind: "shell.list", waitMs: 10_000 },
        [403],
      );
    },
  );

  it(
    "desktop-shell-007 (1/2) revokes queued work without cancelling already claimed work or closing terminals",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();
      const capabilities = shellCapabilities(permissionId);
      const sessionId = randomUUID();

      const [, host] = await Promise.all([
        fixture.run(() => {
          return updateFeatureSwitchesForUser(context, memberIdentity, {
            [FeatureSwitchKey.DesktopShell]: true,
          });
        }),
        fixture.computerUse.startComputerUseHost(
          member,
          shellHostOptions(permissionId, { hostName: "Revoke Test Desktop" }),
        ),
      ]);
      const run1 = await fixture.launchRun(host.hostId);
      const auth1 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Start interactive command",
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [200],
      );

      const run2 = await fixture.launchRun(host.hostId, run1.threadId);
      const sleepCommand =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.cmd", command: "sleep 300", waitMs: 10_000 },
          [200],
        );
      const claimedSleep =
        await fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        );
      expect(claimedSleep.status).toBe("command");
      if (claimedSleep.status === "command") {
        expect(claimedSleep.command.id).toBe(
          expectShellQueued(sleepCommand).commandId,
        );
      }

      const queuedStatus =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.status", sessionId, waitMs: 10_000 },
          [200],
        );

      // Revoking twice is idempotent and fails only queued commands.
      const firstRevoke = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "revoke",
        [200],
      );
      const secondRevoke = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "revoke",
        [200],
      );
      expect(expectShellAuth(firstRevoke).status).toBe("revoked");
      expect(expectShellAuth(secondRevoke).status).toBe("revoked");

      await fixture.computerUse.completeComputerUseCommandWith(
        host.connection,
        expectShellQueued(sleepCommand).commandId,
        {
          status: "succeeded",
          result: {
            session: shellSessionFixture(sessionId, {
              state: "open",
              commandState: "running",
            }),
            reason: "wait_elapsed",
          },
        },
      );

      const [completedSleep, failedQueued] = await Promise.all([
        fixture.computerUse.readComputerUseCommand(
          { bearer: run2.token },
          expectShellQueued(sleepCommand).commandId,
        ),
        fixture.computerUse.readComputerUseCommand(
          { bearer: run2.token },
          expectShellQueued(queuedStatus).commandId,
        ),
      ]);
      expect(completedSleep).toMatchObject({
        status: "succeeded",
        result: {
          session: { id: sessionId, state: "open" },
        },
      });
      expect(failedQueued).toMatchObject({
        status: "failed",
        error: { code: "permission_denied" },
      });

      await Promise.all([
        fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.list", waitMs: 10_000 },
          [403],
        ),
        fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.close", all: true, waitMs: 10_000 },
          [403],
        ),
        fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.cmd", sessionId, input: "yes\n", waitMs: 10_000 },
          [403],
        ),
      ]);
    },
  );

  it(
    "pf-077 (1/2) gates Shell requests, commands, and approval on both Remote Device policy and Shell grant",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();

      const [, host] = await Promise.all([
        fixture.run(() => {
          return updateFeatureSwitchesForUser(context, memberIdentity, {
            [FeatureSwitchKey.DesktopShell]: true,
            [FeatureSwitchKey.RemoteDevices]: true,
          });
        }),
        fixture.computerUse.startComputerUseHost(
          member,
          shellHostOptions(permissionId, { hostName: "Remote Device Desktop" }),
        ),
      ]);

      const directory = await fixture.run(() => {
        return accept(
          remoteDevicesClient.list({
            headers: sessionHeaders(context, member),
          }),
          [200],
        );
      });
      const device = directory.body.devices.find((candidate) => {
        return candidate.channels.some((channel) => {
          return channel.kind === "desktop" && channel.id === host.hostId;
        });
      });
      if (!device) {
        throw new Error("Expected the Desktop host's Remote Device entry");
      }
      expect(device.accessAllowed).toBeFalsy();

      const run1 = await fixture.launchRun();

      // With Remote Device access denied and no Shell grant, neither requesting
      // Shell access nor dispatching a Shell command can proceed.
      await Promise.all([
        fixture.run(() => {
          return accept(
            shellAuthClient.create({
              headers: { authorization: `Bearer ${run1.token}` },
              body: { reason: "Inspect workspace", hostId: host.hostId },
            }),
            [409],
          );
        }),
        fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run1.token },
          { hostId: host.hostId, kind: "shell.list", waitMs: 10_000 },
          [404],
        ),
      ]);

      // Allowing the Remote Device alone is not enough: Shell commands still
      // require the chat's independent one-hour Shell grant.
      const allowedDevice = await fixture.run(() => {
        return accept(
          remoteDevicesClient.setAccess({
            headers: sessionHeaders(context, member),
            params: { deviceId: device.id },
            body: { mode: "always" },
          }),
          [200],
        );
      });
      expect(allowedDevice.body.accessAllowed).toBeTruthy();

      const [missingGrant, requested] = await Promise.all([
        fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run1.token },
          { hostId: host.hostId, kind: "shell.list", waitMs: 10_000 },
          [403],
        ),
        fixture.run(() => {
          return accept(
            shellAuthClient.create({
              headers: { authorization: `Bearer ${run1.token}` },
              body: { reason: "Inspect workspace", hostId: host.hostId },
            }),
            [200],
          );
        }),
      ]);
      expect(expectApiError(missingGrant).code).toBe(
        "SHELL_AUTHORIZATION_REQUIRED",
      );
      expect(requested.body).toMatchObject({
        status: "pending",
        computerUseHostId: host.hostId,
        approvalBlockedReason: "run_active",
      });

      await fixture.cancelRun(run1.runId, run1.sandboxToken);

      // Denying the Remote Device blocks approving the pending Shell request.
      await fixture.run(() => {
        return accept(
          remoteDevicesClient.setAccess({
            headers: sessionHeaders(context, member),
            params: { deviceId: device.id },
            body: { mode: "denied" },
          }),
          [200],
        );
      });
      const blockedRead = await fixture.computerUse.readDesktopShellAccess(
        member,
        requested.body.id,
      );
      expect(blockedRead.body).toMatchObject({
        status: "pending",
        approvalBlockedReason: "computer_changed",
      });
      await fixture.computerUse.actDesktopShellAccess(
        member,
        requested.body.id,
        "approve",
        [409],
      );

      // Re-allowing the Remote Device unblocks approval of the chat's Shell grant.
      await fixture.run(() => {
        return accept(
          remoteDevicesClient.setAccess({
            headers: sessionHeaders(context, member),
            params: { deviceId: device.id },
            body: { mode: "always" },
          }),
          [200],
        );
      });
      const approved = await fixture.computerUse.actDesktopShellAccess(
        member,
        requested.body.id,
        "approve",
        [200],
      );
      expect(expectShellAuth(approved).status).toBe("approved");
    },
  );

  it(
    "desktop-shell-004 notifies the owner when another computer changes the computer for a pending Shell approval",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId1 = randomUUID();
      const permissionId2 = randomUUID();

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });

      const host1 = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId1, { hostName: "Primary Desktop" }),
      );
      const run1 = await fixture.launchRun(host1.hostId);

      const shellRequest = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Inspect local repository",
      );
      const selectionRequest =
        await fixture.computerUse.createComputerUseAuthorizationRequest({
          bearer: run1.token,
        });
      const requestToken = extractTrailingPathSegment(
        selectionRequest.authorizationUrl,
      );

      const host2 = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId2, { hostName: "Secondary Desktop" }),
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);

      const ready = await fixture.computerUse.readDesktopShellAccess(
        member,
        expectShellAuth(shellRequest).id,
      );
      expect(ready.body).toMatchObject({
        status: "pending",
        approvalBlockedReason: null,
      });

      const observedBlockedReasons: (string | null)[] = [];
      const pendingObservations: Promise<void>[] = [];
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.publish.mockImplementation((topic: unknown) => {
        if (topic !== "desktopShellAuthorizationChanged") {
          return Promise.resolve(undefined);
        }
        const observed = fixture.computerUse
          .readDesktopShellAccess(member, expectShellAuth(shellRequest).id)
          .then((snapshot) => {
            observedBlockedReasons.push(
              expectShellAuth(snapshot).approvalBlockedReason,
            );
          });
        pendingObservations.push(observed);
        return observed;
      });

      await fixture.computerUse.applyComputerUseAuthorizationRequest(
        member,
        requestToken,
        host2.hostId,
      );
      await Promise.all(pendingObservations);
      context.mocks.ably.publish.mockResolvedValue(undefined);

      expect(observedBlockedReasons).toStrictEqual(["computer_changed"]);
      expect(
        channelsPublishedTo(context.mocks, "desktopShellAuthorizationChanged"),
      ).toStrictEqual([`user:${member.userId}`]);

      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(shellRequest).id,
        "approve",
        [409],
      );
    },
  );

  it(
    "desktop-shell-006 (2/2) scopes approval to the owning chat and computer",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId1 = randomUUID();
      const permissionId2 = randomUUID();

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });

      const host1 = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId1, { hostName: "Chat One Desktop" }),
      );
      const run1 = await fixture.launchRun(host1.hostId);
      const auth1 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Approve chat one",
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [200],
      );

      // A Run in a second chat on the same computer cannot use chat one's grant.
      const run2 = await fixture.launchRun(host1.hostId);
      const crossChatCommand =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.list", waitMs: 10_000 },
          [403],
        );
      expect(expectApiError(crossChatCommand).code).toBe(
        "SHELL_AUTHORIZATION_REQUIRED",
      );

      const auth2 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run2.token },
        "Approve chat two",
      );
      await fixture.cancelRun(run2.runId, run2.sandboxToken);

      const host2 = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId2, { hostName: "Chat Two Desktop" }),
      );

      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();
      await fixture.run(() => {
        return fixture.chat.updateThreadComputerUseHost(
          member,
          run2.threadId,
          host2.hostId,
        );
      });

      expect(
        channelsPublishedTo(context.mocks, "desktopShellAuthorizationChanged"),
      ).toStrictEqual([`user:${member.userId}`]);

      const movedRead = await fixture.computerUse.readDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
      );
      expect(movedRead.body).toMatchObject({
        status: "pending",
        approvalBlockedReason: "computer_changed",
      });

      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
        "approve",
        [409],
      );
      const denied = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
        "deny",
        [200],
      );
      expect(expectShellAuth(denied).status).toBe("denied");
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
        "approve",
        [409],
      );
    },
  );

  it(
    "desktop-shell-008 expires grants at the dispatch boundary and expires unapproved requests separately",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const baseTime = now();
      mockNow(baseTime);

      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();
      const capabilities = shellCapabilities(permissionId);
      const hostOptions = shellHostOptions(permissionId, {
        hostName: "Expiry Desktop",
        installationId: randomUUID(),
      });

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });

      const host = await fixture.computerUse.startComputerUseHost(
        member,
        hostOptions,
      );
      const run1 = await fixture.launchRun(host.hostId);
      const auth1 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Time-bounded grant check",
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      const approved = await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
        "approve",
        [200],
      );
      const approvedAuth = expectShellAuth(approved);
      if (!approvedAuth.grantExpiresAt) {
        throw new Error("Expected grantExpiresAt on approved authorization");
      }
      const grantExpiresAtMs = Date.parse(approvedAuth.grantExpiresAt);

      const run2 = await fixture.launchRun(host.hostId, run1.threadId);

      // One millisecond before the grant expires, heartbeat and queue shell.list.
      mockNow(grantExpiresAtMs - 1);
      await fixture.computerUse.heartbeatComputerUseHost(
        host.connection,
        hostOptions,
      );
      const queuedBeforeExpiry =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.list", waitMs: 10_000 },
          [200],
        );

      // At the exact grant expiry boundary, claim is idle and the queued command
      // fails with permission_denied while the authorization reads expired.
      mockNow(grantExpiresAtMs);
      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      const expiredCommand = await fixture.computerUse.readComputerUseCommand(
        { bearer: run2.token },
        expectShellQueued(queuedBeforeExpiry).commandId,
      );
      expect(expiredCommand).toMatchObject({
        status: "failed",
        error: { code: "permission_denied" },
      });

      const expiredGrant = await fixture.computerUse.readDesktopShellAccess(
        member,
        expectShellAuth(auth1).id,
      );
      expect(expectShellAuth(expiredGrant).status).toBe("expired");

      await fixture.computerUse.requestCreateDesktopShellCommand(
        { bearer: run2.token },
        { kind: "shell.list", waitMs: 10_000 },
        [403],
      );

      const auth2 = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run2.token },
        "Replacement request",
      );
      expect(expectShellAuth(auth2).id).not.toBe(expectShellAuth(auth1).id);

      await fixture.cancelRun(run2.runId, run2.sandboxToken);

      // Advance to the unapproved request's expiry and attempt approval.
      mockNow(Date.parse(expectShellAuth(auth2).requestExpiresAt));
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
        "approve",
        [410],
      );
      const expiredRequest = await fixture.computerUse.readDesktopShellAccess(
        member,
        expectShellAuth(auth2).id,
      );
      expect(expiredRequest.body).toMatchObject({
        status: "expired",
        grantExpiresAt: null,
      });
    },
  );

  it(
    "desktop-shell-009 uses the authorized computer, explicit local capabilities and the existing result channel",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createDesktopShellFixture(context, suiteApis);
      const { member, memberIdentity } = fixture;
      const permissionId = randomUUID();
      const capabilities = shellCapabilities(permissionId);
      const sessionId = randomUUID();

      const host = await fixture.computerUse.startComputerUseHost(
        member,
        shellHostOptions(permissionId, {
          hostName: "Shell Only Desktop",
          permissions: { accessibility: false, screenRecording: false },
        }),
      );

      // With Desktop Shell switch off, member command gets 403 and host stays idle.
      await fixture.computerUse.requestCreateDesktopShellCommand(
        member,
        { kind: "shell.list", waitMs: 10_000 },
        [403],
      );
      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      // Turn switch on; unauthorized Run gets 403 SHELL_AUTHORIZATION_REQUIRED.
      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });
      const run1 = await fixture.launchRun(host.hostId);
      const unauthorized =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run1.token },
          { kind: "shell.list", waitMs: 10_000 },
          [403],
        );
      expect(expectApiError(unauthorized).code).toBe(
        "SHELL_AUTHORIZATION_REQUIRED",
      );
      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      const auth = await fixture.computerUse.requestDesktopShellAccess(
        { bearer: run1.token },
        "Run pwd in local shell",
      );
      await fixture.cancelRun(run1.runId, run1.sandboxToken);
      await fixture.computerUse.actDesktopShellAccess(
        member,
        expectShellAuth(auth).id,
        "approve",
        [200],
      );

      const run2 = await fixture.launchRun(host.hostId, run1.threadId);
      context.mocks.ably.createTokenRequest.mockResolvedValue({
        keyName: "test-key",
        ttl: 76_000,
        timestamp: now(),
        capability: JSON.stringify({ "*": ["subscribe"] }),
        clientId: member.userId,
        nonce: "test-nonce",
        mac: "test-mac",
      });
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();

      const pwdCreated =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.cmd", command: "pwd", waitMs: 1000, realtime: true },
          [200],
        );

      const expectedHostChannel = computerUseHostChannelName(
        member.userId,
        memberIdentity.orgId,
        host.hostId,
        host.connection.connectionGeneration,
      );
      const expectedResultChannel = computerUseCommandResultChannelName(
        member.userId,
        memberIdentity.orgId,
        expectShellQueued(pwdCreated).commandId,
      );
      expect(expectShellQueued(pwdCreated).realtime).toMatchObject({
        channelName: expectedResultChannel,
        eventName: computerUseCommandResultChangedEvent,
      });
      expect(
        channelsPublishedTo(context.mocks, computerUseCommandsChangedEvent),
      ).toContain(expectedHostChannel);

      const claimedPwd = await fixture.computerUse.claimNextComputerUseCommand(
        host.connection,
        capabilities,
      );
      expect(claimedPwd.status).toBe("command");
      if (claimedPwd.status === "command") {
        expect(claimedPwd.command).toMatchObject({
          id: expectShellQueued(pwdCreated).commandId,
          hostId: host.hostId,
          kind: "shell.cmd",
          timeoutMs: 16_000,
          payload: {
            command: "pwd",
            waitMs: 1000,
            shellPermissionId: permissionId,
          },
        });
      }

      // Invalid completion returns HTTP 400 and leaves the command running.
      await fixture.computerUse.requestCompleteComputerUseCommand(
        host.connection,
        expectShellQueued(pwdCreated).commandId,
        { status: "succeeded", result: { nextCursor: -1 } },
        [400],
      );
      const stillRunning = await fixture.computerUse.readComputerUseCommand(
        { bearer: run2.token },
        expectShellQueued(pwdCreated).commandId,
      );
      expect(stillRunning.status).toBe("running");

      // Valid running-session completion transitions to succeeded and notifies
      // the existing result channel.
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();
      await fixture.computerUse.completeComputerUseCommandWith(
        host.connection,
        expectShellQueued(pwdCreated).commandId,
        {
          status: "succeeded",
          result: {
            session: shellSessionFixture(sessionId, {
              commandState: "running",
            }),
            reason: "wait_elapsed",
          },
        },
      );

      const completedPwd = await fixture.computerUse.readComputerUseCommand(
        { bearer: run2.token },
        expectShellQueued(pwdCreated).commandId,
      );
      expect(completedPwd).toMatchObject({
        status: "succeeded",
        result: {
          session: { id: sessionId, commandState: "running" },
        },
      });
      expect(
        channelsPublishedTo(
          context.mocks,
          computerUseCommandResultChangedEvent,
        ),
      ).toContain(expectedResultChannel);

      // Queue shell.list, then toggle the switch off, on, and off.
      const queuedList =
        await fixture.computerUse.requestCreateDesktopShellCommand(
          { bearer: run2.token },
          { kind: "shell.list", waitMs: 10_000 },
          [200],
        );

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: false,
        });
      });
      const failedAfterSwitchOff =
        await fixture.computerUse.readComputerUseCommand(
          { bearer: run2.token },
          expectShellQueued(queuedList).commandId,
        );
      expect(failedAfterSwitchOff).toMatchObject({
        status: "failed",
        error: { code: "permission_denied" },
      });

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: true,
        });
      });
      await expect(
        fixture.computerUse.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        ),
      ).resolves.toStrictEqual({ status: "idle" });

      await fixture.run(() => {
        return updateFeatureSwitchesForUser(context, memberIdentity, {
          [FeatureSwitchKey.DesktopShell]: false,
        });
      });
      await fixture.computerUse.requestCreateDesktopShellCommand(
        { bearer: run2.token },
        { kind: "shell.list", waitMs: 10_000 },
        [403],
      );
    },
  );
});
