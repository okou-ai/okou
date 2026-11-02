import { randomUUID } from "node:crypto";
import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { browserAuthorizationRoutes } from "../browser-authorization";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, now } from "../../../lib/time";

const context = testContext();
const permission = "00000000-0000-4000-8000-000000000001";
const capabilities = [
  "apps.list",
  "shell.cmd",
  "shell.list",
  "shell.status",
  "shell.close",
  `shell.permission:${permission}`,
] as const;

// The complete wire record emitted by released 0.54.x Desktop builds.
const shellSession = {
  id: permission,
  state: "open",
  initialCwd: "/tmp",
  cwd: "/tmp",
  commandState: "running",
  exitCode: null,
  shellExitCode: null,
  shellExitSignal: null,
  closeReason: null,
  oldestCursor: 0,
  endCursor: 0,
  idleRemainingSeconds: 900,
  cols: 120,
  rows: 40,
} as const;

async function approveAndResume(
  scenario: ReturnType<typeof createPublicComputerUseScenario>,
  actor: Parameters<typeof scenario.claim>[0],
  initial: Awaited<ReturnType<typeof scenario.claim>>,
) {
  const api = scenario.computerUse;
  const requested = await api.requestDesktopShellAccess(
    { bearer: initial.token },
    "Inspect the project in Terminal",
  );
  if (requested.status !== 200) {
    throw new Error("Expected Shell access request");
  }
  const request = requested.body;
  expect(request).toMatchObject({
    status: "pending",
    chatThreadId: initial.threadId,
    requestedByRunId: initial.runId,
    approvalBlockedReason: "run_active",
    grantExpiresAt: null,
  });
  await api.actDesktopShellAccess(actor, request.id, "approve", [409]);
  const repeated = await api.requestDesktopShellAccess(
    { bearer: initial.token },
    "Inspect the project in Terminal",
  );
  expect(repeated.body).toMatchObject({ id: request.id });
  context.mocks.ably.publish.mockClear();
  await scenario.cancelRun(actor, initial.runId);
  await scenario.run(flushWaitUntilForTest);
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    "desktopShellAuthorizationChanged",
    null,
  );
  mockNow(now() + 1000);
  const decisions = await Promise.all([
    api.actDesktopShellAccess(actor, request.id, "approve", [200, 409]),
    api.actDesktopShellAccess(actor, request.id, "approve", [200, 409]),
  ]);
  const approved = decisions.find((result) => {
    return result.status === 200;
  });
  if (!approved || approved.status !== 200) {
    throw new Error("Expected approved Shell access");
  }
  expect(approved.body).toMatchObject({
    status: "approved",
    approvedAt: new Date(now()).toISOString(),
    grantExpiresAt: new Date(now() + 3_600_000).toISOString(),
  });
  await scenario.run(flushWaitUntilForTest);
  await api.actDesktopShellAccess(actor, request.id, "approve");
  const { events } = await createChatFilesBddApi(context).listThreadEvents(
    actor,
    initial.threadId,
  );
  expect(
    events.filter((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === request.id
      );
    }),
  ).toHaveLength(1);
  const launched = events.find((event) => {
    return (
      event.eventType === "input.prompt" && event.revokesEventId === request.id
    );
  });
  if (!launched?.runId) {
    throw new Error("Approval must launch the next Run");
  }
  const claim = await scenario.claimExisting(actor, launched.runId);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected claimed Run token");
  }
  return {
    ...initial,
    runId: launched.runId,
    token,
    authorization: approved.body,
  };
}

describe("Desktop Shell command pipeline", () => {
  it.each(["immediate", "queued"] as const)(
    "publishes committed chat_busy authorization when the %s pick acquires the chat slot",
    { timeout: 30_000 },
    async (pick) => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        const chat = createChatFilesBddApi(context);
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        const source = await scenario.claim(actor, host.hostId);
        const requested = await api.requestDesktopShellAccess(
          { bearer: source.token },
          "Inspect the project in Terminal",
        );
        if (requested.status !== 200) {
          throw new Error("Expected pending Shell access");
        }
        await scenario.cancelRun(actor, source.runId);
        await scenario.run(flushWaitUntilForTest);
        expect(
          (await api.readDesktopShellAccess(actor, requested.body.id)).body,
        ).toMatchObject({ status: "pending", approvalBlockedReason: null });

        const { agentId } = await scenario.prepareActor(actor);
        const send = async (clientEventId: string) => {
          await chat.requestSendEvent(
            actor,
            {
              agentId,
              threadId: source.threadId,
              prompt: "Continue working in this chat",
              clientEventId,
            },
            [201],
          );
          await scenario.run(flushWaitUntilForTest);
        };
        const launchedRun = async (clientEventId: string) => {
          const { events } = await chat.listThreadEvents(
            actor,
            source.threadId,
          );
          return events.find((event) => {
            return (
              event.eventType === "input.prompt" &&
              event.revokesEventId === clientEventId
            );
          })?.runId;
        };
        let blockingRunId: string | undefined;
        if (pick === "queued") {
          const blockingEventId = randomUUID();
          await send(blockingEventId);
          blockingRunId = await launchedRun(blockingEventId);
          if (!blockingRunId) {
            throw new Error("Expected a blocking Run in the chat");
          }
        }
        const nextEventId = randomUUID();
        if (pick === "queued") {
          await send(nextEventId);
          await expect(launchedRun(nextEventId)).resolves.toBeUndefined();
        }

        // Observe eligibility through HTTP at the notification boundary, so a
        // slot-release wakeup alone cannot satisfy the queued-pick regression.
        const notifiedReasons: (string | null)[] = [];
        context.mocks.ably.publish.mockClear();
        context.mocks.ably.publish.mockImplementation(async (topic) => {
          if (topic === "desktopShellAuthorizationChanged") {
            const current = await api.readDesktopShellAccess(
              actor,
              requested.body.id,
            );
            if (current.status !== 200) {
              throw new Error("Expected the pending Shell authorization");
            }
            notifiedReasons.push(current.body.approvalBlockedReason);
          }
        });
        if (blockingRunId) {
          await scenario.cancelRun(actor, blockingRunId);
          await scenario.run(flushWaitUntilForTest);
        } else {
          await send(nextEventId);
        }
        const nextRunId = await launchedRun(nextEventId);
        expect(nextRunId).toBeDefined();
        expect(notifiedReasons).toContain("chat_busy");
        expect(context.mocks.ably.publish).toHaveBeenCalledWith(
          "desktopShellAuthorizationChanged",
          null,
        );
        expect(
          (await api.readDesktopShellAccess(actor, requested.body.id)).body,
        ).toMatchObject({
          status: "pending",
          approvalBlockedReason: "chat_busy",
        });
        await api.actDesktopShellAccess(
          actor,
          requested.body.id,
          "approve",
          [409],
        );
        context.mocks.ably.publish.mockResolvedValue(undefined);
        if (nextRunId) {
          await scenario.cancelRun(actor, nextRunId);
        }
      });
    },
  );

  it.each(["cloud browser", "another computer", "queued send"] as const)(
    "notifies the owner when %s changes the computer for a pending Shell approval",
    { timeout: 30_000 },
    async (authorization) => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        const chat = createChatFilesBddApi(context);
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        const source = await scenario.claim(actor, host.hostId);
        const requested = await api.requestDesktopShellAccess(
          { bearer: source.token },
          "Inspect the project in Terminal",
        );
        if (requested.status !== 200) {
          throw new Error("Expected pending Shell access");
        }
        const browser = setupApp({
          context,
          routes: browserAuthorizationRoutes,
        })(browserAuthorizationRequestsContract);
        const created =
          authorization === "cloud browser"
            ? (
                await accept(
                  browser.create({
                    headers: {
                      authorization: `Bearer ${source.sandboxToken}`,
                    },
                    body: {},
                  }),
                  [200],
                )
              ).body
            : authorization === "another computer"
              ? await api.createComputerUseAuthorizationRequest({
                  bearer: source.token,
                })
              : null;
        const requestToken = created
          ? decodeURIComponent(
              new URL(created.authorizationUrl).pathname.slice(
                authorization === "cloud browser"
                  ? "/browser/authorize/".length
                  : "/computer-use/authorize/".length,
              ),
            )
          : null;
        const secondHost =
          authorization !== "cloud browser"
            ? await api.startComputerUseHost(actor, {
                supportedCapabilities: capabilities,
              })
            : null;
        await scenario.cancelRun(actor, source.runId);
        await scenario.run(flushWaitUntilForTest);
        expect(
          (await api.readDesktopShellAccess(actor, requested.body.id)).body,
        ).toMatchObject({ status: "pending", approvalBlockedReason: null });
        const { agentId } = await scenario.prepareActor(actor);
        const nextEventId = randomUUID();
        if (authorization === "queued send") {
          await chat.requestSendEvent(
            actor,
            {
              agentId,
              threadId: source.threadId,
              prompt: "Keep working on this computer",
              clientEventId: randomUUID(),
            },
            [201],
          );
          await scenario.run(flushWaitUntilForTest);
          expect(
            (await api.readDesktopShellAccess(actor, requested.body.id)).body,
          ).toMatchObject({ approvalBlockedReason: "chat_busy" });
        }

        const notifiedReasons: (string | null)[] = [];
        context.mocks.ably.publish.mockClear();
        context.mocks.ably.channelGet.mockClear();
        context.mocks.ably.publish.mockImplementation(async (topic) => {
          if (topic === "desktopShellAuthorizationChanged") {
            const current = await api.readDesktopShellAccess(
              actor,
              requested.body.id,
            );
            if (current.status !== 200) {
              throw new Error("Expected the pending Shell authorization");
            }
            notifiedReasons.push(current.body.approvalBlockedReason);
          }
        });
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        if (authorization === "queued send" && secondHost) {
          await chat.requestSendEvent(
            actor,
            {
              agentId,
              threadId: source.threadId,
              prompt: "Continue on the other computer",
              computerUseHostId: secondHost.hostId,
              clientEventId: nextEventId,
            },
            [201],
          );
        } else if (secondHost && requestToken) {
          await api.applyComputerUseAuthorizationRequest(
            actor,
            requestToken,
            secondHost.hostId,
          );
        } else if (requestToken) {
          await accept(
            browser.apply({
              headers: { authorization: "Bearer clerk-session" },
              params: { requestToken },
              body: {},
            }),
            [200],
          );
        } else {
          throw new Error("Expected the public computer-selection request");
        }
        await scenario.run(flushWaitUntilForTest);
        if (authorization === "queued send") {
          const { events } = await chat.listThreadEvents(
            actor,
            source.threadId,
          );
          expect(
            events.some((event) => {
              return (
                event.eventType === "input.prompt" &&
                event.revokesEventId === nextEventId &&
                event.runId !== undefined
              );
            }),
          ).toBeFalsy();
        }
        expect(notifiedReasons).toStrictEqual(["computer_changed"]);
        expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
          `user:${actor.userId}`,
        ]);
        await api.actDesktopShellAccess(
          actor,
          requested.body.id,
          "approve",
          [409],
        );
        context.mocks.ably.publish.mockResolvedValue(undefined);
      });
    },
  );

  it(
    "scopes approval to the owning chat and computer, and only accepts human decisions",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const other = scenario.user();
        const api = scenario.computerUse;
        const switches = createAuthDeviceSupportApi(context);
        await switches.updateFeatureSwitches(actor, { desktopShell: true });
        await switches.updateFeatureSwitches(other, { desktopShell: true });
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        const run = await approveAndResume(
          scenario,
          actor,
          await scenario.claim(actor, host.hostId),
        );
        await api.readDesktopShellAccess(other, run.authorization.id, [404]);
        await api.actDesktopShellAccess(
          other,
          run.authorization.id,
          "revoke",
          [404],
        );
        await api.actDesktopShellAccess(
          { bearer: run.token },
          run.authorization.id,
          "approve",
          [403],
        );
        await api.requestDesktopShellAccess(
          actor,
          "Bypass the Run context",
          [403],
        );
        await api.requestCreateDesktopShellCommand(
          actor,
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        const token = await scenario.createCliToken(actor);
        await api.requestCreateDesktopShellCommand(
          { bearer: token.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        const differentChat = await scenario.claim(actor, host.hostId);
        await api.requestCreateDesktopShellCommand(
          { bearer: differentChat.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        const requested = await api.requestDesktopShellAccess(
          { bearer: differentChat.token },
          "Need Terminal for this chat",
        );
        if (requested.status !== 200) {
          throw new Error("Expected request for second chat");
        }
        await scenario.cancelRun(actor, differentChat.runId);
        const secondHost = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        context.mocks.ably.publish.mockClear();
        await createChatFilesBddApi(context).updateThreadComputerUseHost(
          actor,
          differentChat.threadId,
          secondHost.hostId,
        );
        expect(context.mocks.ably.publish).toHaveBeenCalledWith(
          "desktopShellAuthorizationChanged",
          null,
        );
        const changed = await api.readDesktopShellAccess(
          actor,
          requested.body.id,
        );
        expect(changed.body).toMatchObject({
          approvalBlockedReason: "computer_changed",
        });
        await api.actDesktopShellAccess(
          actor,
          requested.body.id,
          "approve",
          [409],
        );
        await api.actDesktopShellAccess(actor, requested.body.id, "deny");
        await api.actDesktopShellAccess(
          actor,
          requested.body.id,
          "approve",
          [409],
        );
      });
    },
  );

  it(
    "revokes queued work without cancelling already claimed work or closing terminals",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        const run = await approveAndResume(
          scenario,
          actor,
          await scenario.claim(actor, host.hostId),
        );
        const running = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.cmd", command: "sleep 300", waitMs: 1000 },
          [200],
        );
        if (!("commandId" in running.body)) {
          throw new Error("Expected Shell operation");
        }
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({
          status: "command",
          command: { id: running.body.commandId, kind: "shell.cmd" },
        });
        const queued = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.status", sessionId: permission, waitMs: 1000 },
          [200],
        );
        if (!("commandId" in queued.body)) {
          throw new Error("Expected queued operation");
        }
        await api.actDesktopShellAccess(actor, run.authorization.id, "revoke");
        await api.actDesktopShellAccess(actor, run.authorization.id, "revoke");
        await api.completeComputerUseCommandWith(
          host.connection,
          running.body.commandId,
          {
            status: "succeeded",
            result: {
              session: shellSession,
              reason: "wait_elapsed",
            },
          },
        );
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            running.body.commandId,
          ),
        ).resolves.toMatchObject({
          status: "succeeded",
          result: { session: { state: "open" } },
        });
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            queued.body.commandId,
          ),
        ).resolves.toMatchObject({
          status: "failed",
          error: { code: "permission_denied" },
        });
        for (const request of [
          { kind: "shell.list", waitMs: 1000 },
          { kind: "shell.close", all: true, waitMs: 1000 },
          { kind: "shell.cmd", sessionId: permission, waitMs: 1000 },
        ] as const) {
          await api.requestCreateDesktopShellCommand(
            { bearer: run.token },
            request,
            [403],
          );
        }
        const renewed = await approveAndResume(scenario, actor, run);
        expect(renewed.authorization.id).not.toBe(run.authorization.id);
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({ status: "idle" });
        const reuse = await api.requestCreateDesktopShellCommand(
          { bearer: renewed.token },
          {
            kind: "shell.cmd",
            sessionId: permission,
            input: "yes\n",
            waitMs: 1000,
          },
          [200],
        );
        if (!("commandId" in reuse.body)) {
          throw new Error("Expected existing terminal reuse");
        }
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({
          status: "command",
          command: {
            id: reuse.body.commandId,
            payload: {
              sessionId: permission,
              input: "yes\n",
              shellPermissionId: permission,
            },
          },
        });
      });
    },
  );

  it(
    "expires grants at the dispatch boundary and expires unapproved requests separately",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
        });
        const run = await approveAndResume(
          scenario,
          actor,
          await scenario.claim(actor, host.hostId),
        );
        const expiresAt = Date.parse(run.authorization.grantExpiresAt ?? "");
        mockNow(expiresAt - 1);
        await api.heartbeatComputerUseHost(host.connection, {
          supportedCapabilities: capabilities,
        });
        const queued = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [200],
        );
        if (!("commandId" in queued.body)) {
          throw new Error("Expected queued operation before expiry");
        }
        mockNow(expiresAt);
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({ status: "idle" });
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            queued.body.commandId,
          ),
        ).resolves.toMatchObject({
          status: "failed",
          error: { code: "permission_denied" },
        });
        expect(
          (await api.readDesktopShellAccess(actor, run.authorization.id)).body,
        ).toMatchObject({ status: "expired" });
        await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        const requested = await api.requestDesktopShellAccess(
          { bearer: run.token },
          "Renew expired access",
        );
        if (requested.status !== 200) {
          throw new Error("Expected new request after grant expiry");
        }
        expect(requested.body.id).not.toBe(run.authorization.id);
        await scenario.cancelRun(actor, run.runId);
        mockNow(Date.parse(requested.body.requestExpiresAt));
        await api.actDesktopShellAccess(
          actor,
          requested.body.id,
          "approve",
          [410],
        );
        expect(
          (await api.readDesktopShellAccess(actor, requested.body.id)).body,
        ).toMatchObject({ status: "expired", grantExpiresAt: null });
      });
    },
  );

  it(
    "uses the authorized computer, explicit local capabilities and the existing result channel",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        context.mocks.ably.createTokenRequest.mockResolvedValue({
          keyName: "test.key",
          timestamp: 1,
          nonce: "nonce",
          mac: "signed",
          capability: "{}",
        });
        const api = scenario.computerUse;
        const switches = createAuthDeviceSupportApi(context);
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
          permissions: { accessibility: false, screenRecording: false },
        });
        await api.requestCreateDesktopShellCommand(
          actor,
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        await switches.updateFeatureSwitches(actor, { desktopShell: true });
        const initial = await scenario.claim(actor, host.hostId);
        const denied = await api.requestCreateDesktopShellCommand(
          { bearer: initial.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        expect(denied.body).toMatchObject({
          error: { code: "SHELL_AUTHORIZATION_REQUIRED" },
        });
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({ status: "idle" });
        const run = await approveAndResume(scenario, actor, initial);
        const created = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.cmd", command: "pwd", waitMs: 1000, realtime: true },
          [200],
        );
        if (!("commandId" in created.body)) {
          throw new Error("Expected queued Shell operation");
        }
        expect(context.mocks.ably.publish).toHaveBeenCalledWith(
          "commandsChanged",
          null,
        );
        const claimed = await api.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        );
        expect(claimed).toMatchObject({
          status: "command",
          command: {
            id: created.body.commandId,
            hostId: host.hostId,
            kind: "shell.cmd",
            timeoutMs: 16_000,
            payload: {
              command: "pwd",
              waitMs: 1000,
              shellPermissionId: permission,
            },
          },
        });
        await api.requestCompleteComputerUseCommand(
          host.connection,
          created.body.commandId,
          { status: "succeeded", result: { nextCursor: -1 } },
          [400],
        );
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            created.body.commandId,
          ),
        ).resolves.toMatchObject({ status: "running" });
        // A transport success may report a still-running foreground command.
        await api.completeComputerUseCommandWith(
          host.connection,
          created.body.commandId,
          {
            status: "succeeded",
            result: {
              session: shellSession,
              reason: "wait_elapsed",
            },
          },
        );
        const result = await api.readComputerUseCommand(
          { bearer: run.token },
          created.body.commandId,
        );
        expect(result).toMatchObject({
          status: "succeeded",
          result: { session: { commandState: "running" } },
        });
        const queued = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [200],
        );
        if (!("commandId" in queued.body)) {
          throw new Error("Expected queued observation");
        }
        await switches.updateFeatureSwitches(actor, { desktopShell: false });
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            queued.body.commandId,
          ),
        ).resolves.toMatchObject({
          status: "failed",
          error: { code: "permission_denied" },
        });
        await switches.updateFeatureSwitches(actor, { desktopShell: true });
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({ status: "idle" });
        await switches.updateFeatureSwitches(actor, { desktopShell: false });
        await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
      });
    },
  );

  it(
    "never routes shell work to old hosts with empty capabilities or an unbound run",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const old = await api.startComputerUseHost(actor, {
          supportedCapabilities: [],
        });
        const oldRun = await scenario.claim(actor, old.hostId);
        await api.requestCreateDesktopShellCommand(
          { bearer: oldRun.token },
          { kind: "shell.list", waitMs: 1000 },
          [409],
        );
        await expect(
          api.claimNextComputerUseCommand(old.connection, []),
        ).resolves.toMatchObject({ status: "idle" });
        const unbound = await scenario.claim(actor);
        await api.requestCreateDesktopShellCommand(
          { bearer: unbound.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
      });
    },
  );
});
