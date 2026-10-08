import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computerUseSessionHostsContract as contract,
  computerUseHostsContract,
  computerUseHeartbeatContract,
  computerUseCommandContract,
  computerUseHostCommandsContract,
} from "@okouai/api-contracts/contracts/computer-use";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
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
    isolatePg: true,
  });
}

describe("Native Computer Use session authentication", () => {
  it("registers, claims, reports, and stops using only a Clerk session", async () => {
    const api = await app();
    const client = api(contract);
    const actor = identity();
    authenticate(actor);
    const registered = await accept(
      client.register({ headers, body: runtimeBody }),
      [200],
    );
    expect(registered.body).toStrictEqual({
      hostId: expect.any(String),
      connectionGeneration: 1,
    });
    const params = { hostId: registered.body.hostId };
    const body = { connectionGeneration: registered.body.connectionGeneration };
    await accept(
      client.heartbeat({ headers, params, body: { ...runtimeBody, ...body } }),
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
      client.heartbeat({ headers, params, body: { ...runtimeBody, ...body } }),
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
          body: { connectionGeneration: first.connectionGeneration },
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

  it.each(["session", "membership"])(
    "stops admission after remote %s revocation while the JWT is still accepted",
    async (revocation) => {
      mockNow(Date.parse("2026-10-08T01:00:00Z"));
      const api = await app();
      const client = api(contract);
      authenticate(identity());
      const registered = (
        await accept(client.register({ headers, body: runtimeBody }), [200])
      ).body;
      if (revocation === "session") {
        context.mocks.clerk.sessions.getSession.mockResolvedValue({
          status: "revoked",
        });
      } else {
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          { data: [], totalCount: 0 },
        );
      }
      mockNow(Date.parse("2026-10-08T01:00:31Z"));
      await accept(
        client.next({
          headers,
          params: { hostId: registered.hostId },
          body: { connectionGeneration: registered.connectionGeneration },
        }),
        [409],
      );
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

  it("preserves legacy routes without issuing a host token to the Native protocol", async () => {
    const api = await app();
    const actor = identity();
    authenticate(actor);
    const legacy = (
      await accept(
        api(computerUseHostsContract).start({ headers, body: runtimeBody }),
        [200],
      )
    ).body;
    await accept(
      api(computerUseHeartbeatContract).heartbeat({
        headers: { authorization: `Bearer ${legacy.hostToken}` },
        body: runtimeBody,
      }),
      [200],
    );
    const native = (
      await accept(
        api(contract).register({ headers, body: runtimeBody }),
        [200],
      )
    ).body;
    expect(native.hostId).toBe(legacy.hostId);
    await accept(
      api(computerUseHostCommandsContract).next({
        headers: { authorization: `Bearer ${legacy.hostToken}` },
        body: {},
      }),
      [401],
    );
    await accept(
      api(contract).heartbeat({
        headers,
        params: { hostId: native.hostId },
        body: {
          ...runtimeBody,
          connectionGeneration: native.connectionGeneration,
        },
      }),
      [200],
    );
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
        body: { connectionGeneration: first.connectionGeneration },
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

  it("pauses after expired validation during a Clerk outage and recovers the same connection", async () => {
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
        body: { connectionGeneration: host.connectionGeneration },
      }),
      [503],
    );
    authenticate(actor);
    const recovered = await accept(
      client.next({
        headers,
        params: { hostId: host.hostId },
        body: { connectionGeneration: host.connectionGeneration },
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
