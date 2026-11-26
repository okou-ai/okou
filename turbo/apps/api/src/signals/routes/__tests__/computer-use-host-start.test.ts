import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, nowDate } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { channelsPublishedTo } from "./helpers/realtime-publications";

const context = testContext();

describe("Computer Use host START", () => {
  it("computer-use-host-start-002 (1/2) preserves identity on restart, updates metadata and notification, and retains identity after stop", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const createdAt = nowDate().toISOString();
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const owner = bdd.user({ orgRole: "org:member" });
    const installationId = randomUUID();

    const first = await api.startComputerUseHost(owner, {
      installationId,
      hostName: "Initial Desktop",
      appVersion: "0.52.0",
      osVersion: "macOS 14",
      supportedCapabilities: ["apps.list"],
      permissions: { accessibility: false, screenRecording: false },
    });

    mockNow(start + 5000);
    const notificationsBeforeRestart = channelsPublishedTo(
      context.mocks,
      "computerUseHostsChanged",
    ).length;

    const restarted = await api.startComputerUseHost(owner, {
      installationId,
      hostName: "Updated Desktop",
      appVersion: "0.53.0",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "app.state"],
      permissions: { accessibility: true, screenRecording: false },
    });

    const restartNotifications = channelsPublishedTo(
      context.mocks,
      "computerUseHostsChanged",
    ).slice(notificationsBeforeRestart);

    const listedAfterRestart = await api.listComputerUseHosts(owner);
    const oldHeartbeat = await api.requestComputerUseHeartbeat(
      first.connection,
      [409],
    );
    const newHeartbeat = await api.requestComputerUseHeartbeat(
      restarted.connection,
      [200],
    );

    expect(restarted.hostId).toBe(first.hostId);
    expect(restarted.connectionGeneration).toBeGreaterThan(
      first.connectionGeneration,
    );
    expect(restartNotifications).toStrictEqual([`user:${owner.userId}`]);
    expect(listedAfterRestart.hosts).toHaveLength(1);
    expect(listedAfterRestart.hosts[0]).toMatchObject({
      id: first.hostId,
      hostName: "Updated Desktop",
      displayName: "Updated Desktop",
      appVersion: "0.53.0",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "app.state"],
      permissions: { accessibility: true, screenRecording: false },
      createdAt,
    });
    expect(oldHeartbeat.status).toBe(409);
    expect(newHeartbeat.status).toBe(200);

    await api.stopComputerUseHost(restarted.connection);

    mockNow(start + 10_000);
    const afterStop = await api.startComputerUseHost(owner, {
      installationId,
      hostName: "Resumed Desktop",
      appVersion: "0.53.1",
      osVersion: "macOS 15.1",
      supportedCapabilities: ["apps.list"],
      permissions: { accessibility: true, screenRecording: true },
    });
    const listedAfterStopRestart = await api.listComputerUseHosts(owner);

    expect(afterStop.hostId).toBe(first.hostId);
    expect(afterStop.connectionGeneration).toBeGreaterThan(
      restarted.connectionGeneration,
    );
    expect(listedAfterStopRestart.hosts[0]).toMatchObject({
      id: first.hostId,
      createdAt,
    });
  });

  it("computer-use-host-start-002 (2/2) isolates installation ownership across users and resolves concurrent starts to one host", async () => {
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const owner = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const foreign = bdd.user({ orgRole: "org:member" });
    const installationId = randomUUID();

    const ownerHost = await api.startComputerUseHost(owner, { installationId });
    const peerHost = await api.startComputerUseHost(peer, { installationId });
    const foreignHost = await api.startComputerUseHost(foreign, {
      installationId,
    });

    expect(peerHost.hostId).not.toBe(ownerHost.hostId);
    expect(foreignHost.hostId).not.toBe(ownerHost.hostId);
    expect(foreignHost.hostId).not.toBe(peerHost.hostId);

    const freshInstallationId = randomUUID();
    const [concurrentA, concurrentB] = await Promise.all([
      api.startComputerUseHost(owner, {
        installationId: freshInstallationId,
        hostName: "Concurrent Desktop A",
      }),
      api.startComputerUseHost(owner, {
        installationId: freshInstallationId,
        hostName: "Concurrent Desktop B",
      }),
    ]);

    expect(concurrentA.hostId).toBe(concurrentB.hostId);

    const heartbeatA = await api.requestComputerUseHeartbeat(
      concurrentA.connection,
      [200, 409],
    );
    const heartbeatB = await api.requestComputerUseHeartbeat(
      concurrentB.connection,
      [200, 409],
    );

    expect([heartbeatA.status, heartbeatB.status].sort()).toStrictEqual([
      200, 409,
    ]);
  });
});
