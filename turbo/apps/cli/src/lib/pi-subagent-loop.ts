import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { PI_AGENT_DIR } from "@okouai/api-contracts/contracts/runners";
import { runPiSubagent } from "@okouai/pi-agent-runtime/node";

import { piSandboxAgentConfigFromEnv } from "./pi-agent-loop";
import { PI_SESSION_ROLE_ENV } from "./pi-session-env";
import {
  removeSubagentDirectory,
  validateSubagentDirectory,
} from "./pi-subagents";

const inputSchema = z.object({ prompt: z.string().trim().min(1) });

export async function runPiSubagentLoop(
  directory: string,
  agentDir = PI_AGENT_DIR,
): Promise<void> {
  if (process.env[PI_SESSION_ROLE_ENV] !== "child") {
    throw new Error("The subagent loop requires a child Pi session.");
  }
  validateSubagentDirectory(directory);
  const controller = new AbortController();
  const stop = () => {
    return controller.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let fifo: Awaited<ReturnType<typeof open>> | undefined;
  let inputTask: Promise<void> | undefined;
  const inputController = new AbortController();
  try {
    fifo = await open(
      join(directory, "stdin"),
      constants.O_RDWR | constants.O_NONBLOCK,
    );
    // Keep the FIFO's reader open across individual fire-and-forget writes.
    process.send?.({ type: "ready" });
    process.disconnect?.();
    process.stdin.setEncoding("utf8");
    let bootstrap = "";
    for await (const chunk of process.stdin) {
      bootstrap += String(chunk);
      if (Buffer.byteLength(bootstrap) > 1024 * 1024) {
        throw new Error("Subagent prompt exceeds 1 MiB.");
      }
    }
    const { prompt } = inputSchema.parse(JSON.parse(bootstrap));
    const config = await piSandboxAgentConfigFromEnv();
    if (config.launchPayload.launchConfig.maintenance) {
      throw new Error("Memory maintenance cannot launch subagents.");
    }
    const inputFile = fifo;
    await runPiSubagent(
      {
        cwd: process.cwd(),
        agentDir,
        sessionId: config.sessionId,
        model: config.model,
        appendSystemPrompt: config.launchPayload.appendSystemPrompt,
        memoryRecall: config.launchPayload.launchConfig.memoryRecall,
        prompt,
        onEvent(event) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
          if (
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            (event.message.stopReason === "error" ||
              event.message.stopReason === "aborted")
          ) {
            process.exitCode = 1;
          }
        },
        subscribeInput(steer) {
          inputTask = readSteering(
            inputFile,
            steer,
            inputController.signal,
          ).catch((error: unknown) => {
            if (!inputController.signal.aborted) {
              console.error(
                error instanceof Error
                  ? error.message
                  : "Subagent input failed.",
              );
              controller.abort();
            }
          });
          return () => {
            return inputController.abort();
          };
        },
      },
      controller.signal,
    );
  } finally {
    inputController.abort();
    await inputTask;
    await fifo?.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await removeSubagentDirectory(directory);
  }
}

async function readSteering(
  fifo: Awaited<ReturnType<typeof open>>,
  steer: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const buffer = Buffer.alloc(4096);
  let pending = Buffer.alloc(0);
  while (!signal.aborted) {
    try {
      const { bytesRead } = await fifo.read(buffer, 0, buffer.length, null);
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        const { prompt } = inputSchema.parse(JSON.parse(line));
        steer(prompt);
      }
      if (pending.length >= 4096)
        throw new Error("Subagent steering frame is too large.");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EAGAIN"
      ))
        throw error;
    }
    await setTimeout(50, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}
