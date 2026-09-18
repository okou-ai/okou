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
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type ExtensionAPI,
  type ExtensionFactory,
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
  resolvePiApiMemoryRecall,
} from "./memory-recall-node";
import { createPiMemoryTools } from "./memory-tools-node";
import { resolvePiAgentModel } from "./model";
import {
  buildOkouHarnessSystemPrompt,
  type OkouHarnessToolPrompt,
} from "./okou-harness-prompt";
import {
  createPiPreheatedResourceLoader,
  piPreheatedResourceLoaderOptions,
} from "./resources";
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

async function createLangfuseDebugExtension(pi: ExtensionAPI): Promise<void> {
  try {
    if (
      !process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT?.trim() ||
      !process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN?.trim()
    ) {
      return;
    }
    const { default: langfuseObservabilityExtension } =
      await import("@langfuse/pi-observability-plugin");
    langfuseObservabilityExtension(pi);
  } catch {
    // Optional debug telemetry must not prevent the Pi runtime from starting.
  } finally {
    // The plugin captures relay authentication in its extension closure.
    // Remove temporary exporter settings before model or tool execution.
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT;
    delete process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN;
  }
}

function langfuseDebugExtensionFactories(
  enabled: boolean | undefined,
): ExtensionFactory[] {
  return enabled ? [createLangfuseDebugExtension] : [];
}

const PI_INTERMEDIATE_COMMENTARY_PROMPT = `## Intermediate commentary

As you work, provide brief intermediate text messages to the user. These messages are how you collaborate with the user while working - stating assumptions and sharing updates. Keep them concise and easy to scan. Their purpose is to make your work easy for the user to understand and verify.

If the user's request requires calling tools, start with a brief intermediate message before the first tool call. During longer work, provide additional updates at meaningful points.

Do not put a final response, such as a blocking or clarifying question, in an intermediate message. Intermediate messages are only for partial updates, partial results, or non-blocking context that can provide value while you continue working. An intermediate update does not end the task; continue working when more work remains. The final answer must always be fully self-contained.`;

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
  // A run captures its current effort before either API-first or Sandbox execution.
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
  readonly enableLangfuseObservability?: boolean;
}

type PiApiFirstAgentSessionRuntimeArgs = Omit<
  PiAgentSessionRuntimeArgs,
  "enableLangfuseObservability" | "memoryRecall" | "memoryRoot"
> & {
  readonly resourceSnapshot: PiPreheatedResourceSnapshot;
};

export async function createPiAgentSessionForRuntime(
  args: PiAgentSessionRuntimeArgs,
  signal?: AbortSignal,
) {
  return await createPiAgentSession(args, "generic", signal);
}

/** API-only entry: use frozen inputs without generic package discovery. */
export async function createPiApiFirstAgentSessionForRuntime(
  args: PiApiFirstAgentSessionRuntimeArgs,
  signal?: AbortSignal,
) {
  return await createPiAgentSession(args, "api-first", signal);
}

async function createPiAgentSession(
  args: PiAgentSessionRuntimeArgs,
  mode: "api-first" | "generic",
  signal?: AbortSignal,
) {
  const finishResources = startPiPreparationObservation(
    args.onPreparationTiming,
    "resources_prompt",
    signal,
  );
  let resourcesOutcome: "success" | "error" = "error";
  // Keep the existing synchronous/API and asynchronous/Sandbox preparation order.
  let prepared: ReturnType<typeof prepareModelAndPrompt>;
  let memoryRecall: Awaited<ReturnType<typeof loadPiSandboxMemoryRecall>>;
  try {
    initializePiSessionResourceRegistry();
    memoryRecall = args.resourceSnapshot
      ? resolvePiApiMemoryRecall(args.resourceSnapshot)
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
        ...(args.resourceSnapshot ||
        ["anthropic-messages", "bedrock-converse-stream"].includes(
          args.model.dialect,
        )
          ? { credentials: new InMemoryCredentialStore() }
          : {}),
      });
    },
    signal,
  );
  const resourceSnapshot = args.resourceSnapshot;
  const extensionFactories = langfuseDebugExtensionFactories(
    args.enableLangfuseObservability,
  );
  const services = await measurePiPreparation(
    args.onPreparationTiming,
    "session_services",
    () => {
      if (mode === "api-first") {
        if (!resourceSnapshot) {
          throw new Error("Pi API preparation requires a resource snapshot");
        }
        const settingsManager = SettingsManager.inMemory(
          {},
          { projectTrusted: true },
        );
        const resourceLoader = measurePiPreparationSync(
          args.onPreparationTiming,
          "resource_loader",
          () => {
            return createPiPreheatedResourceLoader({
              snapshot: resourceSnapshot,
              appendSystemPrompt,
              systemPrompt,
            });
          },
          signal,
        );
        const apiServices: AgentSessionServices = {
          cwd: args.cwd,
          agentDir: args.agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader,
          diagnostics: [],
        };
        return apiServices;
      }
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
        resourceLoaderOptions: resourceSnapshot
          ? measurePiPreparationSync(
              args.onPreparationTiming,
              "resource_loader",
              () => {
                return {
                  ...piPreheatedResourceLoaderOptions({
                    snapshot: resourceSnapshot,
                    appendSystemPrompt,
                    systemPrompt,
                  }),
                  extensionFactories,
                };
              },
              signal,
            )
          : { ...sandboxResourceLoaderOptions, extensionFactories },
      });
    },
    signal,
  );
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
          mode: args.resourceSnapshot ? "api-first" : "sandbox",
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
    PI_INTERMEDIATE_COMMENTARY_PROMPT,
    ...(args.appendSystemPrompt === null ? [] : [args.appendSystemPrompt]),
    ...(memoryRecall.block === null ? [] : [memoryRecall.block]),
  ];
  const systemPrompt = buildOkouHarnessSystemPrompt(
    okouHarnessToolPrompts(args.cwd),
  );
  const sandboxResourceLoaderOptions =
    args.appendSystemPrompt === null && memoryRecall.block === null
      ? {
          systemPrompt,
          appendSystemPromptOverride(base: string[]) {
            return [PI_INTERMEDIATE_COMMENTARY_PROMPT, ...base];
          },
        }
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
