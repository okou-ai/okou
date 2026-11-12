import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { runnersRoutes } from "../runners";
import { sshAccessRoutes } from "../ssh-access";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import {
  createConnectorBddApi,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { sshAuthorizationContract as contract } from "@okouai/api-contracts/contracts/ssh-authorization";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { sshAuthorizationRoutes } from "../ssh-authorization";
import { sshConnectionsRoutes } from "../ssh-connections";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicRemoteAccessRunApi } from "./helpers/public-remote-access-run";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { inlineSshKey } from "./helpers/ssh-credential";

const context = testContext();
const mocks = createRouteMocks(context);
describe("SSH chat authorization", () => {
  const publicRuns = createPublicRemoteAccessRunApi(context);
  const headers = { authorization: "Bearer clerk-session" };
  const api = () => {
    return setupApp({ context, routes: sshAuthorizationRoutes })(contract);
  };
  const hosts = () => {
    return setupApp({ context, routes: sshConnectionsRoutes })(
      sshConnectionsContract,
    );
  };
  const access = () => {
    return setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
  };
  const resumed: {
    runId: string;
    actor: Awaited<ReturnType<typeof publicRuns.start>>["actor"];
    sandboxToken?: string;
  }[] = [];
  function authenticate(owner: { userId: string; orgId: string }) {
    mocks.clerk.session(owner.userId, owner.orgId);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: "org:member",
          organization: { id: owner.orgId },
          publicUserData: { userId: owner.userId },
        },
      ],
    });
  }
  afterEach(async () => {
    for (const { actor, runId, sandboxToken } of resumed.splice(0)) {
      await createRunsApi(context).requestCancelRun(actor, runId, [200]);
      if (sandboxToken) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "SSH approval test cleanup" },
          { authorization: `Bearer ${sandboxToken}` },
          [200],
        );
      }
    }
    await flushWaitUntilForTest();
    await publicRuns.cleanup();
  });
  async function scenario(memberMode = false) {
    mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
    const owner = {
      userId: `user_ssh_approval_${randomUUID()}`,
      orgId: `org_ssh_approval_${randomUUID()}`,
    };
    const pending = await publicRuns.start(owner);
    await createAuthDeviceSupportApi(context).updateFeatureSwitches(
      pending.actor,
      { sshChatApproval: true, connectorChatAccountAccess: memberMode },
    );
    const run = await publicRuns.claim(pending, {
      authorization: `Bearer vm0_official_${"c".repeat(64)}`,
    });
    authenticate(owner);
    const host = await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Work Mac",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", "private-key", null),
        },
      }),
      [201],
    );
    await accept(
      access().setThreadOverride({
        headers,
        params: {
          threadId: run.threadId,
          protocol: "ssh",
          connectionId: host.body.id,
        },
        body: { enabled: false },
      }),
      [200],
    );
    const token = { authorization: `Bearer ${run.agentToken}` };
    const body = {
      connectionId: host.body.id,
      reason: "Verify SSH login",
      callbackPrompt: "Recheck SSH access and continue setup",
      requiredPermissions: [],
    };
    return { run, host: host.body, owner, token, body };
  }
  async function end(run: Awaited<ReturnType<typeof scenario>>["run"]) {
    await publicRuns.finish(run, "completed");
    authenticate(run);
  }

  it("approves just this host in this chat and enqueues one continuation across repeated decisions", async () => {
    const s = await scenario();
    const created = await accept(
      api().create({ headers: s.token, body: s.body }),
      [200],
    );
    expect(created.body).toMatchObject({
      status: "pending",
      enabled: false,
      approvalBlockedReason: "run_active",
      username: "deploy",
    });
    const repeated = await accept(
      api().create({ headers: s.token, body: s.body }),
      [200],
    );
    expect(repeated.body.id).toBe(created.body.id);
    const params = { id: created.body.id };
    await accept(api().approve({ headers, params, body: {} }), [409]);
    await accept(
      api().approve({ headers: s.token, params, body: {} }),
      [401, 403],
    );
    await end(s.run);
    const before = await createChatFilesBddApi(context).listThreadEvents(
      s.run.actor,
      s.run.threadId,
    );
    authenticate(s.owner);
    const decisions = await Promise.all([
      api().approve({ headers, params, body: {} }),
      api().approve({ headers, params, body: {} }),
    ]);
    expect(
      decisions.map((decision) => {
        return decision.status;
      }),
    ).toStrictEqual([200, 200]);
    const allowed = await accept(Promise.resolve(decisions[0]!), [200]);
    expect(allowed.body).toMatchObject({
      status: "approved",
      enabled: true,
      continuationPending: false,
    });
    await flushWaitUntilForTest();
    const after = await createChatFilesBddApi(context).listThreadEvents(
      s.run.actor,
      s.run.threadId,
    );
    const launched = after.events.filter((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === created.body.id
      );
    });
    expect(launched).toHaveLength(1);
    if (!launched[0]?.runId) {
      throw new Error("Expected automatic continuation Run");
    }
    const continuationOwner: (typeof resumed)[number] = {
      actor: s.run.actor,
      runId: launched[0].runId,
    };
    resumed.push(continuationOwner);
    const claimed = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
        extraHeaders: { "X-Client-Version": "0.234.18" },
        query: { workflowSkills: "2" },
        params: { id: launched[0].runId },
        body: {
          runnerIdentity: s.run.runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        },
      }),
      [200],
    );
    const nextToken = claimed.body.platformEnvironment.OKOU_TOKEN;
    continuationOwner.sandboxToken = claimed.body.sandboxToken;
    if (!nextToken) {
      throw new Error("Expected the continuation Run credential");
    }
    const inventory = await accept(
      setupApp({ context, routes: sshAccessRoutes })(sshHostsContract).list({
        headers: { authorization: `Bearer ${nextToken}` },
      }),
      [200],
    );
    expect(inventory.body.hosts).toContainEqual(
      expect.objectContaining({
        id: s.host.id,
        availability: { status: "ready" },
      }),
    );
    expect(
      after.events.filter((event) => {
        return event.eventType === "input.prompt";
      }).length,
    ).toBeGreaterThan(
      before.events.filter((event) => {
        return event.eventType === "input.prompt";
      }).length,
    );
    authenticate(s.owner);
    await accept(api().approve({ headers, params, body: {} }), [200]);
    const otherChat = await createChatFilesBddApi(context).createThread(
      s.run.actor,
      { agentId: s.run.agentId },
    );
    authenticate(s.owner);
    const otherAccess = await accept(
      access().listThreadAccess({
        headers,
        params: { threadId: otherChat.id },
      }),
      [200],
    );
    expect(otherAccess.body.ssh).toContainEqual(
      expect.objectContaining({ connectionId: s.host.id, enabled: false }),
    );
    const selected = await accept(
      access().listThreadAccess({
        headers,
        params: { threadId: s.run.threadId },
      }),
      [200],
    );
    expect(selected.body.ssh).toContainEqual(
      expect.objectContaining({
        connectionId: s.host.id,
        enabled: true,
        source: "override",
        defaultEnabled: false,
      }),
    );
    await accept(
      access().setThreadOverride({
        headers,
        params: {
          threadId: s.run.threadId,
          protocol: "ssh",
          connectionId: s.host.id,
        },
        body: { enabled: false },
      }),
      [200],
    );
    const revoked = await accept(api().get({ headers, params }), [200]);
    expect(revoked.body.status).toBe("revoked");
    await accept(api().approve({ headers, params, body: {} }), [409]);
  });

  it("keeps companion connector permissions separate and permits denial without granting host access", async () => {
    const s = await scenario();
    const created = await accept(
      api().create({
        headers: s.token,
        body: {
          ...s.body,
          requiredPermissions: [
            { connectorSlug: "cloudflare", permission: "dns.write" },
          ],
        },
      }),
      [200],
    );
    await end(s.run);
    const params = { id: created.body.id };
    const waiting = await accept(api().get({ headers, params }), [200]);
    expect(waiting.body.approvalBlockedReason).toBe("permissions_required");
    await accept(api().approve({ headers, params, body: {} }), [409]);
    const denied = await accept(
      api().deny({ headers, params, body: {} }),
      [200],
    );
    expect(denied.body).toMatchObject({ status: "denied", enabled: false });
    await accept(api().deny({ headers, params, body: {} }), [200]);
  });

  it("requires fresh review after a host configuration change and hides requests from other owners", async () => {
    const s = await scenario();
    const created = await accept(
      api().create({ headers: s.token, body: s.body }),
      [200],
    );
    await end(s.run);
    const params = { id: created.body.id };
    const otherActor = {
      ...s.run.actor,
      userId: `user_other_${randomUUID()}`,
      email: "other-ssh-owner@example.test",
    };
    await createAuthDeviceSupportApi(context).updateFeatureSwitches(
      otherActor,
      { sshChatApproval: true },
    );
    authenticate({ ...s.owner, userId: otherActor.userId });
    await accept(api().get({ headers, params }), [404]);
    authenticate(s.owner);
    await accept(
      hosts().update({
        headers,
        params: { connectionId: s.host.id },
        body: {
          expectedGeneration: s.host.generation,
          host: "replacement.example.com",
        },
      }),
      [200],
    );
    const stale = await accept(api().get({ headers, params }), [200]);
    expect(stale.body).toMatchObject({
      status: "stale",
      enabled: false,
      approvalBlockedReason: "host_changed",
    });
    await accept(api().approve({ headers, params, body: {} }), [409]);
  });

  it("expires the request without adding a temporary lifetime to the chat host selection", async () => {
    const s = await scenario();
    const created = await accept(
      api().create({ headers: s.token, body: s.body }),
      [200],
    );
    await end(s.run);
    mockNow(now() + 3_600_001);
    const expired = await accept(
      api().get({ headers, params: { id: created.body.id } }),
      [200],
    );
    expect(expired.body).toMatchObject({ status: "expired", enabled: false });
    await accept(
      api().approve({ headers, params: { id: created.body.id }, body: {} }),
      [410],
    );
  });

  it("revokes approved access through the review endpoint and keeps repeated decisions safe", async () => {
    const s = await scenario();
    const created = await accept(
      api().create({ headers: s.token, body: s.body }),
      [200],
    );
    await end(s.run);
    const params = { id: created.body.id };
    await accept(api().approve({ headers, params, body: {} }), [200]);
    await flushWaitUntilForTest();
    const events = await createChatFilesBddApi(context).listThreadEvents(
      s.run.actor,
      s.run.threadId,
    );
    const continuation = events.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === created.body.id
      );
    });
    if (!continuation?.runId) {
      throw new Error("Expected an approved SSH continuation Run");
    }
    const continuationOwner: (typeof resumed)[number] = {
      actor: s.run.actor,
      runId: continuation.runId,
    };
    resumed.push(continuationOwner);
    const claimed = await createRunsApi(context).requestClaimRunnerJobAs(
      `Bearer vm0_official_${"c".repeat(64)}`,
      continuation.runId,
      [200],
      { runnerIdentity: s.run.runnerIdentity },
    );
    if (claimed.status !== 200) {
      throw new Error("Expected the approved SSH continuation to be claimed");
    }
    continuationOwner.sandboxToken = claimed.body.sandboxToken;
    const continued = await createRunsApi(context).readRun(
      s.run.actor,
      continuation.runId,
    );
    expect(continued.appendSystemPrompt).toContain(
      "okou ssh request-access <connection-id> --reason <purpose>",
    );
    expect(continued.appendSystemPrompt).toContain(
      "attach continuation only to the SSH request",
    );
    authenticate(s.owner);
    const revoked = await accept(
      api().revoke({ headers, params, body: {} }),
      [200],
    );
    expect(revoked.body).toMatchObject({
      status: "revoked",
      enabled: false,
      continuationPending: false,
    });
    const selected = await accept(
      access().listThreadAccess({
        headers,
        params: { threadId: s.run.threadId },
      }),
      [200],
    );
    expect(selected.body.ssh).toContainEqual(
      expect.objectContaining({
        connectionId: s.host.id,
        enabled: false,
        source: "override",
      }),
    );
    await accept(api().revoke({ headers, params, body: {} }), [200]);
    await accept(api().approve({ headers, params, body: {} }), [409]);
  });

  it.each([false, true])(
    "continues only after the companion permission is approved in the effective permission model (shared=%s)",
    async (memberMode) => {
      const s = await scenario(memberMode);
      const connectors = createConnectorBddApi(context);
      mockSlackConnectorOAuth();
      const oauth = await connectors.startOauth(
        s.run.actor,
        "slack",
        "oauth",
        s.run.agentId,
      );
      const state = new URL(oauth.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected Slack OAuth state");
      }
      await connectors.completeOauthCallback("slack", {
        state,
        code: "ssh-companion-permission",
      });
      authenticate(s.owner);
      const requested = await accept(
        api().create({
          headers: s.token,
          body: {
            ...s.body,
            requiredPermissions: [
              { connectorSlug: "slack", permission: "chat:write" },
            ],
          },
        }),
        [200],
      );
      const params = { id: requested.body.id };
      await end(s.run);
      const waiting = await accept(api().get({ headers, params }), [200]);
      expect(waiting.body.approvalBlockedReason).toBe("permissions_required");
      const legacy = setupApp({ context, routes: userPermissionGrantsRoutes })(
        userPermissionGrantsContract,
      );
      await accept(
        legacy.apply({
          headers,
          body: {
            agentId: s.run.agentId,
            connectorSlug: "slack",
            mode: "patch",
            grants: [
              { permission: "chat:write", action: "allow", expiresIn: "1h" },
            ],
          },
        }),
        [200],
      );
      if (memberMode) {
        const stillWaiting = await accept(
          api().get({ headers, params }),
          [200],
        );
        expect(stillWaiting.body.approvalBlockedReason).toBe(
          "permissions_required",
        );
        await accept(
          setupApp({ context, routes: connectorPermissionsRoutes })(
            connectorPermissionsContract,
          ).apply({
            headers,
            body: {
              target: { kind: "builtin", connectorSlug: "slack" },
              mode: "patch",
              grants: [
                { permission: "chat:write", action: "allow", expiresIn: "1h" },
              ],
            },
          }),
          [200],
        );
      }
      const ready = await accept(api().get({ headers, params }), [200]);
      expect(ready.body.approvalBlockedReason).toBeNull();
      const approved = await accept(
        api().approve({ headers, params, body: {} }),
        [200],
      );
      expect(approved.body).toMatchObject({
        enabled: true,
        continuationPending: false,
      });
      await flushWaitUntilForTest();
      const events = await createChatFilesBddApi(context).listThreadEvents(
        s.run.actor,
        s.run.threadId,
      );
      const continuation = events.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === requested.body.id
        );
      });
      if (!continuation?.runId) {
        throw new Error("Expected continuation after both approvals");
      }
      resumed.push({ actor: s.run.actor, runId: continuation.runId });
    },
  );
});
