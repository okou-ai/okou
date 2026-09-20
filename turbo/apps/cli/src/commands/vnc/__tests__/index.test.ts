import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVncCommand } from "../index";

const helper = vi.hoisted(() => {
  return {
    mode: "normal",
    data: "",
    response: undefined as unknown,
    requests: [] as unknown[],
    ready: undefined as (() => void) | undefined,
  };
});

// Only replace the external executable. The fixture consumes and produces the
// actual framed protocol through real pipes, including real EOF and exit events.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[]) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      expect(args).toEqual(["--stream"]);
      const script = `
        const mode = process.env.VNC_TEST_MODE;
        const data = Buffer.from(process.env.VNC_TEST_DATA, 'base64');
        const sessionId = 'b0000000-0000-4000-8000-000000000001';
        const connectionId = 'a0000000-0000-4000-8000-000000000001';
        const geometryId = 'c0000000-0000-4000-8000-000000000001';
        let pending = Buffer.alloc(0), request;
        const emit = payload => {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(payload.length);
          process.stdout.write(Buffer.concat([header, payload]));
        };
        const reply = value => emit(Buffer.from(JSON.stringify(value)));
        function finish() {
          if (['nonzero-exit', 'rpc-error', 'early-rejection', 'partial-error'].includes(mode)) process.exitCode = 1;
          process.stdout.end();
          if (mode === 'close-gate') {
            process.send('ready');
            process.on('message', () => process.exit(0));
            setInterval(() => {}, 1000);
          } else process.disconnect();
        }
        function respond() {
          if (mode === 'hang') {
            process.send('ready');
            setInterval(() => {}, 1000);
            return;
          }
          if (mode === 'missing-terminal') return finish();
          if (mode === 'oversize-frame') {
            process.stdout.write(Buffer.from([255, 255, 255, 255]));
            return finish();
          }
          if (mode === 'truncated-frame') {
            process.stdout.write(Buffer.from([0, 0, 0, 4, 123]));
            return finish();
          }
          if (mode === 'malformed-json') {
            emit(Buffer.from('{broken'));
            return finish();
          }
          if (mode === 'invalid-utf8') {
            emit(Buffer.from([123, 255, 125]));
            return finish();
          }
          if (process.env.VNC_TEST_RESPONSE) {
            reply(JSON.parse(process.env.VNC_TEST_RESPONSE));
            return finish();
          }
          const session = { sessionId, connectionId, mode: request.params.mode || 'shared' };
          if (mode === 'wrong-identity') session.sessionId = connectionId;
          if (mode === 'wrong-connection') session.connectionId = sessionId;
          if (mode === 'wrong-mode') session.mode = 'exclusive';
          let result;
          switch (request.method) {
            case 'vnc.session.start': result = { outcome: 'started', session }; break;
            case 'vnc.session.list': result = { outcome: 'listed', sessions: [session] }; break;
            case 'vnc.session.status': result = { outcome: 'status', session }; break;
            case 'vnc.session.close': result = { outcome: 'closed' }; break;
            case 'vnc.input': result = { outcome: 'sent' }; break;
            case 'vnc.capture': {
              const metadata = { kind: 'capture', mimeType: 'image/png', bytes: data.length,
                width: 1, height: 1, geometry: { sessionId: geometryId, epoch: 7 },
                updateSequence: 2, capturedAt: 1700000000000 };
              if (mode === 'byte-count') metadata.bytes += 1;
              if (mode === 'too-big') metadata.bytes = 16 * 1024 * 1024 + 1;
              if (mode === 'unsafe-epoch') metadata.geometry.epoch = 9007199254740992;
              if (mode !== 'missing-metadata') reply({ type: 'event', data: metadata });
              if (mode === 'duplicate-metadata') reply({ type: 'event', data: metadata });
              if (mode === 'partial-error') {
                emit(Buffer.concat([Buffer.from([0]), data.subarray(0, 2)]));
                reply({ type: 'error', code: 'transport', delivery: 'unknown' });
                return finish();
              }
              if (mode === 'empty-data-frame') emit(Buffer.from([0]));
              for (let offset = 0; offset < data.length; offset += 32768) {
                emit(Buffer.concat([Buffer.from([0]), data.subarray(offset, offset + 32768)]));
              }
              if (mode !== 'missing-end') emit(Buffer.from([1]));
              if (mode === 'after-end') emit(Buffer.from([0, 1]));
              if (mode === 'capture-no-terminal') return finish();
              result = { outcome: 'captured', bytes: data.length + (mode === 'terminal-byte-count' ? 1 : 0) };
              break;
            }
            default: throw new Error('Unexpected test method');
          }
          if (mode === 'wrong-method') result = { outcome: 'closed' };
          if (mode === 'unexpected-binary') emit(Buffer.from([0, 1]));
          reply({ type: 'result', data: result });
          if (mode === 'duplicate-terminal') reply({ type: 'result', data: result });
          if (mode === 'trailing-data') emit(Buffer.from([0, 1]));
          finish();
        }
        if (mode === 'early-rejection') {
          require('node:fs').closeSync(0);
          reply({ type: 'error', code: 'unknown_method', delivery: 'not_dispatched' });
          finish();
        } else process.stdin.on('data', chunk => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE()) {
            const size = pending.readUInt32BE();
            const payload = pending.subarray(4, 4 + size);
            pending = pending.subarray(4 + size);
            if (!request) {
              request = JSON.parse(payload.toString());
              process.send(request);
            } else if (payload.length === 1 && payload[0] === 1) respond();
            else throw new Error('Unexpected request frame');
          }
        });
      `;
      const child =
        helper.mode === "missing-helper"
          ? original.spawn("/nonexistent/vnc-test-helper", [], {
              stdio: ["pipe", "pipe", "pipe"],
            })
          : original.spawn(process.execPath, ["-e", script], {
              stdio: ["pipe", "pipe", "pipe", "ipc"],
              env: {
                ...process.env,
                VNC_TEST_MODE: helper.mode,
                VNC_TEST_DATA: helper.data,
                VNC_TEST_RESPONSE:
                  helper.response === undefined
                    ? ""
                    : JSON.stringify(helper.response),
              },
            });
      child.on("message", (message: unknown) => {
        if (message === "ready") helper.ready?.();
        else helper.requests.push(message);
      });
      children.push(child);
      return child;
    }),
  };
});

const connectionId = "a0000000-0000-4000-8000-000000000001";
const sessionId = "b0000000-0000-4000-8000-000000000001";
const geometry = {
  sessionId: "c0000000-0000-4000-8000-000000000001",
  epoch: 7,
};
const session = { sessionId, connectionId, mode: "shared" };
const screenshotBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0Z0AAAAASUVORK5CYII=",
  "base64",
);
const children: ReturnType<typeof spawn>[] = [];
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
let directory: string;

function token(capabilities: string[]) {
  return `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId: connectionId })).toString("base64url")}.signature`;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-vnc-cli-"));
  vi.stubEnv("OKOU_TOKEN", token(["vnc:read", "vnc:write"]));
  helper.mode = "normal";
  helper.data = screenshotBytes.toString("base64");
  helper.response = undefined;
  helper.requests.length = 0;
  helper.ready = undefined;
  vi.mocked(spawn).mockClear();
  process.exitCode = 0;
});

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid)
        return;
      const closed = new Promise<void>((resolve) => {
        child.once("close", resolve);
      });
      child.kill("SIGKILL");
      await closed;
    }),
  );
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  output.mockClear();
  errors.mockClear();
  process.exitCode = 0;
});

async function invoke(...args: string[]) {
  await createVncCommand().parseAsync([...args, "--json"], { from: "user" });
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

describe("VNC sessions and input", () => {
  it("explains native sharing effects and uncertain input in command help", () => {
    const command = createVncCommand();
    const start = command.commands
      .find((entry) => {
        return entry.name() === "session";
      })
      ?.commands.find((entry) => {
        return entry.name() === "start";
      });
    const click = command.commands.find((entry) => {
      return entry.name() === "click";
    });
    if (!start || !click) throw new Error("Missing VNC command");
    let help = "";
    for (const entry of [start, click]) {
      entry.configureOutput({
        writeOut: (text) => {
          help += text;
        },
      });
      entry.outputHelp();
    }
    expect(help).toContain("--mode <shared|exclusive>");
    expect(help).toContain("disconnect other viewers");
    expect(help).toContain("Success is not proof of exclusive control");
    expect(help).toContain("outcome=unknown");
    expect(help).toContain("never retry input automatically");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("explains uncertain delivery without suggesting automatic replay", async () => {
    helper.response = {
      type: "result",
      data: { outcome: "unknown", reason: "network_failure" },
    };
    await createVncCommand().parseAsync(
      ["text", sessionId, "--text", "hello"],
      {
        from: "user",
      },
    );
    const message = errors.mock.calls.flat().join("\n");
    expect(message).toContain("VNC unknown: network_failure");
    expect(message).toContain("may have taken effect");
    expect(message).toContain("Never replay automatically");
    expect(message).toContain("fresh screenshot");
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("explains a certain timeout without claiming which component was silent", async () => {
    helper.response = {
      type: "result",
      data: { outcome: "failed", reason: "timed_out" },
    };
    await createVncCommand().parseAsync(
      ["session", "start", connectionId, "--mode", "shared"],
      { from: "user" },
    );
    const message = errors.mock.calls.flat().join("\n");
    expect(message).toContain("VNC failed: timed_out");
    expect(message).toContain("Runner network");
    expect(message).toContain("RFB banner");
    expect(message).toContain("firewall or VNC server logs");
    expect(message).toContain("does not identify which component was silent");
    expect(message).not.toContain("may have taken effect");
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["shared", "exclusive"])(
    "forwards the explicit %s mode exactly once",
    async (mode) => {
      expect(
        await invoke("session", "start", connectionId, "--mode", mode),
      ).toEqual({
        outcome: "started",
        session: { ...session, mode },
      });
      expect(helper.requests).toEqual([
        {
          version: 1,
          method: "vnc.session.start",
          params: { connectionId, mode },
        },
      ]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each([
    {
      args: ["session", "list"],
      method: "vnc.session.list",
      params: {},
      result: { outcome: "listed", sessions: [session] },
    },
    {
      args: ["session", "status", sessionId],
      method: "vnc.session.status",
      params: { sessionId },
      result: { outcome: "status", session },
    },
    {
      args: ["session", "close", sessionId],
      method: "vnc.session.close",
      params: { sessionId },
      result: { outcome: "closed" },
    },
  ])(
    "dispatches $method and preserves its response",
    async ({ args, method, params, result }) => {
      expect(await invoke(...args)).toEqual(result);
      expect(helper.requests).toEqual([{ version: 1, method, params }]);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      args: [
        "click",
        "--geometry",
        JSON.stringify(geometry),
        "--x",
        "0",
        "--y",
        "65535",
      ],
      input: { type: "click", geometry, x: 0, y: 65535, button: "left" },
    },
    {
      args: [
        "drag",
        "--geometry",
        JSON.stringify(geometry),
        "--points",
        "[[1,2],[3,4]]",
        "--button",
        "right",
      ],
      input: {
        type: "drag",
        geometry,
        points: [
          [1, 2],
          [3, 4],
        ],
        button: "right",
      },
    },
    {
      args: [
        "scroll",
        "--geometry",
        JSON.stringify(geometry),
        "--x",
        "4",
        "--y",
        "5",
        "--axis",
        "horizontal",
        "--steps",
        "-100",
      ],
      input: {
        type: "scroll",
        geometry,
        x: 4,
        y: 5,
        axis: "horizontal",
        steps: -100,
      },
    },
    {
      args: ["text", "--text", "Hi 世界\n\t🙂"],
      input: { type: "text", text: "Hi 世界\n\t🙂" },
    },
    {
      args: ["key", "--keys", "Control", "Alt", "Delete"],
      input: { type: "key_chord", keys: ["Control", "Alt", "Delete"] },
    },
  ])(
    "submits $args as one typed input without replay",
    async ({ args, input }) => {
      expect(await invoke(args[0]!, sessionId, ...args.slice(1))).toEqual({
        outcome: "sent",
      });
      expect(helper.requests).toEqual([
        { version: 1, method: "vnc.input", params: { sessionId, input } },
      ]);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["session", "start", connectionId],
    ["session", "start", connectionId, "--mode", "automatic"],
    ["session", "start", "invalid", "--mode", "shared"],
    ["session", "status", "invalid"],
    ["click", sessionId, "--geometry", "{bad", "--x", "1", "--y", "2"],
    [
      "click",
      sessionId,
      "--geometry",
      JSON.stringify({ ...geometry, epoch: 9007199254740992 }),
      "--x",
      "1",
      "--y",
      "2",
    ],
    [
      "click",
      sessionId,
      "--geometry",
      JSON.stringify({ ...geometry, extra: true }),
      "--x",
      "1",
      "--y",
      "2",
    ],
    [
      "click",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--x",
      "65536",
      "--y",
      "2",
    ],
    [
      "click",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--x",
      "1.5",
      "--y",
      "2",
    ],
    [
      "drag",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--points",
      "[[1,2]]",
    ],
    [
      "drag",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--points",
      JSON.stringify(
        Array.from({ length: 257 }, () => {
          return [0, 0];
        }),
      ),
    ],
    [
      "scroll",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--x",
      "1",
      "--y",
      "2",
      "--axis",
      "vertical",
      "--steps",
      "0",
    ],
    [
      "scroll",
      sessionId,
      "--geometry",
      JSON.stringify(geometry),
      "--x",
      "1",
      "--y",
      "2",
      "--axis",
      "vertical",
      "--steps",
      "101",
    ],
    ["text", sessionId, "--text", ""],
    ["text", sessionId, "--text", "a".repeat(2049)],
    ["text", sessionId, "--text", "界".repeat(1366)],
    ["text", sessionId, "--text", "\u0000"],
    ["text", sessionId, "--text", "\ud800"],
    ["key", sessionId, "--keys", "Control", "Control"],
    ["key", sessionId, "--keys", "F36"],
    ["key", sessionId, "--keys", "Control+X"],
    ["key", sessionId, "--keys", "a", "b", "c", "d", "e", "f", "g", "h", "i"],
  ])("rejects invalid arguments before dispatch: %j", async (...args) => {
    expect(await invoke(...args)).toMatchObject({
      reason: "invalid_input",
      delivery: "not_dispatched",
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["session", "list"],
    ["text", sessionId, "--text", "hello"],
    ["screenshot", sessionId, "--output", "unused.png"],
  ])("requires execution capability before dispatch: %j", async (...args) => {
    vi.stubEnv("OKOU_TOKEN", token(["vnc:read"]));
    expect(await invoke(...args)).toMatchObject({
      reason: "permission_denied",
      delivery: "not_dispatched",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { outcome: "not_started", reason: "stale_geometry" },
    { outcome: "not_started", reason: "disconnected" },
    { outcome: "unknown", reason: "network_failure" },
  ])(
    "preserves Runner input outcome $outcome/$reason without replay",
    async (result) => {
      helper.response = { type: "result", data: result };
      expect(await invoke("text", sessionId, "--text", "hello")).toEqual(
        result,
      );
      expect(process.exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["not_dispatched", "unknown"])(
    "preserves envelope delivery %s and never falls back",
    async (delivery) => {
      helper.mode = "rpc-error";
      helper.response = { type: "error", code: "unknown_method", delivery };
      expect(await invoke("text", sessionId, "--text", "hello")).toMatchObject({
        outcome: delivery === "not_dispatched" ? "not_started" : "unknown",
        reason: "unsupported_runner",
        delivery,
      });
      expect(process.exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "missing-terminal",
    "duplicate-terminal",
    "wrong-method",
    "unexpected-binary",
    "malformed-json",
    "invalid-utf8",
    "nonzero-exit",
  ])("reports uncertain input after %s, without retry", async (mode) => {
    helper.mode = mode;
    expect(
      await invoke("text", sessionId, "--text", "possibly sent"),
    ).toMatchObject({ outcome: "unknown", delivery: "unknown" });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: "wrong-identity", args: ["session", "status", sessionId] },
    {
      mode: "wrong-connection",
      args: ["session", "start", connectionId, "--mode", "shared"],
    },
    {
      mode: "wrong-mode",
      args: ["session", "start", connectionId, "--mode", "shared"],
    },
  ])("rejects a mismatched $mode response", async ({ mode, args }) => {
    helper.mode = mode;
    expect(await invoke(...args)).toMatchObject({
      outcome: "failed",
      reason: "protocol",
      delivery: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects unrecognized failure payloads without exposing arbitrary server text", async () => {
    helper.response = {
      type: "result",
      data: { outcome: "not_started", reason: "secret-server-diagnostic" },
    };
    const result = await invoke("text", sessionId, "--text", "hello");
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "protocol",
      delivery: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain("secret-server-diagnostic");
  });

  it("reports a missing executable as not dispatched", async () => {
    helper.mode = "missing-helper";
    expect(await invoke("text", sessionId, "--text", "hello")).toMatchObject({
      outcome: "not_started",
      reason: "helper_unavailable",
      delivery: "not_dispatched",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("preserves a framed rejection from a helper that never reads stdin", async () => {
    helper.mode = "early-rejection";
    expect(await invoke("text", sessionId, "--text", "hello")).toEqual({
      outcome: "not_started",
      reason: "unsupported_runner",
      delivery: "not_dispatched",
    });
    expect(helper.requests).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("VNC screenshots", () => {
  it.each([false, true])(
    "publishes verified bytes privately with overwrite=%s",
    async (overwrite) => {
      const path = join(directory, "screen.png");
      if (overwrite) await writeFile(path, "old image");
      const result = await invoke(
        "screenshot",
        sessionId,
        "--output",
        path,
        ...(overwrite ? ["--overwrite"] : []),
      );
      expect(result).toMatchObject({
        outcome: "captured",
        kind: "capture",
        mimeType: "image/png",
        bytes: screenshotBytes.length,
        width: 1,
        height: 1,
        geometry,
        updateSequence: 2,
        capturedAt: 1700000000000,
        path,
        sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
      });
      expect(await readFile(path)).toEqual(screenshotBytes);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["screen.png"]);
      expect(helper.requests).toEqual([
        { version: 1, method: "vnc.capture", params: { sessionId } },
      ]);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each([false, true])(
    "returns the published path through symlink parents with relative=%s",
    async (useRelativePath) => {
      const actualParent = join(directory, "actual");
      const nested = join(actualParent, "nested");
      await mkdir(nested, { recursive: true });
      await symlink(nested, join(directory, "alias"));
      const base = useRelativePath
        ? relative(process.cwd(), directory)
        : directory;
      // Preserve the components: the filesystem resolves .. after the symlink.
      const requestedPath = `${base}/alias/../screen.png`;

      const result = await invoke(
        "screenshot",
        sessionId,
        "--output",
        requestedPath,
      );

      expect(result.outcome).toBe("captured");
      expect(await readFile(requestedPath)).toEqual(screenshotBytes);
      expect(isAbsolute(result.path)).toBe(true);
      expect(await readFile(result.path)).toEqual(screenshotBytes);
      expect(await readdir(actualParent)).toEqual(["nested", "screen.png"]);
      expect(process.exitCode).toBe(0);
    },
  );

  it("reports a removed working directory before dispatching a capture", async () => {
    const previousCwd = process.cwd();
    const removedDirectory = join(directory, "removed");
    await mkdir(removedDirectory);
    try {
      process.chdir(removedDirectory);
      await rmdir(removedDirectory);

      expect(
        await invoke("screenshot", sessionId, "--output", "screen.png"),
      ).toEqual({
        outcome: "failed",
        reason: "path_not_found",
        delivery: "not_dispatched",
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("refuses existing files and symlinks before contacting the helper", async () => {
    const path = join(directory, "existing.png");
    const linked = join(directory, "linked.png");
    await writeFile(path, "keep image");
    await symlink(path, linked);
    expect(
      await invoke("screenshot", sessionId, "--output", path),
    ).toMatchObject({
      outcome: "failed",
      reason: "destination_exists",
      delivery: "not_dispatched",
    });
    expect(
      await invoke("screenshot", sessionId, "--output", linked, "--overwrite"),
    ).toMatchObject({
      outcome: "failed",
      reason: "not_regular_file",
      delivery: "not_dispatched",
    });
    expect(await readFile(path, "utf8")).toBe("keep image");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves a valid terminal error after partial image bytes without publishing", async () => {
    helper.mode = "partial-error";
    const path = join(directory, "screen.png");
    await writeFile(path, "old image");
    expect(
      await invoke("screenshot", sessionId, "--output", path, "--overwrite"),
    ).toEqual({
      outcome: "failed",
      reason: "transport",
      delivery: "unknown",
    });
    expect(await readFile(path, "utf8")).toBe("old image");
    expect(await readdir(directory)).toEqual(["screen.png"]);
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    "missing-metadata",
    "duplicate-metadata",
    "missing-end",
    "capture-no-terminal",
    "byte-count",
    "terminal-byte-count",
    "too-big",
    "unsafe-epoch",
    "empty-data-frame",
    "after-end",
    "duplicate-terminal",
    "trailing-data",
    "oversize-frame",
    "truncated-frame",
    "nonzero-exit",
  ])(
    "keeps the destination unchanged and removes staging after %s",
    async (mode) => {
      helper.mode = mode;
      const path = join(directory, "screen.png");
      await writeFile(path, "old image");
      const result = await invoke(
        "screenshot",
        sessionId,
        "--output",
        path,
        "--overwrite",
      );
      expect(result.outcome).toBe("failed");
      expect(await readFile(path, "utf8")).toBe("old image");
      expect(await readdir(directory)).toEqual(["screen.png"]);
      expect(process.exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for real helper exit even after complete bytes, End and terminal success", async () => {
    helper.mode = "close-gate";
    const ready = new Promise<void>((resolve) => {
      helper.ready = resolve;
    });
    const path = join(directory, "screen.png");
    const pending = invoke("screenshot", sessionId, "--output", path);
    await ready;
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const staging = await readdir(directory);
    expect(staging).toHaveLength(1);
    expect((await stat(join(directory, staging[0]!))).mode & 0o777).toBe(0o700);
    const child = children.at(-1);
    if (!child) throw new Error("Missing helper child");
    child.send("release");
    expect(await pending).toMatchObject({ outcome: "captured" });
    expect(await readdir(directory)).toEqual(["screen.png"]);
  });

  it("cancels, reaps the child and removes staging without publishing", async () => {
    helper.mode = "hang";
    const ready = new Promise<void>((resolve) => {
      helper.ready = resolve;
    });
    const listeners = process.listenerCount("SIGINT");
    const pending = invoke(
      "screenshot",
      sessionId,
      "--output",
      join(directory, "screen.png"),
    );
    await ready;
    process.emit("SIGINT");
    expect(await pending).toMatchObject({
      outcome: "failed",
      reason: "cancelled",
    });
    expect(await readdir(directory)).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(children.at(-1)?.signalCode).toBe("SIGKILL");
  });

  it("treats cancelled input as uncertain and never replays it", async () => {
    helper.mode = "hang";
    const ready = new Promise<void>((resolve) => {
      helper.ready = resolve;
    });
    const pending = invoke("text", sessionId, "--text", "hello");
    await ready;
    process.emit("SIGINT");
    expect(await pending).toMatchObject({
      outcome: "unknown",
      reason: "cancelled",
      delivery: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
