import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { phoneUseCommand } from "../phone-use";
import {
  ablyRealtimeFake,
  ablyTokenExchangeHandler,
} from "../../test-fixtures/ably-realtime";
vi.mock("ably", async () => {
  const { FakeRealtime } = await import("../../test-fixtures/ably-realtime");
  return { Realtime: FakeRealtime };
});
let directory = "";
beforeEach(async () => {
  ablyRealtimeFake.reset();
  directory = await mkdtemp(join(tmpdir(), "phone-use-"));
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("Phone Use CLI", () => {
  it.each([true, false])(
    "reports whether a phone is online (%s)",
    async (online) => {
      const device = {
        id: randomUUID(),
        displayName: "Owner iPhone",
        osVersion: "27.1",
        appVersion: "1",
        generation: 1,
        online,
        lastSeenAt: "2026-11-17T00:00:00.000Z",
      };
      server.use(
        http.get("https://api.vm0.ai/api/phone-use/devices", () => {
          return HttpResponse.json({ devices: [device] });
        }),
      );
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await new Command()
        .exitOverride()
        .addCommand(phoneUseCommand)
        .parseAsync(["phone-use", "devices"], { from: "user" });
      expect(output).toHaveBeenCalledWith(
        JSON.stringify({ devices: [device] }, null, 2),
      );
    },
  );
  it("recovers a submitted operation by its identity and writes its screenshot privately", async () => {
    const id = randomUUID();
    const operation = {
      id,
      deviceId: randomUUID(),
      runId: randomUUID(),
      grantId: randomUUID(),
      action: { kind: "observe" },
      status: "succeeded",
      result: { snapshotID: randomUUID() },
      error: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
    };
    server.use(
      http.post(
        "https://api.vm0.ai/api/phone-use/operations",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            id,
            action: { kind: "observe" },
          });
          return HttpResponse.json(operation);
        },
      ),
      http.get(`https://api.vm0.ai/api/phone-use/operations/${id}`, () => {
        return HttpResponse.json(operation);
      }),
      http.get(
        `https://api.vm0.ai/api/phone-use/operations/${id}/screenshot`,
        () => {
          return HttpResponse.json({
            url: "https://private-images.example/phone.png",
          });
        },
      ),
      http.get("https://private-images.example/phone.png", ({ request }) => {
        expect(request.headers.get("Authorization")).toBeNull();
        return new HttpResponse(new Uint8Array([137, 80, 78, 71]));
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride().addCommand(phoneUseCommand);
    await program.parseAsync(
      [
        "phone-use",
        "observe",
        "--id",
        id,
        "--wait",
        "0",
        "--output",
        directory,
      ],
      { from: "user" },
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining(id));
    const path = join(directory, `${id}.png`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(Buffer.from([137, 80, 78, 71]));
    await chmod(path, 0o644);
    await program.parseAsync(
      ["phone-use", "status", id, "--output", directory],
      { from: "user" },
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("submits a snapshot-bound tap and reports its native receipt", async () => {
    const id = randomUUID(),
      snapshot = randomUUID();
    const action = {
      kind: "tap",
      app: "com.example.notes",
      snapshotId: snapshot,
      elementId: "3",
    };
    const operation = {
      id,
      deviceId: randomUUID(),
      runId: randomUUID(),
      grantId: randomUUID(),
      action,
      status: "succeeded",
      result: { nativeAcknowledged: true, outcomeVerified: false },
      error: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    server.use(
      http.post(
        "https://api.vm0.ai/api/phone-use/operations",
        async ({ request }) => {
          expect(await request.json()).toEqual({ id, action });
          return HttpResponse.json(operation);
        },
      ),
      http.get(`https://api.vm0.ai/api/phone-use/operations/${id}`, () => {
        return HttpResponse.json(operation);
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await new Command()
      .exitOverride()
      .addCommand(phoneUseCommand)
      .parseAsync(
        [
          "phone-use",
          "tap",
          "--id",
          id,
          "--app",
          action.app,
          "--snapshot",
          snapshot,
          "--element",
          "3",
          "--wait",
          "0",
        ],
        { from: "user" },
      );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"status": "succeeded"'),
    );
  });
  it("reads a completed receipt from an older caller without resubmitting input", async () => {
    const id = randomUUID();
    const operation = {
      id,
      deviceId: randomUUID(),
      runId: randomUUID(),
      grantId: randomUUID(),
      action: {
        kind: "tap",
        app: "com.example.notes",
        snapshotId: randomUUID(),
        elementId: "3",
        confirmation: "Publish the draft",
      },
      status: "succeeded",
      result: { nativeAcknowledged: true, outcomeVerified: false },
      error: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    server.use(
      http.get(`https://api.vm0.ai/api/phone-use/operations/${id}`, () => {
        return HttpResponse.json(operation);
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await new Command()
      .exitOverride()
      .addCommand(phoneUseCommand)
      .parseAsync(["phone-use", "wait", id, "--timeout", "0"], {
        from: "user",
      });
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"nativeAcknowledged": true'),
    );
  });
});

it.each(["observe", "wait"])(
  "finishes %s through an operation-scoped notification without printing its token",
  async (command) => {
    const id = randomUUID();
    let status = command === "wait" ? "approval_required" : "running";
    const operation = () => {
      return {
        id,
        deviceId: randomUUID(),
        runId: randomUUID(),
        grantId: randomUUID(),
        action: { kind: "observe" },
        status,
        result: status === "succeeded" ? { snapshotID: "observed" } : null,
        error: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    };
    const realtime = {
      channelName: `phone-use-result:org:user:${id}`,
      eventName: "resultChanged",
      tokenRequest: {
        keyName: "test.key",
        timestamp: 1,
        nonce: "nonce",
        mac: "private-signature",
        capability: JSON.stringify({
          [`phone-use-result:org:user:${id}`]: ["subscribe"],
        }),
      },
    };
    server.use(
      ablyTokenExchangeHandler,
      http.post("https://api.vm0.ai/api/phone-use/operations", () => {
        return HttpResponse.json({ ...operation(), realtime });
      }),
      http.get(
        `https://api.vm0.ai/api/phone-use/operations/${id}`,
        ({ request }) => {
          return HttpResponse.json({
            ...operation(),
            ...(new URL(request.url).searchParams.has("realtime")
              ? { realtime }
              : {}),
          });
        },
      ),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const args =
      command === "wait"
        ? ["phone-use", "wait", id]
        : ["phone-use", "observe", "--id", id];
    const run = new Command()
      .exitOverride()
      .addCommand(phoneUseCommand)
      .parseAsync(args, { from: "user" });
    const connection = await ablyRealtimeFake.created.promise;
    await connection.subscribed.promise;
    status = "succeeded";
    connection.publish();
    await run;
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"snapshotID": "observed"'),
    );
    expect(output.mock.calls.flat().join("\n")).not.toContain(
      "private-signature",
    );
    expect(connection.closed).toBe(true);
  },
);
