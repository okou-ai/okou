import { createServer, type Server, type ServerResponse } from "node:http";
import { watch } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { type SpawnOptions } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  array,
  boolean,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

import { createSubagentCommand } from "../index";
import {
  buildProcessEntry,
  disposePreparedProcessEntry,
} from "../../../test/fixtures/build-process-entry";

const helper = vi.hoisted(() => {
  return { root: "", mode: "normal" };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn(file: string, args: string[], options: SpawnOptions) {
      expect(file).toBe("/usr/local/bin/guest-task-exec");
      if (helper.mode === "missing-helper")
        return original.spawn(
          join(helper.root, "missing-helper"),
          args,
          options,
        );
      return original.spawn(
        "python3",
        [
          fileURLToPath(
            new URL(
              "../../../test/fixtures/guest-task-helper.py",
              import.meta.url,
            ),
          ),
          helper.mode,
          helper.root,
          ...args,
        ],
        options,
      );
    },
  };
});

const fixture = fileURLToPath(
  new URL("../../../test/fixtures/pi-subagent-child.ts", import.meta.url),
);
const requestSchema = object({
  model: string(),
  messages: array(object({ role: string() }).passthrough()),
}).passthrough();
const inspectionSchema = object({
  id: string(),
  pid: number(),
  running: boolean(),
  stdout: string(),
  stderr: string(),
});

interface ProviderRequest {
  readonly body: zInfer<typeof requestSchema>;
  readonly authorization: string | undefined;
  readonly response: ServerResponse;
}

function completion(
  response: ServerResponse,
  text: string,
  tool?: { name: string; arguments: string },
): void {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          { index: 0, id: "call_test", type: "function", function: tool },
        ],
      }
    : { role: "assistant", content: text };
  const events = [
    {
      id: "completion-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: "completion-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [
        { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join("") + "data: [DONE]\n\n",
  );
}

function waitForFile(
  path: string,
  accept: (text: string) => boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let reading = false;
    let needsRead = false;
    const watcher = watch(dirname(path), requestCheck);
    onTestFinished(close);
    watcher.on("error", fail);

    function close() {
      needsRead = false;
      watcher.close();
    }

    function fail(error: unknown) {
      close();
      reject(error);
    }

    function requestCheck() {
      // Keep one pending check when a change arrives during the current read.
      needsRead = true;
      if (reading) return;
      reading = true;
      check().catch(fail);
    }

    async function check() {
      while (needsRead) {
        needsRead = false;
        const text = await readFile(path, "utf8").catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return undefined;
          throw error;
        });
        if (text !== undefined && accept(text)) {
          close();
          resolve(text);
          return;
        }
      }
      reading = false;
    }

    requestCheck();
  });
}

async function waitForRemoval(directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(directory), () => {
      void check().catch(reject);
    });
    watcher.on("error", reject);
    const check = async () => {
      try {
        const exists = await access(directory).then(
          () => {
            return true;
          },
          () => {
            return false;
          },
        );
        if (!exists) {
          watcher.close();
          resolve();
        }
      } catch (error) {
        watcher.close();
        reject(error);
      }
    };
    void check().catch(reject);
  });
}

describe("okou subagent", () => {
  let root: string;
  let entry: string;
  let server: Server;
  let requests: ProviderRequest[];
  let pending: Array<(request: ProviderRequest) => void>;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let compiled: Awaited<ReturnType<typeof buildProcessEntry>>;
  let preparation: ReturnType<typeof buildProcessEntry> | undefined;
  beforeAll(async () => {
    preparation = buildProcessEntry(fixture);
    compiled = await preparation;
  });
  afterAll(async () => {
    await disposePreparedProcessEntry(preparation);
  });

  async function run(...args: string[]): Promise<string[]> {
    log.mockClear();
    await createSubagentCommand({
      entry,
      execArgv:
        entry === compiled.entry
          ? []
          : ["--import", import.meta.resolve("tsx")],
    }).parseAsync(["node", "okou", ...args]);
    return log.mock.calls.map((call) => {
      return String(call[0]);
    });
  }

  function nextRequest(): Promise<ProviderRequest> {
    const existing = requests.shift();
    return existing
      ? Promise.resolve(existing)
      : new Promise((resolve) => {
          return pending.push(resolve);
        });
  }

  beforeEach(async () => {
    entry = compiled.entry;
    root = await mkdtemp(join(tmpdir(), "okou-subagent-"));
    helper.root = join(root, "guest-tasks");
    helper.mode = "normal";
    requests = [];
    pending = [];
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const captured = {
          body: requestSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString()),
          ),
          authorization: request.headers.authorization,
          response,
        };
        const waiter = pending.shift();
        if (waiter) waiter(captured);
        else requests.push(captured);
      })().catch((error) => {
        return response.destroy(error instanceof Error ? error : undefined);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test provider address.");
    const launchFile = join(root, "launch.json");
    await writeFile(
      launchFile,
      JSON.stringify({
        schemaVersion: 1,
        appendSystemPrompt: "Inherited task constraints",
        launchConfig: { schemaVersion: 2 },
      }),
    );
    vi.stubEnv("OKOU_RUN_ID", "run-one");
    vi.stubEnv("OKOU_PI_SESSION_ROLE", "parent");
    vi.stubEnv("OKOU_PI_RUNTIME_ROOT", root);
    vi.stubEnv("OKOU_PI_LAUNCH_PAYLOAD_FILE", launchFile);
    vi.stubEnv("OKOU_PI_EFFECTIVE_THINKING_LEVEL", "high");
    vi.stubEnv("OPENAI_API_KEY", "test-subagent-key");
    vi.stubEnv(
      "OKOU_PI_MODEL_CONFIG",
      JSON.stringify({
        schemaVersion: 5,
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "deepseek/deepseek-v4.1-flash",
        dialect: "openai-completions",
        transport: "sse",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "api-key",
            environment: "OPENAI_API_KEY",
            secretName: "OPENROUTER_API_KEY",
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    helper.mode = "normal";
    vi.stubEnv("OKOU_PI_SESSION_ROLE", "parent");
    vi.stubEnv("OKOU_RUN_ID", "run-one");
    const active = (
      await readdir(join(root, "run-one")).catch(() => {
        return [];
      })
    ).filter((name) => {
      return /^\d+$/u.test(name);
    });
    for (const id of active) await run("kill", id);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      return server.close(() => {
        return resolve();
      });
    });
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    log.mockClear();
    errorLog.mockClear();
  });

  it("starts a child in the writable default /tmp registry without a runtime-root override", async () => {
    const runId = basename(root);
    const directory = join("/tmp/pi", runId);
    vi.stubEnv("OKOU_RUN_ID", runId);
    vi.stubEnv("OKOU_PI_RUNTIME_ROOT", undefined);
    try {
      await run("start", "task using the default registry");
      await nextRequest();
      const child = inspectionSchema.parse(
        JSON.parse((await run("inspect", "1"))[0] ?? ""),
      );
      expect(child.running).toBe(true);
      expect(child.stdout).toBe(join(directory, "1", "stdout"));
      expect((await run("list")).join("\n")).toContain("1\t");
      await run("kill", "1");
      await expect(access(join(directory, "1"))).rejects.toThrow();
    } finally {
      await run("kill", "1").catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts concurrent independent sessions, lists and inspects only this Run, and kills them", async () => {
    const results = await Promise.all([
      run("start", "first independent task"),
      run("start", "second independent task"),
    ]);
    // Concurrent commands share console capture; discover their IDs through the public list.
    expect(results.flat().join("\n")).toContain(
      "Inspect: okou subagent inspect",
    );
    // Launch confirmation precedes readiness; keep both children at the provider boundary.
    const providerA = await nextRequest();
    const providerB = await nextRequest();
    const output = (await run("list")).join("\n");
    expect(output).toContain("1\t");
    expect(output).toContain("2\t");
    const first = inspectionSchema.parse(
      JSON.parse((await run("inspect", "1"))[0] ?? ""),
    );
    const second = inspectionSchema.parse(
      JSON.parse((await run("inspect", "2"))[0] ?? ""),
    );
    expect(first.pid).not.toBe(second.pid);
    expect(first.stdout).toBe(join(root, "run-one", "1", "stdout"));
    expect((await readdir(dirname(first.stdout))).sort()).toEqual([
      "stderr",
      "stdin",
      "stdout",
      "task",
    ]);
    for (const request of [providerA, providerB]) {
      expect(request.body.model).toBe("deepseek/deepseek-v4.1-flash");
      expect(request.authorization).toBe("Bearer test-subagent-key");
      expect(request.body.reasoning).toEqual(
        expect.objectContaining({ effort: "high" }),
      );
      expect(JSON.stringify(request.body)).toContain(
        "Inherited task constraints",
      );
      expect(JSON.stringify(request.body)).toContain("okou subagent start");
    }
    expect(JSON.stringify(providerA.body.messages)).not.toBe(
      JSON.stringify(providerB.body.messages),
    );
    vi.stubEnv("OKOU_RUN_ID", "another-run");
    expect((await run("list")).join("\n")).toContain("No running subagents");
    vi.stubEnv("OKOU_RUN_ID", "run-one");
    await run("kill", "1");
    await expect(access(dirname(first.stdout))).rejects.toThrow();
    expect((await run("list")).join("\n")).not.toContain(`${first.pid}`);
  });

  it("uses autonomous model/tool turns, queues repeated steering, and removes temporary logs on completion", async () => {
    const task = join(root, "task.md");
    await writeFile(task, "create an artifact");
    const started = inspectionSchema.parse(
      JSON.parse((await run("start", "-f", task))[0] ?? ""),
    );
    const first = await nextRequest();
    await run("steer", "-p", started.id, "first follow-up");
    await waitForFile(started.stdout, (text) => {
      return text.includes("first follow-up");
    });
    const followup = join(root, "followup.md");
    await writeFile(followup, "second follow-up");
    await run("steer", "-p", started.id, "-f", followup);
    await waitForFile(started.stdout, (text) => {
      return text.includes("second follow-up");
    });
    const artifact = join(root, "deliverable.txt");
    completion(first.response, "", {
      name: "write",
      arguments: JSON.stringify({
        path: artifact,
        content: "independent result",
      }),
    });
    const next = await nextRequest();
    expect(await readFile(artifact, "utf8")).toBe("independent result");
    expect(JSON.stringify(next.body.messages)).toContain("first follow-up");
    // The SDK may deliver steering one at a time. Finish each accepted turn.
    completion(next.response, "completed first follow-up");
    const final = await nextRequest();
    expect(JSON.stringify(final.body.messages)).toContain("second follow-up");
    completion(final.response, "finished");
    await waitForRemoval(dirname(started.stdout));
    expect((await run("list")).join("\n")).toContain("No running subagents");
    expect(await readFile(artifact, "utf8")).toBe("independent result");
  });

  it("uses the saved Guest handle to stop a runtime with a detached tool before deleting the directory", async () => {
    entry = fileURLToPath(
      new URL(
        "../../../test/fixtures/pi-subagent-unresponsive.ts",
        import.meta.url,
      ),
    );
    const item = inspectionSchema.parse(
      JSON.parse((await run("start", "unresponsive task"))[0] ?? ""),
    );
    await waitForFile(item.stdout, (text) => {
      return text.includes("toolPid");
    });
    const toolPid = object({ toolPid: number() }).parse(
      JSON.parse((await readFile(item.stdout, "utf8")).trim()),
    ).toolPid;
    await run("kill", item.id);
    await expect(access(dirname(item.stdout))).rejects.toThrow();
    const stat = await readFile(`/proc/${toolPid}/stat`, "utf8").catch(() => {
      return undefined;
    });
    if (stat)
      expect(stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
    const admitted = (await readdir(helper.root)).filter((name) => {
      return !name.endsWith(".stopped");
    });
    expect(await readdir(helper.root)).toContain(`${admitted[0]}.stopped`);
  }); // Kernel escalation and reaping are exercised by the native Guest lane.

  it("keeps IDs unique within a Run after completed directories are removed", async () => {
    entry = fileURLToPath(
      new URL(
        "../../../test/fixtures/pi-subagent-responsive.ts",
        import.meta.url,
      ),
    );
    const first = inspectionSchema.parse(
      JSON.parse((await run("start", "first task"))[0] ?? ""),
    );
    await run("kill", first.id);
    const next = inspectionSchema.parse(
      JSON.parse((await run("start", "new task"))[0] ?? ""),
    );
    expect(next.id).toBe("2");
    expect(next.pid).not.toBe(first.pid);
  });

  it("preserves UTF-8 prompts across bootstrap pipe chunks", async () => {
    const prompt = "跨块输入".repeat(7000);
    const file = join(root, "utf8-task.md");
    await writeFile(file, prompt, "utf8");
    const item = inspectionSchema.parse(
      JSON.parse((await run("start", "-f", file))[0] ?? ""),
    );
    const request = await nextRequest();
    expect(JSON.stringify(request.body.messages)).toContain(prompt);
    completion(request.response, "complete");
    await waitForRemoval(dirname(item.stdout));
  });

  it("lets child sessions start and kill by Run-wide ID without stopping other tasks", async () => {
    const first = inspectionSchema.parse(
      JSON.parse((await run("start", "first task"))[0] ?? ""),
    );
    vi.stubEnv("OKOU_PI_SESSION_ROLE", "child");
    const child = inspectionSchema.parse(
      JSON.parse((await run("start", "independent task"))[0] ?? ""),
    );
    await run("kill", first.id);
    expect(
      inspectionSchema.parse(
        JSON.parse((await run("inspect", child.id))[0] ?? ""),
      ).running,
    ).toBe(true);
    vi.stubEnv("OKOU_PI_SESSION_ROLE", "");
    await expect(run("list")).rejects.toThrow("Pi session");
  });

  it.each([
    "wrong-pid",
    "invalid-handle",
    "missing-report",
    "oversized-report",
    "publication-failure",
    "missing-helper",
  ])(
    "cleans a failed %s startup without publishing a running subagent",
    async (mode) => {
      helper.mode = mode;
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("command failed");
      });
      try {
        await expect(run("start", "failed startup")).rejects.toThrow(
          "command failed",
        );
        expect((await run("list")).join("\n")).toContain(
          "No running subagents",
        );
        await expect(access(join(root, "run-one", "1"))).rejects.toThrow();
      } finally {
        exit.mockRestore();
      }
    },
  );

  it("retains the registry when Guest stop fails, then permits a successful retry", async () => {
    const item = inspectionSchema.parse(
      JSON.parse((await run("start", "active task"))[0] ?? ""),
    );
    helper.mode = "stop-failure";
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("command failed");
    });
    try {
      await expect(run("kill", item.id)).rejects.toThrow("command failed");
      expect(
        await readFile(join(dirname(item.stdout), "task"), "utf8"),
      ).toContain(String(item.pid));
      expect((await run("inspect", item.id)).join("\n")).toContain(
        '"running": true',
      );
    } finally {
      exit.mockRestore();
      helper.mode = "normal";
    }
    await run("kill", item.id);
    await expect(access(dirname(item.stdout))).rejects.toThrow();
  });

  it("writes bounded streaming JSONL through the real child loop and retains the final message", async () => {
    const item = inspectionSchema.parse(
      JSON.parse((await run("start", "stream a large response"))[0] ?? ""),
    );
    const request = await nextRequest();
    // Hold a follow-up request open so completion does not dispose the logs
    // before they can be inspected through the command's advertised path.
    await run("steer", "-p", item.id, "wait for the log inspection");
    await waitForFile(item.stdout, (text) => {
      return text.includes("wait for the log inspection");
    });
    request.response.writeHead(200, {
      "content-type": "text/event-stream",
    });
    const delta = "large streamed content ".repeat(12);
    const chunk = (content: string, finishReason: string | null = null) => {
      return `data: ${JSON.stringify({
        id: "large-stream",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek/deepseek-v4.1-flash",
        choices: [
          { index: 0, delta: { content }, finish_reason: finishReason },
        ],
      })}\n\n`;
    };
    for (let index = 0; index < 1000; index++) {
      request.response.write(chunk(delta));
    }
    request.response.write(chunk("stream-inspection-boundary"));
    const streaming = await waitForFile(item.stdout, (text) => {
      return text.endsWith("\n") && text.includes("stream-inspection-boundary");
    });
    // Native stringify would repeat two growing snapshots on each of 1000
    // deltas, producing hundreds of MiB rather than this sub-MiB wire log.
    expect(Buffer.byteLength(streaming)).toBeLessThan(1024 * 1024);
    const updateSchema = object({
      type: string(),
      assistantMessageEvent: object({
        type: string(),
        delta: string().optional(),
      })
        .passthrough()
        .optional(),
    }).passthrough();
    const updates = streaming
      .trimEnd()
      .split("\n")
      .map((line) => {
        return updateSchema.parse(JSON.parse(line));
      })
      .filter((event) => {
        return event.type === "message_update";
      });
    expect(
      updates.filter((event) => {
        return event.assistantMessageEvent?.type === "text_delta";
      }),
    ).toHaveLength(1001);
    request.response.end(chunk("", "stop") + "data: [DONE]\n\n");
    const followup = await nextRequest();
    const completed = await readFile(item.stdout, "utf8");
    expect(Buffer.byteLength(completed)).toBeLessThan(2 * 1024 * 1024);
    const finalEvents: unknown[] = completed
      .trimEnd()
      .split("\n")
      .map((line) => {
        return JSON.parse(line);
      });
    expect(finalEvents).toContainEqual({
      type: "message_end",
      message: expect.objectContaining({
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: delta.repeat(1000) + "stream-inspection-boundary",
          },
        ],
      }),
    });
    completion(followup.response, "inspection complete");
    await waitForRemoval(dirname(item.stdout));
  });

  it("validates prompt exclusivity and path-safe IDs through Commander", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    try {
      await expect(run("start", "prompt", "-f", "file.md")).rejects.toThrow(
        "exit",
      );
      expect(errorLog.mock.calls.flat().join("\n")).toContain(
        "either PROMPT or -f",
      );
      await expect(run("inspect", "../other-run")).rejects.toThrow("exit");
      expect(errorLog.mock.calls.flat().join("\n")).toContain(
        "positive integer",
      );
    } finally {
      exit.mockRestore();
    }
  });
});
