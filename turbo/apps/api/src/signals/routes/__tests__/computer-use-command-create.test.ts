import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
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

const STARTED_AT_MS = Date.parse("2026-09-19T01:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;
const PLUGIN_BODY = {
  plugin: "filesystem",
  tool: "read_text_file",
  arguments: { path: "/tmp/r21.txt" },
} as const;
const HOST_CAPABILITIES = [
  "apps.list",
  "app.open",
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
  computerUsePluginToolCapability(
    COMPUTER_USE_FILESYSTEM_PLUGIN,
    "read_text_file",
  ),
] as const;

type CommandKind = "read" | "write" | "plugin";
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;
type CreationStatus = 200 | 400 | 401 | 403 | 404 | 409;
aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (!actor.orgId) {
    throw new Error("Computer Use command creation requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

async function enablePlugins(
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

function agentAuth(args: {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly hostId?: string;
  readonly runId?: string;
  readonly capabilities?: readonly Capability[];
}): { readonly bearer: string; readonly runId: string } {
  mockClerkMembership(context, args.actor, "org:admin");
  const token = computerUseToken({
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    capabilities: args.capabilities ?? ["computer-use:write"],
    ...(args.hostId ? { computerUseHostId: args.hostId } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
  });
  return { bearer: token.token, runId: token.runId };
}

function requestCreate(
  kind: CommandKind,
  auth: ComputerUseAuth,
  statuses: readonly CreationStatus[],
  signal?: AbortSignal,
) {
  if (kind === "read") {
    return computerUse.requestCreateComputerUseReadCommand(
      auth,
      { kind: "apps.list", timeoutMs: 11_001 },
      statuses,
      signal,
    );
  }
  if (kind === "write") {
    return computerUse.requestCreateComputerUseWriteCommand(
      auth,
      statuses,
      { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
      signal,
    );
  }
  return computerUse.requestCreateComputerUsePluginCommand(
    auth,
    { ...PLUGIN_BODY, timeoutMs: 13_003 },
    statuses,
    signal,
  );
}

async function createCommand(
  kind: CommandKind,
  auth: Exclude<ComputerUseAuth, null>,
  signal?: AbortSignal,
): Promise<{ readonly commandId: string; readonly status: "queued" }> {
  const response = await requestCreate(kind, auth, [200], signal);
  if (!("commandId" in response.body)) {
    throw new Error(`Expected ${kind} command creation response`);
  }
  return response.body;
}

async function startCapableHost(actor: ApiTestUser, name = "R21 Desktop") {
  return await computerUse.startComputerUseHost(actor, {
    hostName: name,
    supportedCapabilities: HOST_CAPABILITIES,
  });
}

function clearExternalEffects(): void {
  context.mocks.ably.publish.mockClear();
  context.mocks.s3.send.mockClear();
}

function expectNoExternalEffects(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  expect(context.mocks.s3.send).not.toHaveBeenCalled();
}

async function claimAndComplete(args: {
  readonly hostToken: string;
  readonly commandId: string;
  readonly capabilities?: readonly string[];
}): Promise<void> {
  const claimed = await computerUse.claimNextComputerUseCommand(
    args.hostToken,
    args.capabilities ?? HOST_CAPABILITIES,
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: args.commandId, status: "running" },
  });
  await computerUse.completeComputerUseCommandWith(
    args.hostToken,
    args.commandId,
    {
      status: "failed",
      error: { code: "app_not_found", message: "R21 test completion" },
    },
  );
}

describe("Computer Use command creation", () => {
  it(
    "preserves exact session, PAT and bound Agent creation semantics with public read/claim/audit evidence",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const sessionActor = orgScoped(bdd.user());
      const sessionHost = await startCapableHost(
        sessionActor,
        "Session Desktop",
      );
      clearExternalEffects();
      const sessionCreated = await createCommand("read", sessionActor);
      expect(sessionCreated).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
      const sessionRead = await computerUse.readComputerUseCommand(
        sessionActor,
        sessionCreated.commandId,
      );
      expect(sessionRead).toMatchObject({
        id: sessionCreated.commandId,
        hostId: sessionHost.hostId,
        kind: "apps.list",
        status: "queued",
        timeoutMs: 11_001,
        payload: {},
      });
      expect(
        (
          await computerUse.listComputerUseAuditEvents(sessionActor, {
            commandId: sessionCreated.commandId,
          })
        ).auditEvents,
      ).toStrictEqual([]);
      expectNoExternalEffects();
      await claimAndComplete({
        hostToken: sessionHost.hostToken,
        commandId: sessionCreated.commandId,
      });

      const patActor = orgScoped(bdd.user());
      const patHost = await startCapableHost(patActor, "PAT Desktop");
      const { token: pat } = await authOrg.createCliToken(patActor);
      mockClerkMembership(context, patActor, "org:admin");
      const patCreated = await createCommand("write", { bearer: pat });
      const patClaimed = await computerUse.claimNextComputerUseCommand(
        patHost.hostToken,
        HOST_CAPABILITIES,
      );
      expect(patClaimed).toMatchObject({
        status: "command",
        command: {
          id: patCreated.commandId,
          hostId: patHost.hostId,
          kind: "app.open",
          timeoutMs: 12_002,
          payload: { app: "Safari" },
        },
      });
      await computerUse.completeComputerUseCommand(
        patHost.hostToken,
        patCreated.commandId,
      );
      const patAudit = await computerUse.listComputerUseAuditEvents(patActor, {
        commandId: patCreated.commandId,
      });
      expect(patAudit.auditEvents).toHaveLength(1);
      expect(patAudit.auditEvents[0]).toMatchObject({
        commandId: patCreated.commandId,
        runId: null,
      });

      const agentActor = orgScoped(bdd.user());
      await enablePlugins(agentActor);
      const agentHost = await startCapableHost(agentActor, "Agent Desktop");
      const agent = agentAuth({
        actor: agentActor,
        hostId: agentHost.hostId,
        runId: `run_${randomUUID()}`,
      });
      const agentCreated = await createCommand("plugin", {
        bearer: agent.bearer,
      });
      const agentClaimed = await computerUse.claimNextComputerUseCommand(
        agentHost.hostToken,
        HOST_CAPABILITIES,
      );
      expect(agentClaimed).toMatchObject({
        status: "command",
        command: {
          id: agentCreated.commandId,
          hostId: agentHost.hostId,
          kind: "plugin.call",
          timeoutMs: 13_003,
          payload: PLUGIN_BODY,
        },
      });
      await computerUse.completeComputerUseCommandWith(
        agentHost.hostToken,
        agentCreated.commandId,
        {
          status: "succeeded",
          result: {
            plugin: "filesystem",
            tool: "read_text_file",
            sizeBytes: 0,
          },
        },
      );
      const agentAudit = await computerUse.listComputerUseAuditEvents(
        agentActor,
        { commandId: agentCreated.commandId },
      );
      expect(agentAudit.auditEvents).toHaveLength(1);
      expect(agentAudit.auditEvents[0]).toMatchObject({
        commandId: agentCreated.commandId,
        hostId: agentHost.hostId,
        runId: agent.runId,
        kind: "plugin.call",
      });
    },
  );

  it(
    "keeps authentication, feature, bound-host and 404/409 eligibility precedence unchanged",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      expect((await requestCreate("read", null, [401])).status).toBe(401);

      const disabled = await requestCreate("plugin", actor, [403]);
      expectApiError(disabled.body);
      expect(disabled.body.error.message).toBe(
        "Computer Use Desktop plugins are disabled",
      );

      const unbound = agentAuth({ actor });
      const unboundResponse = await requestCreate(
        "read",
        { bearer: unbound.bearer },
        [403],
      );
      expectApiError(unboundResponse.body);
      expect(unboundResponse.body.error.message).toBe(
        "Computer-use host is not authorized for this run",
      );

      const noHost = await requestCreate("read", actor, [404]);
      expectApiError(noHost.body);
      expect(noHost.body.error.message).toBe(
        "No linked computer-use host found",
      );

      await computerUse.startComputerUseHost(actor, {
        hostName: "Unsupported Desktop",
        supportedCapabilities: ["apps.list"],
      });
      const unsupported = await requestCreate("write", actor, [409]);
      expectApiError(unsupported.body);
      expect(unsupported.body.error.message).toBe(
        "No online computer-use host supports this command",
      );

      await startCapableHost(actor, "Second Desktop");
      const ambiguous = await requestCreate("read", actor, [409]);
      expectApiError(ambiguous.body);
      expect(ambiguous.body.error.message).toBe(
        "Multiple active computer-use hosts are online",
      );

      mockNow(STARTED_AT_MS + 91_000);
      const offline = await requestCreate("read", actor, [409]);
      expectApiError(offline.body);
      expect(offline.body.error.message).toBe(
        "No online computer-use host found",
      );
    },
  );
});
