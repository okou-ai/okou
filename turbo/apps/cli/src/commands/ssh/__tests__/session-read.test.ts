import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sshCommand } from "../index";

const helper = vi.hoisted(() => {
  return {
    replies: [] as { data: unknown; mode?: "hang" | "extra"; exit?: number }[],
    requests: [] as string[],
  };
});

// Replace only the external helper executable. Exercise real pipes, EOF, child
// exit, command parsing, response validation and aggregation for every page.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (file: string, args: string[], options: { stdio: string[] }) => {
        expect(file).toBe("/usr/local/bin/runner-rpc-client");
        expect(args).toEqual([]);
        expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
        const reply = helper.replies.shift();
        if (!reply) throw new Error("Unexpected SSH page request");
        const child = original.spawn(
          process.execPath,
          [
            "-e",
            `
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => {
          process.send(input);
          if (process.env.SSH_READ_MODE === 'hang') { setInterval(() => {}, 1000); return; }
          const response = Buffer.from(process.env.SSH_READ_RESPONSE, 'base64');
          process.stdout.write(response);
          if (process.env.SSH_READ_MODE === 'extra') process.stdout.write(response);
          process.stdout.end(() => process.exit(Number(process.env.SSH_READ_EXIT)));
        });
      `,
          ],
          {
            stdio: ["pipe", "pipe", "pipe", "ipc"],
            env: {
              ...process.env,
              SSH_READ_RESPONSE: Buffer.from(
                `${JSON.stringify({ type: "result", data: reply.data })}\n`,
              ).toString("base64"),
              SSH_READ_MODE: reply.mode ?? "normal",
              SSH_READ_EXIT: String(reply.exit ?? 0),
            },
          },
        );
        child.on("message", (message: unknown) => {
          if (typeof message === "string") helper.requests.push(message);
        });
        return child;
      },
    ),
  };
});

const id = "b0000000-0000-4000-8000-000000000001";
const host = "a0000000-0000-4000-8000-000000000001";
const session = {
  session_id: id,
  ssh_connection_id: host,
  generation: 7,
  state: { type: "running" },
  effects: "unknown",
  stdin_closed: false,
  oldest_cursor: 0,
  end_cursor: 0,
};
function page(cursor: number, bytes: Buffer, end: number, chunkSize = 4096) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    chunks.push({
      cursor: cursor + offset,
      stream: "stdout",
      data: bytes.subarray(offset, offset + chunkSize).toString("base64"),
    });
  return {
    type: "read",
    session: { ...session, end_cursor: end },
    chunks,
    wait_expired: false,
    next_cursor: cursor + bytes.length,
  };
}
const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
function result(): unknown {
  return JSON.parse(Buffer.concat(stdout).toString());
}
async function read(...args: string[]) {
  await sshCommand.parseAsync(["session", "read", id, "--json", ...args], {
    from: "user",
  });
}
async function plain(...args: string[]) {
  await sshCommand.parseAsync(["session", "read", id, ...args], {
    from: "user",
  });
}
function requests(): unknown[] {
  return helper.requests.map((request) => {
    return JSON.parse(request);
  });
}

beforeEach(() => {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities: ["ssh:read", "ssh:write"], userId: "owner", orgId: "org", runId: host })).toString("base64url")}.signature`,
  );
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  helper.replies.length = 0;
  helper.requests.length = 0;
  stdout.length = 0;
  stderr.length = 0;
  vi.mocked(spawn).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((): never => {
    throw new Error("CLI exit");
  });
  for (const [stream, writes] of [
    [process.stdout, stdout],
    [process.stderr, stderr],
  ] as const)
    vi.spyOn(stream, "write").mockImplementation(
      (bytes, encodingOrCallback, callback) => {
        writes.push(Buffer.from(bytes));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        done?.();
        return true;
      },
    );
  for (const command of sshCommand.commands.find((command) => {
    return command.name() === "session";
  })?.commands ?? [])
    for (const option of command.options)
      command.setOptionValue(option.attributeName(), option.defaultValue);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

describe("okou ssh session read", () => {
  it("waits once by default and treats quiet wait expiry as successful observation", async () => {
    helper.replies.push({
      data: { ...page(0, Buffer.alloc(0), 0), wait_expired: true },
    });
    await read();
    expect(result()).toMatchObject({
      stop_reason: "wait_elapsed",
      failure: null,
      session: { state: { type: "running" } },
      next_cursor: 0,
      more_available: false,
      limits: { wait_seconds: 10, max_bytes: 16384 },
      next_command: `okou ssh session read ${id} --cursor 0 --wait 10 --max-bytes 16384 --json`,
    });
    expect(requests()).toEqual([
      {
        version: 1,
        method: "ssh.session.read",
        params: {
          sessionId: id,
          cursor: 0,
          waitMs: 10000,
          maxBytes: 8192,
          maxChunks: 32,
        },
      },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("reads immediately with --wait 0 and preserves an explicit starting cursor", async () => {
    helper.replies.push({ data: page(17, Buffer.alloc(0), 17) });
    await read("--cursor", "17", "--wait", "0");
    expect(result()).toMatchObject({
      stop_reason: "caught_up",
      next_cursor: 17,
      chunks: [],
      failure: null,
    });
    expect(requests()).toMatchObject([{ params: { cursor: 17, waitMs: 0 } }]);
  });

  it("auto-pages without another wait and preserves binary bytes and lost ranges", async () => {
    const first = page(10, Buffer.alloc(8192, 255), 8210);
    const second = page(8202, Buffer.from([0, 1, 255, 2, 3, 4, 5, 6]), 8210);
    helper.replies.push(
      {
        data: {
          ...first,
          session: { ...first.session, oldest_cursor: 10 },
          lost: { from: 0, to: 10 },
        },
      },
      { data: second },
    );
    await read("--wait", "0.025");
    expect(result()).toMatchObject({
      stop_reason: "caught_up",
      next_cursor: 8210,
      more_available: false,
      chunks: [...first.chunks, ...second.chunks],
      lost: [{ from: 0, to: 10 }],
      failure: null,
    });
    expect(requests()).toMatchObject([
      { params: { cursor: 0, waitMs: 25, maxBytes: 8192 } },
      { params: { cursor: 8202, waitMs: 0, maxBytes: 8192 } },
    ]);
  });

  it("honors the byte budget exactly and still offers continuation for terminal backlog", async () => {
    const terminal = {
      ...session,
      state: { type: "finished", exit: { type: "status", code: 7 } },
      effects: "completed",
      end_cursor: 9000,
    };
    helper.replies.push(
      { data: { ...page(0, Buffer.alloc(8192, 97), 9000), session: terminal } },
      { data: { ...page(8192, Buffer.from("tail"), 9000), session: terminal } },
    );
    await read("--max-bytes", "8196");
    expect(result()).toMatchObject({
      stop_reason: "byte_limit",
      next_cursor: 8196,
      more_available: true,
      session: { state: { type: "finished", exit: { code: 7 } } },
      next_command: expect.stringContaining("--cursor 8196"),
    });
    expect(requests()).toMatchObject([
      { params: { maxBytes: 8192 } },
      { params: { maxBytes: 4, waitMs: 0 } },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it.each(["finished", "failed"])(
    "drains terminal %s output without equating reader success with remote success",
    async (state) => {
      const remote =
        state === "finished"
          ? { type: "finished", exit: { type: "status", code: 23 } }
          : { type: "failed", failure_reason: "disconnected" };
      helper.replies.push({
        data: {
          ...page(0, Buffer.from("done\n"), 5),
          session: {
            ...session,
            end_cursor: 5,
            state: remote,
            effects: state === "finished" ? "completed" : "unknown",
          },
        },
      });
      await read();
      expect(result()).toMatchObject({
        stop_reason: "terminal",
        next_command: null,
        next_cursor: 5,
        more_available: false,
        session: { state: remote },
        failure: null,
      });
      expect(process.exitCode).toBe(0);
    },
  );

  it.each(["chunk", "request"])(
    "bounds tiny-page aggregation by the %s limit",
    async (limit) => {
      const count = limit === "chunk" ? 8 : 64;
      const size = limit === "chunk" ? 32 : 1;
      for (let i = 0; i < count; i++)
        helper.replies.push({
          data: page(i * size, Buffer.alloc(size, 97), 1000, 1),
        });
      await read();
      expect(result()).toMatchObject({
        stop_reason: `${limit}_limit`,
        next_cursor: count * size,
        more_available: true,
      });
      expect(helper.requests).toHaveLength(count);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each([
    { chunks: [{ cursor: 1, stream: "stdout", data: "YQ==" }], next_cursor: 2 },
    { chunks: [{ cursor: 0, stream: "stdout", data: "YQ" }], next_cursor: 1 },
    { chunks: [], next_cursor: 1 },
    { chunks: [{ cursor: 0, stream: "stdout", data: "YQ==" }], next_cursor: 0 },
    { lost: { from: 0, to: 1 } },
    { wait_expired: true },
    { session: { ...session, session_id: host, end_cursor: 1 } },
  ])(
    "rejects inconsistent page evidence without advancing the cursor %#",
    async (change) => {
      helper.replies.push({
        data: { ...page(0, Buffer.from("a"), 1), ...change },
      });
      await read();
      expect(result()).toMatchObject({
        stop_reason: "failed",
        session: null,
        chunks: [],
        next_cursor: 0,
        more_available: null,
        failure: { failure_reason: "protocol", effects: "unknown" },
      });
      expect(helper.requests).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    },
  );

  it("rejects a page exceeding the requested remaining byte budget", async () => {
    helper.replies.push({ data: page(0, Buffer.from("ab"), 2) });
    await read("--max-bytes", "1");
    expect(result()).toMatchObject({
      chunks: [],
      next_cursor: 0,
      failure: { failure_reason: "protocol" },
    });
  });

  it.each(["extra", "exit"])(
    "does not commit a subsequent page without verified EOF/exit: %s",
    async (problem) => {
      const first = page(0, Buffer.from("safe"), 8);
      helper.replies.push(
        { data: first },
        {
          data: page(4, Buffer.from("tail"), 8),
          ...(problem === "extra" ? { mode: "extra" as const } : { exit: 1 }),
        },
      );
      await read();
      expect(result()).toMatchObject({
        chunks: first.chunks,
        next_cursor: 4,
        more_available: true,
        stop_reason: "failed",
        failure: { failure_reason: "protocol" },
        next_command: expect.stringContaining("--cursor 4"),
      });
      expect(helper.requests).toHaveLength(2);
    },
  );

  it("preserves verified pages when cancelled, without issuing a remote close or replay", async () => {
    const first = page(0, Buffer.from("safe"), 8);
    helper.replies.push({ data: first }, { data: null, mode: "hang" });
    const work = read();
    await vi.waitFor(() => {
      return expect(helper.requests).toHaveLength(2);
    });
    process.emit("SIGINT");
    await work;
    expect(result()).toMatchObject({
      chunks: first.chunks,
      next_cursor: 4,
      stop_reason: "failed",
      failure: { failure_reason: "cancelled" },
    });
    expect(requests()).toMatchObject([
      { method: "ssh.session.read" },
      { method: "ssh.session.read" },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("bounds a stuck helper by the whole collection deadline", async () => {
    helper.replies.push({ data: null, mode: "hang" });
    await read();
    expect(result()).toMatchObject({
      stop_reason: "time_limit",
      next_cursor: 0,
      more_available: null,
      failure: { failure_reason: "timed_out" },
    });
    expect(helper.requests).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  }, 45_000);

  it("directs unavailable sessions to list instead of an endless read retry", async () => {
    helper.replies.push({
      data: {
        type: "failed",
        failure_reason: "unavailable",
        effects: "not_started",
      },
    });
    await read();
    expect(result()).toMatchObject({
      next_command: "okou ssh session list",
      session: null,
      failure: { failure_reason: "unavailable" },
    });
  });

  it("prints split UTF-8 as readable text, keeps stderr separate, and labels binary bytes", async () => {
    const utf8 = Buffer.from("你好\n");
    const chunks = [
      {
        cursor: 0,
        stream: "stdout",
        data: utf8.subarray(0, 1).toString("base64"),
      },
      {
        cursor: 1,
        stream: "stdout",
        data: utf8.subarray(1).toString("base64"),
      },
      {
        cursor: 7,
        stream: "stderr",
        data: Buffer.from("warning\n").toString("base64"),
      },
      { cursor: 15, stream: "stdout", data: "AP8=" },
    ];
    helper.replies.push({ data: { ...page(0, Buffer.alloc(17), 17), chunks } });
    await plain();
    expect(Buffer.concat(stdout).toString()).toBe(
      "你好\n[stdout binary bytes 15–17: base64 AP8=]\n",
    );
    expect(Buffer.concat(stderr).toString()).toContain(
      "warning\n\nSSH read: caught_up",
    );
    expect(Buffer.concat(stderr).toString()).toContain("next_cursor=17");
  });

  it("does not invent a remote state when the first read fails", async () => {
    helper.replies.push({
      data: { type: "failed", failure_reason: "transport", effects: "unknown" },
    });
    await plain();
    expect(Buffer.concat(stderr).toString()).toContain(
      "observed state=unknown",
    );
    expect(Buffer.concat(stderr).toString()).toContain(
      "more_available=unknown",
    );
    expect(Buffer.concat(stderr).toString()).toContain(
      '"failure_reason":"transport"',
    );
    expect(process.exitCode).toBe(1);
  });

  it.each(["\u001b[31m", "\u0000", "\u009b"])(
    "labels terminal control bytes rather than executing %j",
    async (control) => {
      const bytes = Buffer.from(control);
      helper.replies.push({ data: page(0, bytes, bytes.length) });
      await plain();
      expect(Buffer.concat(stdout).toString()).toContain(
        `base64 ${bytes.toString("base64")}`,
      );
      expect(Buffer.concat(stdout).toString()).not.toContain(control);
    },
  );

  it("waits for output backpressure before publishing the continuation", async () => {
    helper.replies.push({ data: page(0, Buffer.from("hello"), 5) });
    let release: (() => void) | undefined;
    vi.mocked(process.stdout.write).mockImplementation(
      (bytes, encodingOrCallback, callback) => {
        stdout.push(Buffer.from(bytes));
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        release = () => {
          return done?.();
        };
        return false;
      },
    );
    const work = plain();
    try {
      await vi.waitFor(() => {
        return expect(stdout).toHaveLength(1);
      });
      expect(stderr).toEqual([]);
      release?.();
      await work;
      expect(Buffer.concat(stderr).toString()).toContain("next_cursor=5");
    } finally {
      release?.();
    }
  });

  it("reports output failure without claiming a cursor was delivered", async () => {
    helper.replies.push({ data: page(0, Buffer.from("hello"), 5) });
    vi.mocked(process.stdout.write).mockImplementation(
      (_bytes, encodingOrCallback, callback) => {
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        const error = new Error("broken output pipe");
        done?.(error);
        process.stdout.emit("error", error);
        return false;
      },
    );
    await expect(plain()).rejects.toThrow("CLI exit");
    expect(stderr).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("broken output pipe"),
    );
    expect(helper.requests).toHaveLength(1);
  });

  it.each(["timeout", "interrupt"])(
    "bounds a stalled JSON output sink on %s without more RPCs",
    async (reason) => {
      helper.replies.push({ data: page(0, Buffer.from("hello"), 5) });
      let release: (() => void) | undefined;
      vi.mocked(process.stdout.write).mockImplementation(
        (bytes, encodingOrCallback, callback) => {
          stdout.push(Buffer.from(bytes));
          const done =
            typeof encodingOrCallback === "function"
              ? encodingOrCallback
              : callback;
          release = () => {
            done?.();
          };
          return false;
        },
      );
      const work = read();
      const rejection = expect(work).rejects.toThrow("CLI exit");
      try {
        await vi.waitFor(() => {
          expect(stdout).toHaveLength(1);
        });
        if (reason === "interrupt") process.emit("SIGINT");
        await rejection;
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(helper.requests).toHaveLength(1);
        expect(stderr).toEqual([]);
      } finally {
        release?.();
      }
    },
    10_000,
  );

  it.each([
    ["--wait", "-1"],
    ["--wait", "31"],
    ["--wait", "0.0001"],
    ["--wait", "NaN"],
    ["--max-bytes", "0"],
    ["--max-bytes", "65537"],
    ["--cursor", "1.1"],
  ])("rejects invalid %s %s before helper dispatch", async (...args) => {
    await expect(read(...args)).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  });
});
