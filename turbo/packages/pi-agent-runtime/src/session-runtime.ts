import {
  InMemoryCredentialStore,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SettingsManager,
  type CreateAgentSessionFromServicesOptions,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
  PiMemoryToolSourceUse,
  PiPreheatedResourceSnapshot,
} from "./api-types";
import {
  loadPiSandboxMemoryRecall,
  resolvePiPreheatedMemoryRecall,
} from "./memory-recall-node";
import { createPiMemoryTools } from "./memory-tools-node";
import { resolvePiAgentModel } from "./model";
import {
  buildOkouHarnessSystemPrompt,
  type OkouHarnessToolPrompt,
} from "./okou-harness-prompt";
import { piPreheatedResourceLoaderOptions } from "./resources";
import {
  createPiModelRuntime,
  initializePiSessionResourceRegistry,
} from "./session-model";
import type { PiAgentModelConfig } from "./types";
import {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
  type PiPreparationObserver,
} from "./preparation-timing";

/**
 * Shell options for the loop's Bash tool.
 *
 * `exposeSessionEnvironment` stays off so the child shell inherits no `PI_*`
 * session variables and the tool contributes no guideline pointing at them.
 * The guest injects its own run identifiers separately.
 */
const PI_BASH_TOOL_OPTIONS = {
  shellPath: "/usr/local/bin/guest-tool-exec",
  exposeSessionEnvironment: false,
} as const;

/**
 * Tools the official session activates by default. Custom tools stay out of
 * the base prompt's tool sections because they carry no prompt snippet.
 */
function okouHarnessToolPrompts(cwd: string): OkouHarnessToolPrompt[] {
  return [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd, PI_BASH_TOOL_OPTIONS),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
  ].map((definition) => {
    return {
      name: definition.name,
      snippet: definition.promptSnippet,
      guidelines: definition.promptGuidelines,
    };
  });
}

function configuredThinkingLevel(
  sessionManager: SessionManager,
  configured: ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  // A run captures its current effort before Sandbox execution.
  if (configured !== undefined) return configured;
  const hasThinkingEntry = sessionManager.getBranch().some((entry) => {
    return entry.type === "thinking_level_change";
  });
  if (!hasThinkingEntry) {
    return configured;
  }
  const existing = sessionManager.buildSessionContext().thinkingLevel;
  switch (existing) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return existing;
    }
    default: {
      throw new Error(`Unsupported Pi session thinking level: ${existing}`);
    }
  }
}

function recordConfiguredThinkingLevel(
  sessionManager: SessionManager,
  configured: ModelThinkingLevel | undefined,
  effective: ModelThinkingLevel,
): void {
  // The SDK restores messages but does not record a changed launch effort on an
  // existing branch. Persist the effective level before a handoff/checkpoint.
  if (
    configured !== undefined &&
    sessionManager.buildSessionContext().thinkingLevel !== effective
  ) {
    sessionManager.appendThinkingLevelChange(effective);
  }
}

interface PiAgentSessionRuntimeArgs {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManager;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly memoryRoot?: string;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly sessionStartEvent?: CreateAgentSessionFromServicesOptions["sessionStartEvent"];
}

export async function createPiAgentSessionForRuntime(
  args: PiAgentSessionRuntimeArgs,
  signal?: AbortSignal,
) {
  const finishResources = startPiPreparationObservation(
    args.onPreparationTiming,
    "resources_prompt",
    signal,
  );
  let resourcesOutcome: "success" | "error" = "error";
  // Resolve frozen inputs before constructing the model and tool registry.
  let prepared: ReturnType<typeof prepareModelAndPrompt>;
  let memoryRecall: Awaited<ReturnType<typeof loadPiSandboxMemoryRecall>>;
  try {
    initializePiSessionResourceRegistry();
    memoryRecall = args.resourceSnapshot
      ? resolvePiPreheatedMemoryRecall(args.resourceSnapshot)
      : await loadPiSandboxMemoryRecall(args.memoryRecall, args.memoryRoot);
    args.onMemoryRecallOutcome?.(memoryRecall.outcome);
    prepared = prepareModelAndPrompt(args, memoryRecall);
    resourcesOutcome = "success";
  } finally {
    finishResources(resourcesOutcome);
  }
  const {
    memoryTools,
    appendSystemPrompt,
    systemPrompt,
    sandboxResourceLoaderOptions,
    model,
  } = prepared;

  const modelRuntime = await measurePiPreparation(
    args.onPreparationTiming,
    "model_runtime",
    () => {
      return createPiModelRuntime({
        model,
        config: args.model,
        ...(args.resourceSnapshot
          ? { credentials: new InMemoryCredentialStore() }
          : {}),
      });
    },
    signal,
  );
  const resourceSnapshot = args.resourceSnapshot;
  const services = await measurePiPreparation(
    args.onPreparationTiming,
    "session_services",
    () => {
      return createAgentSessionServices({
        cwd: args.cwd,
        agentDir: args.agentDir,
        modelRuntime,
        ...(resourceSnapshot
          ? {
              settingsManager: SettingsManager.inMemory(
                {},
                { projectTrusted: true },
              ),
            }
          : {}),
        // Both branches are measured so the preheated and sandbox loaders are
        // comparable under one phase. This observes loader *option* assembly,
        // which is all either branch does here; upstream discovery and loading
        // happen inside `session_services` and `session_create`.
        resourceLoaderOptions: measurePiPreparationSync(
          args.onPreparationTiming,
          "resource_loader",
          () => {
            return resourceSnapshot
              ? piPreheatedResourceLoaderOptions({
                  snapshot: resourceSnapshot,
                  appendSystemPrompt,
                  systemPrompt,
                })
              : sandboxResourceLoaderOptions;
          },
          signal,
        ),
      });
    },
    signal,
  );
  // 0.86 resolves an unset `cacheWarming` to `streaming`, so a long tool run
  // would issue background prompt-cache requests we do not pay for. Pin it off
  // for every path here, including the no-snapshot fallback that loads settings
  // from disk. `getCacheWarmingMode()` reads global settings only, which
  // `applyOverrides()` does not reach, so this setter is the effective one; it
  // updates the resolved value without persisting the choice to any disk file.
  services.settingsManager.setCacheWarmingMode("off");
  const created = await measurePiPreparation(
    args.onPreparationTiming,
    "session_create",
    () => {
      return createAgentSessionFromServices({
        services,
        sessionManager: args.sessionManager,
        sessionStartEvent: args.sessionStartEvent,
        model,
        thinkingLevel: configuredThinkingLevel(
          args.sessionManager,
          args.model.thinkingLevel,
        ),
        customTools: [
          createBashTool(args.cwd, PI_BASH_TOOL_OPTIONS),
          ...memoryTools,
        ],
      });
    },
    signal,
  );
  measurePiPreparationSync(
    args.onPreparationTiming,
    "session_finalize",
    () => {
      return recordConfiguredThinkingLevel(
        args.sessionManager,
        args.model.thinkingLevel,
        created.session.thinkingLevel,
      );
    },
    signal,
  );
  return { ...created, services, model };
}

function prepareModelAndPrompt(
  args: PiAgentSessionRuntimeArgs,
  memoryRecall: Awaited<ReturnType<typeof loadPiSandboxMemoryRecall>>,
) {
  const memorySelection = args.resourceSnapshot
    ? args.resourceSnapshot.schemaVersion === 2
      ? args.resourceSnapshot.memoryRecall
      : undefined
    : args.memoryRecall;
  const memoryTools =
    memorySelection !== undefined &&
    (memoryRecall.outcome.parity === "frozen-match" ||
      memoryRecall.outcome.parity === "frozen-no-content")
      ? createPiMemoryTools({
          selection: memorySelection,
          ...(args.memoryRoot === undefined
            ? {}
            : { memoryRoot: args.memoryRoot }),
          ...(args.onMemoryToolSourceUse === undefined
            ? {}
            : { onSourceUse: args.onMemoryToolSourceUse }),
        })
      : [];
  const appendSystemPrompt = [
    ...(args.appendSystemPrompt === null ? [] : [args.appendSystemPrompt]),
    ...(memoryRecall.block === null ? [] : [memoryRecall.block]),
  ];
  const systemPrompt = buildOkouHarnessSystemPrompt(
    okouHarnessToolPrompts(args.cwd),
  );
  // Passing `appendSystemPrompt` at all replaces the official loader's own
  // append-block discovery, so an empty array must omit the key entirely or a
  // Sandbox session silently stops loading its APPEND_SYSTEM.md.
  const sandboxResourceLoaderOptions =
    appendSystemPrompt.length === 0
      ? { systemPrompt }
      : { systemPrompt, appendSystemPrompt };
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new Error(
      `Pi provider ${args.model.provider} does not catalog model ${args.model.model}`,
    );
  }

  return {
    memoryTools,
    appendSystemPrompt,
    systemPrompt,
    sandboxResourceLoaderOptions,
    model,
  };
}
