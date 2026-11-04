import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import {
  computerUseSessionHostsContract as contract,
  computerUseHostsContract,
  computerUseCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";

import {
  accept,
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { computerUseRoutes } from "../computer-use";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runtimeBody = Object.freeze({
  installationId: randomUUID(),
  hostName: "Native test Mac",
  appVersion: "0.50.0",
  osVersion: "macOS 26",
  supportedCapabilities: ["apps.list"],
  permissions: { accessibility: true, screenRecording: true },
});
function identity() {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    sessionId: `sess_${randomUUID()}`,
  };
}
function authenticate(actor: ReturnType<typeof identity>) {
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
}
async function app() {
  return await setupApp({
    context,
    routes: computerUseRoutes,
  });
}

describe("Native Computer Use session authentication", () => {
  it("enforces the supported Native version at registration", async () => {
    const api = await app();
    authenticate(identity());
    desktopCompatibility.minimumSupportedVersion = "0.54.0";
    const old = await accept(
      api(contract).register({
        headers,
        body: { ...runtimeBody, appVersion: "0.53.4" },
      }),
      [426],
    );
    expect(old.body).toMatchObject({
      error: { code: "DESKTOP_UPDATE_REQUIRED" },
      minimumSupportedVersion: "0.54.0",
    });
    await accept(
      api(contract).register({
        headers,
        body: { ...runtimeBody, appVersion: "0.54.0" },
      }),
      [200],
    );
  });

  it("closes admission for existing old hosts but lets their claimed command finish and stop", async () => {
    const api = await app();
    authenticate(identity());
    const client = api(contract);
    const oldRuntime = { ...runtimeBody, appVersion: "0.53.4" };
    const registered = (
      await accept(client.register({ headers, body: oldRuntime }), [200])
    ).body;
    const params = { hostId: registered.hostId };
    const body = { connectionGeneration: registered.connectionGeneration };
    const created = (
      await accept(
        api(computerUseCommandContract).create({
          headers,
          body: { kind: "apps.list", timeoutMs: 10_000 },
        }),
        [200],
      )
    ).body;
    await accept(
      client.next({
        headers,
        params,
        body: { ...body, supportedCapabilities: ["apps.list"] },
      }),
      [200],
    );
    desktopCompatibility.minimumSupportedVersion = "0.54.0";
    await accept(
      client.next({
        headers,
        params,
        body,
        extraHeaders: { "X-Client-Version": "99.0.0" },
      }),
      [426],
    );
    const listed = (
      await accept(api(computerUseHostsContract).list({ headers }), [200])
    ).body;
    expect(listed.hosts).toContainEqual(
      expect.objectContaining({ id: params.hostId, status: "offline" }),
    );
    await accept(
      api(computerUseCommandContract).create({
        headers,
        body: { kind: "apps.list" },
      }),
      [409],
    );
    await accept(
      client.heartbeat({ headers, params, body: { ...oldRuntime, ...body } }),
      [200],
    );
    await accept(
      client.complete({
        headers,
        params: { ...params, commandId: created.commandId },
        body: { ...body, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    const observed = (
      await accept(
        api(computerUseCommandContract).get({
          headers,
          params: { commandId: created.commandId },
        }),
        [200],
      )
    ).body;
    expect(observed).toMatchObject({
      status: "succeeded",
      result: { apps: [] },
    });
    await accept(client.stop({ headers, params, body }), [200]);
  });

  it("preserves the GUI claim lifecycle for a supported Desktop", async () => {
    const version = "0.54.0";
    const supportedRuntime = { ...runtimeBody, appVersion: version };
    const headers = {
      authorization: "Bearer clerk-session",
      "X-Client-Type": "Desktop",
      "X-Client-Version": version,
    };
    const api = await app();
    desktopCompatibility.minimumSupportedVersion = version;
    const client = api(contract);
    const actor = identity();
    authenticate(actor);
    const registered = await accept(
      client.register({ headers, body: supportedRuntime }),
      [200],
    );
    expect(registered.body).toStrictEqual({
      hostId: expect.any(String),
      connectionGeneration: 1,
      commandNotifications: {
        channelName: `computer-use-host:${actor.userId}:${actor.orgId}:${registered.body.hostId}:1`,
        eventName: "commandsChanged",
      },
    });
    const params = { hostId: registered.body.hostId };
    const body = {
      connectionGeneration: registered.body.connectionGeneration,
    };
    await accept(
      client.heartbeat({
        headers,
        params,
        body: { ...supportedRuntime, ...body },
      }),
      [200],
    );
    const created = await accept(
      api(computerUseCommandContract).create({
        headers,
        body: { kind: "apps.list", timeoutMs: 10_000 },
      }),
      [200],
    );
    const claimed = await accept(
      client.next({
        headers,
        params,
        body: { ...body, supportedCapabilities: ["apps.list"] },
      }),
      [200],
    );
    expect(claimed.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
    await accept(
      client.complete({
        headers,
        params: { ...params, commandId: created.body.commandId },
        body: { ...body, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    const observed = await accept(
      api(computerUseCommandContract).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(observed.body).toMatchObject({
      status: "succeeded",
      result: { apps: [] },
    });
    await accept(client.stop({ headers, params, body }), [200]);
    await accept(
      client.heartbeat({
        headers,
        params,
        body: { ...supportedRuntime, ...body },
      }),
      [409],
    );
    const listed = await accept(
      api(computerUseHostsContract).list({ headers }),
      [200],
    );
    expect(listed.body.hosts).toContainEqual(
      expect.objectContaining({ id: params.hostId, status: "offline" }),
    );
  });

  it.each([
    ["succeeded", 29_999],
    ["succeeded", 30_000],
    ["failed", 29_999],
    ["failed", 30_000],
  ] as const)(
    "refreshes liveness for %s completion at %i ms and preserves the result through retries",
    async (status, completionAge) => {
      const startedAt = Date.parse("2026-10-12T01:00:00Z");
      mockNow(startedAt);
      const api = await app();
      const client = api(contract);
      authenticate(identity());
      const registered = (
        await accept(client.register({ headers, body: runtimeBody }), [200])
      ).body;
      const params = { hostId: registered.hostId };
      const generation = {
        connectionGeneration: registered.connectionGeneration,
      };
      const created = await accept(
        api(computerUseCommandContract).create({
          headers,
          body: { kind: "apps.list", timeoutMs: 60_000 },
        }),
        [200],
      );
      const claimed = await accept(
        client.next({
          headers,
          params,
          body: {
            ...generation,
            supportedCapabilities: runtimeBody.supportedCapabilities,
          },
        }),
        [200],
      );
      expect(claimed.body).toMatchObject({
        status: "command",
        command: { id: created.body.commandId },
      });
      const completedParams = { ...params, commandId: created.body.commandId };
      const succeeded = {
        ...generation,
        status: "succeeded" as const,
        result: { apps: [] },
      };
      const failed = {
        ...generation,
        status: "failed" as const,
        error: {
          code: "app_not_found" as const,
          message: "The requested app is unavailable",
        },
      };
      mockNow(startedAt + completionAge);
      await accept(
        client.complete({
          headers,
          params: completedParams,
          body: status === "succeeded" ? succeeded : failed,
        }),
        [200],
      );
      const initialDirectory = await accept(
        api(computerUseHostsContract).list({ headers }),
        [200],
      );
      expect(initialDirectory.body.hosts).toContainEqual(
        expect.objectContaining({
          id: registered.hostId,
          status: "online",
          lastSeenAt: new Date(
            startedAt + (completionAge === 30_000 ? completionAge : 0),
          ).toISOString(),
        }),
      );
      const original = (
        await accept(
          api(computerUseCommandContract).get({
            headers,
            params: { commandId: created.body.commandId },
          }),
          [200],
        )
      ).body;
      expect(original).toMatchObject({
        status,
        completedAt: new Date(startedAt + completionAge).toISOString(),
        ...(status === "succeeded"
          ? { result: succeeded.result }
          : { error: failed.error }),
      });
      for (const retryAge of [30_000, 59_999, 60_000]) {
        mockNow(startedAt + retryAge);
        const retried = await accept(
          client.complete({
            headers,
            params: completedParams,
            body: status === "succeeded" ? failed : succeeded,
          }),
          [200],
        );
        expect(retried.body).toStrictEqual({ ok: true });
        const directory = await accept(
          api(computerUseHostsContract).list({ headers }),
          [200],
        );
        expect(directory.body.hosts).toContainEqual(
          expect.objectContaining({
            id: registered.hostId,
            status: "online",
            lastSeenAt: new Date(
              startedAt + (retryAge === 60_000 ? retryAge : 30_000),
            ).toISOString(),
          }),
        );
        const observed = await accept(
          api(computerUseCommandContract).get({
            headers,
            params: { commandId: created.body.commandId },
          }),
          [200],
        );
        expect(observed.body).toStrictEqual(original);
      }
    },
  );

  it("acknowledges a completion that loses to timeout during screenshot storage without refreshing liveness", async () => {
    const startedAt = Date.parse("2026-10-12T02:00:00Z");
    mockNow(startedAt);
    const api = await app();
    const client = api(contract);
    authenticate(identity());
    const hostBody = { ...runtimeBody, supportedCapabilities: ["app.state"] };
    const registered = (
      await accept(client.register({ headers, body: hostBody }), [200])
    ).body;
    const created = await accept(
      api(computerUseCommandContract).create({
        headers,
        body: { kind: "app.state", app: "Calculator", timeoutMs: 1000 },
      }),
      [200],
    );
    const claimed = await accept(
      client.next({
        headers,
        params: { hostId: registered.hostId },
        body: {
          connectionGeneration: registered.connectionGeneration,
          supportedCapabilities: hostBody.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(claimed.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
    context.mocks.s3.send.mockImplementationOnce(async () => {
      mockNow(startedAt + 30_000);
      const expired = await accept(
        api(computerUseCommandContract).get({
          headers,
          params: { commandId: created.body.commandId },
        }),
        [200],
      );
      expect(expired.body).toMatchObject({
        status: "failed",
        error: { code: "timeout" },
        completedAt: new Date(startedAt + 30_000).toISOString(),
      });
      return {};
    });
    const completed = await accept(
      client.complete({
        headers,
        params: {
          hostId: registered.hostId,
          commandId: created.body.commandId,
        },
        body: {
          connectionGeneration: registered.connectionGeneration,
          status: "succeeded",
          result: {
            screenshot: `data:image/png;base64,${Buffer.from("test-png").toString("base64")}`,
            screenshotWidth: 800,
            screenshotHeight: 600,
          },
        },
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({ ok: true });
    const observed = await accept(
      api(computerUseCommandContract).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(observed.body).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
      completedAt: new Date(startedAt + 30_000).toISOString(),
    });
    expect(observed.body).not.toHaveProperty("result");
    const directory = await accept(
      api(computerUseHostsContract).list({ headers }),
      [200],
    );
    expect(directory.body.hosts).toContainEqual(
      expect.objectContaining({
        id: registered.hostId,
        status: "online",
        lastSeenAt: new Date(startedAt).toISOString(),
      }),
    );
  });

  it("rejects another user, organization, session, and replaced connection", async () => {
    const api = await app();
    const client = api(contract);
    const owner = identity();
    authenticate(owner);
    const first = (
      await accept(client.register({ headers, body: runtimeBody }), [200])
    ).body;
    for (const actor of [
      { ...owner, userId: `user_${randomUUID()}` },
      { ...owner, orgId: `org_${randomUUID()}` },
      { ...owner, sessionId: `sess_${randomUUID()}` },
    ]) {
      authenticate(actor);
      await accept(
        client.next({
          headers,
          params: { hostId: first.hostId },
          body: {
            connectionGeneration: first.connectionGeneration,
            supportedCapabilities: runtimeBody.supportedCapabilities,
          },
        }),
        [409],
      );
    }
    authenticate(owner);
    const second = (
      await accept(client.register({ headers, body: runtimeBody }), [200])
    ).body;
    expect(second).toStrictEqual({
      hostId: first.hostId,
      connectionGeneration: 2,
      commandNotifications: {
        channelName: `computer-use-host:${owner.userId}:${owner.orgId}:${first.hostId}:2`,
        eventName: "commandsChanged",
      },
    });
    await accept(
      client.stop({
        headers,
        params: { hostId: first.hostId },
        body: { connectionGeneration: 1 },
      }),
      [409],
    );
    await accept(
      client.heartbeat({
        headers,
        params: { hostId: second.hostId },
        body: { ...runtimeBody, connectionGeneration: 2 },
      }),
      [200],
    );
  });

  it.each([
    ["session", "heartbeat"],
    ["session", "next"],
    ["session", "complete"],
    ["session", "stop"],
    ["membership", "heartbeat"],
    ["membership", "next"],
    ["membership", "complete"],
    ["membership", "stop"],
  ] as const)(
    "expires cached authority after remote %s revocation before %s",
    async (revocation, operation) => {
      const registeredAt = Date.parse("2026-10-08T01:00:00Z");
      mockNow(registeredAt);
      const api = await app();
      const client = api(contract);
      const actor = identity();
      authenticate(actor);
      const registered = (
        await accept(client.register({ headers, body: runtimeBody }), [200])
      ).body;
      const params = { hostId: registered.hostId };
      const body = { connectionGeneration: registered.connectionGeneration };
      const created = await accept(
        api(computerUseCommandContract).create({
          headers,
          body: { kind: "apps.list", timeoutMs: 60_000 },
        }),
        [200],
      );
      const claimed = await accept(
        client.next({
          headers,
          params,
          body: {
            ...body,
            supportedCapabilities: runtimeBody.supportedCapabilities,
          },
        }),
        [200],
      );
      expect(claimed.body).toMatchObject({
        status: "command",
        command: { id: created.body.commandId },
      });
      if (revocation === "session") {
        context.mocks.clerk.sessions.getSession.mockResolvedValue({
          id: actor.sessionId,
          userId: actor.userId,
          status: "revoked",
        });
      } else {
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          { data: [], totalCount: 0 },
        );
      }
      mockNow(registeredAt + 29_999);
      await accept(
        client.heartbeat({
          headers,
          params,
          body: { ...runtimeBody, ...body },
        }),
        [200],
      );
      mockNow(registeredAt + 30_000);
      if (operation === "heartbeat") {
        await accept(
          client.heartbeat({
            headers,
            params,
            body: { ...runtimeBody, ...body },
          }),
          [409],
        );
      } else if (operation === "next") {
        await accept(
          client.next({
            headers,
            params,
            body: {
              ...body,
              supportedCapabilities: runtimeBody.supportedCapabilities,
            },
          }),
          [409],
        );
      } else if (operation === "complete") {
        await accept(
          client.complete({
            headers,
            params: { ...params, commandId: created.body.commandId },
            body: { ...body, status: "succeeded", result: { apps: [] } },
          }),
          [409],
        );
      } else {
        await accept(client.stop({ headers, params, body }), [409]);
      }
      const listed = await accept(
        api(computerUseHostsContract).list({ headers }),
        [200],
      );
      expect(listed.body.hosts).toContainEqual(
        expect.objectContaining({ id: registered.hostId, status: "offline" }),
      );
    },
  );

  it("denies a missing session and an inactive provider session at registration", async () => {
    const client = (await app())(contract);
    const actor = identity();
    authenticate(actor);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: actor.userId,
          orgId: actor.orgId,
          orgRole: "org:admin",
        };
      },
    });
    const missing = await accept(
      client.register({ headers, body: runtimeBody }),
      [401],
    );
    expect(missing.body.error.code).toBe("UNAUTHORIZED");
    authenticate(actor);
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: actor.sessionId,
      userId: actor.userId,
      status: "revoked",
    });
    const inactive = await accept(
      client.register({ headers, body: runtimeBody }),
      [401],
    );
    expect(inactive.body.error.code).toBe("UNAUTHORIZED");
  });

  it("does not let a new connection report an older connection's action", async () => {
    const api = await app();
    const client = api(contract);
    authenticate(identity());
    const first = (
      await accept(client.register({ headers, body: runtimeBody }), [200])
    ).body;
    const created = await accept(
      api(computerUseCommandContract).create({
        headers,
        body: { kind: "apps.list", timeoutMs: 10_000 },
      }),
      [200],
    );
    await accept(
      client.next({
        headers,
        params: { hostId: first.hostId },
        body: {
          connectionGeneration: first.connectionGeneration,
          supportedCapabilities: runtimeBody.supportedCapabilities,
        },
      }),
      [200],
    );
    const second = (
      await accept(client.register({ headers, body: runtimeBody }), [200])
    ).body;
    const params = { hostId: first.hostId, commandId: created.body.commandId };
    await accept(
      client.complete({
        headers,
        params,
        body: {
          connectionGeneration: first.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [409],
    );
    await accept(
      client.complete({
        headers,
        params,
        body: {
          connectionGeneration: second.connectionGeneration,
          status: "succeeded",
          result: { apps: [] },
        },
      }),
      [404],
    );
    const observed = await accept(
      api(computerUseCommandContract).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(observed.body.status).toBe("running");
  });

  it.each(["replaced", "stopped"])(
    "rejects a connection %s during screenshot upload without confirming its result",
    async (invalidation) => {
      const api = await app();
      const client = api(contract);
      const actor = identity();
      authenticate(actor);
      const hostBody = { ...runtimeBody, supportedCapabilities: ["app.state"] };
      const first = (
        await accept(client.register({ headers, body: hostBody }), [200])
      ).body;
      const created = await accept(
        api(computerUseCommandContract).create({
          headers,
          body: { kind: "app.state", app: "Calculator", timeoutMs: 10_000 },
        }),
        [200],
      );
      const claimed = await accept(
        client.next({
          headers,
          params: { hostId: first.hostId },
          body: {
            connectionGeneration: first.connectionGeneration,
            supportedCapabilities: hostBody.supportedCapabilities,
          },
        }),
        [200],
      );
      expect(claimed.body).toMatchObject({
        status: "command",
        command: { id: created.body.commandId },
      });
      context.mocks.s3.send.mockImplementationOnce(async () => {
        if (invalidation === "replaced") {
          const replacement = await accept(
            client.register({ headers, body: hostBody }),
            [200],
          );
          expect(replacement.body).toStrictEqual({
            hostId: first.hostId,
            connectionGeneration: first.connectionGeneration + 1,
            commandNotifications: {
              channelName: `computer-use-host:${actor.userId}:${actor.orgId}:${first.hostId}:${first.connectionGeneration + 1}`,
              eventName: "commandsChanged",
            },
          });
        } else {
          const stopped = await accept(
            client.stop({
              headers,
              params: { hostId: first.hostId },
              body: { connectionGeneration: first.connectionGeneration },
            }),
            [200],
          );
          expect(stopped.body).toStrictEqual({
            ok: true,
            hostId: first.hostId,
          });
        }
        return {};
      });
      const rejected = await accept(
        client.complete({
          headers,
          params: { hostId: first.hostId, commandId: created.body.commandId },
          body: {
            connectionGeneration: first.connectionGeneration,
            status: "succeeded",
            result: {
              screenshot: `data:image/png;base64,${Buffer.from("test-png").toString("base64")}`,
              screenshotWidth: 800,
              screenshotHeight: 600,
            },
          },
        }),
        [409],
      );
      expect(rejected.body.error.code).toBe("HOST_CONNECTION_INVALID");
      const observed = await accept(
        api(computerUseCommandContract).get({
          headers,
          params: { commandId: created.body.commandId },
        }),
        [200],
      );
      expect(observed.body.status).toBe("running");
    },
  );

  it.each(["session", "membership"])(
    "cancels a stalled Clerk %s read and recovers the same connection",
    async (stage) => {
      const initialTime = Date.parse("2026-10-08T02:00:00Z");
      mockNow(initialTime);
      const api = await app();
      const client = api(contract);
      const actor = identity();
      authenticate(actor);
      const host = (
        await accept(client.register({ headers, body: runtimeBody }), [200])
      ).body;
      mockNow(initialTime + 31_000);
      const received = createDeferredPromise<void>(context.signal);
      const cancelled = createDeferredPromise<void>(context.signal);
      const path =
        stage === "session"
          ? `sessions/${actor.sessionId}`
          : `organizations/${actor.orgId}/memberships`;
      server.use(
        http.get(
          `https://api.clerk.com/v1/${path}`,
          async ({ request }) => {
            const disconnected = createDeferredPromise<void>(context.signal);
            const observeDisconnect = () => {
              if (!disconnected.settled()) {
                disconnected.resolve();
              }
            };
            request.signal.addEventListener("abort", observeDisconnect, {
              once: true,
            });
            if (request.signal.aborted) {
              observeDisconnect();
            }
            received.resolve();
            const observed = await settleIncludingAbort(disconnected.promise);
            request.signal.removeEventListener("abort", observeDisconnect);
            if (!observed.ok) {
              throw observed.error;
            }
            cancelled.resolve();
            return HttpResponse.json({ errors: [] }, { status: 503 });
          },
          { once: true },
        ),
      );
      const request = client.next({
        headers,
        params: { hostId: host.hostId },
        body: {
          connectionGeneration: host.connectionGeneration,
          supportedCapabilities: runtimeBody.supportedCapabilities,
        },
      });
      await received.promise;
      await accept(request, [503]);
      await cancelled.promise;
      const recovered = await accept(
        client.next({
          headers,
          params: { hostId: host.hostId },
          body: {
            connectionGeneration: host.connectionGeneration,
            supportedCapabilities: runtimeBody.supportedCapabilities,
          },
        }),
        [200],
      );
      expect(recovered.body.status).toBe("idle");
    },
    6000,
  );

  it("pauses after expired validation during a Clerk outage and recovers the same connection", async () => {
    onTestFinished(context.mocks.clerkRetryJitter(0));
    mockNow(Date.parse("2026-10-08T02:00:00Z"));
    const api = await app();
    const client = api(contract);
    const actor = identity();
    authenticate(actor);
    const host = (
      await accept(client.register({ headers, body: runtimeBody }), [200])
    ).body;
    class ClerkUnavailable extends Error {
      static readonly kind = "ClerkAPIResponseError";
      readonly status = 503;
    }
    context.mocks.clerk.sessions.getSession.mockRejectedValue(
      new ClerkUnavailable("Clerk unavailable"),
    );
    mockNow(Date.parse("2026-10-08T02:00:31Z"));
    await accept(
      client.next({
        headers,
        params: { hostId: host.hostId },
        body: {
          connectionGeneration: host.connectionGeneration,
          supportedCapabilities: runtimeBody.supportedCapabilities,
        },
      }),
      [503],
    );
    authenticate(actor);
    const recovered = await accept(
      client.next({
        headers,
        params: { hostId: host.hostId },
        body: {
          connectionGeneration: host.connectionGeneration,
          supportedCapabilities: runtimeBody.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(recovered.body).toStrictEqual({ status: "idle" });
  });

  it("exposes provider rate limits without creating a host connection", async () => {
    const api = await app();
    authenticate(identity());
    class ClerkRateLimited extends Error {
      static readonly kind = "ClerkAPIResponseError";
      readonly status = 429;
      readonly retryAfter = 7;
    }
    context.mocks.clerk.sessions.getSession.mockRejectedValue(
      new ClerkRateLimited("Clerk rate limited"),
    );
    const rejected = await accept(
      api(contract).register({ headers, body: runtimeBody }),
      [429],
    );
    expect(rejected.headers.get("Retry-After")).toBe("7");
    const listed = await accept(
      api(computerUseHostsContract).list({ headers }),
      [200],
    );
    expect(listed.body.hosts).toStrictEqual([]);
  });
});
