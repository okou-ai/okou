import { SessionManager } from "@earendil-works/pi-coding-agent";
import { http, HttpResponse } from "msw";
import fsSync, { promises as fs } from "node:fs";
import { server } from "../mocks/server";
import terminalFixtures from "../../../../../fixtures/pi-memory-phase2-terminal.json";
import nativePiFixtures from "../../../../packages/api-contracts/src/contracts/__tests__/fixtures/pi-native.json";
import { PI_NATIVE_CREDENTIAL_PLACEHOLDER } from "@okouai/api-contracts/contracts/pi-native";
import { zstdDecompressSync } from "node:zlib";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryPiSession,
  PiMemoryPhase2EngineError,
} from "@okouai/pi-agent-runtime/node";

import {
  piSandboxAgentConfigFromEnv,
  recordPiMemoryToolSourceUse,
  recordPiPreparationTiming,
  runPiSandboxAgentLoop,
  reportPiSandboxAgentLoopFailure,
  type PiSandboxAgentConfig,
} from "./pi-agent-loop";

const RUN_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RPC_FIXTURE = fileURLToPath(
  new URL("../test/fixtures/pi-agent-loop-rpc-host.ts", import.meta.url),
);
const TSX_IMPORT = import.meta.resolve("tsx");
const CONFIG: PiSandboxAgentConfig = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  reportPreparationTiming: true,
  launchPayload: {
    schemaVersion: 1,
    appendSystemPrompt: "exact immutable Pi append prompt",
    launchConfig: { schemaVersion: 2 },
  },
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-flash",
    dialect: "openai-responses",
    transport: "sse",
    apiKey: "test-api-key",
  },
};

let launchPayloadDirectory = "";
let launchPayloadFile = "";

interface ProviderRequest {
  readonly body: unknown;
  failRetryable(): void;
  respond(text: string): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function responsesTextSse(text: string, sequence: number): string {
  const responseId = `resp_pi_rpc_${sequence}`;
  const messageId = `msg_pi_rpc_${sequence}`;
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
        },
      },
    },
  ];
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function writeSseResponse(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(body);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class ProviderHarness {
  readonly requests: ProviderRequest[] = [];
  readonly #waiters: Array<Deferred<ProviderRequest>> = [];
  readonly #server: Server;
  #nextRequestIndex = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<ProviderHarness> {
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(
          (request.headers["content-encoding"] === "zstd"
            ? zstdDecompressSync(Buffer.concat(chunks))
            : Buffer.concat(chunks)
          ).toString("utf8"),
        ) as unknown;
        const sequence = harness.requests.length + 1;
        const providerRequest: ProviderRequest = {
          body,
          failRetryable() {
            response.writeHead(429, {
              "content-type": "application/json",
              "retry-after-ms": "1",
            });
            response.end(
              JSON.stringify({ error: { message: "retry this request" } }),
            );
          },
          respond(text) {
            writeSseResponse(response, responsesTextSse(text, sequence));
          },
        };
        harness.#recordRequest(providerRequest);
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    const harness = new ProviderHarness(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return harness;
  }

  get baseUrl(): string {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pi provider test server has no TCP address");
    }
    return `http://127.0.0.1:${address.port}/`;
  }

  async nextRequest(): Promise<ProviderRequest> {
    const index = this.#nextRequestIndex;
    this.#nextRequestIndex += 1;
    const existing = this.requests[index];
    if (existing) {
      return existing;
    }
    const waiter = deferred<ProviderRequest>();
    this.#waiters.push(waiter);
    return await withTimeout(waiter.promise, "Pi provider request");
  }

  #recordRequest(request: ProviderRequest): void {
    this.requests.push(request);
    this.#waiters.shift()?.resolve(request);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

class RpcHost {
  readonly records: Array<Record<string, unknown>> = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterableIterator<string>;
  #stderr = "";

  constructor(args: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionDir: string;
    readonly env: NodeJS.ProcessEnv;
  }) {
    this.#child = spawn(
      process.execPath,
      ["--import", TSX_IMPORT, RPC_FIXTURE, args.agentDir, args.sessionDir],
      {
        cwd: args.cwd,
        env: args.env,
        stdio: "pipe",
      },
    );
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#lines = createInterface({
      input: this.#child.stdout,
      crlfDelay: Infinity,
    });
    this.#iterator = this.#lines[Symbol.asyncIterator]();
  }

  preparationRecords(): Array<Record<string, unknown>> {
    return this.#stderr
      .split("\n")
      .filter((line) => {
        return line.startsWith("{");
      })
      .map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      })
      .filter((record) => {
        return record.type === "pi_preparation_timing";
      });
  }

  send(command: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async waitFor(
    predicate: (record: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const next = await withTimeout(
        this.#iterator.next(),
        "Pi RPC stdout record",
      );
      if (next.done) {
        throw new Error(`Pi RPC host exited early: ${this.#stderr}`);
      }
      const record = JSON.parse(next.value) as Record<string, unknown>;
      this.records.push(record);
      if (predicate(record)) {
        return record;
      }
    }
  }

  async state(id: string): Promise<Record<string, unknown>> {
    this.send({ id, type: "get_state" });
    const response = await this.waitFor((record) => {
      return record.type === "response" && record.id === id;
    });
    return response.data as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    const [code, signal] = await withTimeout(
      once(this.#child, "exit") as Promise<
        [number | null, NodeJS.Signals | null]
      >,
      "Pi RPC host exit",
    );
    this.#lines.close();
    expect(signal).toBeNull();
    expect(code, this.#stderr).toBe(0);
  }

  async terminate(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await once(this.#child, "exit");
    }
    this.#lines.close();
  }
}

beforeEach(async () => {
  launchPayloadDirectory = await mkdtemp(join(tmpdir(), "okou-pi-launch-"));
  launchPayloadFile = join(launchPayloadDirectory, "payload.json");
  await writeFile(launchPayloadFile, JSON.stringify(CONFIG.launchPayload));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(launchPayloadDirectory, { recursive: true, force: true });
});

function piEnv(runIdEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...runIdEnv,
    OKOU_PI_SESSION_ID: SESSION_ID,
    OKOU_PI_LAUNCH_PAYLOAD_FILE: launchPayloadFile,
    OKOU_PI_MODEL_CONFIG: JSON.stringify({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "DEEPSEEK_API_KEY",
    }),
    OKOU_PI_PREPARATION_TIMING: "1",
    OPENAI_API_KEY: "test-api-key",
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function startSandboxHost(args: {
  readonly root: string;
  /** History the Runner restored from the run's `resumeSession`, if any. */
  readonly restoredJsonl?: string;
  readonly providerBaseUrl: string;
  readonly model?:
    | "deepseek"
    | "deepseek-v41"
    | "openrouter-v41"
    | "openrouter-luna"
    | "luna"
    | "codex-luna";
  readonly serviceTier?: "priority" | "fast";
  readonly reportPreparationTiming?: boolean;
}): Promise<RpcHost> {
  const agentDir = join(args.root, ".pi", "agent");
  const sessionDir = join(agentDir, "sessions", "--test--");
  if (args.restoredJsonl !== undefined) {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, `restored-${SESSION_ID}.jsonl`),
      args.restoredJsonl,
      { mode: 0o600 },
    );
  }
  const payloadFile = join(args.root, "launch-payload.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    payloadFile,
    JSON.stringify({
      schemaVersion: 1,
      appendSystemPrompt: null,
      launchConfig: { schemaVersion: 2 },
    }),
    { mode: 0o600 },
  );
  const luna = args.model === "luna" || args.model === "openrouter-luna";
  const openrouter =
    args.model === "openrouter-luna" || args.model === "openrouter-v41";
  const v41 = args.model === "deepseek-v41" || args.model === "openrouter-v41";
  const env = {
    ...process.env,
    OKOU_RUN_ID: RUN_ID,
    OKOU_PI_SESSION_ID: SESSION_ID,
    OKOU_PI_LAUNCH_PAYLOAD_FILE: payloadFile,
    OKOU_PI_MODEL_CONFIG: JSON.stringify(
      args.model === "codex-luna"
        ? {
            schemaVersion: 3,
            dialect: "openai-codex-responses",
            transport: "sse",
            provider: "openai-codex",
            baseUrl: args.providerBaseUrl,
            model: "gpt-6-luna",
            thinkingLevel: "low",
            serviceTier: args.serviceTier,
            credentialBindings: [
              {
                kind: "access-token",
                environment: "CHATGPT_ACCESS_TOKEN",
                secretName: "CHATGPT_ACCESS_TOKEN",
              },
              {
                kind: "account-id",
                environment: "CHATGPT_ACCOUNT_ID",
                secretName: "CHATGPT_ACCOUNT_ID",
              },
            ],
          }
        : {
            provider: openrouter ? "openrouter" : luna ? "openai" : "deepseek",
            baseUrl: args.providerBaseUrl,
            model: v41
              ? openrouter
                ? "deepseek/deepseek-v4.1-flash"
                : "deepseek-flash"
              : openrouter
                ? "openai/gpt-6-luna"
                : luna
                  ? "gpt-6-luna"
                  : "deepseek-v4-flash",
            ...(luna
              ? {
                  thinkingLevel: "low" as const,
                }
              : {}),
            ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
            apiKeyEnv: "OPENAI_API_KEY",
            credentialSecretName: openrouter
              ? "OPENROUTER_API_KEY"
              : luna
                ? "OPENAI_API_KEY"
                : "DEEPSEEK_API_KEY",
          },
    ),
    ...(args.reportPreparationTiming
      ? { OKOU_PI_PREPARATION_TIMING: "1" }
      : {}),
    OPENAI_API_KEY: "pi-ownership-transfer-test-key",
    CHATGPT_ACCESS_TOKEN: "opaque-access-token-placeholder",
    CHATGPT_ACCOUNT_ID: "opaque-account-id-placeholder",
  };
  return new RpcHost({ cwd: args.root, agentDir, sessionDir, env });
}

describe("sandbox Pi agent loop", () => {
  it("serves RPC state with complete configuration and session startup observations", async () => {
    const host = await startSandboxHost({
      root: launchPayloadDirectory,
      providerBaseUrl: "http://127.0.0.1:1",
      reportPreparationTiming: true,
    });
    try {
      const state = await host.state("startup-observation-state");
      expect(state.sessionId).toBe(SESSION_ID);
      await host.terminate();
      const records = host.preparationRecords();
      expect(
        records.map((record) => {
          return record.phase;
        }),
      ).toEqual(
        expect.arrayContaining([
          "cli_config",
          "cli_launch_payload",
          "cli_credentials",
          "cli_session_file",
          "session_manager",
          "runtime_initialize",
          "resources_prompt",
          "model_runtime",
          "session_services",
          "resource_loader",
          "session_create",
          "session_finalize",
        ]),
      );
      for (const record of records) {
        expect(record).toMatchObject({
          type: "pi_preparation_timing",
          runId: RUN_ID,
          outcome: "success",
        });
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
        expect(record.startedAt).toEqual(expect.any(Number));
        expect(record.finishedAt).toEqual(expect.any(Number));
      }
    } finally {
      await host.terminate();
    }
  });

  it("keeps preparation reporting best effort when the diagnostic fd is closed", async () => {
    const helper = fileURLToPath(
      new URL("./pi-startup-timing.ts", import.meta.url),
    );
    const script = `import fs from 'node:fs'; const {writePiPreparationTiming} = await import(${JSON.stringify(helper)}); fs.closeSync(2); writePiPreparationTiming('run', {phase:'cli_config',startedAt:0,finishedAt:1,durationMs:1,outcome:'error'}); process.stdout.write('still-alive');`;
    const child = spawn(
      process.execPath,
      ["--import", TSX_IMPORT, "--input-type=module", "-e", script],
      { stdio: "pipe" },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(stdout).toBe("still-alive");
  });
  it("writes the private maintenance attestation only after mounted validation", async () => {
    const errors = vi.spyOn(console, "error");
    const exitCode = process.exitCode;
    const validationFile = join(
      launchPayloadDirectory,
      "maintenance-validation.json",
    );
    const memoryRoot = join(launchPayloadDirectory, "memory");
    const storageId = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
    const memory = "# Durable memory\n";
    const summary = "v1\nDurable memory\n";
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "MEMORY.md"), memory);
    await writeFile(join(memoryRoot, "memory_summary.md"), summary);
    const versionEntries = [
      `MEMORY.md:${createHash("sha256").update(memory).digest("hex")}`,
      `memory_summary.md:${createHash("sha256").update(summary).digest("hex")}`,
    ].sort();
    const validatedVersionId = createHash("sha256")
      .update(`storage:${storageId}\n${versionEntries.join("\n")}`)
      .digest("hex");
    const selectionEncoding = Buffer.from(
      "vm0.pi-memory.phase2.selection.v1",
      "utf8",
    );
    const selectionEncodingLength = Buffer.alloc(4);
    selectionEncodingLength.writeUInt32BE(selectionEncoding.length);
    const emptySelectionLength = Buffer.alloc(4);
    emptySelectionLength.writeUInt32BE(0);
    const selectionDigest = createHash("sha256")
      .update(
        Buffer.concat([
          selectionEncodingLength,
          selectionEncoding,
          emptySelectionLength,
        ]),
      )
      .digest("hex");
    const maintenance = {
      schemaVersion: 1 as const,
      memoryStorageId: storageId,
      claimedRevision: 7,
      claimedBaseVersionId: validatedVersionId,
      leaseToken: "44754115-d375-4c46-aea7-a55bd1b61ec7",
      selectionDigest,
      selected: [],
    };
    await writeFile(validationFile, "stale-attestation", { mode: 0o600 });

    await runPiSandboxAgentLoop({
      config: {
        ...CONFIG,
        launchPayload: {
          ...CONFIG.launchPayload,
          launchConfig: {
            ...CONFIG.launchPayload.launchConfig,
            maintenance,
          },
        },
      },
      memoryRoot,
      maintenanceValidationFile: validationFile,
    });

    await expect(readFile(join(memoryRoot, "MEMORY.md"), "utf8")).resolves.toBe(
      memory,
    );
    await expect(
      readFile(join(memoryRoot, "memory_summary.md"), "utf8"),
    ).resolves.toBe(summary);
    await expect(readFile(validationFile, "utf8")).resolves.toBe(
      JSON.stringify({
        schemaVersion: 1,
        runId: RUN_ID,
        memoryStorageId: maintenance.memoryStorageId,
        claimedRevision: maintenance.claimedRevision,
        claimedBaseVersionId: maintenance.claimedBaseVersionId,
        leaseToken: maintenance.leaseToken,
        selectionDigest: maintenance.selectionDigest,
        validatedVersionId,
      }),
    );
    expect((await stat(validationFile)).mode & 0o777).toBe(0o600);
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  });

  it.each(
    // Only the output-validation and mounted-apply fixtures are reproducible
    // by this scenario. Session-lifecycle fixtures are covered by the engine
    // tests and the shared serializer boundary. `summary_tokens` is a historical
    // diagnostic: a valid source above the prompt injection budget now publishes
    // in full, so the runtime cannot produce it. Its fixture stays for the
    // parsers that must keep reading old terminal records.
    terminalFixtures.filter((fixture) => {
      return (
        fixture.diagnostic &&
        fixture.errorClass === "agent_output_invalid" &&
        fixture.diagnostic.reason !== "summary_tokens"
      );
    }),
  )(
    "carries $name through the real mounted runtime and CLI terminal serializer",
    async (fixture) => {
      server.use(
        http.post("https://phase2-fixture.example/responses", () => {
          return HttpResponse.text(
            responsesTextSse("Synthetic model leaves files unchanged", 1),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const memoryRoot = join(launchPayloadDirectory, "terminal-memory");
      const validationFile = join(
        launchPayloadDirectory,
        "maintenance-validation.json",
      );
      const memory = "# PRIVATE_MEMORY_SENTINEL\n";
      const isApply = fixture.diagnostic?.stage === "mounted_apply";
      const summary = isApply
        ? "v1\nValid summary"
        : "V1\nPRIVATE_SUMMARY_SENTINEL";
      await mkdir(memoryRoot);
      await writeFile(join(memoryRoot, "MEMORY.md"), memory);
      await writeFile(join(memoryRoot, "memory_summary.md"), summary);
      await writeFile(validationFile, "stale-attestation");
      const memoryStorageId = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
      const stalePath = join(
        memoryRoot,
        "rollout_summaries/pi/PRIVATE_PATH_SENTINEL.md",
      );
      const staleContent = "PRIVATE_EVIDENCE_SENTINEL";
      if (isApply) {
        await mkdir(join(memoryRoot, "rollout_summaries/pi"), {
          recursive: true,
        });
        await writeFile(stalePath, staleContent);
      }
      const contentIdentity = createHash("sha256")
        .update(
          `storage:${memoryStorageId}\n${[
            `MEMORY.md:${createHash("sha256").update(memory).digest("hex")}`,
            `memory_summary.md:${createHash("sha256").update(summary).digest("hex")}`,
            ...(isApply
              ? [
                  `rollout_summaries/pi/PRIVATE_PATH_SENTINEL.md:${createHash("sha256").update(staleContent).digest("hex")}`,
                ]
              : []),
          ]
            .sort()
            .join("\n")}`,
        )
        .digest("hex");
      const originalUnlink = fs.unlink;
      const remove = vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
        if (isApply && path === stalePath)
          throw Object.assign(new Error("PRIVATE_ERROR_SENTINEL"), {
            code:
              fixture.diagnostic?.errno === "unknown"
                ? "PRIVATE_ERRNO_SENTINEL"
                : fixture.diagnostic?.errno,
            path: stalePath,
          });
        await originalUnlink(path);
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const previousExit = process.exitCode;
      try {
        const run = runPiSandboxAgentLoop({
          config: {
            ...CONFIG,
            model: {
              provider: "openai",
              baseUrl: "https://phase2-fixture.example/",
              apiKey: "SYNTHETIC_KEY",
              model: "gpt-6-luna",
              dialect: "openai-responses",
              transport: "sse",
            },
            launchPayload: {
              ...CONFIG.launchPayload,
              launchConfig: {
                ...CONFIG.launchPayload.launchConfig,
                maintenance: {
                  schemaVersion: 1,
                  memoryStorageId,
                  claimedRevision: 7,
                  claimedBaseVersionId: contentIdentity,
                  leaseToken: "44754115-d375-4c46-aea7-a55bd1b61ec7",
                  selectionDigest:
                    "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
                  selected: [],
                },
              },
            },
          },
          memoryRoot,
          maintenanceValidationFile: validationFile,
        }).catch(reportPiSandboxAgentLoopFailure);
        await run;
        expect(process.exitCode).toBe(1);
        expect(log.mock.calls).toEqual([[fixture.stderr]]);
        expect(fixture.stderr.length).toBeLessThan(512);
        expect(fixture.stderr).not.toMatch(
          /PRIVATE_|SYNTHETIC_KEY|terminal-memory/,
        );
        await expect(readFile(validationFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toBe(
          memory,
        );
      } finally {
        process.exitCode = previousExit;
        log.mockRestore();
        remove.mockRestore();
      }
    },
  );

  it("preserves failure status when the terminal log sink throws", () => {
    const previousExit = process.exitCode;
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("PRIVATE_SINK_SENTINEL");
    });
    try {
      const failure = new PiMemoryPhase2EngineError("agent_output_invalid", {
        candidateCount: 0,
        fileCount: 0,
        totalBytes: 0,
      });
      expect(() => {
        return reportPiSandboxAgentLoopFailure(failure);
      }).not.toThrow();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit;
      log.mockRestore();
    }
  });

  it("removes a stale maintenance attestation when validation fails", async () => {
    const validationFile = join(
      launchPayloadDirectory,
      "maintenance-validation.json",
    );
    const memoryRoot = join(launchPayloadDirectory, "memory");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Partial memory\n");
    await writeFile(validationFile, "stale-attestation", { mode: 0o600 });

    await expect(
      runPiSandboxAgentLoop({
        config: {
          ...CONFIG,
          launchPayload: {
            ...CONFIG.launchPayload,
            launchConfig: {
              ...CONFIG.launchPayload.launchConfig,
              maintenance: {
                schemaVersion: 1,
                memoryStorageId: "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63",
                claimedRevision: 7,
                claimedBaseVersionId: "a".repeat(64),
                leaseToken: "44754115-d375-4c46-aea7-a55bd1b61ec7",
                selectionDigest: "b".repeat(64),
                selected: [],
              },
            },
          },
        },
        memoryRoot,
        maintenanceValidationFile: validationFile,
      }),
    ).rejects.toThrow("Pi memory Phase 2 input was invalid");
    await expect(readFile(validationFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records content-free memory source use with run and session correlation", () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      recordPiMemoryToolSourceUse(RUN_ID, SESSION_ID, {
        operation: "read",
        outcome: "success",
        memoryStorageId: "memory-storage-a",
        storageVersionId: "memory-version-a",
        pathHash: "a".repeat(64),
        visitedEntries: 0,
        scannedFiles: 1,
        scannedBytes: 42,
        returnedEntries: 0,
        returnedLines: 2,
        returnedMatches: 0,
        truncated: false,
        durationMs: 3,
      });
    } finally {
      write.mockRestore();
    }

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "{}") as unknown).toStrictEqual({
      type: "pi_memory_tool_source_use",
      runId: RUN_ID,
      sessionId: SESSION_ID,
      operation: "read",
      outcome: "success",
      memoryStorageId: "memory-storage-a",
      storageVersionId: "memory-version-a",
      pathHash: "a".repeat(64),
      visitedEntries: 0,
      scannedFiles: 1,
      scannedBytes: 42,
      returnedEntries: 0,
      returnedLines: 2,
      returnedMatches: 0,
      truncated: false,
      durationMs: 3,
    });
  });

  it("reports each sandbox preparation phase as a bounded stderr envelope", () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(fsSync, "writeSync")
      .mockImplementation((_fd, chunk) => {
        writes.push(String(chunk));
        return Buffer.byteLength(String(chunk));
      });
    try {
      recordPiPreparationTiming(RUN_ID, {
        phase: "session_services",
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_000_042,
        durationMs: 41.6,
        outcome: "success",
      });
    } finally {
      write.mockRestore();
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    // guest-agent parses this envelope into `pi_prepare_session_services`;
    // the child carries wall boundaries for correlation; Guest still owns _time.
    expect(JSON.parse(writes[0] ?? "{}") as unknown).toStrictEqual({
      type: "pi_preparation_timing",
      runId: RUN_ID,
      phase: "session_services",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_042,
      durationMs: 41.6,
      outcome: "success",
    });
  });

  it("stays silent about preparation phases until guest-agent opts the child in", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    delete env.OKOU_PI_PREPARATION_TIMING;

    // An older guest-agent does not recognize the envelope and would surface it
    // as user-visible failure output, so the child must not emit it.
    await expect(piSandboxAgentConfigFromEnv(env)).resolves.toMatchObject({
      reportPreparationTiming: false,
    });
    const looseValue = piEnv({ OKOU_RUN_ID: RUN_ID });
    looseValue.OKOU_PI_PREPARATION_TIMING = "true";
    await expect(
      piSandboxAgentConfigFromEnv(looseValue),
    ).resolves.toMatchObject({ reportPreparationTiming: false });
  });

  it("resolves the Pi session, launch payload file, and model credential", async () => {
    await expect(
      piSandboxAgentConfigFromEnv(piEnv({ OKOU_RUN_ID: RUN_ID })),
    ).resolves.toEqual(CONFIG);
  });

  it("uses run authentication and the first-party relay without Langfuse keys", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    Object.assign(env, {
      OKOU_PI_LANGFUSE_DEBUG_ENABLED: "true",
      OKOU_API_BACKEND_URL: "https://api.okou.test",
      OKOU_TOKEN: "run-scoped-token",
      LANGFUSE_BASE_URL: "https://user-langfuse.example",
      LANGFUSE_PUBLIC_KEY: "user-project",
      LANGFUSE_SECRET_KEY: "user-secret",
      LANGFUSE_USER_ID: "anonymous-user",
      LANGFUSE_TRACING_ENVIRONMENT: "internal-debug",
    });
    const resolved = await piSandboxAgentConfigFromEnv(env);
    expect(resolved.langfuseConfig).toStrictEqual({
      relay: {
        endpoint: `https://api.okou.test/api/webhooks/agent/${RUN_ID}/langfuse/traces`,
        token: "run-scoped-token",
      },
      userId: "anonymous-user",
      environment: "internal-debug",
    });
    env.OKOU_PI_LANGFUSE_DEBUG_ENABLED = "false";
    expect(
      (await piSandboxAgentConfigFromEnv(env)).langfuseConfig,
    ).toBeUndefined();
  });

  it("carries the frozen memory epoch through the private launch file", async () => {
    const memoryRecall = {
      status: "no-content" as const,
      memoryStorageId: "memory-storage",
      storageVersionId: "memory-version-a",
    };
    await writeFile(
      launchPayloadFile,
      JSON.stringify({
        ...CONFIG.launchPayload,
        launchConfig: { ...CONFIG.launchPayload.launchConfig, memoryRecall },
      }),
    );

    await expect(
      piSandboxAgentConfigFromEnv(piEnv({ OKOU_RUN_ID: RUN_ID })),
    ).resolves.toMatchObject({
      launchPayload: { launchConfig: { memoryRecall } },
    });
  });

  it("preserves canonical Gen1 request policy at launch", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = JSON.stringify({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-luna",
      thinkingLevel: "low",
      serviceTier: "priority",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENAI_API_KEY",
    });

    const resolved = await piSandboxAgentConfigFromEnv(env);
    expect(resolved.model).toStrictEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-luna",
      dialect: "openai-responses",
      transport: "sse",
      thinkingLevel: "low",
      serviceTier: "priority",
      apiKey: "test-api-key",
    });
  });

  it("resolves a custom gateway model without exposing its header template to Pi", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = JSON.stringify({
      provider: "deepseek",
      baseUrl: "https://gateway.example.com/v1",
      model: "company-deepseek-production",
      catalogModel: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "CUSTOM_GATEWAY_API_KEY",
      credentialHeader: {
        name: "x-api-key",
        valueTemplate: "Key {{secret}}",
      },
    });
    env.OPENAI_API_KEY = "safe-gateway-placeholder";

    await expect(piSandboxAgentConfigFromEnv(env)).resolves.toMatchObject({
      model: {
        provider: "deepseek",
        baseUrl: "https://gateway.example.com/v1",
        model: "company-deepseek-production",
        catalogModel: "deepseek-v4-flash",
        dialect: "openai-responses",
        apiKey: "unused",
        requestHeaders: {
          authorization: null,
          "x-api-key": "safe-gateway-placeholder",
        },
      },
    });
  });

  it.each([2, 3] as const)(
    "materializes exact subscription bindings from generation %s",
    async (schemaVersion) => {
      const env = piEnv({ OKOU_RUN_ID: RUN_ID });
      env.OKOU_PI_MODEL_CONFIG = JSON.stringify({
        schemaVersion,
        ...(schemaVersion === 3 ? { serviceTier: "fast" } : {}),
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-6-luna",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
          {
            kind: "account-id",
            environment: "CHATGPT_ACCOUNT_ID",
            secretName: "CHATGPT_ACCOUNT_ID",
          },
        ],
      });
      delete env.OPENAI_API_KEY;
      env.CHATGPT_ACCESS_TOKEN = "opaque-access-token-placeholder";
      env.CHATGPT_ACCOUNT_ID = "opaque-account-id-placeholder";

      await expect(piSandboxAgentConfigFromEnv(env)).resolves.toMatchObject({
        model: {
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api",
          model: "gpt-6-luna",
          ...(schemaVersion === 3 ? { serviceTier: "fast" } : {}),
          dialect: "openai-codex-responses",
          transport: "sse",
          apiKey: "opaque-access-token-placeholder",
          accountId: "opaque-account-id-placeholder",
        },
      });
    },
  );

  it.each([
    {
      dialect: "openai-responses",
      provider: "openai",
      serviceTier: "fast",
      credentialBindings: [
        {
          kind: "api-key",
          environment: "OPENAI_API_KEY",
          secretName: "OPENAI_API_KEY",
        },
      ],
    },
    {
      dialect: "openai-codex-responses",
      provider: "openai-codex",
      serviceTier: "priority",
      credentialBindings: [
        {
          kind: "access-token",
          environment: "CHATGPT_ACCESS_TOKEN",
          secretName: "CHATGPT_ACCESS_TOKEN",
        },
        {
          kind: "account-id",
          environment: "CHATGPT_ACCOUNT_ID",
          secretName: "CHATGPT_ACCOUNT_ID",
        },
      ],
    },
  ])(
    "rejects generation 3 $serviceTier on $dialect before credential materialization",
    async (route) => {
      const env = piEnv({ OKOU_RUN_ID: RUN_ID });
      env.OKOU_PI_MODEL_CONFIG = JSON.stringify({
        ...route,
        schemaVersion: 3,
        transport: "sse",
        baseUrl: "https://example.test/v1",
        model: "gpt-6-luna",
      });
      await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrow();
    },
  );

  it.each(["openai-responses", "openai-completions", "openai-codex-responses"])(
    "rejects an extra api key (%s) at the private launch boundary",
    async (api) => {
      const env = piEnv({ OKOU_RUN_ID: RUN_ID });
      env.OKOU_PI_MODEL_CONFIG = JSON.stringify({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-6-luna",
        api,
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENAI_API_KEY",
      });
      await expect(piSandboxAgentConfigFromEnv(env)).rejects.toMatchObject({
        issues: [
          expect.objectContaining({ code: "unrecognized_keys", keys: ["api"] }),
        ],
      });
    },
  );

  it("requires the run id", async () => {
    await expect(piSandboxAgentConfigFromEnv(piEnv({}))).rejects.toThrowError(
      "OKOU_RUN_ID is required for Pi execution",
    );
  });

  it("requires the private launch payload file", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    delete env.OKOU_PI_LAUNCH_PAYLOAD_FILE;
    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_LAUNCH_PAYLOAD_FILE is required for Pi execution",
    );
  });

  it("does not echo malformed model config", async () => {
    const invalidModelConfig = "credential-like-model-config{";
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = invalidModelConfig;

    try {
      await piSandboxAgentConfigFromEnv(env);
      throw new Error("Expected malformed Pi model config to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("OKOU_PI_MODEL_CONFIG must contain valid JSON");
      expect(message).not.toContain(invalidModelConfig);
    }
  });

  it("keeps standard Luna tierless on the sandbox-first AgentSession call", async () => {
    const root = await mkdtemp(join(tmpdir(), "okou-pi-sandbox-first-rpc-"));
    const prompt = "execute this sandbox-owned first turn once";
    const provider = await ProviderHarness.start();
    let host: RpcHost | undefined;

    try {
      host = await startSandboxHost({
        root,
        providerBaseUrl: provider.baseUrl,
        model: "openrouter-luna",
      });

      const state = await host.state("sandbox-first-state");
      // The first stdout line is the official RPC response, with no private
      // startup record ahead of it.
      expect(host.records[0]).toMatchObject({
        type: "response",
        id: "sandbox-first-state",
      });
      expect(state).toMatchObject({ sessionId: SESSION_ID, messageCount: 0 });
      expect(String(state.sessionFile)).toBe(
        join(
          root,
          ".pi",
          "agent",
          "sessions",
          "--test--",
          `${SESSION_ID}.jsonl`,
        ),
      );

      host.send({ id: "sandbox-first", type: "prompt", message: prompt });
      const request = await provider.nextRequest();
      expect(occurrences(JSON.stringify(request.body), prompt)).toBe(1);
      expect(request.body).not.toHaveProperty("service_tier");
      request.respond("sandbox-first complete");
      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      await host.close();
      host = undefined;

      expect(provider.requests).toHaveLength(1);
      const persisted = await readFile(String(state.sessionFile), "utf8");
      expect(occurrences(persisted, prompt)).toBe(1);
      expect(persisted).toContain("sandbox-first complete");
    } finally {
      await host?.terminate();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    {
      name: "mounted skill",
      prompt: "/skill:handoff-skill first  argument\nsecond line",
      expandsSkill: true,
    },
    {
      name: "whitespace before a skill",
      prompt: " \n\t/skill:handoff-skill first  argument\nsecond line",
      expandsSkill: false,
    },
    {
      name: "unknown slash input",
      prompt: "/unknown-command first  argument\nsecond line",
      expandsSkill: false,
    },
    {
      name: "absolute path",
      prompt: "/home/user/workspace/report.txt first  argument\nsecond line",
      expandsSkill: false,
    },
  ])(
    "processes $name through native sandbox-first AgentSession on fresh and resumed H0",
    async ({ prompt, expandsSkill }) => {
      const root = await mkdtemp(join(tmpdir(), "okou-pi-native-input-"));
      const provider = await ProviderHarness.start();
      const skillDir = join(root, ".pi", "agent", "skills", "handoff-skill");
      const skillFile = join(skillDir, "SKILL.md");
      const skillBody = "Use the mounted handoff skill body for this request.";
      let h0: string | undefined;
      let host: RpcHost | undefined;
      try {
        // Use the existing user-skill discovery root, without settings,
        // extensions, templates, or a replacement resource loader.
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          skillFile,
          `---\nname: handoff-skill\ndescription: Exercises native mounted skill expansion.\n---\n${skillBody}\n`,
        );
        const expectedInput = expandsSkill
          ? `<skill name="handoff-skill" location="${skillFile}">\nReferences are relative to ${skillDir}.\n\n${skillBody}\n</skill>\n\nfirst  argument\nsecond line`
          : prompt;
        for (const turn of [1, 2]) {
          host = await startSandboxHost({
            root,
            restoredJsonl: h0,
            providerBaseUrl: provider.baseUrl,
            model: "openrouter-luna",
          });
          const state = await host.state(`native-input-state-${turn}`);
          expect(state).toMatchObject({
            sessionId: SESSION_ID,
            // A fresh session has projected nothing yet. Once the first turn
            // has run, 0.86's single leading transcript system message is part
            // of the projection this count reports, alongside each completed
            // user/assistant pair.
            messageCount: turn === 1 ? 0 : (turn - 1) * 2 + 1,
          });
          expect(host.records[0]).toMatchObject({
            type: "response",
            id: `native-input-state-${turn}`,
          });
          const installed = await readFile(String(state.sessionFile), "utf8");
          // The first turn opens a fresh session; a resumed turn opens the
          // Runner-restored H0, which must remain byte-for-byte intact.
          if (h0 === undefined) {
            expect(String(state.sessionFile)).toMatch(
              new RegExp(`/${SESSION_ID}\\.jsonl$`),
            );
          } else {
            expect(String(state.sessionFile)).toMatch(
              new RegExp(`/restored-${SESSION_ID}\\.jsonl$`),
            );
            expect(installed).toBe(h0);
          }

          host.send({
            id: `native-input-${turn}`,
            type: "prompt",
            message: prompt,
          });
          const request = await provider.nextRequest();
          expect(request.body).not.toHaveProperty("service_tier");
          expect(request.body).toMatchObject({
            input: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                content: [{ type: "input_text", text: expectedInput }],
              }),
            ]),
          });
          request.respond(`native input complete ${turn}`);
          await host.waitFor((record) => {
            return record.type === "agent_settled";
          });
          expect(
            host.records.filter((record) => {
              return record.type === "agent_settled";
            }),
          ).toHaveLength(1);
          await host.close();
          host = undefined;

          h0 = await readFile(String(state.sessionFile), "utf8");
          const persisted = MemoryPiSession.fromJsonl(h0);
          expect(persisted.getSessionId()).toBe(SESSION_ID);
          expect(persisted.isSettledCheckpoint()).toBe(true);
          const messages = persisted.buildSessionContext().messages;
          // 0.86 declares the prompt and tool loadout as one leading transcript
          // system message. It must be written once for the session, not once
          // per turn, so the projection grows by exactly the user/assistant
          // pair each turn.
          expect(messages).toHaveLength(turn * 2 + 1);
          expect(
            messages.filter((message) => {
              return message.role === "system";
            }),
          ).toHaveLength(1);
          expect(messages[0]?.role).toBe("system");
          expect(
            messages.filter((message) => {
              return message.role === "user";
            }),
          ).toStrictEqual(
            Array.from({ length: turn }, () => {
              return expect.objectContaining({
                content: [{ type: "text", text: expectedInput }],
              });
            }),
          );
          expect(provider.requests).toHaveLength(turn);
        }
      } finally {
        await host?.terminate();
        await provider.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("keeps OpenRouter priority on an official AgentSession retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "okou-pi-retry-rpc-"));
    const prompt = "retry this sandbox-owned prompt exactly once";
    const provider = await ProviderHarness.start();
    const session = MemoryPiSession.create({ cwd: root, id: SESSION_ID });
    let host: RpcHost | undefined;

    try {
      host = await startSandboxHost({
        root,
        restoredJsonl: session.toJsonl(),
        providerBaseUrl: provider.baseUrl,
        model: "openrouter-luna",
        serviceTier: "priority",
      });

      const state = await host.state("retry-state");
      host.send({ id: "retry", type: "prompt", message: prompt });
      const firstRequest = await provider.nextRequest();
      expect(firstRequest.body).toMatchObject({ service_tier: "priority" });
      expect(occurrences(JSON.stringify(firstRequest.body), prompt)).toBe(1);
      firstRequest.failRetryable();

      const retryRequest = await provider.nextRequest();
      expect(retryRequest.body).toMatchObject({ service_tier: "priority" });
      expect(occurrences(JSON.stringify(retryRequest.body), prompt)).toBe(1);
      retryRequest.respond("OpenRouter retry complete");
      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      await host.close();
      host = undefined;

      expect(provider.requests).toHaveLength(2);
      const persisted = await readFile(String(state.sessionFile), "utf8");
      expect(occurrences(persisted, prompt)).toBe(1);
      expect(persisted).toContain("OpenRouter retry complete");
      expect(persisted).not.toContain("serviceTier");
      expect(persisted).not.toContain("service_tier");
    } finally {
      await host?.terminate();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps priority on compaction and the original AgentSession prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "okou-pi-compaction-rpc-"));
    const priorPrompt = "prior context that requires official compaction";
    const prompt = "run this original prompt after official compaction";
    const compactionSummary = "official compacted context summary";
    const finalAnswer = "sandbox answer after compaction";
    const provider = await ProviderHarness.start();
    const session = SessionManager.create(root, root, { id: SESSION_ID });
    session.appendModelChange("deepseek", "deepseek-v4-flash");
    session.appendThinkingLevelChange("high");
    session.appendMessage({ role: "user", content: priorPrompt, timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "earlier answer to summarize" }],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    session.appendMessage({
      role: "user",
      content: "recent context ".repeat(8_000),
      timestamp: 3,
    });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "recent answer retained after compaction" },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 1_033_617,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_033_617,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    let host: RpcHost | undefined;

    try {
      const sessionFile = session.getSessionFile();
      if (!sessionFile) throw new Error("Missing compaction session file");
      host = await startSandboxHost({
        root,
        restoredJsonl: await readFile(sessionFile, "utf8"),
        providerBaseUrl: provider.baseUrl,
        model: "openrouter-luna",
        serviceTier: "priority",
      });

      const state = await host.state("compaction-state");
      host.send({ id: "compaction", type: "prompt", message: prompt });

      const compactionRequest = await provider.nextRequest();
      const compactionBody = JSON.stringify(compactionRequest.body);
      expect(compactionBody).toContain(priorPrompt);
      expect(compactionBody).not.toContain(prompt);
      expect(compactionRequest.body).toMatchObject({
        service_tier: "priority",
      });
      compactionRequest.respond(compactionSummary);

      const promptRequest = await provider.nextRequest();
      expect(occurrences(JSON.stringify(promptRequest.body), prompt)).toBe(1);
      expect(promptRequest.body).toMatchObject({ service_tier: "priority" });
      promptRequest.respond(finalAnswer);
      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      const rpcRecords = [...host.records];
      await host.close();
      host = undefined;

      expect(provider.requests).toHaveLength(2);
      const persisted = await readFile(String(state.sessionFile), "utf8");
      expect(occurrences(persisted, prompt)).toBe(1);
      const entries = persisted
        .trimEnd()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as {
            type?: string;
            message?: {
              role?: string;
              content?: unknown;
              usage?: unknown;
            };
            summary?: string;
            usage?: unknown;
          };
        });
      const compactions = entries.filter((entry) => {
        return entry.type === "compaction";
      });
      expect(compactions).toHaveLength(1);
      expect(compactions[0]).toMatchObject({
        summary: compactionSummary,
        usage: {
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 8,
        },
      });
      const lastAssistant = [...entries].reverse().find((entry) => {
        return entry.type === "message" && entry.message?.role === "assistant";
      });
      expect(lastAssistant?.message).toMatchObject({
        content: [{ type: "text", text: finalAnswer }],
        usage: {
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 8,
        },
      });
      expect(
        rpcRecords
          .filter((record) => {
            return String(record.type).startsWith("message_");
          })
          .some((record) => {
            return JSON.stringify(record).includes(compactionSummary);
          }),
      ).toBeFalsy();
    } finally {
      await host?.terminate();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("native Pi launch context reader", () => {
  it.each(nativePiFixtures)(
    "reads $name without changing the independent launch snapshot",
    async ({ config }) => {
      const launchPayload = {
        ...CONFIG.launchPayload,
        launchConfig: {
          ...CONFIG.launchPayload.launchConfig,
          memoryRecall: {
            status: "no-content",
            memoryStorageId: "native-memory",
            storageVersionId: "native-version",
          },
        },
      };
      await writeFile(launchPayloadFile, JSON.stringify(launchPayload));
      const env = piEnv({ OKOU_RUN_ID: RUN_ID });
      env.OKOU_PI_MODEL_CONFIG = JSON.stringify(config);
      for (const binding of config.credentialBindings)
        env[binding.environment] = PI_NATIVE_CREDENTIAL_PLACEHOLDER;
      const resolved = await piSandboxAgentConfigFromEnv(env);
      expect(resolved.launchPayload).toStrictEqual(launchPayload);
      expect(resolved.model).toMatchObject({
        model: config.model,
        catalogModel: config.catalogModel,
        dialect: config.dialect,
        transport: config.transport,
      });
      expect(JSON.stringify(resolved.model)).not.toContain(
        "AWS_SECRET_ACCESS_KEY",
      );
    },
  );
});
