import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  computerUseCommandContract as commands,
  computerUseWriteCommandContract as writeCommands,
  computerUseSessionHostsContract as hosts,
} from "@okouai/api-contracts/contracts/computer-use";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { computerUseRoutes } from "../computer-use";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runtime = Object.freeze({
  hostName: "Result notification Mac",
  appVersion: "99.0.0",
  osVersion: "macOS 26",
  supportedCapabilities: ["apps.list", "app.open"],
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

function signTokenRequests() {
  const params = z.object({
    capability: z.record(z.string(), z.array(z.string())),
    clientId: z.string(),
    ttl: z.number(),
  });
  context.mocks.ably.createTokenRequest.mockImplementation((input) => {
    const parsed = params.parse(input);
    return Promise.resolve({
      keyName: "test.key",
      timestamp: now(),
      nonce: randomUUID(),
      mac: "signed",
      ...parsed,
      capability: JSON.stringify(parsed.capability),
    });
  });
}

async function setup() {
  const api = await setupApp({
    context,
    routes: computerUseRoutes,
    isolatePg: true,
  });
  const actor = authenticate();
  signTokenRequests();
  const host = await accept(
    api(hosts).register({
      headers,
      body: { ...runtime, installationId: randomUUID() },
    }),
    [200],
  );
  return {
    api,
    actor,
    host: host.body,
    connection: { connectionGeneration: host.body.connectionGeneration },
  };
}

describe("Computer Use CLI result subscriptions", () => {
  it.each(["read", "write"] as const)(
    "issues an exact subscribe-only command grant only when a %s caller opts in",
    async (kind) => {
      const { api, actor } = await setup();
      const created =
        kind === "read"
          ? await accept(
              api(commands).create({
                headers,
                body: { kind: "apps.list", realtime: true, timeoutMs: 10_000 },
              }),
              [200],
            )
          : await accept(
              api(writeCommands).create({
                headers,
                body: {
                  kind: "app.open",
                  app: "Safari",
                  realtime: true,
                  timeoutMs: 10_000,
                },
              }),
              [200],
            );
      const channel = `computer-use-result:${actor.userId}:${actor.orgId}:${created.body.commandId}`;
      expect(created.body.realtime).toMatchObject({
        channelName: channel,
        eventName: "resultChanged",
        tokenRequest: {
          clientId: actor.userId,
          ttl: 70_000,
          capability: JSON.stringify({ [channel]: ["subscribe"] }),
        },
      });
      const oldClient = await accept(
        api(commands).create({ headers, body: { kind: "apps.list" } }),
        [200],
      );
      expect(oldClient.body).toStrictEqual({
        commandId: oldClient.body.commandId,
        status: "queued",
      });
      expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);

      authenticate();
      await accept(
        api(commands).get({
          headers,
          params: { commandId: created.body.commandId },
        }),
        [404],
      );
    },
  );

  it.each(["succeeded", "failed"] as const)(
    "notifies a durable %s result once and keeps completion idempotent",
    async (status) => {
      const { api, actor, host, connection } = await setup();
      const created = await accept(
        api(commands).create({
          headers,
          body: { kind: "apps.list", realtime: true },
        }),
        [200],
      );
      await accept(
        api(hosts).next({
          headers,
          params: { hostId: host.hostId },
          body: {
            ...connection,
            supportedCapabilities: runtime.supportedCapabilities,
          },
        }),
        [200],
      );
      const body =
        status === "succeeded"
          ? { ...connection, status, result: { apps: [] } }
          : {
              ...connection,
              status,
              error: {
                code: "permission_denied" as const,
                message: "Access denied",
              },
            };
      const notifiedStatus = createDeferredPromise<string>(context.signal);
      context.mocks.ably.publish.mockImplementation(async (topic) => {
        if (topic !== "resultChanged") {
          return;
        }
        const readable = await accept(
          api(commands).get({
            headers,
            params: { commandId: created.body.commandId },
          }),
          [200],
        );
        notifiedStatus.resolve(readable.body.status);
      });
      for (let repeat = 0; repeat < 2; repeat++) {
        await accept(
          api(hosts).complete({
            headers,
            params: { hostId: host.hostId, commandId: created.body.commandId },
            body,
          }),
          [200],
        );
      }
      await flushWaitUntilForTest();
      await expect(notifiedStatus.promise).resolves.toBe(status);
      const result = await accept(
        api(commands).get({
          headers,
          params: { commandId: created.body.commandId },
        }),
        [200],
      );
      expect(result.body.status).toBe(status);
      expect(channelsPublishedTo(context.mocks, "resultChanged")).toStrictEqual(
        [
          `computer-use-result:${actor.userId}:${actor.orgId}:${created.body.commandId}`,
        ],
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "resultChanged",
        null,
      );
    },
  );

  it("publishes one timeout result and does not let a late completion overwrite it", async () => {
    mockNow(Date.parse("2026-10-10T00:00:00Z"));
    const { api, actor, host, connection } = await setup();
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list", realtime: true, timeoutMs: 1000 },
      }),
      [200],
    );
    await accept(
      api(hosts).next({
        headers,
        params: { hostId: host.hostId },
        body: {
          ...connection,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    mockNow(now() + 2000);
    await Promise.all(
      [0, 1].map(() => {
        return api(commands).get({
          headers,
          params: { commandId: created.body.commandId },
        });
      }),
    );
    await accept(
      api(hosts).complete({
        headers,
        params: { hostId: host.hostId, commandId: created.body.commandId },
        body: { ...connection, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const result = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    expect(channelsPublishedTo(context.mocks, "resultChanged")).toStrictEqual([
      `computer-use-result:${actor.userId}:${actor.orgId}:${created.body.commandId}`,
    ]);
  });

  it("keeps a created command executable when subscription issuance fails", async () => {
    const { api, host, connection } = await setup();
    context.mocks.ably.createTokenRequest.mockRejectedValue(
      new Error("Ably unavailable"),
    );
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list", realtime: true },
      }),
      [200],
    );
    expect(created.body).toStrictEqual({
      commandId: created.body.commandId,
      status: "queued",
    });
    const next = await accept(
      api(hosts).next({
        headers,
        params: { hostId: host.hostId },
        body: {
          ...connection,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    expect(next.body).toMatchObject({
      status: "command",
      command: { id: created.body.commandId },
    });
    await accept(
      api(hosts).complete({
        headers,
        params: { hostId: host.hostId, commandId: created.body.commandId },
        body: { ...connection, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    const result = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(result.body.status).toBe("succeeded");
  });

  it("keeps a durable result readable when its notification cannot be published", async () => {
    const { api, host, connection } = await setup();
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list", realtime: true },
      }),
      [200],
    );
    await accept(
      api(hosts).next({
        headers,
        params: { hostId: host.hostId },
        body: {
          ...connection,
          supportedCapabilities: runtime.supportedCapabilities,
        },
      }),
      [200],
    );
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Publication unavailable"),
    );
    await accept(
      api(hosts).complete({
        headers,
        params: { hostId: host.hostId, commandId: created.body.commandId },
        body: { ...connection, status: "succeeded", result: { apps: [] } },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const result = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      status: "succeeded",
      result: { apps: [] },
    });
  });

  it("returns the created command even if token issuance stalls", async () => {
    const { api } = await setup();
    const provider = createDeferredPromise<unknown>(context.signal);
    context.mocks.ably.createTokenRequest.mockImplementation(() => {
      return provider.promise;
    });
    const created = await accept(
      api(commands).create({
        headers,
        body: { kind: "apps.list", realtime: true },
      }),
      [200],
    );
    provider.resolve({});
    expect(created.body).toStrictEqual({
      commandId: created.body.commandId,
      status: "queued",
    });
    const result = await accept(
      api(commands).get({
        headers,
        params: { commandId: created.body.commandId },
      }),
      [200],
    );
    expect(result.body.status).toBe("queued");
  });

  it(
    "requires the sandbox Agent's existing bound-host capability before issuing a result grant",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const host = await scenario.computerUse.startComputerUseHost(actor, {
          supportedCapabilities: runtime.supportedCapabilities,
        });
        const agent = await scenario.claim(actor, host.hostId);
        signTokenRequests();
        const created = await scenario.computerUse.createComputerUseReadCommand(
          { bearer: agent.token },
          { kind: "apps.list", realtime: true },
        );
        expect(created.realtime?.tokenRequest.capability).toBe(
          JSON.stringify({
            [`computer-use-result:${actor.userId}:${actor.orgId}:${created.commandId}`]:
              ["subscribe"],
          }),
        );
        const unbound = await scenario.claim(actor, undefined);
        await scenario.computerUse.requestCreateComputerUseReadCommand(
          { bearer: unbound.token },
          { kind: "apps.list", realtime: true },
          [403],
        );
        expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
      });
    },
  );
});
