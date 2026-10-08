import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ComputerUseCommandError,
  ComputerUseCommandResult,
} from "@okouai/api-contracts/contracts/computer-use";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  computerUseToken,
  createComputerUseBddApi,
} from "./helpers/api-bdd-computer-use";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T13:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

/** Fails immediately when the operation terminates before its expected gate. */
aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use audit events require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

/** Projects one dormant B1 closure and retires exactly that test-owned job. */
function clearPublications(): void {
  context.mocks.ably.publish.mockClear();
}

function expectNoPublications(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

async function startAuditHost(actor: ApiTestUser, hostName: string) {
  return await computerUse.startComputerUseHost(actor, {
    installationId: randomUUID(),
    hostName,
    supportedCapabilities: [
      "apps.list",
      "app.state",
      "app.open",
      "element.click",
      COMPUTER_USE_PLUGIN_CALL_KIND,
      computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
      computerUsePluginToolCapability(
        COMPUTER_USE_FILESYSTEM_PLUGIN,
        "read_text_file",
      ),
    ],
    permissions: { accessibility: true, screenRecording: true },
  });
}

async function claimAndComplete(
  hostToken: string,
  commandId: string,
  body:
    | {
        readonly status: "succeeded";
        readonly result: ComputerUseCommandResult;
      }
    | {
        readonly status: "failed";
        readonly error: ComputerUseCommandError;
      },
  supportedCapabilities?: readonly string[],
): Promise<void> {
  const claimed = await computerUse.claimNextComputerUseCommand(
    hostToken,
    supportedCapabilities,
  );
  expect(claimed.status).toBe("command");
  if (claimed.status !== "command") {
    throw new Error("Expected the audit fixture command to be claimed");
  }
  expect(claimed.command.id).toBe(commandId);
  await computerUse.completeComputerUseCommandWith(hostToken, commandId, body);
}

async function createSimpleAuditEvent(actor: ApiTestUser, label: string) {
  const host = await startAuditHost(actor, `${label} Desktop`);
  const created = await computerUse.createComputerUseWriteCommand(actor, {
    kind: "app.open",
    app: label,
  });
  await claimAndComplete(host.hostToken, created.commandId, {
    status: "succeeded",
    result: { app: label, opened: true },
  });
  return { host, commandId: created.commandId };
}

async function enableComputerUseDesktopPlugins(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    { [FeatureSwitchKey.ComputerUseDesktopPlugins]: true },
  );
}

const PLUGIN_CAPABILITIES = [
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
  computerUsePluginToolCapability(
    COMPUTER_USE_FILESYSTEM_PLUGIN,
    "read_text_file",
  ),
] as const;

describe("Computer Use audit events", () => {
  it(
    "preserves session, Clerk OAuth session, PAT, organization and sandbox-token auth controls",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { host, commandId } = await createSimpleAuditEvent(actor, "Auth");

      const unauthenticated =
        await computerUse.requestListComputerUseAuditEvents(null, {}, [401]);
      expectApiError(unauthenticated.body);

      const noOrganization = bdd.user({ orgId: null });
      const missingOrganization =
        await computerUse.requestListComputerUseAuditEvents(
          noOrganization,
          {},
          [401],
        );
      expectApiError(missingOrganization.body);

      const session = await computerUse.listComputerUseAuditEvents(actor);
      expect(
        session.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual([commandId]);

      // Clerk OAuth-backed browser sessions reach this route through the same
      // externally authenticated Clerk request boundary as cookie sessions.
      const oauthSession = await computerUse.listComputerUseAuditEvents({
        bearer: "clerk-oauth-session",
      });
      expect(oauthSession).toStrictEqual(session);

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      const personalAccessToken = await computerUse.listComputerUseAuditEvents({
        bearer: pat,
      });
      expect(personalAccessToken).toStrictEqual(session);

      const agent = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
        computerUseHostId: host.hostId,
      });
      const agentDenied = await computerUse.requestListComputerUseAuditEvents(
        { bearer: agent.token },
        {},
        [403],
      );
      expect(agentDenied.body).toStrictEqual({
        error: {
          message: "This endpoint is not available for sandbox tokens",
          code: "FORBIDDEN",
        },
      });

      const sandbox = generateSandboxToken(
        actor.userId,
        randomUUID(),
        actor.orgId,
      );
      const sandboxDenied = await computerUse.requestListComputerUseAuditEvents(
        { bearer: sandbox },
        {},
        [403],
      );
      expect(sandboxDenied.body).toStrictEqual(agentDenied.body);
    },
  );

  it(
    "preserves exact owner isolation, every selector, nulls and complete redacted payloads",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreign = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      await enableComputerUseDesktopPlugins(actor);
      const s3 = computerUse.installComputerUseS3Fake();
      const host = await startAuditHost(actor, "Payload Desktop");
      mockClerkMembership(context, actor, "org:admin");
      const granted = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
        computerUseHostId: host.hostId,
      });

      const succeeded = await computerUse.createComputerUseWriteCommand(
        { bearer: granted.token },
        {
          kind: "element.click",
          app: "Safari",
          snapshotId: "snap_audit",
          elementIndex: 7,
          button: "left",
          clickCount: 1,
        },
      );
      await claimAndComplete(host.hostToken, succeeded.commandId, {
        status: "succeeded",
        result: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appState: "private state",
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 13,
            visibleElementCount: 2,
          },
        },
      });

      mockNow(STARTED_AT_MS + 1000);
      const failed = await computerUse.createComputerUseWriteCommand(actor, {
        kind: "app.open",
        app: "Finder",
      });
      await claimAndComplete(host.hostToken, failed.commandId, {
        status: "failed",
        error: { code: "app_not_found", message: "Finder is unavailable" },
      });

      mockNow(STARTED_AT_MS + 2000);
      await computerUse.heartbeatComputerUseHost(host.hostToken, {
        hostName: "Payload Desktop",
        supportedCapabilities: [
          "apps.list",
          "app.state",
          "app.open",
          "element.click",
          ...PLUGIN_CAPABILITIES,
        ],
        permissions: { accessibility: true, screenRecording: true },
      });
      const plugin = await computerUse.createComputerUsePluginCommand(actor, {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/private.txt" },
      });
      const privateContent = Buffer.from("private plugin payload");
      await claimAndComplete(
        host.hostToken,
        plugin.commandId,
        {
          status: "succeeded",
          result: {
            plugin: "filesystem",
            tool: "read_text_file",
            sizeBytes: privateContent.length,
            pluginContent: {
              dataBase64: privateContent.toString("base64"),
              mimeType: "text/plain",
              fileName: "private.txt",
            },
          },
        },
        PLUGIN_CAPABILITIES,
      );
      expect(s3.puts).toHaveLength(1);

      const peerEvent = await createSimpleAuditEvent(peer, "Peer Secret");
      const foreignEvent = await createSimpleAuditEvent(
        foreign,
        "Foreign Secret",
      );
      clearPublications();

      const all = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 200,
      });
      expect(
        all.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual([
        plugin.commandId,
        failed.commandId,
        succeeded.commandId,
      ]);
      expect(all.auditEvents[0]).toStrictEqual({
        id: expect.any(String),
        commandId: plugin.commandId,
        runId: null,
        hostId: host.hostId,
        kind: "plugin.call",
        app: null,
        event: "completed",
        redactedResult: {
          plugin: "filesystem",
          tool: "read_text_file",
          status: "succeeded",
          destructive: false,
          path: "/tmp/private.txt",
          offloaded: true,
          sizeBytes: privateContent.length,
          fileName: "private.txt",
          mimeType: "text/plain",
        },
        error: null,
        createdAt: new Date(STARTED_AT_MS + 2000).toISOString(),
      });
      expect(all.auditEvents[1]).toStrictEqual({
        id: expect.any(String),
        commandId: failed.commandId,
        runId: null,
        hostId: host.hostId,
        kind: "app.open",
        app: "Finder",
        event: "completed",
        redactedResult: null,
        error: { code: "app_not_found", message: "Finder is unavailable" },
        createdAt: new Date(STARTED_AT_MS + 1000).toISOString(),
      });
      expect(all.auditEvents[2]).toStrictEqual({
        id: expect.any(String),
        commandId: succeeded.commandId,
        runId: granted.runId,
        hostId: host.hostId,
        kind: "element.click",
        app: "Safari",
        event: "completed",
        redactedResult: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appStateLength: 13,
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 13,
            visibleElementCount: 2,
          },
        },
        error: null,
        createdAt: new Date(STARTED_AT_MS).toISOString(),
      });
      expect(JSON.stringify(all)).not.toContain("private state");
      expect(JSON.stringify(all)).not.toContain("private plugin payload");
      expect(JSON.stringify(all)).not.toContain("Peer Secret");
      expect(JSON.stringify(all)).not.toContain("Foreign Secret");

      const byCommand = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: succeeded.commandId,
      });
      expect(byCommand.auditEvents).toStrictEqual([all.auditEvents[2]]);
      const byHost = await computerUse.listComputerUseAuditEvents(actor, {
        hostId: host.hostId,
      });
      expect(byHost).toStrictEqual(all);
      const byRun = await computerUse.listComputerUseAuditEvents(actor, {
        runId: granted.runId,
      });
      expect(byRun.auditEvents).toStrictEqual([all.auditEvents[2]]);
      const combined = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: succeeded.commandId,
        hostId: host.hostId,
        runId: granted.runId,
      });
      expect(combined).toStrictEqual(byRun);

      for (const foreignSelector of [
        { commandId: peerEvent.commandId },
        { hostId: peerEvent.host.hostId },
        { commandId: foreignEvent.commandId },
        { hostId: foreignEvent.host.hostId },
      ]) {
        const hidden = await computerUse.listComputerUseAuditEvents(
          actor,
          foreignSelector,
        );
        expect(hidden.auditEvents).toStrictEqual([]);
      }
      expectNoPublications();
    },
  );

  it(
    "preserves default 50, explicit limits, max 200, descending order and empty results",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startAuditHost(actor, "Limit Desktop");
      const commandIds: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        mockNow(STARTED_AT_MS + index * 1000);
        const created = await computerUse.createComputerUseWriteCommand(actor, {
          kind: "app.open",
          app: `Limit ${index}`,
        });
        await claimAndComplete(host.hostToken, created.commandId, {
          status: "succeeded",
          result: { app: `Limit ${index}`, opened: true },
        });
        commandIds.push(created.commandId);
      }

      const expectedDescending = [...commandIds].reverse();
      const defaultPage = await computerUse.listComputerUseAuditEvents(actor);
      expect(defaultPage.auditEvents).toHaveLength(50);
      expect(
        defaultPage.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending.slice(0, 50));

      const explicit = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 7,
      });
      expect(
        explicit.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending.slice(0, 7));

      const maximum = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 200,
      });
      expect(
        maximum.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending);

      const empty = await computerUse.listComputerUseAuditEvents(actor, {
        runId: `missing_${randomUUID()}`,
      });
      expect(empty.auditEvents).toStrictEqual([]);

      await expect(
        computerUse.requestListComputerUseAuditEvents(
          actor,
          { limit: 201 },
          [200],
        ),
      ).rejects.toThrow(/status 400/);
    },
  );

  it(
    "preserves empty-string and malformed selector behavior without poisoning later reads",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Selector");
      const unfiltered = await computerUse.listComputerUseAuditEvents(actor);
      const emptySelectors = await computerUse.listComputerUseAuditEvents(
        actor,
        {
          commandId: "",
          hostId: "",
          runId: "",
        },
      );
      expect(emptySelectors).toStrictEqual(unfiltered);

      for (const malformed of [
        { commandId: "not-a-uuid" },
        { hostId: "not-a-uuid" },
      ]) {
        await expect(
          computerUse.requestListComputerUseAuditEvents(
            actor,
            malformed,
            [200, 403],
          ),
        ).rejects.toThrow(/Unknown response status 500/);
      }
      const textSelector = await computerUse.listComputerUseAuditEvents(actor, {
        runId: "not-a-uuid",
      });
      expect(textSelector.auditEvents).toStrictEqual([]);

      const recovered = await computerUse.listComputerUseAuditEvents(actor, {
        commandId,
      });
      expect(recovered.auditEvents).toHaveLength(1);
    },
  );
});
