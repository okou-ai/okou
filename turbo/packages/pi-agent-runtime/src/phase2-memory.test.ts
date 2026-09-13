import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePiAgentModel } from "./model";
import type { PiMemoryPhase2Diagnostic } from "./phase2-memory-diagnostics";
import { renderPiMemoryPhase2Prompt } from "./phase2-memory-prompt";
import { PI_MEMORY_PHASE2_TOOL_NAMES } from "./phase2-memory-tools";
import {
  runPiMemoryPhase2LocalConsolidation,
  runPiMemoryPhase2MountedConsolidation,
} from "./phase2-memory";
import {
  snapshotMountedPiMemoryPhase2Base,
  snapshotPiMemoryPhase2Input,
} from "./phase2-memory-filesystem";
import {
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2LocalConsolidationArgs,
  type PiMemoryPhase2SelectedSnapshot,
} from "./phase2-memory-types";

type PiMemoryPhase2EngineTestHooks = NonNullable<
  Parameters<typeof runPiMemoryPhase2LocalConsolidation>[2]
>;
type PiMemoryPhase2SessionSnapshot = Parameters<
  NonNullable<PiMemoryPhase2EngineTestHooks["onSessionCreated"]>
>[0];

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function storageContentIdentity(
  storageId: string,
  files: readonly PiMemoryPhase2BaseFile[],
): string {
  return createHash("sha256")
    .update(
      `storage:${storageId}\n${files
        .map((file) => {
          return `${file.path}:${file.hash}`;
        })
        .sort()
        .join("\n")}`,
    )
    .digest("hex");
}

function baseFile(path: string, content: string): PiMemoryPhase2BaseFile {
  const bytes = Buffer.from(content);
  return {
    type: "file",
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    bytes,
  };
}

function selected(
  overrides: Partial<PiMemoryPhase2SelectedSnapshot> = {},
): PiMemoryPhase2SelectedSnapshot {
  return {
    piSessionId: "pi-session-secret-input",
    sourceRunId: "source-run-secret-input",
    sourceHistoryHash: createHash("sha256").update("history").digest("hex"),
    sourceCompletedAt: new Date("2026-09-03T03:04:05.000Z"),
    rawMemory: "RAW_STAGE1_SECRET_31243",
    rolloutSummary: "ROLLOUT_SUMMARY_SECRET_31243",
    rolloutSlug: "ROLLOUT_SLUG_SECRET_31243",
    ...overrides,
  };
}

function args(
  baseUrl: string,
  overrides: Partial<PiMemoryPhase2LocalConsolidationArgs> = {},
  /** Written into the literal below so the dialect arm stays discriminated. */
  catalogModel = "gpt-5.6-terra",
): PiMemoryPhase2LocalConsolidationArgs {
  return {
    memoryStorageId: "storage-phase2",
    baseFiles: [
      baseFile("MEMORY.md", "# Task Group: prior\n"),
      baseFile("memory_summary.md", "v1\n## User Profile\n- prior\n"),
      baseFile(".git/config", "BASE_GIT_SECRET_31243"),
      baseFile("legacy.md", "BASE_LEGACY_SECRET_31243"),
      baseFile("raw_memories.md", "BASE_CODEX_RAW_SECRET_31243"),
      baseFile("rollout_summaries/codex.md", "BASE_CODEX_EVIDENCE_31243"),
    ],
    selected: [selected()],
    model: {
      provider: "openai",
      baseUrl,
      apiKey: "PROVIDER_KEY_SECRET_31243",
      model: "MODEL_ALIAS_SECRET_31243",
      catalogModel,
      dialect: "openai-responses",
      transport: "sse",
      thinkingLevel: "max",
      requestHeaders: { "x-phase2-secret": "HEADER_SECRET_31243" },
    },
    ...overrides,
  };
}

interface ProviderRequest {
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

type ProviderStep =
  | {
      readonly type: "tool";
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      /**
       * Report a large prior context for the turn. The SDK anchors its context
       * estimate on the last assistant usage, so this drives the next request's
       * derived output ceiling without a real large provider request.
       */
      readonly usageTotalTokens?: number;
    }
  | {
      readonly type: "text";
      readonly text: string;
      /** Reproduce a provider that returns no response id for the turn. */
      readonly omitResponseId?: true;
      readonly usageTotalTokens?: number;
    }
  | { readonly type: "incomplete"; readonly reason: string }
  | { readonly type: "http-error" }
  | { readonly type: "hang"; readonly onRequest?: () => void };

function writeSse(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

function usage(totalTokens?: number) {
  return {
    input_tokens: 11,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: totalTokens ?? 18,
  };
}

function toolSse(
  response: ServerResponse,
  index: number,
  step: ProviderStep,
): void {
  if (step.type !== "tool") {
    throw new Error("Expected tool provider step");
  }
  const responseId = `resp_phase2_tool_${index.toString()}`;
  const itemId = `fc_phase2_${index.toString()}`;
  const callId = `call_phase2_${index.toString()}`;
  const functionArguments = JSON.stringify(step.arguments);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: step.name,
    arguments: functionArguments,
    status: "completed",
  };
  writeSse(response, [
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
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(step.usageTotalTokens),
      },
    },
  ]);
}

function textSse(
  response: ServerResponse,
  index: number,
  step: ProviderStep,
): void {
  if (step.type !== "text") {
    throw new Error("Expected text provider step");
  }
  const text = step.text;
  const responseId = `resp_phase2_final_${index.toString()}`;
  const messageId = `msg_phase2_${index.toString()}`;
  const item = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeSse(response, [
    {
      type: "response.created",
      response: {
        ...(step.omitResponseId ? {} : { id: responseId }),
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...(step.omitResponseId ? {} : { id: responseId }),
        object: "response",
        status: "completed",
        output: [item],
        usage: usage(step.usageTotalTokens),
      },
    },
  ]);
}

/** A turn the provider truncated, such as an exhausted output budget. */
function incompleteSse(
  response: ServerResponse,
  index: number,
  reason: string,
): void {
  const responseId = `resp_phase2_incomplete_${index.toString()}`;
  const messageId = `msg_phase2_${index.toString()}`;
  const item = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "incomplete",
    content: [{ type: "output_text", text: "truncated", annotations: [] }],
  };
  writeSse(response, [
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
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "truncated",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.incomplete",
      response: {
        id: responseId,
        object: "response",
        status: "incomplete",
        incomplete_details: { reason },
        output: [item],
        usage: usage(),
      },
    },
  ]);
}

async function startProvider(steps: readonly ProviderStep[]): Promise<{
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
}> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const index = requests.length;
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >,
      });
      const step = steps[index];
      if (!step) {
        response.writeHead(500).end();
        return;
      }
      switch (step.type) {
        case "tool": {
          toolSse(response, index, step);
          return;
        }
        case "text": {
          textSse(response, index, step);
          return;
        }
        case "incomplete": {
          incompleteSse(response, index, step.reason);
          return;
        }
        case "http-error": {
          response.writeHead(500).end("provider failure secret");
          return;
        }
        case "hang": {
          step.onRequest?.();
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting\n\n");
          return;
        }
      }
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Phase 2 provider test server has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

function metadataWithoutContents<
  T extends { readonly files: readonly { readonly path: string }[] },
>(value: T): unknown {
  return {
    ...value,
    files: value.files.map((file) => {
      return { path: file.path };
    }),
  };
}

function expectBoundedFailure(
  promise: Promise<unknown>,
  errorClass: PiMemoryPhase2EngineError["errorClass"],
  diagnostic?: PiMemoryPhase2Diagnostic,
): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`Expected ${errorClass} failure`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PiMemoryPhase2EngineError);
      expect(error).toMatchObject({ errorClass });
      expect(error).not.toHaveProperty("files");
      expect(JSON.stringify(error)).not.toContain("SECRET_");
      if (!diagnostic) {
        return;
      }
      if (!(error instanceof PiMemoryPhase2EngineError)) {
        throw new Error("Expected a Pi memory Phase 2 engine error");
      }
      expect(error.diagnostic).toStrictEqual(diagnostic);
      expect(error.terminalMessage()).toBe(
        `${error.message} pi_memory_phase2=${JSON.stringify(diagnostic)}`,
      );
    },
  );
}

describe("Pi memory Phase 2 consolidation engine", () => {
  it("requires the exact mounted base and selection for a no-diff result", async () => {
    const memoryRoot = await mkdtemp(
      join(tmpdir(), "pi-memory-mounted-no-diff-"),
    );
    temporaryDirectories.push(memoryRoot);
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Task Group: existing\n");
    await writeFile(
      join(memoryRoot, "memory_summary.md"),
      "v1\n## User Profile\n- existing\n",
    );
    const memoryStorageId = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(memoryRoot);

    const mountedArgs = {
      memoryRoot,
      memoryStorageId,
      claimedBaseVersionId: storageContentIdentity(memoryStorageId, baseFiles),
      selectionDigest:
        "f95c6835f8a93234e88b26bc2162bd3cf8defd709037f6eefb14ee6ae3d56e48",
      selected: [],
      model: args("http://127.0.0.1:1/v1").model,
    };
    const result = await runPiMemoryPhase2MountedConsolidation(
      mountedArgs,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "no_diff",
      validatedVersionId: storageContentIdentity(memoryStorageId, baseFiles),
    });
    for (const mismatch of [
      { claimedBaseVersionId: "0".repeat(64) },
      { selectionDigest: "0".repeat(64) },
    ]) {
      await expectBoundedFailure(
        runPiMemoryPhase2MountedConsolidation(
          { ...mountedArgs, ...mismatch },
          new AbortController().signal,
        ),
        "input_invalid",
      );
    }
    expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toBe(
      "# Task Group: existing\n",
    );
  });

  it("validates then writes a changed result into the mounted tree", async () => {
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: mounted update\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/memory_summary.md",
          content: "v1\n## User Profile\n- mounted update\n",
        },
      },
      { type: "text", text: "done" },
    ]);
    const memoryRoot = await mkdtemp(
      join(tmpdir(), "pi-memory-mounted-change-"),
    );
    temporaryDirectories.push(memoryRoot);
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Task Group: existing\n");
    await writeFile(
      join(memoryRoot, "memory_summary.md"),
      "v1\n## User Profile\n- existing\n",
    );
    const memoryStorageId = "1d09f0c9-a5c6-4f21-9664-d80a3ca3ae63";
    const baseFiles = await snapshotMountedPiMemoryPhase2Base(memoryRoot);
    const selectedCandidates = [selected()];
    const model = args(provider.baseUrl).model;
    const privateInput = snapshotPiMemoryPhase2Input(
      {
        ...args(provider.baseUrl),
        memoryStorageId,
        baseFiles,
        selected: selectedCandidates,
        model,
      },
      new AbortController().signal,
    );

    const result = await runPiMemoryPhase2MountedConsolidation(
      {
        memoryRoot,
        memoryStorageId,
        claimedBaseVersionId: storageContentIdentity(
          memoryStorageId,
          baseFiles,
        ),
        selectionDigest: privateInput.selectionDigest,
        selected: selectedCandidates,
        model,
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("prepared");
    expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toBe(
      "# Task Group: mounted update\n",
    );
    expect(await readFile(join(memoryRoot, "memory_summary.md"), "utf8")).toBe(
      "v1\n## User Profile\n- mounted update\n",
    );
    expect(result.validatedVersionId).toBe(
      storageContentIdentity(
        memoryStorageId,
        await snapshotMountedPiMemoryPhase2Base(memoryRoot),
      ),
    );
  });
  it("returns an exact no-op without a provider call", async () => {
    let cleanupRoot: string | undefined;
    const input = args("http://127.0.0.1:1/v1", {
      selected: [],
    });
    const result = await runPiMemoryPhase2LocalConsolidation(
      input,
      new AbortController().signal,
      {
        async beforeCleanup(root) {
          cleanupRoot = root;
          await expect(stat(root)).resolves.toBeDefined();
        },
      },
    );

    expect(result.status).toBe("no_diff");
    expect(result.responseId).toBeNull();
    expect(result.usage).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(
      input.baseFiles
        .map((file) => {
          return file.path;
        })
        .slice()
        .sort(),
    );
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses one restricted official AgentSession and returns exact prepared usage", async () => {
    const credentialDir = await mkdtemp(
      join(tmpdir(), "pi-phase2-credentials-"),
    );
    temporaryDirectories.push(credentialDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", credentialDir);
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: updated by maintenance\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/memory_summary.md",
          content: "v1\n## User Profile\n- updated by maintenance\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/skills/reusable/SKILL.md",
          content:
            "---\nname: reusable\ndescription: reusable procedure\n---\n\n# Reusable\n",
        },
      },
      { type: "text", text: "MODEL_TEXT_SECRET_31243 completed" },
    ]);
    const sessions: PiMemoryPhase2SessionSnapshot[] = [];
    let cleanupRoot: string | undefined;
    const input = args(provider.baseUrl);
    const hooks: PiMemoryPhase2EngineTestHooks = {
      onSessionCreated(snapshot) {
        sessions.push(snapshot);
      },
      async beforeCleanup(root) {
        cleanupRoot = root;
      },
    };
    const result = await runPiMemoryPhase2LocalConsolidation(
      input,
      new AbortController().signal,
      hooks,
    );

    expect(result.status).toBe("prepared");
    await expect(
      readFile(join(credentialDir, "auth.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.responseId).toBe("resp_phase2_final_3");
    expect(result.usage).toStrictEqual({
      input: 36,
      output: 28,
      cacheRead: 8,
      cacheWrite: 0,
      reasoning: 8,
    });
    expect(sessions).toStrictEqual([
      {
        toolNames: PI_MEMORY_PHASE2_TOOL_NAMES,
        thinkingLevel: "max",
        sessionFile: undefined,
        extensions: 0,
        skills: 0,
        prompts: 0,
        themes: 0,
        agentsFiles: 0,
        appendSystemPrompts: 0,
        systemPromptDigest: createHash("sha256")
          .update(
            `${renderPiMemoryPhase2Prompt()}\nCurrent working directory: /phase2-memory\n`,
          )
          .digest("hex"),
      },
    ]);
    expect(provider.requests).toHaveLength(4);
    for (const request of provider.requests) {
      expect(request.url).toBe("/v1/responses");
      expect(request.body).toMatchObject({
        model: "MODEL_ALIAS_SECRET_31243",
        reasoning: { effort: "max" },
      });
      expect(
        (request.body.tools as Array<{ readonly name: string }>).map((tool) => {
          return tool.name;
        }),
      ).toStrictEqual(PI_MEMORY_PHASE2_TOOL_NAMES);
      expect(JSON.stringify(request.body)).not.toContain('"bash"');
      expect(JSON.stringify(request.body)).not.toContain('"memories_');
    }
    const firstRequest = provider.requests[0];
    if (!firstRequest) {
      throw new Error("Missing first Phase 2 provider request");
    }
    expect(firstRequest.headers["x-phase2-secret"]).toBe("HEADER_SECRET_31243");
    expect(
      (firstRequest.body.input as Array<Record<string, unknown>>)[0],
    ).toStrictEqual({
      role: "developer",
      content: `${renderPiMemoryPhase2Prompt()}\nCurrent working directory: /phase2-memory\n`,
    });

    const files = new Map(
      result.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString()];
      }),
    );
    expect(files.get(".git/config")).toBe("BASE_GIT_SECRET_31243");
    expect(files.get("legacy.md")).toBe("BASE_LEGACY_SECRET_31243");
    expect(files.get("raw_memories.md")).toBe("BASE_CODEX_RAW_SECRET_31243");
    expect(files.get("rollout_summaries/codex.md")).toBe(
      "BASE_CODEX_EVIDENCE_31243",
    );
    expect(
      [...files.keys()].some((path) => {
        return path.startsWith("rollout_summaries/pi/");
      }),
    ).toBe(true);
    expect([...files.keys()]).not.toContain("raw-memories.md");
    expect([...files.keys()]).not.toContain("workspace-diff.md");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);

    const contentSafePayloads = JSON.stringify({
      result: metadataWithoutContents(result),
    });
    for (const secret of [
      "RAW_STAGE1_SECRET_31243",
      "ROLLOUT_SUMMARY_SECRET_31243",
      "ROLLOUT_SLUG_SECRET_31243",
      "BASE_GIT_SECRET_31243",
      "BASE_LEGACY_SECRET_31243",
      "BASE_CODEX_RAW_SECRET_31243",
      "PROVIDER_KEY_SECRET_31243",
      "HEADER_SECRET_31243",
      "MODEL_TEXT_SECRET_31243",
      cleanupRoot,
    ]) {
      expect(contentSafePayloads).not.toContain(secret);
    }
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("snapshots mutable inputs before the first await", async () => {
    const provider = await startProvider([{ type: "text", text: "complete" }]);
    const bytes = Buffer.from("# Task Group: original\n");
    const candidate = selected();
    const headers: Record<string, string> = { "x-snapshot": "original" };
    const input = args(provider.baseUrl, {
      baseFiles: [
        {
          type: "file",
          path: "MEMORY.md",
          hash: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          bytes,
        },
        baseFile("memory_summary.md", "v1\n## User Profile\n"),
      ],
      selected: [candidate],
      model: {
        provider: "openai",
        baseUrl: provider.baseUrl,
        apiKey: "original-key",
        model: "gpt-5.6-terra",
        dialect: "openai-responses",
        transport: "sse",
        requestHeaders: headers,
      },
    });
    const promise = runPiMemoryPhase2LocalConsolidation(
      input,
      new AbortController().signal,
    );
    bytes.fill(120);
    headers["x-snapshot"] = "mutated";
    (candidate as { rawMemory: string }).rawMemory = "mutated raw";
    (candidate as { rolloutSummary: string }).rolloutSummary =
      "mutated summary";

    const result = await promise;
    expect(result.status).toBe("prepared");
    const files = new Map(
      result.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString()];
      }),
    );
    expect(files.get("MEMORY.md")).toBe("# Task Group: original\n");
    expect(
      [...files]
        .filter(([path]) => {
          return path.startsWith("rollout_summaries/pi/");
        })
        .map(([, content]) => {
          return content;
        })
        .join("\n"),
    ).toContain("ROLLOUT_SUMMARY_SECRET_31243");
    expect(provider.requests[0]?.headers["x-snapshot"]).toBe("original");
  });

  it("treats stale Pi evidence deletion with an empty selection as model work", async () => {
    const provider = await startProvider([
      { type: "text", text: "stale evidence removed" },
    ]);
    const input = args(provider.baseUrl, {
      selected: [],
      baseFiles: [
        baseFile("MEMORY.md", "# Task Group: prior\n"),
        baseFile("memory_summary.md", "v1\n## User Profile\n- prior\n"),
        baseFile("rollout_summaries/pi/stale.md", "stale"),
        baseFile("rollout_summaries/codex.md", "preserved"),
      ],
    });
    const result = await runPiMemoryPhase2LocalConsolidation(
      input,
      new AbortController().signal,
    );
    expect(provider.requests).toHaveLength(1);
    expect(result.status).toBe("prepared");
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).not.toContain("rollout_summaries/pi/stale.md");
    expect(
      result.files.map((file) => {
        return file.path;
      }),
    ).toContain("rollout_summaries/codex.md");
  });
  it("preserves bounded output validation diagnostics", async () => {
    const provider = await startProvider([{ type: "text", text: "done" }]);
    const input = args(provider.baseUrl, {
      baseFiles: [
        baseFile("MEMORY.md", "# Memory\n"),
        baseFile("memory_summary.md", `v1\n${" ".repeat(64 * 1024)}`),
      ],
      selected: [],
    });
    await expect(
      runPiMemoryPhase2LocalConsolidation(input, new AbortController().signal),
    ).rejects.toMatchObject({
      errorClass: "agent_output_invalid",
      diagnostic: {
        stage: "output_validation",
        reason: "summary_bytes",
        fileClass: "summary",
        actual: 65_539,
        limit: 65_536,
      },
    });
  });

  it("returns bounded failures with no partial result and always cleans staging", async () => {
    const cases: ReadonlyArray<{
      readonly steps: readonly ProviderStep[];
      readonly errorClass: PiMemoryPhase2EngineError["errorClass"];
      readonly diagnostic?: PiMemoryPhase2Diagnostic;
      readonly input?: Partial<PiMemoryPhase2LocalConsolidationArgs>;
    }> = [
      {
        steps: [{ type: "http-error" }],
        errorClass: "model_failed",
        diagnostic: {
          stage: "final_response",
          reason: "final_stop_error",
        },
        input: { baseFiles: [] },
      },
      {
        steps: [{ type: "incomplete", reason: "max_output_tokens" }],
        errorClass: "session_failed",
        diagnostic: {
          stage: "final_response",
          reason: "final_stop_length",
        },
        input: { baseFiles: [] },
      },
      {
        steps: [{ type: "incomplete", reason: "content_filter" }],
        errorClass: "model_failed",
        diagnostic: {
          stage: "final_response",
          reason: "final_stop_error",
        },
        input: { baseFiles: [] },
      },
      {
        steps: [{ type: "text", text: "finished without required files" }],
        errorClass: "agent_output_invalid",
        input: { baseFiles: [] },
      },
      {
        steps: [
          {
            type: "tool",
            name: "phase2_write",
            arguments: {
              path: "memory/.git/config",
              content: "FORBIDDEN_TOOL_WRITE_SECRET_31243",
            },
          },
          { type: "text", text: "stopped after rejected tool" },
        ],
        errorClass: "agent_output_invalid",
        input: { baseFiles: [] },
      },
    ];
    for (const testCase of cases) {
      const provider = await startProvider(testCase.steps);
      let cleanupRoot: string | undefined;
      await expectBoundedFailure(
        runPiMemoryPhase2LocalConsolidation(
          args(provider.baseUrl, testCase.input),
          new AbortController().signal,
          {
            async beforeCleanup(root) {
              cleanupRoot = root;
            },
          },
        ),
        testCase.errorClass,
        testCase.diagnostic,
      );
      await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("accepts a validated result without completion text or a response id", async () => {
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: silent completion\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/memory_summary.md",
          content: "v1\n## User Profile\n- silent completion\n",
        },
      },
      { type: "text", text: "", omitResponseId: true },
    ]);
    const result = await runPiMemoryPhase2LocalConsolidation(
      args(provider.baseUrl),
      new AbortController().signal,
    );

    expect(result.status).toBe("prepared");
    expect(result.responseId).toBeNull();
    expect(result.usage.output).toBeGreaterThan(0);
    const files = new Map(
      result.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString()];
      }),
    );
    expect(files.get("MEMORY.md")).toBe("# Task Group: silent completion\n");
    expect(files.get("memory_summary.md")).toBe(
      "v1\n## User Profile\n- silent completion\n",
    );
  });

  it("publishes a summary above the injection budget with its numeric feedback", async () => {
    // The production failures reported exactly 2943 exact o200k source tokens.
    const summary = `v1\n## User Profile\n${" token".repeat(2936)}`;
    expect(encode(summary).length).toBe(2943);
    const summaryBytes = Buffer.byteLength(summary);
    expect(summaryBytes).toBeLessThanOrEqual(64 * 1024);
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: larger consolidation\n",
        },
      },
      {
        type: "tool",
        name: "phase2_write",
        arguments: { path: "memory/memory_summary.md", content: summary },
      },
      { type: "text", text: "done" },
    ]);

    const result = await runPiMemoryPhase2LocalConsolidation(
      args(provider.baseUrl),
      new AbortController().signal,
    );

    expect(result.status).toBe("prepared");
    const published = result.files.find((file) => {
      return file.path === "memory_summary.md";
    });
    expect(published?.size).toBe(summaryBytes);
    expect(published?.bytes).toEqual(Buffer.from(summary, "utf8"));

    // The write feedback the model actually observed describes the whole
    // resulting summary, without ever repeating its content.
    expect(JSON.stringify(provider.requests.at(-1)?.body ?? {})).toContain(
      `written summary_bytes=${summaryBytes.toString()} summary_byte_limit=65536 summary_tokens=2943 summary_injection_target=2500`,
    );
  });

  it("attributes an unexpected engine failure to a bounded stage and errno", async () => {
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: unexpected\n",
        },
      },
      { type: "text", text: "done" },
    ]);

    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl),
        new AbortController().signal,
        {
          beforeOutputValidation() {
            return Promise.reject(
              Object.assign(new Error("PRIVATE_ENGINE_SECRET_33066"), {
                code: "ENOSPC",
              }),
            );
          },
        },
      ),
      "session_failed",
      { stage: "unknown", reason: "unexpected_error", errno: "ENOSPC" },
    );
  });

  it("rejects completed model output without the required files", async () => {
    const provider = await startProvider([
      { type: "text", text: "finished without required files" },
    ]);
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl, {
          baseFiles: [],
        }),
        new AbortController().signal,
      ),
      "agent_output_invalid",
    );
  });

  it("rejects a pre-aborted local job without contacting the provider", async () => {
    const provider = await startProvider([{ type: "text", text: "unused" }]);
    const controller = new AbortController();
    controller.abort(new Error("PRE_MODEL_ABORT_SECRET"));
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl),
        controller.signal,
      ),
      "aborted",
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("disposes a created session cancelled before its model invocation", async () => {
    const provider = await startProvider([{ type: "text", text: "unused" }]);
    const controller = new AbortController();
    let disposed = false;
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl),
        controller.signal,
        {
          onSessionCreated() {
            controller.abort(new Error("SESSION_CREATED_ABORT_SECRET"));
          },
          onSessionDisposed() {
            disposed = true;
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
      ),
      "aborted",
    );
    expect(provider.requests).toHaveLength(0);
    expect(disposed).toBe(true);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects cancellation after model completion wins arbitration", async () => {
    const provider = await startProvider([{ type: "text", text: "complete" }]);
    const controller = new AbortController();
    let disposed = false;
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl),
        controller.signal,
        {
          async afterModelCompletionSelected() {
            controller.abort(new Error("POST_MODEL_ABORT_SECRET"));
          },
          onSessionDisposed() {
            disposed = true;
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
      ),
      "aborted",
    );
    expect(provider.requests).toHaveLength(1);
    expect(disposed).toBe(true);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a validated result when cancellation arrives during cleanup", async () => {
    const controller = new AbortController();
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args("http://127.0.0.1:1/v1", { selected: [] }),
        controller.signal,
        {
          async beforeCleanup(root) {
            cleanupRoot = root;
            controller.abort(new Error("PRE_APPLICATION_ABORT_SECRET"));
          },
        },
      ),
      "aborted",
    );
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("observes post-model abort before output validation can succeed", async () => {
    const controller = new AbortController();
    const provider = await startProvider([
      { type: "text", text: "completed before validation abort" },
    ]);
    let disposedSessions = 0;
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl),
        controller.signal,
        {
          async beforeOutputValidation() {
            controller.abort(new Error("VALIDATION_ABORT_SECRET_31252"));
          },
          onSessionDisposed() {
            disposedSessions += 1;
          },
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
      ),
      "aborted",
    );

    expect(provider.requests).toHaveLength(1);
    expect(disposedSessions).toBe(1);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("aborts an active session immediately and discards late completion", async () => {
    const controller = new AbortController();
    const provider = await startProvider([
      {
        type: "hang",
        onRequest() {
          controller.abort(new Error("CALLER_ABORT_SECRET_31243"));
        },
      },
    ]);
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(
        args(provider.baseUrl, { baseFiles: [] }),
        controller.signal,
        {
          async beforeCleanup(root) {
            cleanupRoot = root;
          },
        },
      ),
      "aborted",
    );
    expect(provider.requests).toHaveLength(1);
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lets cleanup failure override an otherwise valid result", async () => {
    const input = args("http://127.0.0.1:1/v1", { selected: [] });
    let cleanupRoot: string | undefined;
    await expectBoundedFailure(
      runPiMemoryPhase2LocalConsolidation(input, new AbortController().signal, {
        async beforeCleanup(root) {
          cleanupRoot = root;
          throw new Error("CLEANUP_HOOK_SECRET_31243");
        },
      }),
      "cleanup_failed",
    );
    await expect(stat(cleanupRoot ?? "missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  async function maintenanceRequestBudget(
    priorContextTokens: number,
    catalogModel?: string,
  ): Promise<number> {
    const provider = await startProvider([
      {
        type: "tool",
        name: "phase2_write",
        arguments: {
          path: "memory/MEMORY.md",
          content: "# Task Group: maintenance budget\n",
        },
        usageTotalTokens: priorContextTokens,
      },
      { type: "text", text: "consolidated" },
    ]);
    const result = await runPiMemoryPhase2LocalConsolidation(
      args(provider.baseUrl, {}, catalogModel),
      new AbortController().signal,
    );
    expect(result.status).toBe("prepared");
    const next = provider.requests[1];
    if (!next) {
      throw new Error("Missing the Phase 2 request after the reported context");
    }
    expect(next.body).toMatchObject({ reasoning: { effort: "max" } });
    const budget = next.body.max_output_tokens;
    if (typeof budget !== "number") {
      throw new Error("Phase 2 request did not serialize an output ceiling");
    }
    return budget;
  }

  it("serializes the official output ceiling past the legacy context threshold", async () => {
    // The legacy catalog window collapses both of these to the Responses
    // adapter's 16-token floor, which ends the turn as `length`.
    expect(await maintenanceRequestBudget(270_000)).toBe(128_000);
    expect(await maintenanceRequestBudget(330_000)).toBe(128_000);
  });

  it("keeps the real context clamp active near the official window", async () => {
    const lower = await maintenanceRequestBudget(950_000);
    const higher = await maintenanceRequestBudget(950_001);
    expect(lower).toBeGreaterThan(16);
    expect(lower).toBeLessThan(128_000);
    expect(lower - higher).toBe(1);
  });

  it("scopes the correction to the one legacy catalog case", async () => {
    const config = args("http://127.0.0.1:1/v1").model;
    // Ordinary resolution keeps the catalog value before and after maintenance.
    expect(resolvePiAgentModel(config)?.contextWindow).toBe(272_000);
    // Precondition: the sibling model still carries the same stale catalog
    // window. If the catalog is corrected upstream this fails deliberately, so
    // the scope of the local correction is re-decided rather than drifting.
    expect(
      resolvePiAgentModel(
        args("http://127.0.0.1:1/v1", {}, "gpt-5.6-sol").model,
      )?.contextWindow,
    ).toBe(272_000);
    // The correction cannot lift a different catalog model on the same provider
    // and dialect, so its derived ceiling stays below the corrected one.
    const corrected = await maintenanceRequestBudget(270_000);
    const untouched = await maintenanceRequestBudget(270_000, "gpt-5.6-sol");
    expect(corrected).toBe(128_000);
    expect(untouched).toBeLessThan(corrected);
    const after = resolvePiAgentModel(config);
    expect(after?.contextWindow).toBe(272_000);
    expect(after?.maxTokens).toBe(128_000);
  });
});
