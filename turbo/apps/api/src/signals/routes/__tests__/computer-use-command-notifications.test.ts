import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

function workspaceAdmin(): ApiTestUser {
  return createBddApi(context).user({ orgRole: "org:admin" });
}

function expectedChannel(
  admin: ApiTestUser,
  hostId: string,
  connectionGeneration: number,
): string {
  return `computer-use-host:${admin.userId}:${admin.orgId ?? ""}:${hostId}:${connectionGeneration}`;
}

describe("Native Computer Use command notifications", () => {
  it("computer-use-command-notifications-001 returns a subscription for the authenticated host's current connection", async () => {
    const api = createComputerUseBddApi(context);
    const admin = workspaceAdmin();
    const installationId = randomUUID();

    const first = await api.startComputerUseHost(admin, { installationId });
    const second = await api.startComputerUseHost(admin, { installationId });
    const stalePoll = await api.requestClaimNextComputerUseCommand(
      first.connection,
      [409],
    );
    const stopped = await api.requestStopComputerUseHost(
      second.connection,
      [200],
    );

    expect(first.commandNotifications).toStrictEqual({
      channelName: expectedChannel(
        admin,
        first.hostId,
        first.connectionGeneration,
      ),
      eventName: "commandsChanged",
    });
    expect(second.hostId).toBe(first.hostId);
    expect(second.connectionGeneration).toBeGreaterThan(
      first.connectionGeneration,
    );
    expect(second.commandNotifications).toStrictEqual({
      channelName: expectedChannel(
        admin,
        second.hostId,
        second.connectionGeneration,
      ),
      eventName: "commandsChanged",
    });
    expect(stalePoll.status).toBe(409);
    expect(stopped.status).toBe(200);
  });

  it("computer-use-command-notifications-005 does not hint work for another host or for unsupported command capabilities", async () => {
    const api = createComputerUseBddApi(context);
    const admin = workspaceAdmin();
    const first = await api.startComputerUseHost(admin);
    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
    });
    const second = await api.startComputerUseHost(admin);

    const secondHeartbeat = await api.heartbeatComputerUseHost(
      second.connection,
    );
    const appStateOnly = await api.heartbeatComputerUseHost(first.connection, {
      supportedCapabilities: ["app.state"],
    });
    const normal = await api.heartbeatComputerUseHost(first.connection);
    const command = await api.readComputerUseCommand(admin, created.commandId);

    expect(secondHeartbeat.hasPendingCommands).toBeFalsy();
    expect(appStateOnly.hasPendingCommands).toBeFalsy();
    expect(normal.hasPendingCommands).toBeTruthy();
    expect(command.status).toBe("queued");
  });

  it("computer-use-command-notifications-002 publishes only after a command is available through the HTTP claiming endpoint", async () => {
    const api = createComputerUseBddApi(context);
    const admin = workspaceAdmin();
    const host = await api.startComputerUseHost(admin, {
      supportedCapabilities: ["apps.list"],
    });
    const published: {
      readonly channelName: string;
      readonly eventName: unknown;
      readonly payload: unknown;
    }[] = [];
    const polls: Promise<unknown>[] = [];
    let currentChannel = "";
    context.mocks.ably.channelGet.mockImplementation((channelName) => {
      currentChannel = channelName;
    });
    context.mocks.ably.publish.mockImplementation(
      (eventName: unknown, payload: unknown) => {
        published.push({ channelName: currentChannel, eventName, payload });
        if (eventName === "commandsChanged") {
          polls.push(
            api.claimNextComputerUseCommand(host.connection, ["apps.list"]),
          );
        }
        return Promise.resolve();
      },
    );

    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
    });
    const claims = await Promise.all(polls);
    const notifications = published.filter((message) => {
      return message.eventName === "commandsChanged";
    });
    const command = await api.readComputerUseCommand(admin, created.commandId);
    await api.completeComputerUseCommand(host.connection, created.commandId);
    const stopped = await api.stopComputerUseHost(host.connection);

    expect(claims).toStrictEqual([
      {
        status: "command",
        command: expect.objectContaining({ id: created.commandId }),
      },
    ]);
    expect(notifications).toStrictEqual([
      {
        channelName: host.commandNotifications.channelName,
        eventName: "commandsChanged",
        payload: null,
      },
    ]);
    expect(command.status).toBe("running");
    expect(stopped.hostId).toBe(host.hostId);
  });
});
