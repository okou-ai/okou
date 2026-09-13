import { spawn } from "node:child_process";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { sshCommand } from "../index";

describe("okou ssh session", () => {
  const id = "a0000000-0000-4000-8000-000000000001";
  const sessionId = "b0000000-0000-4000-8000-000000000001";
  const session = {
    session_id: sessionId,
    ssh_connection_id: id,
    generation: 7,
    state: { type: "running" },
    effects: "unknown",
    stdin_closed: false,
    oldest_cursor: 0,
    end_cursor: 0,
  };
  async function invoke(...args: string[]) {
    await sshCommand.parseAsync(["session", ...args, "--json"], {
      from: "user",
    });
  }
  function reply(data: unknown) {
    response({ type: "result", data });
  }

  it("starts once, preserves shell syntax as data, and returns before remote completion", async () => {
    reply({ type: "started", session_id: sessionId });
    await invoke(
      "start",
      id,
      "--command",
      "printf '$secret'; sleep 90",
      "--pty",
    );
    expect(result()).toEqual({ type: "started", session_id: sessionId });
    expect(
      helper.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toEqual([
      {
        version: 1,
        method: "ssh.session.start",
        params: {
          sshConnectionId: id,
          program: { type: "exec", command: "printf '$secret'; sleep 90" },
          pty: true,
        },
      },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("requests an explicit persistent shell", async () => {
    reply({ type: "started", session_id: sessionId });
    await invoke("start", id, "--shell");
    expect(JSON.parse(helper.requests[0]!)).toMatchObject({
      params: { program: { type: "shell" }, pty: false },
    });
  });

  it.each([
    ["start", id],
    ["start", id, "--shell", "--command", "true"],
    ["start", id, "--command", ""],
    ["start", id, "--command", "界".repeat(21846)],
    ["read", sessionId, "--cursor", "-1"],
    ["read", sessionId, "--cursor", "9007199254740992"],
    ["write", sessionId],
    ["write", sessionId, "--base64", "YQ"],
    ["write", sessionId, "--text", "a", "--base64", "YQ=="],
    ["write", sessionId, "--text", "a".repeat(16385)],
    ["signal", sessionId, "--signal", "CUSTOM"],
    ["status", "invented"],
  ])("rejects invalid input before helper dispatch: %j", async (...args) => {
    await expect(invoke(...args)).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves binary input and EOF in one structured submission", async () => {
    reply({ type: "submitted", session_id: sessionId, effects: "unknown" });
    await invoke("write", sessionId, "--base64", "AP8=", "--eof");
    expect(JSON.parse(helper.requests[0]!)).toEqual({
      version: 1,
      method: "ssh.session.write",
      params: { sessionId, dataBase64: "AP8=", eof: true },
    });
    expect(result()).toMatchObject({ type: "submitted", effects: "unknown" });
  });

  it("accepts bounded output with an explicit lost range and continuation cursor", async () => {
    const read = {
      type: "read",
      session: { ...session, oldest_cursor: 10, end_cursor: 12 },
      chunks: [{ cursor: 10, stream: "stderr", data: "AP8=" }],
      next_cursor: 12,
      lost: { from: 0, to: 10 },
    };
    reply(read);
    await invoke("read", sessionId);
    expect(result()).toEqual(read);
    expect(JSON.parse(helper.requests[0]!)).toMatchObject({
      method: "ssh.session.read",
      params: { sessionId, cursor: 0 },
    });
  });

  it.each([
    { chunks: [{ cursor: 1, stream: "stdout", data: "YQ==" }], next_cursor: 2 },
    { chunks: [{ cursor: 0, stream: "stdout", data: "YQ" }], next_cursor: 1 },
    { chunks: [], next_cursor: 1 },
    { chunks: [{ cursor: 0, stream: "stdout", data: "YQ==" }], next_cursor: 0 },
    {
      chunks: [{ cursor: 0, stream: "stdout", data: "YQ==" }],
      next_cursor: 1,
      lost: { from: 0, to: 1 },
    },
  ])(
    "rejects inconsistent cursor or binary output without replay %#",
    async (output) => {
      reply({
        type: "read",
        session: { ...session, end_cursor: 1 },
        ...output,
      });
      await invoke("read", sessionId);
      expect(result()).toMatchObject({
        type: "failed",
        failure_reason: "protocol",
        effects: "unknown",
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("returns setup failures through status without inventing remote exit evidence", async () => {
    reply({
      type: "status",
      session: {
        ...session,
        state: { type: "failed", failure_reason: "authentication_failed" },
        effects: "not_started",
      },
    });
    await invoke("status", sessionId);
    expect(result()).toMatchObject({
      session: { state: { type: "failed" }, effects: "not_started" },
    });
  });

  it("recovers admitted IDs through list", async () => {
    reply({ type: "sessions", sessions: [session] });
    await invoke("list");
    expect(result()).toEqual({ type: "sessions", sessions: [session] });
  });

  it("rejects a response for another method or session", async () => {
    reply({ type: "status", session: { ...session, session_id: id } });
    await invoke("status", sessionId);
    expect(result()).toMatchObject({
      failure_reason: "protocol",
      effects: "unknown",
    });
  });

  it("surfaces old Runner unknown_method without downgrading into exec", async () => {
    helper.exit = 1;
    response({
      type: "error",
      code: "unknown_method",
      delivery: "not_dispatched",
    });
    await invoke("start", id, "--shell");
    expect(result()).toEqual({
      type: "rpc_error",
      code: "unknown_method",
      delivery: "not_dispatched",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not accept a duplicate terminal or retry a possibly admitted start", async () => {
    const value = {
      type: "result",
      data: { type: "started", session_id: sessionId },
    };
    response(value, value);
    await invoke("start", id, "--shell");
    expect(result()).toMatchObject({
      failure_reason: "protocol",
      effects: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("requires execution capability for retained session access", async () => {
    token(["ssh:read"]);
    await expect(invoke("list")).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("canonicalizes UUID casing before comparing a mutating response", async () => {
    reply({ type: "closed", session_id: sessionId, effects: "unknown" });
    await invoke("close", sessionId.toUpperCase());
    expect(result()).toEqual({
      type: "closed",
      session_id: sessionId,
      effects: "unknown",
    });
    expect(JSON.parse(helper.requests[0]!)).toMatchObject({
      params: { sessionId },
    });
  });

  it("sends the selected signal without treating submission as a remote exit", async () => {
    reply({ type: "submitted", session_id: sessionId, effects: "unknown" });
    await invoke("signal", sessionId, "--signal", "USR2");
    expect(JSON.parse(helper.requests[0]!)).toEqual({
      version: 1,
      method: "ssh.session.signal",
      params: { sessionId, signal: "USR2" },
    });
    expect(result()).toEqual({
      type: "submitted",
      session_id: sessionId,
      effects: "unknown",
    });
  });

  it("preserves binary read output and waits for backpressure before reporting the next cursor", async () => {
    const bytes = Buffer.from([0, 255, 10]);
    reply({
      type: "read",
      session: { ...session, oldest_cursor: 10, end_cursor: 13 },
      chunks: [
        { cursor: 10, stream: "stdout", data: bytes.toString("base64") },
      ],
      next_cursor: 13,
      lost: { from: 0, to: 10 },
    });
    const writes: Buffer[] = [];
    let completeWrite: (() => void) | undefined;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk, encodingOrCallback, callback) => {
        writes.push(Buffer.from(chunk));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        completeWrite = () => {
          done?.();
        };
        return false;
      });
    let settled = false;
    try {
      const work = sshCommand
        .parseAsync(["session", "read", sessionId], { from: "user" })
        .then(() => {
          settled = true;
        });
      await vi.waitFor(() => {
        expect(writes).toHaveLength(1);
      });
      expect(settled).toBe(false);
      expect(errors).toHaveBeenCalledWith(
        "Output bytes 0–10 were discarded from the bounded buffer.",
      );
      expect(errors).not.toHaveBeenCalledWith(
        expect.stringContaining("next_cursor"),
      );
      completeWrite?.();
      await work;
      expect(Buffer.concat(writes)).toEqual(bytes);
      expect(errors).toHaveBeenCalledWith("next_cursor=13; state=running");
      expect(output).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      completeWrite?.();
      stdout.mockRestore();
    }
  });
});

const helper = vi.hoisted(() => {
  return { response: "", exit: 0, mode: "normal", requests: [] as string[] };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (file: string, args: string[], options: { stdio: string[] }) => {
        expect(file).toBe("/usr/local/bin/runner-rpc-client");
        expect(args).toEqual([]);
        expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
        const script = `
      let request = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => request += chunk);
      process.stdin.on('end', () => {
        process.send(request);
        if (process.env.SSH_TEST_MODE === 'hang') { setInterval(() => {}, 1000); return; }
        if (process.env.SSH_TEST_MODE === 'invalid-utf8') { process.stdout.end(Buffer.from([255, 10])); return; }
        if (['large', 'excess', 'aggregate'].includes(process.env.SSH_TEST_MODE)) {
          const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
          emit({ type: 'event', data: { type: 'accepted' } });
          const aggregate = process.env.SSH_TEST_MODE === 'aggregate';
          const chunks = aggregate ? 300 : process.env.SSH_TEST_MODE === 'excess' ? 65 : 64;
          for (const stream of ['stdout', 'stderr']) for (let i = 0; i < chunks; i++) {
            const output = { type: 'event', data: { type: 'output', stream, data: Buffer.alloc(aggregate ? 1 : 16384, 97).toString('base64') } };
            if (aggregate) process.stdout.write(' '.repeat(16384) + JSON.stringify(output) + '\\n');
            else emit(output);
          }
          emit({ type: 'result', data: { type: 'finished', effects: 'completed', exit: { type: 'status', code: 0 }, stdout_bytes: 1048576, stderr_bytes: 1048576, stdout_truncated: true, stderr_truncated: true } });
          process.stdout.end(); return;
        }
        process.stdout.end(Buffer.from(process.env.SSH_TEST_RESPONSE, 'base64'), () => process.exit(Number(process.env.SSH_TEST_EXIT)));
      });
    `;
        const child =
          helper.mode === "missing"
            ? original.spawn("/nonexistent/ssh-test-helper", [], {
                stdio: ["pipe", "pipe", "pipe"],
              })
            : original.spawn(process.execPath, ["-e", script], {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: {
                  ...process.env,
                  SSH_TEST_RESPONSE: Buffer.from(helper.response).toString(
                    "base64",
                  ),
                  SSH_TEST_EXIT: String(helper.exit),
                  SSH_TEST_MODE: helper.mode,
                },
              });
        child.on("message", (message: unknown) => {
          if (typeof message === "string") helper.requests.push(message);
        });
        return child;
      },
    ),
  };
});

const id = "a0000000-0000-4000-8000-000000000001";
const accepted = { type: "event", data: { type: "accepted" } };
const zero = {
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_truncated: false,
  stderr_truncated: false,
};
function finished(code = 0) {
  return {
    type: "result",
    data: {
      type: "finished",
      effects: "completed",
      exit: { type: "status", code },
      ...zero,
    },
  };
}
function response(...messages: unknown[]) {
  helper.response =
    messages
      .map((message) => {
        return JSON.stringify(message);
      })
      .join("\n") + "\n";
}
function token(capabilities = ["ssh:read", "ssh:write"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId: id })).toString("base64url")}.signature`,
  );
}
async function execute(...args: string[]) {
  await sshCommand.parseAsync(
    ["exec", id, "--command", "printf '$secret'", "--json", ...args],
    { from: "user" },
  );
}
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
function result(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  token();
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  helper.requests.length = 0;
  helper.mode = "normal";
  helper.exit = 0;
  response(accepted, finished());
  vi.mocked(spawn).mockClear();
  for (const command of sshCommand.commands.find((command) => {
    return command.name() === "session";
  })?.commands ?? []) {
    for (const option of command.options)
      command.setOptionValue(option.attributeName(), option.defaultValue);
  }
});
afterEach(() => {
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("okou ssh command", () => {
  it("uses exact structured input and EOF without shell expansion or additional arguments", async () => {
    await execute();
    expect(
      helper.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toEqual([
      {
        version: 1,
        method: "ssh.exec",
        params: { sshConnectionId: id, command: "printf '$secret'" },
      },
    ]);
    expect(result()).toMatchObject({
      type: "finished",
      exit: { type: "status", code: 0 },
      effects: "completed",
    });
    expect(process.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("lists live hosts through the canonical API", async () => {
    server.use(
      http.get("http://localhost:3000/api/ssh/hosts", () => {
        return HttpResponse.json({
          hosts: [
            {
              id,
              displayName: "Production",
              host: "ssh.example.com",
              port: 22,
              username: "deploy",
              learnedHostKey: null,
            },
          ],
        });
      }),
    );
    await sshCommand.parseAsync(["host", "list", "--json"], { from: "user" });
    expect(result()).toMatchObject({
      hosts: [{ id, host: "ssh.example.com" }],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, "personal-token"])(
    "requires a Run token even when explicitly invoked (%s)",
    async (value) => {
      vi.stubEnv("OKOU_TOKEN", value);
      await expect(execute()).rejects.toThrow("CLI exit");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("enforces each subcommand's capability separately", async () => {
    token(["ssh:read"]);
    await expect(execute()).rejects.toThrow("CLI exit");
    token(["ssh:write"]);
    await expect(
      sshCommand.parseAsync(["host", "list"], { from: "user" }),
    ).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([1, 255, 256, 0xffffffff])(
    "preserves remote status %s and never treats helper exit zero as remote success",
    async (code) => {
      response(accepted, finished(code));
      await execute();
      expect(result()).toMatchObject({
        type: "finished",
        exit: { type: "status", code },
      });
      expect(process.exitCode).toBe(code <= 255 ? code : 1);
    },
  );

  it.each([
    { connectionId: "ssh.example.com", command: "true" },
    { connectionId: id, command: "" },
    { connectionId: id, command: "a".repeat(65537) },
    { connectionId: id, command: "界".repeat(21846) },
  ])(
    "rejects invalid request input %# before starting the helper",
    async ({ connectionId, command }) => {
      await expect(
        sshCommand.parseAsync(
          ["exec", connectionId, "--command", command, "--json"],
          {
            from: "user",
          },
        ),
      ).rejects.toThrow("CLI exit");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 65536 UTF-8 command bytes without truncating the request", async () => {
    const command = "界".repeat(21845) + "a";
    await sshCommand.parseAsync(["exec", id, "--command", command, "--json"], {
      from: "user",
    });
    expect(helper.requests).toHaveLength(1);
    expect(JSON.parse(helper.requests[0]!)).toMatchObject({
      params: { command },
    });
    expect(process.exitCode).toBe(0);
  });

  it("preserves binary streams and typed remote signal", async () => {
    const stdout = Buffer.from([0, 255, 13, 10]);
    const stderr = Buffer.from([128, 1]);
    response(
      accepted,
      {
        type: "event",
        data: {
          type: "output",
          stream: "stdout",
          data: stdout.toString("base64"),
        },
      },
      {
        type: "event",
        data: {
          type: "output",
          stream: "stderr",
          data: stderr.toString("base64"),
        },
      },
      {
        type: "result",
        data: {
          type: "finished",
          effects: "completed",
          exit: { type: "signal", signal: "TERM", core_dumped: false },
          ...zero,
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
        },
      },
    );
    await execute();
    expect(result()).toMatchObject({
      stdout_base64: stdout.toString("base64"),
      stderr_base64: stderr.toString("base64"),
      exit: { type: "signal", signal: "TERM" },
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    "unavailable",
    "authority_failure",
    "invalid_credential",
    "unsupported_credential",
    "credential_resource_limit",
    "unsafe_destination",
    "network_failure",
    "host_key_mismatch",
    "unsupported_host_key",
    "configuration_changed",
    "authentication_failed",
    "protocol",
    "exec_rejected",
    "disconnected",
    "timed_out",
    "cancelled",
    "resource_exhausted",
    "transport",
  ])("preserves typed failure %s without replay", async (failureReason) => {
    response({
      type: "result",
      data: {
        type: "failed",
        failure_reason: failureReason,
        effects: "not_started",
        ...zero,
      },
    });
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: failureReason,
      effects: "not_started",
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains uncertain delivery from generic helper errors", async () => {
    helper.exit = 1;
    response({ type: "error", code: "transport", delivery: "unknown" });
    await execute();
    expect(result()).toMatchObject({
      type: "rpc_error",
      code: "transport",
      delivery: "unknown",
    });
    expect(process.exitCode).toBe(1);
  });

  it("preserves an unknown-method rejection without fallback or replay", async () => {
    helper.exit = 1;
    response({
      type: "error",
      code: "unknown_method",
      delivery: "not_dispatched",
    });
    await execute();
    expect(result()).toMatchObject({
      type: "rpc_error",
      code: "unknown_method",
      delivery: "not_dispatched",
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [finished()],
    [accepted],
    [accepted, accepted, finished()],
    [accepted, finished(), finished()],
    [
      {
        type: "event",
        data: { type: "output", stream: "stdout", data: "YQ==" },
      },
      finished(),
    ],
    [
      accepted,
      { type: "event", data: { type: "output", stream: "stdout", data: "YQ" } },
      finished(),
    ],
    [
      accepted,
      {
        type: "event",
        data: { type: "output", stream: "stdout", data: "YQ==" },
      },
      finished(),
    ],
    [
      {
        type: "result",
        data: {
          type: "failed",
          failure_reason: "secret-canary",
          effects: "unknown",
          ...zero,
        },
      },
    ],
    [accepted, { ...finished(), extra: "secret-canary" }],
    [
      accepted,
      {
        type: "result",
        data: {
          type: "failed",
          failure_reason: "transport",
          effects: "not_started",
          ...zero,
        },
      },
    ],
  ])(
    "rejects malformed business responses %# conservatively",
    async (...messages) => {
      response(...messages);
      await execute();
      expect(result()).toMatchObject({
        type: "failed",
        failure_reason: "protocol",
        effects: "unknown",
      });
      expect(JSON.stringify(result())).not.toContain("secret-canary");
      expect(process.exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "{secret-canary\n",
    " ".repeat(25 * 1024),
    JSON.stringify(finished()),
  ])("rejects malformed, oversized or unterminated NDJSON %#", async (raw) => {
    helper.response = raw;
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
    });
  });

  it("reports a missing packaged helper without claiming remote execution", async () => {
    helper.mode = "missing";
    await execute();
    expect(result()).toMatchObject({ type: "failed", effects: "not_started" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("kills and awaits the owned helper on Ctrl-C, preserving uncertainty", async () => {
    helper.mode = "hang";
    const work = execute();
    await vi.waitFor(() => {
      return expect(helper.requests).toHaveLength(1);
    });
    process.emit("SIGINT");
    await work;
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "cancelled",
      effects: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung helper with a deadline and does not replay", async () => {
    helper.mode = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = execute();
    await vi.waitFor(() => {
      expect(helper.requests).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(65_000);
    await work;
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "timed_out",
      effects: "unknown",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains two independent bounded streams and truncation flags", async () => {
    helper.mode = "large";
    await execute();
    expect(result()).toMatchObject({
      type: "finished",
      stdout_bytes: 1048576,
      stderr_bytes: 1048576,
      stdout_truncated: true,
      stderr_truncated: true,
    });
    expect(process.exitCode).toBe(0);
  });

  it.each(["excess", "aggregate", "invalid-utf8"])(
    "rejects %s output without replay",
    async (mode) => {
      helper.mode = mode;
      await execute();
      expect(result()).toMatchObject({
        type: "failed",
        failure_reason: "protocol",
        effects: "unknown",
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("requires successful helper EOF even after a valid terminal", async () => {
    helper.exit = 1;
    await execute();
    expect(result()).toMatchObject({
      type: "failed",
      failure_reason: "protocol",
      effects: "unknown",
    });
  });

  it("streams binary output and awaits output backpressure in human mode", async () => {
    const bytes = Buffer.from([0, 255, 10]);
    response(
      accepted,
      {
        type: "event",
        data: {
          type: "output",
          stream: "stdout",
          data: bytes.toString("base64"),
        },
      },
      {
        type: "result",
        data: { ...finished().data, stdout_bytes: bytes.length },
      },
    );
    const writes: Buffer[] = [];
    let completeWrite: (() => void) | undefined;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk, encodingOrCallback, callback) => {
        writes.push(Buffer.from(chunk));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        completeWrite = () => {
          done?.();
        };
        return false;
      });
    const exec = sshCommand.commands.find((command) => {
      return command.name() === "exec";
    });
    if (!exec) throw new Error("Missing exec command");
    exec.setOptionValue("json", false);
    let settled = false;
    try {
      const work = sshCommand
        .parseAsync(["exec", id, "--command", "binary-output"], {
          from: "user",
        })
        .then(() => {
          settled = true;
        });
      await vi.waitFor(() => {
        expect(writes).toHaveLength(1);
      });
      expect(settled).toBe(false);
      completeWrite?.();
      await work;
      expect(Buffer.concat(writes)).toEqual(bytes);
      expect(output).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      completeWrite?.();
      stdout.mockRestore();
      exec.setOptionValue("json", true);
    }
  });
});
