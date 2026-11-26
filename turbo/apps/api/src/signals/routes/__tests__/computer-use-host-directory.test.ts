import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, nowDate } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

describe("standalone Computer Use host directory", () => {
  it("computer-use-host-directory-002 returns the complete ordered online, stale and stopped-installation directory without foreign hosts", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
    const foreign = bdd.user({ orgRole: "org:member" });

    const stale = await api.startComputerUseHost(member, {
      hostName: "Stale Desktop",
    });

    mockNow(start + 1000);
    const stopped = await api.startComputerUseHost(member, {
      hostName: "Stopped Desktop",
    });
    await api.stopComputerUseHost(stopped.connection);

    mockNow(start + 2000);
    const currentCreatedAt = nowDate().toISOString();
    const currentOptions = {
      hostName: "Current Desktop",
      appVersion: "0.52.1",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "element.click"],
      permissions: { accessibility: true, screenRecording: false },
    };
    const current = await api.startComputerUseHost(member, currentOptions);

    await api.startComputerUseHost(peer, { hostName: "Peer Desktop" });
    await api.startComputerUseHost(foreign, { hostName: "Foreign Desktop" });

    mockNow(start + 120_000);
    const currentLastSeenAt = nowDate().toISOString();
    await api.heartbeatComputerUseHost(current.connection, currentOptions);

    const publishedBeforeRead = context.mocks.ably.publish.mock.calls.length;
    const batchedBeforeRead = context.mocks.ably.batchPublish.mock.calls.length;

    const directory = await api.listComputerUseHosts(member);

    expect(
      directory.hosts.map((host) => {
        return { id: host.id, status: host.status };
      }),
    ).toStrictEqual([
      { id: current.hostId, status: "online" },
      { id: stopped.hostId, status: "offline" },
      { id: stale.hostId, status: "offline" },
    ]);
    expect(directory.hosts[0]).toStrictEqual({
      id: current.hostId,
      hostName: "Current Desktop",
      displayName: "Current Desktop",
      appVersion: "0.52.1",
      osVersion: "macOS 15",
      supportedCapabilities: ["apps.list", "element.click"],
      permissions: {
        accessibility: true,
        screenRecording: false,
        automation: {
          chrome: { status: "unknown", updatedAt: null, reason: null },
          safari: { status: "unknown", updatedAt: null, reason: null },
        },
      },
      status: "online",
      lastSeenAt: currentLastSeenAt,
      createdAt: currentCreatedAt,
    });
    expect(
      context.mocks.ably.publish.mock.calls.slice(publishedBeforeRead),
    ).toStrictEqual([]);
    expect(
      context.mocks.ably.batchPublish.mock.calls.slice(batchedBeforeRead),
    ).toStrictEqual([]);
  });
});
