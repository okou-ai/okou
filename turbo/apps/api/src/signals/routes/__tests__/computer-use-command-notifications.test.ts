import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computerUseSessionHostsContract as hosts,
  computerUseCommandContract as commands,
} from "@okouai/api-contracts/contracts/computer-use";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { computerUseRoutes } from "../computer-use";
import { channelsPublishedTo } from "./helpers/realtime-publications";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runtime = Object.freeze({
  hostName: "Notification test Mac",
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

async function app() {
  return await setupApp({
    context,
    routes: computerUseRoutes,
    isolatePg: true,
  });
}

describe("Native Computer Use command notifications", () => {
  it("returns a subscription for the authenticated host's current connection", async () => {
    const api = await app();
    const actor = authenticate();
    const installationId = randomUUID();
    const first = await accept(
      api(hosts).register({
        headers,
        body: { ...runtime, installationId },
      }),
      [200],
    );
    expect(first.body.commandNotifications).toStrictEqual({
      channelName: `computer-use-host:${actor.userId}:${actor.orgId}:${first.body.hostId}:${first.body.connectionGeneration}`,
      eventName: "commandsChanged",
    });
    const second = await accept(
      api(hosts).register({
        headers,
        body: { ...runtime, installationId },
      }),
      [200],
    );
    expect(second.body.hostId).toBe(first.body.hostId);
    expect(second.body.connectionGeneration).toBeGreaterThan(
      first.body.connectionGeneration,
    );
    expect(second.body.commandNotifications.channelName).toBe(
      `computer-use-host:${actor.userId}:${actor.orgId}:${second.body.hostId}:${second.body.connectionGeneration}`,
    );
    await accept(
      api(hosts).next({
        headers,
        params: { hostId: first.body.hostId },
        body: {
          connectionGeneration: first.body.connectionGeneration,
          supportedCapabilities: ["apps.list"],
        },
      }),
      [409],
    );
    await accept(
      api(hosts).stop({
        headers,
        params: { hostId: second.body.hostId },
        body: { connectionGeneration: second.body.connectionGeneration },
      }),
      [200],
    );
  });

  it("publishes only after a command is available through the HTTP claiming endpoint", async () => {
    const api = await app();
    authenticate();
    const host = await accept(
      api(hosts).register({
        headers,
        body: { ...runtime, installationId: randomUUID() },
      }),
      [200],
    );
    const claimed = createDeferredPromise<string>(context.signal);
    context.mocks.ably.publish.mockImplementation(async (topic) => {
      if (topic !== "commandsChanged") {
        return;
      }
      const next = await accept(
        api(hosts).next({
          headers,
          params: { hostId: host.body.hostId },
          body: {
            connectionGeneration: host.body.connectionGeneration,
            supportedCapabilities: ["apps.list"],
          },
        }),
        [200],
      );
      if (next.body.status !== "command") {
        claimed.reject(
          new Error("Published wakeup did not expose a committed command"),
        );
        return;
      }
      claimed.resolve(next.body.command.id);
    });
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list" },
      }),
      [200],
    );
    await expect(claimed.promise).resolves.toBe(created.body.commandId);
    expect(channelsPublishedTo(context.mocks, "commandsChanged")).toStrictEqual(
      [host.body.commandNotifications.channelName],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "commandsChanged",
      null,
    );
    const observed = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(observed.body.status).toBe("running");
    await accept(
      api(hosts).complete({
        headers,
        params: { hostId: host.body.hostId, commandId: created.body.commandId },
        body: {
          connectionGeneration: host.body.connectionGeneration,
          status: "succeeded",
          result: {},
        },
      }),
      [200],
    );
    await accept(
      api(hosts).stop({
        headers,
        params: { hostId: host.body.hostId },
        body: { connectionGeneration: host.body.connectionGeneration },
      }),
      [200],
    );
  });

  it.each(["publish", "channel"] as const)(
    "recovers %s failures through both fresh and updated heartbeat responses",
    async (failure) => {
      const api = await app();
      authenticate();
      const startedAt = now();
      mockNow(startedAt);
      const host = await accept(
        api(hosts).register({
          headers,
          body: { ...runtime, installationId: randomUUID() },
        }),
        [200],
      );
      const params = { hostId: host.body.hostId };
      const body = {
        ...runtime,
        connectionGeneration: host.body.connectionGeneration,
      };
      const empty = await accept(
        api(hosts).heartbeat({ headers, params, body }),
        [200],
      );
      expect(empty.body.hasPendingCommands).toBeFalsy();
      if (failure === "publish") {
        context.mocks.ably.publish.mockImplementation((topic) => {
          return topic === "commandsChanged"
            ? Promise.reject(new Error("Ably unavailable"))
            : Promise.resolve();
        });
      } else {
        context.mocks.ably.channelGet.mockImplementation((channelName) => {
          if (channelName.startsWith("computer-use-host:")) {
            throw new Error("Ably channel unavailable");
          }
        });
      }
      const created = await accept(
        api(commands).create({
          headers,
          body: { kind: "apps.list" },
        }),
        [200],
      );
      const fresh = await accept(
        api(hosts).heartbeat({ headers, params, body }),
        [200],
      );
      expect(fresh.body.hasPendingCommands).toBeTruthy();
      mockNow(startedAt + 31_000);
      const updated = await accept(
        api(hosts).heartbeat({ headers, params, body }),
        [200],
      );
      expect(updated.body.hasPendingCommands).toBeTruthy();
      const next = await accept(
        api(hosts).next({
          headers,
          params,
          body: {
            connectionGeneration: host.body.connectionGeneration,
            supportedCapabilities: ["apps.list"],
          },
        }),
        [200],
      );
      expect(next.body).toMatchObject({
        status: "command",
        command: { id: created.body.commandId },
      });
      const drained = await accept(
        api(hosts).heartbeat({ headers, params, body }),
        [200],
      );
      expect(drained.body.hasPendingCommands).toBeFalsy();
      await accept(
        api(hosts).complete({
          headers,
          params: { ...params, commandId: created.body.commandId },
          body: {
            connectionGeneration: host.body.connectionGeneration,
            status: "succeeded",
            result: {},
          },
        }),
        [200],
      );
      await accept(
        api(hosts).stop({
          headers,
          params,
          body: { connectionGeneration: host.body.connectionGeneration },
        }),
        [200],
      );
    },
  );

  it("does not hint work for another host or for unsupported command capabilities", async () => {
    const api = await app();
    authenticate();
    const first = await accept(
      api(hosts).register({
        headers,
        body: { ...runtime, installationId: randomUUID() },
      }),
      [200],
    );
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list" },
      }),
      [200],
    );
    const second = await accept(
      api(hosts).register({
        headers,
        body: { ...runtime, installationId: randomUUID() },
      }),
      [200],
    );
    const unrelated = await accept(
      api(hosts).heartbeat({
        headers,
        params: { hostId: second.body.hostId },
        body: {
          ...runtime,
          connectionGeneration: second.body.connectionGeneration,
        },
      }),
      [200],
    );
    expect(unrelated.body.hasPendingCommands).toBeFalsy();
    const unsupported = await accept(
      api(hosts).heartbeat({
        headers,
        params: { hostId: first.body.hostId },
        body: {
          ...runtime,
          connectionGeneration: first.body.connectionGeneration,
          supportedCapabilities: ["app.state"],
        },
      }),
      [200],
    );
    expect(unsupported.body.hasPendingCommands).toBeFalsy();
    const supported = await accept(
      api(hosts).heartbeat({
        headers,
        params: { hostId: first.body.hostId },
        body: {
          ...runtime,
          connectionGeneration: first.body.connectionGeneration,
        },
      }),
      [200],
    );
    expect(supported.body.hasPendingCommands).toBeTruthy();
    const observed = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(observed.body.status).toBe("queued");
    for (const host of [first.body, second.body]) {
      await accept(
        api(hosts).stop({
          headers,
          params: { hostId: host.hostId },
          body: { connectionGeneration: host.connectionGeneration },
        }),
        [200],
      );
    }
  });
});
