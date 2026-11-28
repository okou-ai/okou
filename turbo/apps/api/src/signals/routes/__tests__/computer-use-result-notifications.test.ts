import { randomUUID } from "node:crypto";

import {
  remoteDevicesContract,
  type RemoteDeviceAccess,
} from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { remoteDevicesRoutes } from "../remote-devices";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface TokenRequestParams {
  readonly capability: Record<string, readonly string[]>;
  readonly ttl: number;
  readonly clientId: string;
}

function isTokenRequestParams(value: unknown): value is TokenRequestParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "capability" in value &&
    "ttl" in value &&
    "clientId" in value
  );
}

/** The realtime provider signs every token request it receives. */
function signTokenRequests(): void {
  context.mocks.ably.createTokenRequest.mockImplementation(
    (params: unknown) => {
      if (!isTokenRequestParams(params)) {
        throw new Error("Unexpected Ably token request parameters");
      }
      return Promise.resolve({
        keyName: "app.key",
        ttl: params.ttl,
        timestamp: now(),
        capability: JSON.stringify(params.capability),
        clientId: params.clientId,
        nonce: randomUUID(),
        mac: randomUUID(),
      });
    },
  );
}

interface Publication {
  readonly channelName: string;
  readonly eventName: unknown;
  readonly payload: unknown;
}

/** Records every realtime publication with the channel it reached. */
function recordPublications(
  onPublish: (publication: Publication) => void = () => {},
): Publication[] {
  const published: Publication[] = [];
  let currentChannel = "";
  context.mocks.ably.channelGet.mockImplementation((channelName) => {
    currentChannel = channelName;
  });
  context.mocks.ably.publish.mockImplementation(
    (eventName: unknown, payload: unknown) => {
      const publication = { channelName: currentChannel, eventName, payload };
      published.push(publication);
      onPublish(publication);
      return Promise.resolve();
    },
  );
  return published;
}

function resultChannel(admin: ApiTestUser, commandId: string): string {
  return `computer-use-result:${admin.userId}:${admin.orgId ?? ""}:${commandId}`;
}

function resultChangedChannels(published: readonly Publication[]) {
  return [
    ...new Set(
      published
        .filter((publication) => {
          return publication.eventName === "resultChanged";
        })
        .map((publication) => {
          return `${publication.channelName}|${String(publication.payload)}`;
        }),
    ),
  ];
}

describe("Computer Use CLI result subscriptions", () => {
  it("computer-use-result-notifications-001 grants a subscribe-only result channel only when the read caller opts in", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const otherUser = bdd.user({ orgRole: "org:admin" });
    signTokenRequests();
    await api.startComputerUseHost(admin);

    const optedIn = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
      timeoutMs: 10_000,
    });
    const plain = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
    });
    const otherRead = await api.requestReadComputerUseCommand(
      otherUser,
      optedIn.commandId,
      [404],
    );

    const channelName = resultChannel(admin, optedIn.commandId);
    expect(optedIn.realtime).toStrictEqual({
      channelName,
      eventName: "resultChanged",
      tokenRequest: expect.objectContaining({
        clientId: expect.stringContaining(admin.userId),
        ttl: 70_000,
        capability: JSON.stringify({ [channelName]: ["subscribe"] }),
      }),
    });
    expect(plain).toStrictEqual({
      commandId: plain.commandId,
      status: "queued",
    });
    expect(otherRead.status).toBe(404);
  });

  it("computer-use-result-notifications-003 notifies a durable succeeded result and keeps completion idempotent", async () => {
    const api = createComputerUseBddApi(context);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    signTokenRequests();
    const host = await api.startComputerUseHost(admin);
    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
    });
    await api.claimNextComputerUseCommand(host.connection);
    const readsAtPublish: Promise<unknown>[] = [];
    const published = recordPublications((publication) => {
      if (publication.eventName === "resultChanged") {
        readsAtPublish.push(
          api.readComputerUseCommand(admin, created.commandId),
        );
      }
    });
    const completion = {
      status: "succeeded",
      result: { apps: [] },
    } as const;

    const first = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      completion,
      [200],
    );
    const second = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      completion,
      [200],
    );
    const statusesAtPublish = await Promise.all(readsAtPublish);
    const final = await api.readComputerUseCommand(admin, created.commandId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(statusesAtPublish.length).toBeGreaterThan(0);
    expect(statusesAtPublish).toStrictEqual(
      statusesAtPublish.map(() => {
        return expect.objectContaining({ status: "succeeded" });
      }),
    );
    expect(final.status).toBe("succeeded");
    expect(resultChangedChannels(published)).toStrictEqual([
      `${resultChannel(admin, created.commandId)}|null`,
    ]);
  });

  it("computer-use-result-notifications-005 keeps the timeout result when a late completion arrives", async () => {
    const api = createComputerUseBddApi(context);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    signTokenRequests();
    const startedAt = now();
    mockNow(startedAt);
    const host = await api.startComputerUseHost(admin);
    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
      timeoutMs: 1000,
    });
    await api.claimNextComputerUseCommand(host.connection);
    const published = recordPublications();
    mockNow(startedAt + 2000);

    await Promise.all([
      api.readComputerUseCommand(admin, created.commandId),
      api.readComputerUseCommand(admin, created.commandId),
    ]);
    const late = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      { status: "succeeded", result: { apps: [] } },
      [200],
    );
    const final = await api.readComputerUseCommand(admin, created.commandId);

    expect(late.status).toBe(200);
    expect(final).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    expect(resultChangedChannels(published)).toStrictEqual([
      `${resultChannel(admin, created.commandId)}|null`,
    ]);
  });

  it(
    "computer-use-result-notifications-008 requires the sandbox Agent's bound-host capability and live device policy before issuing a result grant",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const api = createComputerUseBddApi(context);
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const chat = createChatFilesBddApi(context);
      const member = bdd.user({ orgRole: "org:member" });
      if (!member.orgId) {
        throw new Error("Expected an organization member");
      }
      const memberOrgId = member.orgId;

      const host = await api.startComputerUseHost(member, {
        hostName: "Realtime Bound Desktop",
      });

      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
      const [, runnerGroup] = await Promise.all([
        deliverOrganizationCreated(context, member),
        runs.configureRunnerGroup(),
      ]);

      let activeRun:
        { readonly runId: string; readonly sandboxToken: string } | undefined;
      async function cancelActiveRun(): Promise<void> {
        if (!activeRun) {
          return;
        }
        const toCancel = activeRun;
        activeRun = undefined;
        await runs.requestCancelRun(member, toCancel.runId, [200, 400]);
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId: toCancel.runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${toCancel.sandboxToken}` },
          [200, 400],
        );
        await flushWaitUntilForTest();
      }
      onTestFinished(async () => {
        await cancelActiveRun();
      });

      async function launchRun(hostId?: string) {
        await cancelActiveRun();
        const before = runs.receivedDispatches(runnerGroup).length;
        const sent = await chat.requestSendEvent(
          member,
          {
            prompt: "Run a realtime computer-use command",
            model: null,
            clientEventId: randomUUID(),
            computerUseHostId: hostId ?? null,
          },
          [201],
        );
        if (sent.status !== 201) {
          throw new Error("Expected an accepted chat send");
        }
        await flushWaitUntilForTest();
        const dispatches = runs.receivedDispatches(runnerGroup);
        const dispatch = dispatches.at(-1);
        const token = dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
        if (dispatches.length <= before || !dispatch || !token) {
          throw new Error("Expected a dispatched Run with OKOU_TOKEN");
        }
        activeRun = {
          runId: dispatch.executionContext.runId,
          sandboxToken: dispatch.executionContext.sandboxToken,
        };
        return { token, runId: dispatch.executionContext.runId };
      }

      const unboundRun = await launchRun();
      const boundRun = await launchRun(host.hostId);

      signTokenRequests();
      const tokenRequestsBefore =
        context.mocks.ably.createTokenRequest.mock.calls.length;

      mockClerkMembership(context, member, "org:member");
      const unboundDenied = await api.requestCreateComputerUseReadCommand(
        { bearer: unboundRun.token },
        { kind: "apps.list", realtime: true },
        [403],
      );
      expectApiError(unboundDenied.body);

      const boundCreated = await api.createComputerUseReadCommand(
        { bearer: boundRun.token },
        { kind: "apps.list", realtime: true },
      );
      const expectedChannel = resultChannel(member, boundCreated.commandId);
      expect(boundCreated.realtime).toStrictEqual({
        channelName: expectedChannel,
        eventName: "resultChanged",
        tokenRequest: expect.objectContaining({
          capability: JSON.stringify({ [expectedChannel]: ["subscribe"] }),
        }),
      });
      expect(
        context.mocks.ably.createTokenRequest.mock.calls.length -
          tokenRequestsBefore,
      ).toBe(1);

      await updateFeatureSwitchesForUser(
        context,
        { userId: member.userId, orgId: memberOrgId, orgRole: member.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      mockClerkMembership(context, member, "org:member");
      const deniedByDevicePolicy =
        await api.requestCreateComputerUseReadCommand(
          { bearer: boundRun.token },
          { kind: "apps.list", realtime: true },
          [404],
        );
      expect(deniedByDevicePolicy.body).toStrictEqual({
        error: {
          message: "No linked computer-use host found",
          code: "NOT_FOUND",
        },
      });
      expect(
        context.mocks.ably.createTokenRequest.mock.calls.length -
          tokenRequestsBefore,
      ).toBe(1);

      const remoteDevices = setupApp({
        context,
        routes: remoteDevicesRoutes,
      })(remoteDevicesContract);
      createRouteMocks(context).clerk.session(
        member.userId,
        memberOrgId,
        member.orgRole,
      );
      const listed = await accept(
        remoteDevices.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const device = listed.body.devices.find((candidate) => {
        return candidate.channels.some((channel) => {
          return channel.kind === "desktop" && channel.id === host.hostId;
        });
      });
      if (!device) {
        throw new Error("Expected remote device for registered desktop");
      }
      const allowAccess: RemoteDeviceAccess = { mode: "always" };
      await accept(
        remoteDevices.setAccess({
          headers: { authorization: "Bearer clerk-session" },
          params: { deviceId: device.id },
          body: allowAccess,
        }),
        [200],
      );

      mockClerkMembership(context, member, "org:member");
      const admittedCreated = await api.createComputerUseReadCommand(
        { bearer: boundRun.token },
        { kind: "apps.list", realtime: true },
      );
      const admittedChannel = resultChannel(member, admittedCreated.commandId);
      expect(admittedCreated.realtime).toStrictEqual({
        channelName: admittedChannel,
        eventName: "resultChanged",
        tokenRequest: expect.objectContaining({
          capability: JSON.stringify({ [admittedChannel]: ["subscribe"] }),
        }),
      });
      expect(
        context.mocks.ably.createTokenRequest.mock.calls.length -
          tokenRequestsBefore,
      ).toBe(2);
    },
  );
});
