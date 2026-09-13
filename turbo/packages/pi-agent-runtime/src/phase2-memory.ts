import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import {
  baseHasValidConsolidatedArtifacts,
  applyValidatedPiMemoryPhase2Result,
  createPiMemoryPhase2Workspace,
  mapsEqual,
  Phase2InputInvalidError,
  preparedSetFromSnapshot,
  removePiMemoryPhase2Workspace,
  snapshotPiMemoryPhase2Input,
  snapshotMountedPiMemoryPhase2Base,
  type Phase2PrivateWorkspace,
  type SnapshotPhase2Input,
  validatePiMemoryPhase2Output,
} from "./phase2-memory-filesystem";
import {
  Phase2OutputInvalidError,
  phase2DiagnosticForError,
  phase2StageDiagnostic,
  type PiMemoryPhase2Diagnostic,
} from "./phase2-memory-diagnostics";
import { renderPiMemoryPhase2Prompt } from "./phase2-memory-prompt";
import {
  createPiMemoryPhase2Tools,
  PI_MEMORY_PHASE2_TOOL_NAMES,
  type Phase2MemoryToolTestHooks,
} from "./phase2-memory-tools";
import {
  PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2LocalConsolidationArgs,
  type PiMemoryPhase2ConsolidationResult,
  type PiMemoryPhase2FailureClass,
  type PiMemoryPhase2FailureCounts,
  type PiMemoryPhase2ProviderUsage,
} from "./phase2-memory-types";
import { resolvePiAgentModel } from "./model";
import {
  createPiModelRuntime,
  initializePiSessionResourceRegistry,
} from "./session-model";

const ZERO_USAGE: PiMemoryPhase2ProviderUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});
const PI_MEMORY_PHASE2_SESSION_CWD = "/phase2-memory";

interface Phase2RuntimeState {
  fileCount: number;
  totalBytes: number;
}

interface Phase2ProviderResult {
  /** Provider evidence only: no Phase 2 outcome depends on its presence. */
  readonly responseId: string | null;
  readonly usage: PiMemoryPhase2ProviderUsage;
}

/**
 * Stop reasons that leave the maintenance turn truncated or undecided. These
 * still fail; only the recorded reason becomes attributable. Keyed by string so
 * the table stays valid against the pinned runtime's own stop-reason union.
 */
const INCOMPLETE_STOP_REASONS: Readonly<
  Record<string, PiMemoryPhase2Diagnostic["reason"]>
> = {
  length: "final_stop_length",
  toolUse: "final_stop_tool_use",
  pending: "final_stop_pending",
};

type Phase2ModelTerminal = Readonly<{
  source: "model";
  status: "completed" | "failed";
}>;

type Phase2CallerTerminal = Readonly<{
  source: "caller";
  status: "aborted" | "disposed";
}>;

type Phase2Terminal = Phase2ModelTerminal | Phase2CallerTerminal;

interface Phase2TerminalSettlement {
  readonly model: Phase2ModelTerminal;
  readonly caller: Phase2CallerTerminal;
}

interface Phase2TerminalArbiter {
  readonly selected: Promise<Phase2Terminal>;
  settle(): Promise<Phase2TerminalSettlement>;
}

interface Phase2CapturedFailure {
  readonly error: unknown;
}

interface PiMemoryPhase2SessionSnapshot {
  readonly toolNames: readonly string[];
  readonly thinkingLevel: string;
  readonly sessionFile: string | undefined;
  readonly extensions: number;
  readonly skills: number;
  readonly prompts: number;
  readonly themes: number;
  readonly agentsFiles: number;
  readonly appendSystemPrompts: number;
  readonly systemPromptDigest: string;
}

interface PiMemoryPhase2EngineTestHooks {
  readonly onSessionCreated?: (snapshot: PiMemoryPhase2SessionSnapshot) => void;
  readonly beforeOutputValidation?: (
    workspace: Phase2PrivateWorkspace,
  ) => Promise<void>;
  readonly afterModelCompletionSelected?: () => Promise<void>;
  readonly onSessionDisposed?: () => void;
  readonly beforeCleanup?: (root: string) => Promise<void>;
  readonly tools?: Phase2MemoryToolTestHooks;
}

function failureCounts(
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
): PiMemoryPhase2FailureCounts {
  return {
    candidateCount: input?.selected.length ?? 0,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
  };
}

function engineError(
  errorClass: PiMemoryPhase2FailureClass,
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
  diagnostic?: PiMemoryPhase2Diagnostic,
): PiMemoryPhase2EngineError {
  return new PiMemoryPhase2EngineError(
    errorClass,
    failureCounts(input, state),
    diagnostic,
  );
}

function abortPromise(signal: AbortSignal): {
  readonly promise: Promise<"aborted" | "disposed">;
  dispose(): void;
} {
  let listener: (() => void) | undefined;
  let resolvePromise: ((status: "aborted" | "disposed") => void) | undefined;
  let settled = false;
  const promise = new Promise<"aborted" | "disposed">((resolve) => {
    resolvePromise = resolve;
    if (signal.aborted) {
      settled = true;
      resolve("aborted");
      return;
    }
    listener = () => {
      settled = true;
      resolve("aborted");
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) {
        signal.removeEventListener("abort", listener);
      }
      if (!settled) {
        settled = true;
        resolvePromise?.("disposed");
      }
    },
  };
}

function createTerminalArbiter(args: {
  readonly session: AgentSession;
  readonly input: SnapshotPhase2Input;
}): Phase2TerminalArbiter {
  const model = args.session
    .prompt("Consolidate the private Pi memory inputs now.", {
      expandPromptTemplates: false,
      source: "interactive",
    })
    .then(
      (): Phase2ModelTerminal => {
        return { source: "model", status: "completed" };
      },
      (): Phase2ModelTerminal => {
        return { source: "model", status: "failed" };
      },
    );
  const callerAbort = abortPromise(args.input.signal);
  const caller = callerAbort.promise.then<Phase2CallerTerminal>((status) => {
    return { source: "caller", status };
  });
  return {
    selected: Promise.race([model, caller]),
    async settle() {
      callerAbort.dispose();
      const [modelResult, callerResult] = await Promise.all([model, caller]);
      return {
        model: modelResult,
        caller: callerResult,
      };
    },
  };
}

function terminalFailure(
  terminal: Phase2Terminal,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Phase2CapturedFailure | undefined {
  switch (terminal.source) {
    case "model": {
      return terminal.status === "failed"
        ? {
            error: engineError(
              "model_failed",
              input,
              state,
              phase2StageDiagnostic("model_turn", "model_turn_failed"),
            ),
          }
        : undefined;
    }
    case "caller": {
      return {
        error:
          terminal.status === "aborted"
            ? engineError("aborted", input, state)
            : engineError(
                "session_failed",
                input,
                state,
                phase2StageDiagnostic("model_turn", "caller_disposed"),
              ),
      };
    }
  }
}

function settlementFailure(
  settlement: Phase2TerminalSettlement,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Phase2CapturedFailure | undefined {
  if (settlement.caller.status === "aborted") {
    return { error: engineError("aborted", input, state) };
  }
  if (settlement.model.status === "failed") {
    return {
      error: engineError(
        "model_failed",
        input,
        state,
        phase2StageDiagnostic("model_turn", "model_turn_failed"),
      ),
    };
  }
  return undefined;
}

/**
 * Best-effort teardown for an already-decided failure. A failing abort must not
 * replace the decided cause with a generic session failure.
 */
async function abortMaintenanceSession(session: AgentSession): Promise<void> {
  try {
    await session.abort();
  } catch {
    // The decided failure stays authoritative; teardown adds no new cause.
  }
}

async function runMaintenancePrompt(args: {
  readonly session: AgentSession;
  readonly input: SnapshotPhase2Input;
  readonly state: Phase2RuntimeState;
  readonly testHooks: PiMemoryPhase2EngineTestHooks | undefined;
}): Promise<Phase2ProviderResult> {
  let arbiter: Phase2TerminalArbiter | undefined;
  let failure: Phase2CapturedFailure | undefined;
  let provider: Phase2ProviderResult | undefined;
  try {
    args.input.signal.throwIfAborted();
    arbiter = createTerminalArbiter(args);
    const terminal = await arbiter.selected;
    failure = args.input.signal.aborted
      ? { error: engineError("aborted", args.input, args.state) }
      : terminalFailure(terminal, args.input, args.state);
    if (!failure) {
      await args.testHooks?.afterModelCompletionSelected?.();
      args.input.signal.throwIfAborted();
      provider = providerResult(args.session, args.input, args.state);
    }
  } catch (error) {
    failure = { error };
  }

  if (failure && arbiter) {
    await abortMaintenanceSession(args.session);
  }
  args.session.dispose();
  const settlement = arbiter ? await arbiter.settle() : undefined;
  args.testHooks?.onSessionDisposed?.();

  if (!failure && settlement) {
    failure = settlementFailure(settlement, args.input, args.state);
  }

  if (failure) {
    throw failure.error;
  }
  args.input.signal.throwIfAborted();
  if (!provider) {
    throw engineError(
      "session_failed",
      args.input,
      args.state,
      phase2StageDiagnostic("final_response", "provider_result_missing"),
    );
  }
  return provider;
}

function finalAssistantMessages(session: AgentSession): AssistantMessage[] {
  return session.agent.state.messages.flatMap((message) => {
    return message.role === "assistant" ? [message] : [];
  });
}

function providerResult(
  session: AgentSession,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Phase2ProviderResult {
  const messages = finalAssistantMessages(session);
  const final = messages.at(-1);
  if (!final) {
    throw engineError(
      "session_failed",
      input,
      state,
      phase2StageDiagnostic("final_response", "final_message_missing"),
    );
  }
  if (final.stopReason === "error") {
    throw engineError(
      "model_failed",
      input,
      state,
      phase2StageDiagnostic("final_response", "final_stop_error"),
    );
  }
  if (final.stopReason === "aborted") {
    throw engineError(
      "aborted",
      input,
      state,
      phase2StageDiagnostic("final_response", "final_stop_aborted"),
    );
  }
  if (final.stopReason !== "stop") {
    throw engineError(
      "session_failed",
      input,
      state,
      phase2StageDiagnostic(
        "final_response",
        INCOMPLETE_STOP_REASONS[final.stopReason] ?? "unknown",
      ),
    );
  }
  const usage = messages.reduce<PiMemoryPhase2ProviderUsage>(
    (total, message) => {
      return {
        input: total.input + message.usage.input,
        output: total.output + message.usage.output,
        cacheRead: total.cacheRead + message.usage.cacheRead,
        cacheWrite: total.cacheWrite + message.usage.cacheWrite,
        reasoning: total.reasoning + (message.usage.reasoning ?? 0),
      };
    },
    ZERO_USAGE,
  );
  return { responseId: final.responseId ?? null, usage: Object.freeze(usage) };
}

type ResolvedPiAgentModel = NonNullable<ReturnType<typeof resolvePiAgentModel>>;

/**
 * The legacy catalog case this narrow maintenance correction adapts.
 *
 * The pinned catalog publishes `openai` / `gpt-5.6-terra` / `openai-responses`
 * with a 272000 context window. 272000 is that model's long-context pricing
 * threshold, above which the stated multipliers apply to the full request; the
 * official specification states 1050000 context tokens and 128000 maximum
 * output tokens: https://developers.openai.com/api/docs/models/gpt-5.6-terra
 */
const PI_MEMORY_PHASE2_LEGACY_CONTEXT_PROVIDER = "openai";
const PI_MEMORY_PHASE2_LEGACY_CONTEXT_API = "openai-responses";
const PI_MEMORY_PHASE2_LEGACY_CONTEXT_CATALOG_MODEL = "gpt-5.6-terra";
const PI_MEMORY_PHASE2_LEGACY_CONTEXT_WINDOW = 272_000;
const PI_MEMORY_PHASE2_OFFICIAL_CONTEXT_WINDOW = 1_050_000;

/**
 * Return the maintenance model with the stale catalog context window corrected.
 *
 * `buildBaseOptions` derives each request's output ceiling by subtracting the
 * estimated context from `contextWindow`, so the pricing threshold above caps a
 * long consolidation turn at the Responses adapter's minimum output budget. The
 * turn then ends as `length`, which Phase 2 correctly refuses to publish.
 *
 * This adapts only that one legacy case, only for maintenance, and only as an
 * immutable copy: the shared catalog object is never mutated, ordinary
 * resolution is untouched, and a value that is already corrected or otherwise
 * different is returned unchanged so newer metadata is never capped. Model
 * identity, provider, route, credentials, headers, tier, transport, reasoning
 * policy, `maxTokens` and pricing all stay exactly as resolved.
 *
 * Remove this correction once the pinned catalog publishes the official window:
 * the guard then stops matching, so it is inert rather than wrong. The catalog
 * identity is matched here instead of the caller's product model id because the
 * stale value belongs to that catalog entry, not to Okou's model selection.
 */
function maintenanceModelWithOfficialContextWindow(
  model: ResolvedPiAgentModel,
  config: SnapshotPhase2Input["model"],
): ResolvedPiAgentModel {
  if (
    model.provider !== PI_MEMORY_PHASE2_LEGACY_CONTEXT_PROVIDER ||
    model.api !== PI_MEMORY_PHASE2_LEGACY_CONTEXT_API ||
    (config.catalogModel ?? config.model) !==
      PI_MEMORY_PHASE2_LEGACY_CONTEXT_CATALOG_MODEL ||
    model.contextWindow !== PI_MEMORY_PHASE2_LEGACY_CONTEXT_WINDOW
  ) {
    return model;
  }
  return {
    ...model,
    contextWindow: PI_MEMORY_PHASE2_OFFICIAL_CONTEXT_WINDOW,
  };
}

async function createMaintenanceSession(args: {
  readonly input: SnapshotPhase2Input;
  readonly workspace: Phase2PrivateWorkspace;
  readonly prompt: string;
  readonly testHooks: PiMemoryPhase2EngineTestHooks | undefined;
}): Promise<AgentSession> {
  initializePiSessionResourceRegistry();
  const resolved = resolvePiAgentModel(args.input.model);
  if (!resolved) {
    throw new Phase2InputInvalidError();
  }
  // One corrected model object reaches both provider registration and the real
  // session, so the adapter cannot receive the stale window.
  const model = maintenanceModelWithOfficialContextWindow(
    resolved,
    args.input.model,
  );
  const modelRuntime = await createPiModelRuntime(
    {
      model,
      config: args.input.model,
      credentials: new InMemoryCredentialStore(),
    },
    args.input.signal,
  );
  const services = await createAgentSessionServices({
    cwd: PI_MEMORY_PHASE2_SESSION_CWD,
    agentDir: join(PI_MEMORY_PHASE2_SESSION_CWD, "agent"),
    modelRuntime,
    modelRuntimeSignal: args.input.signal,
    settingsManager: SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: false },
      },
      { projectTrusted: true },
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: args.prompt,
      skillsOverride: () => {
        return { skills: [], diagnostics: [] };
      },
      promptsOverride: () => {
        return { prompts: [], diagnostics: [] };
      },
      themesOverride: () => {
        return { themes: [], diagnostics: [] };
      },
      agentsFilesOverride: () => {
        return { agentsFiles: [] };
      },
      appendSystemPromptOverride: () => {
        return [];
      },
    },
  });
  const customTools = createPiMemoryPhase2Tools({
    memoryRoot: args.workspace.memoryRoot,
    inputsRoot: args.workspace.inputsRoot,
    testHooks: args.testHooks?.tools,
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(PI_MEMORY_PHASE2_SESSION_CWD, {
      id: randomUUID(),
    }),
    model,
    thinkingLevel: PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
    tools: [...PI_MEMORY_PHASE2_TOOL_NAMES],
    customTools,
  });
  const resources = created.session.resourceLoader;
  const expectedSystemPrompt = `${args.prompt}\nCurrent working directory: ${PI_MEMORY_PHASE2_SESSION_CWD}\n`;
  if (created.session.systemPrompt !== expectedSystemPrompt) {
    created.session.dispose();
    throw new Error("Phase 2 session system prompt mismatch");
  }
  const systemPromptDigest = createHash("sha256")
    .update(created.session.systemPrompt, "utf8")
    .digest("hex");
  args.testHooks?.onSessionCreated?.({
    toolNames: created.session.agent.state.tools.map((tool) => {
      return tool.name;
    }),
    thinkingLevel: created.session.thinkingLevel,
    sessionFile: created.session.sessionFile,
    extensions: resources.getExtensions().extensions.length,
    skills: resources.getSkills().skills.length,
    prompts: resources.getPrompts().prompts.length,
    themes: resources.getThemes().themes.length,
    agentsFiles: resources.getAgentsFiles().agentsFiles.length,
    appendSystemPrompts: resources.getAppendSystemPrompt().length,
    systemPromptDigest,
  });
  return created.session;
}

function normalizeFailure(
  error: unknown,
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
  signal: AbortSignal,
): PiMemoryPhase2EngineError {
  if (error instanceof PiMemoryPhase2EngineError) {
    return error;
  }
  if (error instanceof Phase2InputInvalidError) {
    return engineError("input_invalid", input, state);
  }
  if (error instanceof Phase2OutputInvalidError) {
    return new PiMemoryPhase2EngineError(
      "agent_output_invalid",
      failureCounts(input, state),
      error.diagnostic,
    );
  }
  if (input === null) {
    return engineError("input_invalid", input, state);
  }
  if (signal?.aborted) {
    return engineError("aborted", input, state);
  }
  return engineError(
    "session_failed",
    input,
    state,
    phase2StageDiagnostic("unknown", "unexpected_error", error),
  );
}

async function executeConsolidation(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  root: string,
  testHooks: PiMemoryPhase2EngineTestHooks | undefined,
  signal: AbortSignal,
): Promise<PiMemoryPhase2ConsolidationResult> {
  signal.throwIfAborted();
  let prompt: string;
  try {
    prompt = renderPiMemoryPhase2Prompt();
  } catch {
    throw engineError("prompt_invariant", input, state);
  }
  let workspace: Phase2PrivateWorkspace;
  try {
    workspace = await createPiMemoryPhase2Workspace(root, input);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Phase2InputInvalidError) {
      throw error;
    }
    throw engineError(
      "session_failed",
      input,
      state,
      phase2StageDiagnostic("workspace_stage", "workspace_stage_failed", error),
    );
  }
  state.fileCount = workspace.agentBaseline.size;
  state.totalBytes = [...workspace.agentBaseline.values()].reduce(
    (sum, content) => {
      return sum + content.length;
    },
    0,
  );
  signal.throwIfAborted();

  if (
    mapsEqual(workspace.base, workspace.agentBaseline) &&
    baseHasValidConsolidatedArtifacts(workspace.base)
  ) {
    const prepared = preparedSetFromSnapshot(
      input.memoryStorageId,
      workspace.base,
    );
    signal.throwIfAborted();
    return Object.freeze({
      status: "no_diff",
      ...prepared,
      diff: workspace.diff,
      selectionDigest: input.selectionDigest,
      responseId: null,
      usage: ZERO_USAGE,
    });
  }

  let session: AgentSession;
  try {
    session = await createMaintenanceSession({
      input,
      workspace,
      prompt,
      testHooks,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Phase2InputInvalidError) {
      throw error;
    }
    throw engineError(
      "session_failed",
      input,
      state,
      phase2StageDiagnostic("session_create", "session_create_failed", error),
    );
  }
  const provider = await runMaintenancePrompt({
    session,
    input,
    state,
    testHooks,
  });
  signal.throwIfAborted();
  await testHooks?.beforeOutputValidation?.(workspace);
  signal.throwIfAborted();
  let prepared: Awaited<ReturnType<typeof validatePiMemoryPhase2Output>>;
  try {
    prepared = await validatePiMemoryPhase2Output(
      workspace,
      input.memoryStorageId,
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  signal.throwIfAborted();
  state.fileCount = prepared.manifest.fileCount;
  state.totalBytes = prepared.manifest.totalBytes;
  return Object.freeze({
    status: "prepared",
    ...prepared,
    diff: workspace.diff,
    selectionDigest: input.selectionDigest,
    responseId: provider.responseId,
    usage: provider.usage,
  });
}

/** Prepare owned local bytes; the mounted boundary owns application and checkpoint identity. */
export async function runPiMemoryPhase2LocalConsolidation(
  args: PiMemoryPhase2LocalConsolidationArgs,
  signal: AbortSignal,
  testHooks?: PiMemoryPhase2EngineTestHooks,
): Promise<PiMemoryPhase2ConsolidationResult> {
  const state: Phase2RuntimeState = {
    fileCount: 0,
    totalBytes: 0,
  };
  let input: SnapshotPhase2Input | null = null;
  let root: string | null = null;
  let result: PiMemoryPhase2ConsolidationResult | undefined;
  let failure: PiMemoryPhase2EngineError | undefined;
  try {
    input = snapshotPiMemoryPhase2Input(args, signal);
    state.fileCount = input.baseFiles.length;
    state.totalBytes = input.baseTotalBytes;
    signal.throwIfAborted();
    root = await mkdtemp(join(tmpdir(), "pi-memory-phase2-"));
    result = await executeConsolidation(input, state, root, testHooks, signal);
  } catch (error) {
    failure = normalizeFailure(error, input, state, signal);
  }

  if (root !== null) {
    let cleanupHookFailed = false;
    try {
      await testHooks?.beforeCleanup?.(root);
    } catch {
      cleanupHookFailed = true;
    }
    try {
      await removePiMemoryPhase2Workspace(root);
    } catch {
      cleanupHookFailed = true;
    }
    if (cleanupHookFailed) {
      failure = engineError("cleanup_failed", input, state);
    }
  }

  if (!failure && signal.aborted) {
    failure = engineError("aborted", input, state);
  }

  if (failure) {
    throw failure;
  }
  if (!result) {
    const missing = engineError(
      "session_failed",
      input,
      state,
      phase2StageDiagnostic("commit", "result_missing"),
    );
    throw missing;
  }
  return result;
}

export interface PiMemoryPhase2MountedConsolidationArgs {
  readonly memoryRoot: string;
  readonly memoryStorageId: string;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
  readonly selected: readonly PiMemoryPhase2LocalConsolidationArgs["selected"][number][];
  readonly model: PiMemoryPhase2LocalConsolidationArgs["model"];
}

/**
 * Run Phase 2 from the exact mounted Storage epoch and apply only a fully
 * validated result back to that mount. Durable publication remains owned by
 * the ordinary terminal artifact checkpoint.
 */
export async function runPiMemoryPhase2MountedConsolidation(
  args: PiMemoryPhase2MountedConsolidationArgs,
  signal: AbortSignal,
): Promise<{
  readonly status: "no_diff" | "prepared";
  readonly validatedVersionId: string;
}> {
  const baseFiles = await snapshotMountedPiMemoryPhase2Base(args.memoryRoot);
  const mountedBaseVersionId = createHash("sha256")
    .update(
      `storage:${args.memoryStorageId}\n${baseFiles
        .map((file) => {
          return `${file.path}:${file.hash}`;
        })
        .sort()
        .join("\n")}`,
    )
    .digest("hex");
  if (mountedBaseVersionId !== args.claimedBaseVersionId) {
    throw new PiMemoryPhase2EngineError("input_invalid", {
      candidateCount: args.selected.length,
      fileCount: baseFiles.length,
      totalBytes: baseFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
    });
  }
  const result = await runPiMemoryPhase2LocalConsolidation(
    {
      memoryStorageId: args.memoryStorageId,
      baseFiles,
      selected: args.selected,
      model: args.model,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.selectionDigest !== args.selectionDigest) {
    throw new PiMemoryPhase2EngineError("input_invalid", {
      candidateCount: args.selected.length,
      fileCount: baseFiles.length,
      totalBytes: baseFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
    });
  }
  try {
    await applyValidatedPiMemoryPhase2Result({
      memoryRoot: args.memoryRoot,
      memoryStorageId: args.memoryStorageId,
      baseFiles,
      files: result.files,
      contentIdentity: result.contentIdentity,
    });
  } catch (error) {
    throw new PiMemoryPhase2EngineError(
      "agent_output_invalid",
      {
        candidateCount: args.selected.length,
        fileCount: result.manifest.fileCount,
        totalBytes: result.manifest.totalBytes,
      },
      phase2DiagnosticForError(error, "mounted_apply"),
    );
  }
  signal.throwIfAborted();
  return {
    status: result.status,
    validatedVersionId: result.contentIdentity,
  };
}
