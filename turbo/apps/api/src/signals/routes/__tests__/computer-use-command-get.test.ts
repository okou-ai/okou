import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, nowDate } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("GET /api/computer-use/commands/:commandId", () => {
  it("computer-use-command-get-002 (1/2) preserves queued, running and succeeded offloaded response fields", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const storage = api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member, {
      hostName: "Projection Desktop",
    });

    mockNow(start + 1000);
    const createdAt = nowDate().toISOString();
    const readCommand = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
      timeoutMs: 15_000,
    });
    const queued = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(queued).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "queued",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      timeoutMs: 15_000,
      createdAt,
      claimedAt: null,
      completedAt: null,
    });

    mockNow(start + 2000);
    const claimedAt = nowDate().toISOString();
    const claimedRead = await api.claimNextComputerUseCommand(host.connection);
    expect(claimedRead).toMatchObject({
      status: "command",
      command: { id: readCommand.commandId },
    });
    const running = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(running).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "running",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      timeoutMs: 15_000,
      createdAt,
      claimedAt,
      completedAt: null,
    });

    mockNow(start + 3000);
    const completedAt = nowDate().toISOString();
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64, 9)]);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const visibleText = "Safari — 検索結果 café";
    await api.completeComputerUseCommandWith(
      host.connection,
      readCommand.commandId,
      {
        status: "succeeded",
        result: {
          snapshotId: "snap_projection_1",
          visibleText,
          screenshot: dataUrl,
          screenshotWidth: 1280,
          screenshotHeight: 720,
        },
      },
    );
    const succeeded = await api.readComputerUseCommand(
      member,
      readCommand.commandId,
    );

    expect(succeeded).toStrictEqual({
      id: readCommand.commandId,
      kind: "app.state",
      status: "succeeded",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Safari" },
      result: {
        snapshotId: "snap_projection_1",
        visibleText,
        screenshot: {
          type: "s3",
          mimeType: "image/png",
          sizeBytes: png.length,
          width: 1280,
          height: 720,
        },
        screenshotWidth: 1280,
        screenshotHeight: 720,
      },
      timeoutMs: 15_000,
      createdAt,
      claimedAt,
      completedAt,
    });
    expect(JSON.stringify(succeeded)).not.toContain(png.toString("base64"));
    expect(storage.puts).toHaveLength(1);
  });

  it("computer-use-command-get-002 (2/2) preserves failed response fields without a result", async () => {
    const start = Date.parse("2026-02-01T12:00:00.000Z");
    mockNow(start);
    const bdd = createBddApi(context);
    const api = createComputerUseBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member, {
      hostName: "Projection Desktop",
    });

    mockNow(start + 4000);
    const writeCreatedAt = nowDate().toISOString();
    const writeCommand = await api.createComputerUseWriteCommand(member, {
      kind: "app.open",
      app: "Finder",
    });

    mockNow(start + 5000);
    const writeClaimedAt = nowDate().toISOString();
    const claimedWrite = await api.claimNextComputerUseCommand(host.connection);
    expect(claimedWrite).toMatchObject({
      status: "command",
      command: { id: writeCommand.commandId },
    });

    mockNow(start + 6000);
    const writeCompletedAt = nowDate().toISOString();
    const failureMessage = "Finder が見つかりません — résumé";
    await api.completeComputerUseCommandWith(
      host.connection,
      writeCommand.commandId,
      {
        status: "failed",
        error: {
          code: "app_not_found",
          message: failureMessage,
        },
      },
    );
    const failed = await api.readComputerUseCommand(
      member,
      writeCommand.commandId,
    );

    expect(failed).toStrictEqual({
      id: writeCommand.commandId,
      kind: "app.open",
      status: "failed",
      hostId: host.hostId,
      hostName: "Projection Desktop",
      payload: { app: "Finder" },
      error: {
        code: "app_not_found",
        message: failureMessage,
      },
      timeoutMs: 60_000,
      createdAt: writeCreatedAt,
      claimedAt: writeClaimedAt,
      completedAt: writeCompletedAt,
    });
    expect(failed).not.toHaveProperty("result");
  });
});
