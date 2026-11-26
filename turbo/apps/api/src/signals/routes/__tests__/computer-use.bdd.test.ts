import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("desktop computer-use runtime", () => {
  it("computer-use.bdd-017 keeps an installation's host stable across stop and restart", async () => {
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const installationId = randomUUID();
    const host = await api.startComputerUseHost(member, {
      installationId,
      hostName: "Studio Mac",
    });

    await api.stopComputerUseHost(host.connection);
    const heartbeat = await api.requestComputerUseHeartbeat(
      host.connection,
      [409],
    );
    const stopped = await api.listComputerUseHosts(member);
    const restarted = await api.startComputerUseHost(member, {
      installationId,
      hostName: "Renamed Studio Mac",
    });
    const relisted = await api.listComputerUseHosts(member);

    expect(heartbeat.body).toMatchObject({
      error: {
        message: "Computer-use host connection is no longer authorized",
      },
    });
    expect(stopped.hosts).toStrictEqual([
      expect.objectContaining({ id: host.hostId, status: "offline" }),
    ]);
    expect(restarted.hostId).toBe(host.hostId);
    expect(restarted.connectionGeneration).toBeGreaterThan(
      host.connectionGeneration,
    );
    expect(relisted.hosts).toStrictEqual([
      expect.objectContaining({
        id: host.hostId,
        status: "online",
        displayName: "Renamed Studio Mac",
      }),
    ]);
  });

  it("computer-use.bdd-016 keeps multiple active hosts and lets a stale heartbeat recover", async () => {
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const startedAt = now();
    mockNow(startedAt);
    const office = await api.startComputerUseHost(member, {
      hostName: "Office Mac",
    });
    const firstHeartbeat = await api.heartbeatComputerUseHost(
      office.connection,
      { hostName: "Office Mac" },
    );
    mockNow(startedAt + 120_000);
    const studio = await api.startComputerUseHost(member, {
      hostName: "Studio Mac",
    });

    const recoveredHeartbeat = await api.heartbeatComputerUseHost(
      office.connection,
      { hostName: "Office Mac" },
    );
    const listing = await api.listComputerUseHosts(member);
    const stopped = await api.stopComputerUseHost(studio.connection);
    const recovered = await api.startComputerUseHost(member, {
      hostName: "Recovered Desktop",
    });

    expect(firstHeartbeat).toStrictEqual({
      ok: true,
      hostId: office.hostId,
      hasPendingCommands: false,
    });
    expect(recoveredHeartbeat).toStrictEqual({
      ok: true,
      hostId: office.hostId,
      hasPendingCommands: false,
    });
    expect(studio.hostId).not.toBe(office.hostId);
    expect(listing.hosts).toHaveLength(2);
    expect(listing.hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: office.hostId,
          status: "online",
          displayName: "Office Mac",
        }),
        expect.objectContaining({
          id: studio.hostId,
          status: "online",
          displayName: "Studio Mac",
        }),
      ]),
    );
    expect(stopped).toStrictEqual({ ok: true, hostId: studio.hostId });
    expect(recovered.hostId).not.toBe(studio.hostId);
  });

  it("computer-use.bdd-013 chains host start, command claim, completion, audit and host stop", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });

    const initial = await api.listComputerUseHosts(member);
    const host = await api.startComputerUseHost(member, {
      hostName: "lancy-macbook-pro.local",
    });
    const listed = await api.listComputerUseHosts(member);
    const created = await api.createComputerUseWriteCommand(member, {
      kind: "app.open",
      app: "Safari",
    });
    const claimed = await api.claimNextComputerUseCommand(host.connection);
    await api.completeComputerUseCommand(host.connection, created.commandId);
    const completed = await api.readComputerUseCommand(
      member,
      created.commandId,
    );
    const peerRead = await api.requestReadComputerUseCommand(
      peer,
      created.commandId,
      [403, 404],
    );
    const audit = await api.listComputerUseAuditEvents(member, {
      commandId: created.commandId,
    });
    await api.stopComputerUseHost(host.connection);
    const afterStop = await api.listComputerUseHosts(member);
    const heartbeat = await api.requestComputerUseHeartbeat(
      host.connection,
      [409],
    );

    expect(initial.hosts).toStrictEqual([]);
    expect(host.connectionGeneration).toBe(1);
    expect(listed.hosts).toStrictEqual([
      expect.objectContaining({
        id: host.hostId,
        status: "online",
        permissions: expect.objectContaining({
          accessibility: true,
          screenRecording: true,
        }),
      }),
    ]);
    expect(created.status).toBe("queued");
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId, kind: "app.open" },
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      hostId: host.hostId,
    });
    expect(peerRead.body).toMatchObject({
      error: { code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) },
    });
    expect(audit.auditEvents).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: created.commandId,
          event: "completed",
        }),
      ]),
    );
    expect(afterStop.hosts).toStrictEqual([
      expect.objectContaining({ id: host.hostId, status: "offline" }),
    ]);
    expect(heartbeat.status).toBe(409);
  });

  it("computer-use.bdd-025 offloads a screenshot and resolves its download URL for the owner only", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const outsider = bdd.user({ orgRole: "org:member" });
    const storage = api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member);
    const { commandId } = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.connection);
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(56, 7)]);

    await api.completeComputerUseCommandWith(host.connection, commandId, {
      status: "succeeded",
      result: {
        app: "Safari",
        snapshotId: "snapshot-1",
        screenshot: `data:image/png;base64,${png.toString("base64")}`,
        screenshotWidth: 1363,
        screenshotHeight: 1200,
      },
    });
    const completed = await api.readComputerUseCommand(member, commandId);
    const download = await api.resolveComputerUseScreenshot(member, commandId);
    const outsiderDownload = await api.requestComputerUseScreenshot(
      outsider,
      commandId,
      [404],
    );

    const key = `computer-use/${member.orgId ?? ""}/${member.userId}/${commandId}/screenshot.png`;
    expect(storage.puts).toStrictEqual([
      {
        bucket: expect.stringContaining("user-storages"),
        key,
        body: png,
        contentType: "image/png",
      },
    ]);
    expect(completed).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: {
          type: "s3",
          mimeType: "image/png",
          sizeBytes: png.length,
          width: 1363,
          height: 1200,
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain(png.toString("base64"));
    expect(download).toMatchObject({
      downloadUrl: expect.stringContaining(encodeURIComponent(key)),
      contentType: "image/png",
      size: png.length,
    });
    expect(outsiderDownload.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
