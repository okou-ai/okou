import { randomUUID } from "node:crypto";

import { computerUseAuditEventsContract } from "@okouai/api-contracts/contracts/computer-use";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { computerUseRoutes } from "../computer-use";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return actor.orgId;
}

async function launchBoundRun(
  testCtx: TestContext,
  actor: ApiTestUser,
  hostId: string,
) {
  const bdd = createBddApi(testCtx);
  const runs = createRunsApi(testCtx);
  const chat = createChatFilesBddApi(testCtx);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");

  const [, runnerGroup] = await Promise.all([
    deliverOrganizationCreated(testCtx, actor),
    runs.configureRunnerGroup(),
  ]);

  const sent = await chat.requestSendEvent(
    actor,
    {
      prompt: "Run a computer-use command",
      model: null,
      clientEventId: randomUUID(),
      computerUseHostId: hostId,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected an accepted chat send");
  }
  await flushWaitUntilForTest();
  const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
  if (!dispatch) {
    throw new Error("Expected a dispatched Run");
  }
  const token = dispatch.executionContext.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected dispatched Run OKOU_TOKEN");
  }
  const runId = dispatch.executionContext.runId;
  const sandboxToken = dispatch.executionContext.sandboxToken;
  const issuedAt = now();

  onTestFinished(async () => {
    mockNow(issuedAt);
    await runs.requestCancelRun(actor, runId, [200, 400]);
    await createWebhookCallbackApi(testCtx).requestAgentComplete(
      { runId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${sandboxToken}` },
      [200, 400],
    );
    await flushWaitUntilForTest();
    clearMockNow();
  });

  return { token, runId, sandboxToken, threadId: sent.body.threadId };
}

describe("Computer Use audit events", () => {
  beforeAll(async () => {
    await createRunsApi(context).configureRunnerGroup();
  });

  it(
    "computer-use-audit-events-001 preserves session, Clerk OAuth session, PAT, organization and sandbox-token auth controls",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const authOrg = createAuthOrgBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const memberOrgId = requireOrgId(member);
      const noOrg = bdd.user({ orgId: null });

      const host = await api.startComputerUseHost(member, {
        hostName: "Audit Auth Desktop",
      });
      const run = await launchBoundRun(context, member, host.hostId);
      const pat = await authOrg.createCliToken(member);

      const created = await api.createComputerUseWriteCommand(member, {
        kind: "app.open",
        app: "Safari",
      });
      await api.claimNextComputerUseCommand(host.connection);
      await api.completeComputerUseCommand(host.connection, created.commandId);

      const anonymous = await api.requestListComputerUseAuditEvents(
        null,
        {},
        [401],
      );
      expectApiError(anonymous.body);

      const withoutOrg = await api.requestListComputerUseAuditEvents(
        noOrg,
        {},
        [401],
      );
      expectApiError(withoutOrg.body);

      const sessionEvents = await api.listComputerUseAuditEvents(member);
      expect(sessionEvents.auditEvents).toHaveLength(1);
      expect(sessionEvents.auditEvents[0]).toMatchObject({
        commandId: created.commandId,
        hostId: host.hostId,
        kind: "app.open",
        app: "Safari",
        event: "completed",
      });

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => {
          return {
            tokenType: "oauth_token",
            userId: member.userId,
            orgId: member.orgId,
            orgRole: member.orgRole,
          };
        },
      });
      const oauthSessionEvents = await accept(
        setupApp({ context, routes: computerUseRoutes })(
          computerUseAuditEventsContract,
        ).list({
          headers: { authorization: "Bearer clerk-oauth-session" },
          query: {},
        }),
        [200],
      );
      expect(oauthSessionEvents.body).toStrictEqual(sessionEvents);

      mockClerkMembership(context, member, "org:member");
      const patEvents = await api.listComputerUseAuditEvents({
        bearer: pat.token,
      });
      expect(patEvents).toStrictEqual(sessionEvents);

      const sandboxForbidden = {
        error: {
          message: "This endpoint is not available for sandbox tokens",
          code: "FORBIDDEN",
        },
      };
      const agentDenied = await api.requestListComputerUseAuditEvents(
        { bearer: run.token },
        {},
        [403],
      );
      expect(agentDenied.body).toStrictEqual(sandboxForbidden);

      const sandboxDenied = await api.requestListComputerUseAuditEvents(
        { bearer: run.sandboxToken },
        {},
        [403],
      );
      expect(sandboxDenied.body).toStrictEqual(sandboxForbidden);

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );
      await expect(
        api.listComputerUseAuditEvents(member),
      ).resolves.toStrictEqual(sessionEvents);
      const agentDeniedInDeviceMode =
        await api.requestListComputerUseAuditEvents(
          { bearer: run.token },
          {},
          [403],
        );
      expect(agentDeniedInDeviceMode.body).toStrictEqual(sandboxForbidden);
    },
  );

  it(
    "computer-use-audit-events-002 preserves exact owner isolation, every selector, nulls and complete redacted payloads",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const start = Date.parse("2026-02-01T12:00:00.000Z");
      mockNow(start);
      const bdd = createBddApi(context);
      const api = createComputerUseBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
      const foreign = bdd.user({ orgRole: "org:member" });

      const memberHost = await api.startComputerUseHost(member, {
        hostName: "Member Audit Desktop",
      });
      const peerHost = await api.startComputerUseHost(peer, {
        hostName: "Peer Audit Desktop",
      });
      const foreignHost = await api.startComputerUseHost(foreign, {
        hostName: "Foreign Audit Desktop",
      });

      const run = await launchBoundRun(context, member, memberHost.hostId);

      mockNow(start + 1000);
      const clickAt = nowDate().toISOString();
      mockClerkMembership(context, member, "org:member");
      const clickCommand = await api.createComputerUseWriteCommand(
        { bearer: run.token },
        {
          kind: "element.click",
          app: "Safari",
          snapshotId: "snap_audit_1",
          elementIndex: 2,
          button: "left",
          clickCount: 1,
        },
      );
      await api.claimNextComputerUseCommand(memberHost.connection);
      const privateAppState = "private-state";
      await api.completeComputerUseCommandWith(
        memberHost.connection,
        clickCommand.commandId,
        {
          status: "succeeded",
          result: {
            app: "Safari",
            elementIndex: 2,
            button: "left",
            clickCount: 1,
            appState: privateAppState,
            metrics: { durationMs: 42, retries: 0 },
          },
        },
      );

      mockNow(start + 2000);
      const failedAt = nowDate().toISOString();
      const failedCommand = await api.createComputerUseWriteCommand(member, {
        kind: "app.open",
        app: "Finder",
      });
      await api.claimNextComputerUseCommand(memberHost.connection);
      await api.completeComputerUseCommandWith(
        memberHost.connection,
        failedCommand.commandId,
        {
          status: "failed",
          error: {
            code: "app_not_found",
            message: "Finder is not available",
          },
        },
      );

      const peerCommand = await api.createComputerUseWriteCommand(peer, {
        kind: "app.open",
        app: "PeerSecretApp",
      });
      await api.claimNextComputerUseCommand(peerHost.connection);
      await api.completeComputerUseCommandWith(
        peerHost.connection,
        peerCommand.commandId,
        { status: "succeeded", result: { app: "PeerSecretApp", opened: true } },
      );

      const foreignCommand = await api.createComputerUseWriteCommand(foreign, {
        kind: "app.open",
        app: "ForeignSecretApp",
      });
      await api.claimNextComputerUseCommand(foreignHost.connection);
      await api.completeComputerUseCommandWith(
        foreignHost.connection,
        foreignCommand.commandId,
        {
          status: "succeeded",
          result: { app: "ForeignSecretApp", opened: true },
        },
      );

      const publishedBeforeRead = context.mocks.ably.publish.mock.calls.length;
      const batchedBeforeRead =
        context.mocks.ably.batchPublish.mock.calls.length;

      const full = await api.listComputerUseAuditEvents(member, { limit: 200 });
      expect(full.auditEvents).toHaveLength(2);
      expect(full.auditEvents).toStrictEqual([
        {
          id: expect.any(String),
          commandId: failedCommand.commandId,
          runId: null,
          hostId: memberHost.hostId,
          kind: "app.open",
          app: "Finder",
          event: "completed",
          redactedResult: null,
          error: {
            code: "app_not_found",
            message: "Finder is not available",
          },
          createdAt: failedAt,
        },
        {
          id: expect.any(String),
          commandId: clickCommand.commandId,
          runId: run.runId,
          hostId: memberHost.hostId,
          kind: "element.click",
          app: "Safari",
          event: "completed",
          redactedResult: {
            app: "Safari",
            button: "left",
            clickCount: 1,
            elementIndex: 2,
            appStateLength: privateAppState.length,
            metrics: { durationMs: 42, retries: 0 },
          },
          error: null,
          createdAt: clickAt,
        },
      ]);

      const serialized = JSON.stringify(full);
      expect(serialized).not.toContain(privateAppState);
      expect(serialized).not.toContain("PeerSecretApp");
      expect(serialized).not.toContain("ForeignSecretApp");

      const byHost = await api.listComputerUseAuditEvents(member, {
        hostId: memberHost.hostId,
      });
      expect(byHost).toStrictEqual(full);

      const byCommand = await api.listComputerUseAuditEvents(member, {
        commandId: clickCommand.commandId,
      });
      expect(byCommand.auditEvents).toStrictEqual([full.auditEvents[1]]);

      const byRun = await api.listComputerUseAuditEvents(member, {
        runId: run.runId,
      });
      expect(byRun).toStrictEqual(byCommand);

      const byAllThree = await api.listComputerUseAuditEvents(member, {
        commandId: clickCommand.commandId,
        hostId: memberHost.hostId,
        runId: run.runId,
      });
      expect(byAllThree).toStrictEqual(byRun);

      await expect(
        api.listComputerUseAuditEvents(member, {
          commandId: failedCommand.commandId,
          runId: run.runId,
        }),
      ).resolves.toStrictEqual({ auditEvents: [] });
      await expect(
        api.listComputerUseAuditEvents(member, {
          commandId: clickCommand.commandId,
          hostId: randomUUID(),
        }),
      ).resolves.toStrictEqual({ auditEvents: [] });
      await expect(
        api.listComputerUseAuditEvents(member, {
          commandId: peerCommand.commandId,
        }),
      ).resolves.toStrictEqual({ auditEvents: [] });
      await expect(
        api.listComputerUseAuditEvents(member, { hostId: peerHost.hostId }),
      ).resolves.toStrictEqual({ auditEvents: [] });
      await expect(
        api.listComputerUseAuditEvents(member, {
          commandId: foreignCommand.commandId,
        }),
      ).resolves.toStrictEqual({ auditEvents: [] });
      await expect(
        api.listComputerUseAuditEvents(member, { hostId: foreignHost.hostId }),
      ).resolves.toStrictEqual({ auditEvents: [] });

      expect(
        context.mocks.ably.publish.mock.calls.slice(publishedBeforeRead),
      ).toStrictEqual([]);
      expect(
        context.mocks.ably.batchPublish.mock.calls.slice(batchedBeforeRead),
      ).toStrictEqual([]);
    },
  );
});
