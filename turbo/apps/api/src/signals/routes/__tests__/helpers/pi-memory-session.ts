import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { settleIncludingAbort } from "../../../utils";
import type {
  ExecutionContext,
  StorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import { x } from "tar";

/** A real CLI/RPC child, with only its external model provider replaced. */
export async function readClaimedPiMemory(
  claim: Pick<
    ExecutionContext,
    | "runId"
    | "piSessionId"
    | "piModelConfig"
    | "piLaunchConfig"
    | "appendSystemPrompt"
  >,
  mount: StorageMountEntry,
  signal: AbortSignal,
  afterStartup?: () => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "published-pi-reader-"));
  const requests: unknown[] = [];
  const records: Record<string, unknown>[] = [];
  const outcome = await settleIncludingAbort(async () => {
    const agentDir = join(root, ".pi/agent");
    const memory = join(agentDir, "memory");
    await mkdir(memory, { recursive: true });
    if (!mount.empty) {
      if (!mount.archiveUrl) {
        throw new Error("Selected non-empty Memory has no archive URL");
      }
      const downloaded = await fetch(mount.archiveUrl, { signal });
      if (!downloaded.ok) {
        throw new Error("Selected Memory download failed");
      }
      const archiveFile = join(root, "memory.tar.gz");
      await writeFile(archiveFile, Buffer.from(await downloaded.arrayBuffer()));
      await x({ file: archiveFile, cwd: memory, strict: true });
    }
    if (!claim.piModelConfig || !claim.piLaunchConfig || !claim.piSessionId) {
      throw new Error("Expected a complete ordinary Pi claim");
    }
    const payloadFile = join(root, "launch.json");
    await writeFile(
      payloadFile,
      JSON.stringify({
        schemaVersion: 1,
        appendSystemPrompt: claim.appendSystemPrompt,
        launchConfig: claim.piLaunchConfig,
      }),
    );
    const credentials = Object.fromEntries(
      claim.piModelConfig.credentialBindings.map((binding) => {
        return [binding.environment, "test-memory-provider-credential"];
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--import",
        fileURLToPath(
          new URL(
            "../../../../../../cli/src/test/fixtures/pi-memory-provider.ts",
            import.meta.url,
          ),
        ),
        fileURLToPath(
          new URL(
            "../../../../../../cli/src/test/fixtures/pi-agent-loop-rpc-host.ts",
            import.meta.url,
          ),
        ),
        agentDir,
        join(agentDir, "sessions"),
      ],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        signal,
        env: {
          PI_CODING_AGENT_DIR: agentDir,
          ...credentials,
          OKOU_RUN_ID: claim.runId,
          OKOU_PI_SESSION_ID: claim.piSessionId,
          OKOU_PI_LAUNCH_PAYLOAD_FILE: payloadFile,
          OKOU_PI_MODEL_CONFIG: JSON.stringify({
            ...claim.piModelConfig,
            baseUrl: "https://memory-provider.example/v1",
            transport: "sse",
          }),
        },
      },
    );
    const { stdin, stdout, stderr: errorStream } = child;
    assert(stdin && stdout && errorStream, "Expected piped CLI streams");
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "memory-provider-request" &&
        "body" in message
      ) {
        requests.push(message.body);
      }
    });
    child.on("error", (error) => {
      stdout.destroy(error);
    });
    let stderr = "";
    errorStream.setEncoding("utf8");
    errorStream.on("data", (text: string) => {
      stderr += text;
    });
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    async function until(
      predicate: (record: Record<string, unknown>) => boolean,
    ) {
      for (;;) {
        const line = await iterator.next();
        if (line.done) {
          throw new Error(`Pi CLI exited before completion: ${stderr}`);
        }
        const record = JSON.parse(line.value) as Record<string, unknown>;
        records.push(record);
        if (predicate(record)) {
          return;
        }
      }
    }
    const prompted = await settleIncludingAbort(async () => {
      stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
      await until((record) => {
        return record.type === "response" && record.id === "ready";
      });
      await afterStartup?.();
      stdin.write(
        `${JSON.stringify({ id: "recall", type: "prompt", message: "Recall the harbor project using personal Memory" })}\n`,
      );
      await until((record) => {
        return record.type === "agent_end";
      });
      const exit = once(child, "exit");
      stdin.end();
      if (child.connected) {
        child.disconnect();
      }
      const [code] = await exit;
      if (code !== 0) {
        throw new Error(`Pi CLI failed: ${stderr}`);
      }
    });
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (!prompted.ok) {
      throw prompted.error;
    }
    if (requests.length === 0) {
      throw new Error(
        `No model request reached the provider fixture: ${stderr}`,
      );
    }
    return { requests, records };
  });
  const closed = await settleIncludingAbort(async () => {
    await rm(root, { recursive: true, force: true });
  });
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  return outcome.value;
}
