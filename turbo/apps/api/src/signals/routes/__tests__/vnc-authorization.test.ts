import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshConnectionsRoutes } from "../ssh-connections";
import { inlineSshKey } from "./helpers/ssh-credential";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { tailscaleRoutes } from "../tailscale";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { vncAccessRoutes } from "../vnc-access";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { vncAuthorizationContract as contract } from "@okouai/api-contracts/contracts/vnc-authorization";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { vncAuthorizationRoutes } from "../vnc-authorization";
import { vncConnectionsRoutes } from "../vnc-connections";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicRemoteAccessRunApi } from "./helpers/public-remote-access-run";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const mocks = createRouteMocks(context);
describe("VNC chat authorization", () => {
  const publicRuns = createPublicRemoteAccessRunApi(context);
  const headers = { authorization: "Bearer clerk-session" };
  const api = () => {
    return setupApp({ context, routes: vncAuthorizationRoutes })(contract);
  };
  const hosts = () => {
    return setupApp({ context, routes: vncConnectionsRoutes })(
      vncConnectionsContract,
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
          { runId, exitCode: 1, error: "VNC approval test cleanup" },
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
      userId: `user_vnc_approval_${randomUUID()}`,
      orgId: `org_vnc_approval_${randomUUID()}`,
    };
    const pending = await publicRuns.start(owner);
    await createAuthDeviceSupportApi(context).updateFeatureSwitches(
      pending.actor,
      { sshChatApproval: true, connectorChatAccountAccess: memberMode },
    );
    const run = await publicRuns.executionInput(pending, {
      authorization: `Bearer vm0_official_${"c".repeat(64)}`,
    });
    authenticate(owner);
    const host = await accept(
      hosts().create({
        headers,
        body: {
          ...vncConnectionBody(),
          displayName: "Work Mac",
        },
      }),
      [201],
    );
    await accept(
      access().setThreadOverride({
        headers,
        params: {
          threadId: run.threadId,
          protocol: "vnc",
          connectionId: host.body.id,
        },
        body: { enabled: false },
      }),
      [200],
    );
    const token = { authorization: `Bearer ${run.agentToken}` };
    const body = {
      connectionId: host.body.id,
      reason: "Verify VNC login",
      callbackPrompt: "Recheck VNC access and continue setup",
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
      requiredSshHosts: [],
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
    const input = await createRunsApi(context).executionInput(
      launched[0].runId,
    );
    const nextToken = input.platformEnvironment.OKOU_TOKEN;
    continuationOwner.sandboxToken = input.sandboxToken;
    if (!nextToken) {
      throw new Error("Expected the continuation Run credential");
    }
    const inventory = await accept(
      setupApp({ context, routes: vncAccessRoutes })(vncHostsContract).list({
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
    expect(otherAccess.body.vnc).toContainEqual(
      expect.objectContaining({ connectionId: s.host.id, enabled: false }),
    );
    const selected = await accept(
      access().listThreadAccess({
        headers,
        params: { threadId: s.run.threadId },
      }),
      [200],
    );
    expect(selected.body.vnc).toContainEqual(
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
          protocol: "vnc",
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
      throw new Error("Expected an approved VNC continuation Run");
    }
    resumed.push({ actor: s.run.actor, runId: continuation.runId });
    const continued = await createRunsApi(context).readRun(
      s.run.actor,
      continuation.runId,
    );
    expect(continued.appendSystemPrompt).toContain(
      "okou vnc request-access <connection-id> --reason <purpose>",
    );
    expect(continued.appendSystemPrompt).toContain(
      "continuation only on the host request",
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
    expect(selected.body.vnc).toContainEqual(
      expect.objectContaining({
        connectionId: s.host.id,
        enabled: false,
        source: "override",
      }),
    );
    await accept(api().revoke({ headers, params, body: {} }), [200]);
    await accept(api().approve({ headers, params, body: {} }), [409]);
  });

  it("waits for both SSH transport and KDC hosts without implicitly enabling either", async () => {
    const s = await scenario();
    const ssh = setupApp({ context, routes: sshConnectionsRoutes })(
      sshConnectionsContract,
    );
    const dependencies = [];
    for (const name of ["Desktop tunnel", "KDC tunnel"]) {
      const host = await accept(
        ssh.create({
          headers,
          body: {
            id: randomUUID(),
            displayName: name,
            host: `${randomUUID()}.example.com`,
            credential: inlineSshKey("operator", "private-key", null),
          },
        }),
        [201],
      );
      dependencies.push(host.body);
    }
    const [desktop, kdc] = dependencies;
    if (!desktop || !kdc) {
      throw new Error("Expected both SSH dependencies");
    }
    const vnc = await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Kerberos desktop",
          host: "127.0.0.1",
          port: 5900,
          transport: { type: "ssh", connectionId: desktop.id },
          credential: {
            create: {
              name: "Kerberos login",
              authentication: {
                method: "qemu_kerberos_password",
                initiator: {
                  realm: "EXAMPLE.INVALID",
                  components: ["operator"],
                },
                password: "synthetic-kerberos-password",
              },
            },
          },
          security: {
            type: "qemu_x509_gssapi",
            trust: { mode: "system" },
            service: {
              realm: "EXAMPLE.INVALID",
              components: ["vnc", "desktop.example.com"],
            },
            kdc: {
              host: "127.0.0.1",
              port: 88,
              transport: { type: "ssh", connectionId: kdc.id },
            },
          },
        },
      }),
      [201],
    );
    const created = await accept(
      api().create({
        headers: s.token,
        body: { ...s.body, connectionId: vnc.body.id },
      }),
      [200],
    );
    expect(created.body.requiredSshHosts).toHaveLength(2);
    await end(s.run);
    const params = { id: created.body.id };
    for (const host of dependencies) {
      const blocked = await accept(api().get({ headers, params }), [200]);
      expect(blocked.body.approvalBlockedReason).toBe("ssh_access_required");
      await accept(api().approve({ headers, params, body: {} }), [409]);
      const selections = await accept(
        access().listThreadAccess({
          headers,
          params: { threadId: s.run.threadId },
        }),
        [200],
      );
      expect(selections.body.ssh).toContainEqual(
        expect.objectContaining({ connectionId: host.id, enabled: false }),
      );
      await accept(
        access().setThreadOverride({
          headers,
          params: {
            threadId: s.run.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
          body: { enabled: true },
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
    expect(approved.body).toMatchObject({ status: "approved", enabled: true });
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
      throw new Error("Expected continuation Run");
    }
    resumed.push({ actor: s.run.actor, runId: continuation.runId });
  });

  it.each(["cloudflare_access", "tailscale"] as const)(
    "approves a saved %s VNC route without requiring an SSH host",
    async (provider) => {
      const s = await scenario();
      const configuration = {
        id: randomUUID(),
        name: "Desktop network",
        credentials: { clientId: "test-client", clientSecret: "test-secret" },
      };
      const network =
        provider === "cloudflare_access"
          ? await accept(
              setupApp({ context, routes: cloudflareAccessRoutes })(
                cloudflareAccessContract,
              ).create({
                headers,
                query: { view: "scoped" },
                body: configuration,
              }),
              [201],
            )
          : await accept(
              setupApp({ context, routes: tailscaleRoutes })(
                tailscaleContract,
              ).create({
                headers,
                body: { ...configuration, tags: ["tag:okou"] },
              }),
              [201],
            );
      await accept(
        hosts().update({
          headers,
          params: { connectionId: s.host.id },
          body: {
            expectedGeneration: s.host.generation,
            port: provider === "cloudflare_access" ? 443 : 5900,
            transport: { type: provider, configId: network.body.id },
            security: {
              type: "x509_vnc",
              trust: { mode: "system" },
              serverName: "desktop.example.com",
            },
          },
        }),
        [200],
      );
      const created = await accept(
        api().create({ headers: s.token, body: s.body }),
        [200],
      );
      expect(created.body.requiredSshHosts).toStrictEqual([]);
      await end(s.run);
      const params = { id: created.body.id };
      const ready = await accept(api().get({ headers, params }), [200]);
      expect(ready.body.approvalBlockedReason).toBeNull();
      const approved = await accept(
        api().approve({ headers, params, body: {} }),
        [200],
      );
      expect(approved.body.enabled).toBeTruthy();
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
        throw new Error("Expected native VNC continuation Run");
      }
      resumed.push({ actor: s.run.actor, runId: continuation.runId });
    },
  );
});
