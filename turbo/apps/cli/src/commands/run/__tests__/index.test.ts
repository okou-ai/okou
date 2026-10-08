import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../index";

const helper = vi.hoisted(() => {
  return { response: "", exit: 0, requests: [] as string[] };
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
            process.stdout.end(Buffer.from(process.env.RUN_USAGE_RESPONSE, 'base64'), () => process.exit(Number(process.env.RUN_USAGE_EXIT)));
          });
        `;
        const child = original.spawn(process.execPath, ["-e", script], {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            RUN_USAGE_RESPONSE: Buffer.from(helper.response).toString("base64"),
            RUN_USAGE_EXIT: String(helper.exit),
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

const runId = "a0000000-0000-4000-8000-000000000001";
const complete = {
  schemaVersion: 1,
  runId,
  combined: {
    state: "observed",
    coverage: "complete",
    observedTokens: {
      input: 10,
      cacheRead: 20,
      cacheCreation: 30,
      output: 40,
      total: 100,
    },
  },
  sources: {
    sandboxProxy: {
      state: "observed",
      sampledAtMs: 1,
      revision: 2,
      coverage: "complete",
      reasons: [],
      observedResponses: 1,
      outstandingResponses: 0,
      tokens: {
        input: 10,
        cacheRead: 20,
        cacheCreation: 30,
        output: 40,
        total: 100,
      },
    },
  },
};
const partialZero = {
  schemaVersion: 1,
  runId,
  combined: {
    state: "observed",
    coverage: "partial",
    observedTokens: {
      input: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      total: 0,
    },
  },
  sources: {
    sandboxProxy: {
      state: "observed",
      sampledAtMs: 1,
      revision: 0,
      coverage: "partial",
      reasons: ["missing_usage"],
      observedResponses: 1,
      outstandingResponses: 0,
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheCreation: 0,
        output: 0,
        total: 0,
      },
    },
  },
};

function token(capabilities = ["run-usage:read"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId })).toString("base64url")}.signature`,
  );
}

function response(...messages: unknown[]) {
  helper.response =
    messages
      .map((message) => {
        return JSON.stringify(message);
      })
      .join("\n") + "\n";
}

async function invoke(json = true) {
  await runCommand.parseAsync(json ? ["usage", "--json"] : ["usage"], {
    from: "user",
  });
}

const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});

function jsonOutput(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  token();
  helper.requests.length = 0;
  helper.exit = 0;
  response({ type: "result", data: complete });
  vi.mocked(spawn).mockClear();
  for (const option of runCommand.commands[0]?.options ?? []) {
    option.defaultValue = undefined;
    runCommand.commands[0]?.setOptionValue(option.attributeName(), undefined);
  }
});

afterEach(() => {
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
});

describe("okou run usage", () => {
  it("queries the assigned Run once and prints the strict JSON success outcome", async () => {
    await invoke();
    expect(
      helper.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toEqual([{ version: 1, method: "run.usage", params: {} }]);
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "ok",
      usage: complete,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
  });

  it("prints the combined total and the sandbox proxy source", async () => {
    await invoke(false);
    const text = output.mock.calls
      .map((call) => {
        return String(call[0]);
      })
      .join("\n");
    expect(text).toContain("Observed token usage (complete):");
    expect(text).toContain("Total: 100");
    expect(text).toContain("Sandbox proxy: observed complete");
    expect(process.exitCode).not.toBe(1);
  });

  it("labels partial zero as a lower bound with the source reasons", async () => {
    response({ type: "result", data: partialZero });
    await invoke(false);
    const text = output.mock.calls
      .map((call) => {
        return String(call[0]);
      })
      .join("\n");
    expect(text).toContain("partial; lower bounds");
    expect(text).toContain("Total: 0+");
    expect(text).toContain("Sandbox proxy: observed partial");
    expect(text).toContain("reasons: missing_usage.");
    expect(process.exitCode).not.toBe(1);
  });

  it.each([
    ["unknown_method", "unsupported-runner"],
    ["unavailable", "assignment-unavailable"],
    ["resource_exhausted", "busy"],
    ["timed_out", "timed-out"],
    ["protocol", "invalid-response"],
    ["transport", "transport"],
  ] as const)("maps Runner %s without fallback", async (code, kind) => {
    helper.exit = 1;
    response({ type: "error", code, delivery: "not_dispatched" });
    await invoke();
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "error",
      error: { kind, delivery: "not-dispatched" },
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("accepts unavailable as a truthful business result", async () => {
    const unavailable = {
      schemaVersion: 1,
      runId,
      combined: { state: "unavailable", reason: "no-observation" },
      sources: {
        sandboxProxy: { state: "unavailable", reason: "not-observed" },
      },
    };
    response({ type: "result", data: unavailable });
    await invoke();
    expect(jsonOutput()).toMatchObject({
      status: "ok",
      usage: { combined: { state: "unavailable" } },
    });
    expect(process.exitCode).not.toBe(1);
  });

  it.each([
    [{ type: "event", data: {} }],
    [
      { type: "result", data: complete },
      { type: "result", data: complete },
    ],
    [{ type: "result", data: { ...complete, future: true } }],
    [
      {
        type: "result",
        data: {
          ...complete,
          combined: {
            ...complete.combined,
            observedTokens: { ...complete.combined.observedTokens, total: 109 },
          },
        },
      },
    ],
  ])("rejects malformed helper output without replay", async (...messages) => {
    response(...messages);
    await invoke();
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "error",
      error: { kind: "invalid-response", delivery: "unknown" },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("rejects direct execution without the rollout capability before dispatch", async () => {
    token(["billing:read", "ssh:read"]);
    await expect(invoke()).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("run-usage:read"),
    );
  });
});
