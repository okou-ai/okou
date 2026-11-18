import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000915";
const FIXTURE = fileURLToPath(
  new URL("./test/fixtures/pending-tool-rpc.ts", import.meta.url),
);
// Loaded by the real extension loader in the actual RPC host. IPC controls only
// the fixture tool's cooperative boundary; official commands still use stdin.
const EXTENSION = `import { writeFile } from "node:fs/promises";
export default function (pi) {
  let starting = true;
  if (process.argv[3] === "wire-starting" || process.argv[3] === "wire-input-starting") pi.on("before_agent_start", async () => {
    if (!starting) return;
    starting = false;
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-start") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "starting" });
    });
  });
  let continuing = true;
  if (process.argv[3] === "wire-before-settle") pi.on("agent_before_settle", () => {
    if (!continuing) return;
    continuing = false;
    return {
      entries: [{ type: "custom_message", customType: "boundary-input", content: "finish the boundary", display: false }],
      continue: true
    };
  });
  if (process.argv[3]?.startsWith("wire-tool-")) pi.on("turn_end", (event) => {
    if (event.toolResults.length > 0) process.send({
      type: "native-tool-details",
      detailsBytes: event.toolResults[0].details.data.length
    });
  });
  if (process.argv[3]?.startsWith("wire-tool-details")) pi.on("tool_result", () => ({
    isError: process.argv[3].endsWith("-error")
  }));
  if (process.argv[3] === "wire-boundaries") pi.on("turn_end", (event) => {
    if (event.toolResults.length > 0) process.send({
      type: "native-turn-end",
      hasMessage: event.message !== undefined,
      toolResultCount: event.toolResults.length,
      toolResultBytes: event.toolResults.reduce((bytes, result) => bytes + result.content[0].text.length, 0)
    });
  });
  let holdingSettlement = true;
  if (process.argv[3] !== "http" && !process.argv[3]?.startsWith("wire-")) pi.on("agent_before_settle", async (_event, ctx) => {
    if (!holdingSettlement) return;
    holdingSettlement = false;
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-settlement" || message === "release-settlement-abort") {
          if (message === "release-settlement-abort") ctx.abort();
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "settling" });
    });
  });
  let notifying = true;
  if (process.argv[3] === "wire-notification" || process.argv[3]?.startsWith("wire-input-")) pi.on("input", async (event) => {
    if (event.text !== "delayed input across completion") return;
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-delayed-input") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "input-held" });
    });
    return { action: "continue" };
  });
  let prompts = 0;
  let settlements = 0;
  const holdNextRun = async () => {
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-next-run") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "next-run-held" });
    });
  };
  if (process.argv[3] === "wire-input-preparing") pi.on("before_agent_start", async () => {
    if (++prompts === 2) await holdNextRun();
  });
  if (process.argv[3] === "wire-input-running") pi.on("agent_before_settle", async () => {
    if (++settlements === 2) await holdNextRun();
  });
  if (process.argv[3] === "wire-notification") pi.on("agent_settled", async (_event, ctx) => {
    if (!notifying) return;
    notifying = false;
    pi.sendUserMessage("deferred notification follow-up");
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-notification") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "notifying", idle: ctx.isIdle(), hasSignal: ctx.signal !== undefined });
    });
  });
  if (process.argv[3] === "cancelled-input") pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user" || !ctx.signal?.aborted) return;
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release-input") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send({ type: "persisting-cancelled" });
    });
  });
  pi.registerTool({
    name: "controlled", label: "controlled", description: "Cooperative fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, args, signal, onUpdate) {
      if (process.argv[3]?.startsWith("wire-tool-")) {
        const details = { data: "d".repeat(17 * 1024 * 1024) };
        const content = [{ type: "text", text: process.argv[3] === "wire-tool-content"
          ? "x".repeat(17 * 1024 * 1024) : "tool output" }];
        onUpdate({ content, details });
        return { content, details };
      }
      if (process.argv[3] === "wire-boundaries") return {
        content: [{ type: "text", text: "x".repeat(1024 * 1024) }], details: {}
      };
      if (!signal) throw new Error("Missing native tool signal");
      const aborted = () => process.send({ type: "tool-aborted" });
      signal.addEventListener("abort", aborted, { once: true });
      await new Promise((resolve) => {
        const release = (message) => {
          if (message === "release-tool") {
            process.off("message", release);
            resolve();
          }
        };
        process.on("message", release);
        process.send({ type: "tool-start" });
      });
      signal.removeEventListener("abort", aborted);
      signal.throwIfAborted();
      await writeFile(args.path, "completed side effect");
      return { content: [{ type: "text", text: "done" }], details: {} };
    }
  });
}`;

async function rpcFixture(boundary: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-pending-rpc-"));
  const effect = join(root, "effect.txt");
  const extensions = join(root, "agent", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(join(extensions, "controlled.js"), EXTENSION);
  const memory = MemoryPiSession.create({ cwd: root, id: SESSION_ID });
  await writeFile(join(root, "session.jsonl"), memory.toJsonl());
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), FIXTURE, root, boundary],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      // The parent owns a real kill deadline; no same-thread timeout can make
      // an unowned/hung native continuation look like successful settlement.
      timeout: 20_000,
      killSignal: "SIGKILL",
    },
  );
  const { stdin, stdout, stderr: errorStream } = child;
  if (!stdin || !stdout || !errorStream)
    throw new Error("RPC fixture requires piped stdio");
  const exit = once(child, "exit");
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const records: Array<Record<string, unknown>> = [];
  const notifications: unknown[] = [];
  let stderr = "";
  errorStream.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    notifications.push(message);
  });
  const send = (command: Record<string, unknown>) => {
    stdin.write(`${JSON.stringify(command)}\n`);
  };
  const response = async (id: string) => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error(`RPC host exited before ${id}: ${stderr}`);
      const record = JSON.parse(next.value) as Record<string, unknown>;
      records.push(record);
      if (record.type === "response" && record.id === id) return record;
    }
  };
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
    lines.close();
    await rm(root, { recursive: true, force: true });
  });
  const notification = async (type: string) => {
    for (;;) {
      const found = notifications.find((message) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === type
        );
      });
      if (found) return found;
      await Promise.race([
        once(child, "message"),
        exit.then(() => {
          throw new Error(`RPC host exited before ${type}: ${stderr}`);
        }),
      ]);
    }
  };
  const settled = async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done)
        throw new Error(`RPC host exited before settlement: ${stderr}`);
      const record = JSON.parse(next.value) as Record<string, unknown>;
      records.push(record);
      if (record.type === "agent_settled") return;
    }
  };
  const reopen = async (sessionFile = join(root, "session.jsonl")) => {
    stdin.end();
    expect(await exit, stderr).toEqual([0, null]);
    return MemoryPiSession.fromJsonl(await readFile(sessionFile, "utf8"));
  };
  return {
    root,
    effect,
    child,
    stdin,
    exit,
    records,
    notifications,
    send,
    response,
    notification,
    settled,
    reopen,
  };
}

async function heldSettlement(boundary = "tool") {
  const rpc = await rpcFixture(boundary);
  rpc.send({
    id: "startup",
    type: "prompt",
    message: "execute the controlled tool",
  });
  expect(await rpc.response("startup")).toMatchObject({ success: true });
  await rpc.notification("tool-start");
  rpc.child.send("release-tool");
  await rpc.notification("settling");
  rpc.send({ id: "held", type: "get_state" });
  expect(await rpc.response("held")).toMatchObject({
    data: { isStreaming: true, pendingMessageCount: 0 },
  });
  expect(await readFile(rpc.effect, "utf8")).toBe("completed side effect");
  return rpc;
}

describe("Pi RPC duplicate boundary payloads", () => {
  it("keeps large tool results and native turn events while emitting bounded wire boundaries", async () => {
    const rpc = await rpcFixture("wire-boundaries");
    rpc.send({ id: "large-turn", type: "prompt", message: "run the tools" });
    expect(await rpc.response("large-turn")).toMatchObject({ success: true });
    await rpc.settled();

    // The full 17 MiB turn remains available to extensions. Each result is
    // independently delivered and persisted, but duplicate wire boundaries
    // must not aggregate it into one record beyond Guest's 16 MiB limit.
    expect(await rpc.notification("native-turn-end")).toMatchObject({
      hasMessage: true,
      toolResultCount: 17,
      toolResultBytes: 17 * 1024 * 1024,
    });
    const toolRecords = rpc.records.filter((record) => {
      const message = record.message;
      return (
        record.type === "message_end" &&
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "toolResult"
      );
    });
    expect(toolRecords).toHaveLength(17);
    expect(assistantEnds(rpc.records).at(-1)).toMatchObject({
      message: { content: [{ type: "text", text: "complete" }] },
    });
    const boundaries = rpc.records.filter((record) => {
      return record.type === "turn_end" || record.type === "agent_end";
    });
    expect(
      boundaries.some((record) => {
        return record.type === "turn_end";
      }),
    ).toBe(true);
    expect(
      boundaries.some((record) => {
        return record.type === "agent_end";
      }),
    ).toBe(true);
    for (const record of boundaries) {
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("messages");
      expect(record).not.toHaveProperty("toolResults");
    }
    for (const record of rpc.records) {
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(
        16 * 1024 * 1024,
      );
    }
    const persisted = await rpc.reopen();
    const results = persisted
      .buildSessionContext()
      .messages.filter((message) => {
        return message.role === "toolResult";
      });
    expect(results).toHaveLength(17);
    for (const result of results) {
      expect(result.content).toEqual([
        { type: "text", text: "x".repeat(1024 * 1024) },
      ]);
    }
  }, 30_000);
});

describe("Pi RPC tool result metadata", () => {
  it.each([false, true])(
    "completes with large native details and bounded RPC records (isError=%s)",
    async (isError) => {
      const rpc = await rpcFixture(
        isError ? "wire-tool-details-error" : "wire-tool-details",
      );
      rpc.send({
        id: "large-details",
        type: "prompt",
        message: "run the tool",
      });
      expect(await rpc.response("large-details")).toMatchObject({
        success: true,
      });
      await rpc.settled();

      expect(await rpc.notification("native-tool-details")).toMatchObject({
        detailsBytes: 17 * 1024 * 1024,
      });
      for (const record of rpc.records) {
        expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(
          16 * 1024 * 1024,
        );
      }
      const content = [{ type: "text", text: "tool output" }];
      expect(
        rpc.records.filter((record) => {
          return record.type === "tool_execution_update";
        }),
      ).toEqual([
        expect.objectContaining({
          toolCallId: "call-0|call-0",
          toolName: "controlled",
          partialResult: { content },
        }),
      ]);
      expect(
        rpc.records.filter((record) => {
          return record.type === "tool_execution_end";
        }),
      ).toEqual([
        expect.objectContaining({
          toolCallId: "call-0|call-0",
          toolName: "controlled",
          isError,
          result: { content },
        }),
      ]);
      for (const type of ["message_start", "message_end"]) {
        expect(
          rpc.records.filter((record) => {
            const message = record.message;
            return (
              record.type === type &&
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "toolResult"
            );
          }),
        ).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "toolResult",
              toolCallId: "call-0|call-0",
              toolName: "controlled",
              content,
              isError,
            }),
          }),
        ]);
      }
      expect(assistantEnds(rpc.records).at(-1)).toMatchObject({
        message: { content: [{ type: "text", text: "complete" }] },
      });
      const persisted = await rpc.reopen();
      const results = persisted
        .buildSessionContext()
        .messages.filter((message) => {
          return message.role === "toolResult";
        });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        content,
        isError,
      });
      expect(jsonDigest(results[0]?.details)).toBe(
        jsonDigest({ data: "d".repeat(17 * 1024 * 1024) }),
      );
    },
    30_000,
  );

  it("retains required tool content even when it exceeds the Guest line limit", async () => {
    const rpc = await rpcFixture("wire-tool-content");
    rpc.send({ id: "large-content", type: "prompt", message: "run the tool" });
    expect(await rpc.response("large-content")).toMatchObject({
      success: true,
    });
    await rpc.settled();

    const toolEnd = rpc.records.find((record) => {
      return record.type === "tool_execution_end";
    });
    expect(toolEnd?.toolCallId).toBe("call-0|call-0");
    expect(toolEnd?.isError).toBe(false);
    expect(jsonDigest(toolEnd?.result)).toBe(
      jsonDigest({
        content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }],
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(toolEnd))).toBeGreaterThan(
      16 * 1024 * 1024,
    );
  }, 30_000);
});

// Keep failures bounded even when a fixture carries multi-MiB payloads.
function jsonDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assistantEnds(records: Array<Record<string, unknown>>) {
  return records.filter((record) => {
    const message = record.message;
    return (
      record.type === "message_end" &&
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
    );
  });
}

function assertSettlement(
  rpc: Awaited<ReturnType<typeof rpcFixture>>,
  requests: number,
  aborted: boolean,
) {
  expect(
    rpc.records.filter((record) => {
      return record.type === "agent_settled";
    }),
  ).toEqual([{ type: "agent_settled", aborted }]);
  for (const [type, count] of [
    ["tool-start", 1],
    ["http-start", requests],
    ["settling", 1],
  ] as const) {
    expect(
      rpc.notifications.filter((message) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === type
        );
      }),
    ).toHaveLength(count);
  }
}

describe("official sandbox RPC cancellation", () => {
  it("accepts an asynchronous input across preparation into the same native run", async () => {
    const rpc = await rpcFixture("wire-input-starting");
    rpc.send({ id: "startup", type: "prompt", message: "initial prompt" });
    await rpc.notification("starting");
    rpc.send({
      id: "input",
      type: "steer",
      message: "delayed input across completion",
    });
    await rpc.notification("input-held");
    rpc.child.send("release-start");
    expect(await rpc.response("startup")).toMatchObject({ success: true });
    await rpc.notification("tool-start");
    rpc.child.send("release-delayed-input");
    expect(await rpc.response("input")).toMatchObject({
      success: true,
      data: { disposition: "queued" },
    });
    rpc.child.send("release-tool");
    await rpc.settled();
    const memory = await rpc.reopen();
    expect(
      memory
        .buildSessionContext()
        .messages.filter((message) => {
          return message.role === "user";
        })
        .map((message) => {
          return message.content;
        }),
    ).toEqual([
      [{ type: "text", text: "initial prompt" }],
      [{ type: "text", text: "delayed input across completion" }],
    ]);
    expect(assistantEnds(rpc.records).at(-1)).toMatchObject({
      message: { stopReason: "stop" },
    });
  }, 30_000);

  it("rejects input still awaiting an extension when the session is replaced", async () => {
    const rpc = await rpcFixture("wire-input-replacement");
    rpc.send({ id: "startup", type: "prompt", message: "initial prompt" });
    expect(await rpc.response("startup")).toMatchObject({ success: true });
    await rpc.notification("tool-start");
    rpc.send({
      id: "input",
      type: "steer",
      message: "delayed input across completion",
    });
    await rpc.notification("input-held");
    rpc.child.send("release-tool");
    await rpc.settled();
    rpc.send({ id: "replace", type: "new_session" });
    expect(await rpc.response("replace")).toMatchObject({ success: true });
    rpc.child.send("release-delayed-input");
    expect(await rpc.response("input")).toMatchObject({ success: false });
    rpc.send({ id: "next", type: "prompt", message: "fresh prompt" });
    expect(await rpc.response("next")).toMatchObject({ success: true });
    await rpc.settled();
    rpc.send({ id: "new-state", type: "get_state" });
    const state = await rpc.response("new-state");
    expect(state).toMatchObject({
      success: true,
      data: { pendingMessageCount: 0 },
    });
    const data = state.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("sessionFile" in data) ||
      typeof data.sessionFile !== "string"
    )
      throw new Error("Expected the new session file from RPC state");
    const memory = await rpc.reopen(data.sessionFile);
    expect(
      memory
        .buildSessionContext()
        .messages.filter((message) => {
          return message.role === "user";
        })
        .map((message) => {
          return message.content;
        }),
    ).toEqual([[{ type: "text", text: "fresh prompt" }]]);
  }, 30_000);

  describe.each(["idle", "preparing", "running"])(
    "input ownership after completion (%s)",
    (nextState) => {
      it.each([
        { type: "steer", streamingBehavior: undefined },
        { type: "follow_up", streamingBehavior: undefined },
        { type: "prompt", streamingBehavior: "steer" },
        { type: "prompt", streamingBehavior: "followUp" },
      ])(
        "rejects delayed $type / $streamingBehavior without transferring it to another run",
        async (command) => {
          const rpc = await rpcFixture(`wire-input-${nextState}`);
          rpc.send({
            id: "startup",
            type: "prompt",
            message: "initial prompt",
          });
          expect(await rpc.response("startup")).toMatchObject({
            success: true,
          });
          await rpc.notification("tool-start");
          rpc.send({
            ...command,
            id: "delayed-input",
            message: "delayed input across completion",
          });
          await rpc.notification("input-held");
          rpc.child.send("release-tool");
          await rpc.settled();

          if (nextState !== "idle") {
            rpc.send({ id: "next", type: "prompt", message: "fresh prompt" });
            if (nextState === "running") {
              expect(await rpc.response("next")).toMatchObject({
                success: true,
              });
            }
            await rpc.notification("next-run-held");
          }
          rpc.child.send("release-delayed-input");
          expect(await rpc.response("delayed-input")).toMatchObject({
            success: false,
            error: expect.stringContaining("settling"),
          });
          rpc.send({ id: "queue", type: "get_state" });
          expect(await rpc.response("queue")).toMatchObject({
            data: { pendingMessageCount: 0 },
          });

          if (nextState === "idle") {
            rpc.send({ id: "next", type: "prompt", message: "fresh prompt" });
          } else {
            rpc.child.send("release-next-run");
          }
          if (nextState !== "running") {
            expect(await rpc.response("next")).toMatchObject({ success: true });
          }
          await rpc.settled();
          const memory = await rpc.reopen();
          expect(
            memory
              .buildSessionContext()
              .messages.filter((message) => {
                return message.role === "user";
              })
              .map((message) => {
                return message.content;
              }),
          ).toEqual([
            [{ type: "text", text: "initial prompt" }],
            [{ type: "text", text: "fresh prompt" }],
          ]);
          expect(assistantEnds(rpc.records).at(-1)).toMatchObject({
            message: {
              stopReason: "stop",
              content: [{ type: "text", text: "complete" }],
            },
          });
        },
        30_000,
      );
    },
  );

  it("preserves idle notifications and defers requested prompts until notification dispatch finishes", async () => {
    const rpc = await rpcFixture("wire-notification");
    rpc.send({ id: "startup", type: "prompt", message: "run the tool" });
    expect(await rpc.response("startup")).toMatchObject({ success: true });
    await rpc.notification("tool-start");
    rpc.send({
      id: "delayed-input",
      type: "steer",
      message: "delayed input across completion",
    });
    await rpc.notification("input-held");
    rpc.child.send("release-tool");
    expect(await rpc.notification("notifying")).toMatchObject({
      idle: true,
      hasSignal: false,
    });
    rpc.send({ id: "idle-notification", type: "get_state" });
    expect(await rpc.response("idle-notification")).toMatchObject({
      data: { isStreaming: false, pendingMessageCount: 0 },
    });
    for (const type of ["steer", "follow_up"]) {
      rpc.send({
        id: "late",
        type,
        message: "rejected after native completion",
      });
      expect(await rpc.response("late")).toMatchObject({
        success: false,
        error: expect.stringContaining("settling"),
      });
    }
    rpc.child.send("release-delayed-input");
    expect(await rpc.response("delayed-input")).toMatchObject({
      success: false,
      error: expect.stringContaining("settling"),
    });
    expect(assistantEnds(rpc.records)).toHaveLength(2);
    expect(
      rpc.records.some((record) => {
        return record.type === "agent_settled";
      }),
    ).toBe(false);
    rpc.child.send("release-notification");
    await rpc.settled();
    await rpc.settled();
    const memory = await rpc.reopen();
    const users = memory.buildSessionContext().messages.filter((message) => {
      return message.role === "user";
    });
    expect(
      users.map((message) => {
        return message.content;
      }),
    ).toEqual([
      [{ type: "text", text: "run the tool" }],
      [{ type: "text", text: "deferred notification follow-up" }],
    ]);
    expect(assistantEnds(rpc.records)).toHaveLength(3);
    const firstSettled = rpc.records.findIndex((record) => {
      return record.type === "agent_settled";
    });
    const followUpStart = rpc.records.findIndex((record) => {
      return (
        record.type === "message_start" &&
        JSON.stringify(record.message).includes(
          "deferred notification follow-up",
        )
      );
    });
    expect(firstSettled).toBeLessThan(followUpStart);
  }, 30_000);

  it("retains before-settle boundary continuation within the prompt owner", async () => {
    const rpc = await rpcFixture("wire-before-settle");
    rpc.send({ id: "startup", type: "prompt", message: "run the tool" });
    expect(await rpc.response("startup")).toMatchObject({ success: true });
    await rpc.notification("tool-start");
    rpc.child.send("release-tool");
    await rpc.settled();
    rpc.send({ id: "idle", type: "get_state" });
    expect(await rpc.response("idle")).toMatchObject({
      data: { isStreaming: false, pendingMessageCount: 0 },
    });
    expect(assistantEnds(rpc.records)).toMatchObject([
      { message: { stopReason: "toolUse" } },
      { message: { stopReason: "stop" } },
      { message: { stopReason: "stop" } },
    ]);
    const memory = await rpc.reopen();
    expect(memory.buildSessionContext().messages).toContainEqual(
      expect.objectContaining({
        role: "custom",
        customType: "boundary-input",
        content: "finish the boundary",
      }),
    );
    expect(memory.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      stopReason: "stop",
    });
    expect(
      rpc.records.filter((record) => {
        return record.type === "agent_settled";
      }),
    ).toEqual([{ type: "agent_settled", aborted: false }]);
  }, 30_000);

  it("retains cancellation during prompt preparation and resets it for the next prompt", async () => {
    const rpc = await rpcFixture("wire-starting");
    rpc.send({
      id: "startup",
      type: "prompt",
      message: "cancel before starting",
    });
    await rpc.notification("starting");
    rpc.send({
      id: "input",
      type: "steer",
      message: "accepted before startup",
    });
    expect(await rpc.response("input")).toMatchObject({ success: true });
    rpc.send({ id: "abort", type: "abort" });
    rpc.send({ id: "duplicate-abort", type: "abort" });
    rpc.send({ id: "busy", type: "get_state" });
    expect(await rpc.response("busy")).toMatchObject({
      data: { isStreaming: true, pendingMessageCount: 1 },
    });
    rpc.child.send("release-start");
    expect(await rpc.response("startup")).toMatchObject({ success: true });
    expect(await rpc.response("abort")).toMatchObject({ success: true });
    expect(await rpc.response("duplicate-abort")).toMatchObject({
      success: true,
    });
    expect(assistantEnds(rpc.records)).toMatchObject([
      { message: { stopReason: "aborted" } },
    ]);

    rpc.send({
      id: "next",
      type: "prompt",
      message: "complete the next prompt",
    });
    expect(await rpc.response("next")).toMatchObject({ success: true });
    await rpc.notification("tool-start");
    rpc.child.send("release-tool");
    await rpc.settled();
    const memory = await rpc.reopen();
    const messages = memory.buildSessionContext().messages;
    expect(
      messages.filter((message) => {
        return (
          message.role === "user" &&
          JSON.stringify(message.content).includes("accepted before startup")
        );
      }),
    ).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      stopReason: "stop",
    });
    expect(
      rpc.records.filter((record) => {
        return record.type === "agent_settled";
      }),
    ).toEqual([
      { type: "agent_settled", aborted: true },
      { type: "agent_settled", aborted: false },
    ]);
  }, 30_000);

  it("reconciles the first abort and duplicate abort inside successful settlement", async () => {
    const rpc = await heldSettlement();
    rpc.send({ id: "abort", type: "abort" });
    rpc.send({ id: "duplicate-abort", type: "abort" });
    rpc.send({ id: "aborting", type: "get_state" });
    expect(await rpc.response("aborting")).toMatchObject({
      data: { isStreaming: true },
    });
    expect(
      rpc.records.some((record) => {
        return record.id === "abort" || record.type === "agent_settled";
      }),
    ).toBe(false);
    rpc.child.send("release-settlement");
    expect(await rpc.response("abort")).toMatchObject({ success: true });
    expect(await rpc.response("duplicate-abort")).toMatchObject({
      success: true,
    });
    const assistants = assistantEnds(rpc.records);
    expect(assistants).toHaveLength(3);
    expect(assistants[0]).toMatchObject({ message: { stopReason: "toolUse" } });
    expect(assistants[1]).toMatchObject({ message: { stopReason: "stop" } });
    expect(assistants[2]).toMatchObject({ message: { stopReason: "aborted" } });
    const settledIndex = rpc.records.findIndex((record) => {
      return record.type === "agent_settled";
    });
    expect(rpc.records.indexOf(assistants[2]!)).toBeLessThan(settledIndex);
    expect(settledIndex).toBeLessThan(
      rpc.records.findIndex((record) => {
        return record.id === "abort";
      }),
    );
    const expected: unknown = JSON.parse(
      await readFile(
        new URL(
          "./test/fixtures/pending-tool-settlement-abort.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect([
      // The ordinary prompt emits its tool-call assistant before continuation.
      // Guest's shared fixture describes only the terminal settlement suffix.
      ...assistants.slice(1).map((record) => {
        const message = record.message;
        if (typeof message !== "object" || message === null)
          throw new Error("Expected assistant");
        return {
          type: "message_end",
          message: {
            ...message,
            timestamp: 0,
            ...("durationMs" in message ? { durationMs: 0 } : {}),
          },
        };
      }),
      rpc.records[settledIndex],
    ]).toEqual(expected);
    assertSettlement(rpc, 1, true);
    const memory = await rpc.reopen();
    expect(memory.buildSessionContext().messages.at(-1)).toMatchObject({
      stopReason: "aborted",
    });
    expect(
      memory.buildSessionContext().messages.filter((message) => {
        return message.role === "assistant" && message.stopReason === "aborted";
      }),
    ).toHaveLength(1);
  }, 30_000);

  it.each([
    { type: "steer" },
    { type: "follow_up" },
    { type: "prompt", streamingBehavior: "steer" },
    { type: "prompt", streamingBehavior: "followUp" },
  ])(
    "persists first $type/$streamingBehavior accepted during settlement before EOF",
    async (command) => {
      const rpc = await heldSettlement();
      rpc.send({ ...command, id: "input", message: "accepted while settling" });
      expect(await rpc.response("input")).toMatchObject({ success: true });
      rpc.send({ id: "queued", type: "get_state" });
      expect(await rpc.response("queued")).toMatchObject({
        data: { isStreaming: true, pendingMessageCount: 1 },
      });
      rpc.child.send("release-settlement");
      await rpc.settled();
      rpc.send({ id: "idle", type: "get_state" });
      expect(await rpc.response("idle")).toMatchObject({
        data: { isStreaming: false, pendingMessageCount: 0 },
      });
      assertSettlement(rpc, 2, false);
      const memory = await rpc.reopen();
      expect(
        memory.buildSessionContext().messages.filter((message) => {
          return (
            message.role === "user" &&
            JSON.stringify(message.content).includes("accepted while settling")
          );
        }),
      ).toHaveLength(1);
      expect(memory.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
      expect(assistantEnds(rpc.records)).toHaveLength(3);
    },
    30_000,
  );

  it.each(["rpc", "extension"])(
    "persists accepted input when %s cancellation wins and explicitly rejects closed admission",
    async (cancellation) => {
      const rpc = await heldSettlement("cancelled-input");
      rpc.send({
        id: "input",
        type: "steer",
        message: "accepted while settling",
      });
      expect(await rpc.response("input")).toMatchObject({ success: true });
      if (cancellation === "rpc") {
        rpc.send({ id: "abort", type: "abort" });
        rpc.send({ id: "aborting", type: "get_state" });
        expect(await rpc.response("aborting")).toMatchObject({
          data: { isStreaming: true },
        });
      }
      rpc.child.send(
        cancellation === "rpc"
          ? "release-settlement"
          : "release-settlement-abort",
      );
      await rpc.notification("persisting-cancelled");
      for (const command of [
        { type: "steer" },
        { type: "follow_up" },
        { type: "prompt", streamingBehavior: "steer" },
      ]) {
        rpc.send({
          ...command,
          id: "closed",
          message: "not accepted after cancellation decision",
        });
        expect(await rpc.response("closed")).toMatchObject({
          success: false,
          error: expect.stringContaining("settling"),
        });
      }
      rpc.child.send("release-input");
      await rpc.settled();
      if (cancellation === "rpc")
        expect(await rpc.response("abort")).toMatchObject({ success: true });
      rpc.send({ id: "idle", type: "get_state" });
      expect(await rpc.response("idle")).toMatchObject({
        data: { isStreaming: false, pendingMessageCount: 0 },
      });
      assertSettlement(rpc, 1, true);
      const memory = await rpc.reopen();
      const messages = memory.buildSessionContext().messages;
      expect(
        messages.filter((message) => {
          return (
            message.role === "user" &&
            JSON.stringify(message.content).includes("accepted while settling")
          );
        }),
      ).toHaveLength(1);
      expect(
        messages.some((message) => {
          return (
            message.role === "user" &&
            JSON.stringify(message.content).includes(
              "not accepted after cancellation decision",
            )
          );
        }),
      ).toBe(false);
      expect(
        messages
          .filter((message) => {
            return message.role === "assistant";
          })
          .at(-1),
      ).toMatchObject({ stopReason: "aborted" });
      expect(
        messages.filter((message) => {
          return (
            message.role === "assistant" && message.stopReason === "aborted"
          );
        }),
      ).toHaveLength(1);
    },
    30_000,
  );

  it("drains late steering before follow-ups in native order before final notification", async () => {
    const rpc = await heldSettlement();
    for (const [type, message] of [
      ["follow_up", "follow-up one"],
      ["steer", "steering one"],
      ["steer", "steering two"],
      ["follow_up", "follow-up two"],
    ]) {
      rpc.send({ id: "input", type, message });
      expect(await rpc.response("input")).toMatchObject({ success: true });
    }
    rpc.child.send("release-settlement");
    await rpc.settled();
    assertSettlement(rpc, 5, false);
    const memory = await rpc.reopen();
    const users = memory.buildSessionContext().messages.filter((message) => {
      return message.role === "user";
    });
    expect(
      users.map((message) => {
        return message.content;
      }),
    ).toEqual([
      [{ type: "text", text: "execute the controlled tool" }],
      [{ type: "text", text: "steering one" }],
      [{ type: "text", text: "steering two" }],
      [{ type: "text", text: "follow-up one" }],
      [{ type: "text", text: "follow-up two" }],
    ]);
    expect(memory.buildSessionContext().messages.at(-1)).toMatchObject({
      stopReason: "stop",
    });
  }, 30_000);

  it.each(["tool", "http"])(
    "acknowledges abort only after the owned %s boundary settles",
    async (boundary) => {
      const {
        root,
        effect,
        child,
        stdin,
        exit,
        records,
        notifications,
        send,
        response,
      } = await rpcFixture(boundary);
      send({ id: "state", type: "get_state" });
      expect(await response("state")).toMatchObject({
        success: true,
        data: { sessionId: SESSION_ID },
      });
      const started = once(child, "message");
      send({
        id: "startup",
        type: "prompt",
        message: "execute the controlled tool",
      });
      expect(await response("startup")).toMatchObject({
        command: "prompt",
        success: true,
      });
      expect((await started)[0]).toMatchObject({ type: "tool-start" });
      send({
        id: "busy",
        type: "prompt",
        message: "unowned concurrent prompt",
      });
      expect(await response("busy")).toMatchObject({ success: false });
      send({
        id: "steer",
        type: "steer",
        message: "acknowledged active input",
      });
      expect(await response("steer")).toMatchObject({ success: true });
      if (boundary === "http") {
        const requested = once(child, "message");
        child.send("release-tool");
        expect((await requested)[0]).toMatchObject({
          type: "http-start",
          count: 1,
        });
      }
      const cancelled = once(child, "message");
      send({ id: "abort", type: "abort" });
      send({ id: "duplicate-abort", type: "abort" });
      expect((await cancelled)[0]).toMatchObject({
        type: boundary === "tool" ? "tool-aborted" : "http-aborted",
      });
      if (boundary === "tool") {
        send({ id: "held", type: "get_state" });
        expect(await response("held")).toMatchObject({
          data: { isStreaming: true },
        });
        expect(
          records.some((record) => {
            return record.id === "abort" || record.type === "agent_settled";
          }),
        ).toBe(false);
        child.send("release-tool");
      }
      expect(await response("abort")).toMatchObject({
        command: "abort",
        success: true,
      });
      expect(await response("duplicate-abort")).toMatchObject({
        command: "abort",
        success: true,
      });
      send({ id: "idle", type: "get_state" });
      expect(await response("idle")).toMatchObject({
        data: { isStreaming: false },
      });
      expect(
        records.filter((record) => {
          return record.type === "agent_settled";
        }),
      ).toHaveLength(1);
      const assistants = records.filter((record) => {
        const message = record.message;
        return (
          record.type === "message_end" &&
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "assistant"
        );
      });
      expect(assistants).toHaveLength(2);
      expect(assistants[0]).toMatchObject({
        message: { stopReason: "toolUse" },
      });
      expect(assistants[1]).toMatchObject({
        message: { stopReason: "aborted" },
      });
      if (boundary === "tool") {
        const terminal = assistants[1]?.message;
        if (typeof terminal !== "object" || terminal === null)
          throw new Error("Expected native aborted assistant");
        const expected: unknown = JSON.parse(
          await readFile(
            new URL("./test/fixtures/pending-tool-abort.json", import.meta.url),
            "utf8",
          ),
        );
        expect([
          { type: "message_end", message: { ...terminal, timestamp: 0 } },
          records.find((record) => {
            return record.type === "agent_settled";
          }),
        ]).toEqual(expected);
      }
      const requestCount = () => {
        return notifications.filter((message) => {
          return (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "http-start"
          );
        }).length;
      };
      expect(requestCount()).toBe(boundary === "http" ? 1 : 0);
      if (boundary === "tool")
        await expect(readFile(effect)).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(await readFile(effect, "utf8")).toBe("completed side effect");
      stdin.end();
      expect(await exit).toEqual([0, null]);
      const persisted = MemoryPiSession.fromJsonl(
        await readFile(join(root, "session.jsonl"), "utf8"),
      );
      expect(persisted.getSessionId()).toBe(SESSION_ID);
      expect(
        persisted
          .buildSessionContext()
          .messages.filter((message) => {
            return message.role === "assistant";
          })
          .at(-1),
      ).toMatchObject({
        stopReason: "aborted",
      });
    },
    30_000,
  );
});
