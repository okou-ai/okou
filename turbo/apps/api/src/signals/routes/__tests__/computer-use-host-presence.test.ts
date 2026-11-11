import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computerUseSessionHostsContract as hosts,
  computerUseHostsContract as directory,
  computerUseCommandContract as commands,
} from "@okouai/api-contracts/contracts/computer-use";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { computerUseRoutes } from "../computer-use";
import { channelsPublishedTo } from "./helpers/realtime-publications";
const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runtime = Object.freeze({
  hostName: "Presence Mac",
  appVersion: "99.0.0",
  osVersion: "macOS 26",
  supportedCapabilities: ["apps.list"],
  permissions: { accessibility: true, screenRecording: true },
});
function authenticate() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    sessionId: `sess_${randomUUID()}`,
  };
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { ...actor, orgRole: "org:admin" };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: actor.sessionId,
    userId: actor.userId,
    status: "active",
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
  return actor;
}

async function scenario(presenceOnly = false) {
  const api = await setupApp({ context, routes: computerUseRoutes });
  const actor = authenticate();
  const installationId = randomUUID();
  const registered = await accept(
    api(hosts).register({
      headers,
      body: {
        ...runtime,
        installationId,
        livenessMode: "presence",
        presenceOnly,
      },
    }),
    [200],
  );
  const params = { hostId: registered.body.hostId };
  const generation = {
    connectionGeneration: registered.body.connectionGeneration,
  };
  const channel = registered.body.commandNotifications.channelName;
  context.mocks.ably.presenceGet.mockImplementation((name: unknown) => {
    return Promise.resolve({
      items: name === channel ? [{ clientId: actor.userId }] : [],
    });
  });
  return {
    api,
    actor,
    registered,
    installationId,
    params,
    generation,
    channel,
  };
}

describe("Desktop host presence", () => {
  it("keeps an idle presence host routable beyond heartbeat freshness and follows presence leave", async () => {
    const s = await scenario();
    mockNow(now() + 120_000);
    const online = await accept(s.api(directory).list({ headers }), [200]);
    expect(online.body.hosts).toContainEqual(
      expect.objectContaining({ id: s.params.hostId, status: "online" }),
    );
    await accept(
      s.api(commands).create({ headers, body: { kind: "apps.list" } }),
      [200],
    );
    context.mocks.ably.presenceGet.mockResolvedValue({ items: [] });
    const offline = await accept(s.api(directory).list({ headers }), [200]);
    expect(offline.body.hosts).toContainEqual(
      expect.objectContaining({ id: s.params.hostId, status: "offline" }),
    );
    await accept(
      s.api(commands).create({ headers, body: { kind: "apps.list" } }),
      [409],
    );
  });

  it("issues only current-generation host capabilities and rejects a replaced connection", async () => {
    const s = await scenario();
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test.key",
      nonce: "nonce",
      mac: "mac",
      timestamp: now(),
      capability: JSON.stringify({ [s.channel]: ["subscribe", "presence"] }),
      clientId: s.actor.userId,
      ttl: 3_600_000,
    });
    const token = await accept(
      s
        .api(hosts)
        .realtimeToken({ headers, params: s.params, body: s.generation }),
      [200],
    );
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: { [s.channel]: ["subscribe", "presence"] },
      clientId: s.actor.userId,
      ttl: 3_600_000,
    });
    expect(JSON.parse(token.body.capability ?? "{}")).toStrictEqual({
      [s.channel]: ["subscribe", "presence"],
    });
    expect(token.body.clientId).toBe(s.actor.userId);
    const replacement = await accept(
      s.api(hosts).register({
        headers,
        body: {
          ...runtime,
          installationId: s.installationId,
          livenessMode: "presence",
        },
      }),
      [200],
    );
    await accept(
      s
        .api(hosts)
        .realtimeToken({ headers, params: s.params, body: s.generation }),
      [409],
    );
    mockNow(now() + 120_000);
    const listed = await accept(s.api(directory).list({ headers }), [200]);
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({
        id: replacement.body.hostId,
        status: "offline",
      }),
    );
  });

  it("repairs lost wakeups from queued command reads and admits the command once", async () => {
    const s = await scenario();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("publication unavailable"),
    );
    const created = await accept(
      s.api(commands).create({ headers, body: { kind: "apps.list" } }),
      [200],
    );
    context.mocks.ably.publish.mockResolvedValue(undefined);
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    const read = await accept(
      s
        .api(commands)
        .get({ headers, params: { commandId: created.body.commandId } }),
      [200],
    );
    expect(read.body.status).toBe("queued");
    expect(channelsPublishedTo(context.mocks, "commandsChanged")).toContain(
      s.channel,
    );
    // Simulate the delivered recovery hint by crossing the real claim boundary.
    const claim = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(claim.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
    await accept(
      s.api(hosts).complete({
        headers,
        params: { ...s.params, commandId: created.body.commandId },
        body: { ...s.generation, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    const completed = await accept(
      s
        .api(commands)
        .get({ headers, params: { commandId: created.body.commandId } }),
      [200],
    );
    expect(completed.body.status).toBe("succeeded");
    const idle = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(idle.body.status).toBe("idle");
  });

  it("recovers work through the HTTP queue wait while all Ably wakeup publications fail", async () => {
    const s = await scenario();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Ably publication unavailable"),
    );
    const created = await accept(
      s.api(commands).create({ headers, body: { kind: "apps.list" } }),
      [200],
    );
    const pending = await accept(
      s.api(hosts).wait({ headers, params: s.params, body: s.generation }),
      [200],
    );
    expect(pending.body.hasPendingCommands).toBeTruthy();
    const claim = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(claim.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
  });

  it("keeps a recently received HTTP connection usable during an Ably outage", async () => {
    const s = await scenario();
    context.mocks.ably.presenceGet.mockRejectedValue(
      new Error("Ably unavailable"),
    );
    const listed = await accept(s.api(directory).list({ headers }), [200]);
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({ id: s.params.hostId, status: "online" }),
    );
  });

  it("removes a revoked host session even when its Ably presence is retained", async () => {
    const s = await scenario();
    mockNow(now() + 31_000);
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: s.actor.sessionId,
      userId: s.actor.userId,
      status: "revoked",
    });
    const listed = await accept(s.api(directory).list({ headers }), [200]);
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({ id: s.params.hostId, status: "offline" }),
    );
    await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [409],
    );
  });

  it("reports presence-provider failure as unavailable instead of offline", async () => {
    const s = await scenario();
    mockNow(now() + 120_000);
    context.mocks.ably.presenceGet.mockRejectedValue(
      new Error("Ably unavailable"),
    );
    const response = await accept(s.api(directory).list({ headers }), [503]);
    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("synchronizes changed capabilities and keeps stop authoritative over lingering presence", async () => {
    const s = await scenario();
    await accept(
      s.api(hosts).state({
        headers,
        params: s.params,
        body: {
          ...runtime,
          ...s.generation,
          hostName: "Updated Mac",
          supportedCapabilities: ["app.state"],
        },
      }),
      [200],
    );
    const listed = await accept(s.api(directory).list({ headers }), [200]);
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({
        displayName: "Updated Mac",
        supportedCapabilities: ["app.state"],
      }),
    );
    await accept(
      s.api(hosts).stop({ headers, params: s.params, body: s.generation }),
      [200],
    );
    const stopped = await accept(s.api(directory).list({ headers }), [200]);
    expect(stopped.body.hosts).toContainEqual(
      expect.objectContaining({ id: s.params.hostId, status: "offline" }),
    );
    await accept(
      s
        .api(hosts)
        .realtimeToken({ headers, params: s.params, body: s.generation }),
      [409],
    );
  });
});

describe("Presence-only Desktop", () => {
  it("uses presence for a fresh host and reports an unavailable provider explicitly", async () => {
    const s = await scenario(true);
    expect(s.registered.body).toMatchObject({
      livenessMode: "presence",
      presenceOnly: true,
    });
    context.mocks.ably.presenceGet.mockRejectedValue(
      new Error("Ably unavailable"),
    );
    const unavailable = await accept(s.api(directory).list({ headers }), [503]);
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    context.mocks.ably.presenceGet.mockResolvedValue({ items: [] });
    await accept(
      s.api(hosts).state({
        headers,
        params: s.params,
        body: { ...runtime, ...s.generation },
      }),
      [200],
    );
    const offline = await accept(s.api(directory).list({ headers }), [200]);
    expect(offline.body.hosts).toContainEqual(
      expect.objectContaining({
        id: s.params.hostId,
        status: "offline",
      }),
    );
  });

  it("accepts only the current connection's diagnostics without granting online status", async () => {
    const s = await scenario(true);
    await accept(
      s.api(hosts).connectionEvent({
        headers,
        params: s.params,
        body: { ...s.generation, event: "ready" },
      }),
      [204],
    );
    await accept(
      s.api(hosts).connectionEvent({
        headers,
        params: s.params,
        body: {
          connectionGeneration: s.generation.connectionGeneration + 1,
          event: "unavailable",
          reasonCode: 80_003,
        },
      }),
      [409],
    );
    context.mocks.ably.presenceGet.mockResolvedValue({ items: [] });
    const listed = await accept(s.api(directory).list({ headers }), [200]);
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({
        id: s.params.hostId,
        status: "offline",
      }),
    );
  });

  it("expires an unclaimed operation and still admits a fresh command", async () => {
    const s = await scenario(true);
    const expired = await accept(
      s
        .api(commands)
        .create({ headers, body: { kind: "apps.list", timeoutMs: 1000 } }),
      [200],
    );
    // Finish notification delivery before making result reads own the timeout.
    await flushWaitUntilForTest();
    mockNow(now() + 1001);
    const idle = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(idle.body.status).toBe("idle");
    const observed = await accept(
      s
        .api(commands)
        .get({ headers, params: { commandId: expired.body.commandId } }),
      [200],
    );
    expect(observed.body).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    const fresh = await accept(
      s
        .api(commands)
        .create({ headers, body: { kind: "apps.list", timeoutMs: 1000 } }),
      [200],
    );
    const claim = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(claim.body).toMatchObject({
      status: "command",
      command: { id: fresh.body.commandId },
    });
    await accept(
      s.api(hosts).complete({
        headers,
        params: { ...s.params, commandId: fresh.body.commandId },
        body: { ...s.generation, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
  });

  it("repairs failed publication without a result reader or idle Desktop polling", async () => {
    const s = await scenario(true);
    const delivered = createDeferredPromise<void>(context.signal);
    context.mocks.ably.publish
      .mockRejectedValueOnce(new Error("first publish failed"))
      .mockRejectedValueOnce(new Error("retry failed"))
      .mockImplementation(() => {
        delivered.resolve();
        return Promise.resolve(undefined);
      });
    const created = await accept(
      s.api(commands).create({ headers, body: { kind: "apps.list" } }),
      [200],
    );
    await delivered.promise;
    const claim = await accept(
      s.api(hosts).next({
        headers,
        params: s.params,
        body: {
          ...s.generation,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(claim.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
    await accept(
      s.api(hosts).complete({
        headers,
        params: { ...s.params, commandId: created.body.commandId },
        body: { ...s.generation, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    const result = await accept(
      s
        .api(commands)
        .get({ headers, params: { commandId: created.body.commandId } }),
      [200],
    );
    expect(result.body.status).toBe("succeeded");
  });
});
