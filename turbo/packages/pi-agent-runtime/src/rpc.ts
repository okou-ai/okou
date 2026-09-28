import { readFileSync } from "node:fs";

import type { PiLangfuseParent } from "@okouai/api-contracts/contracts/runners";
import {
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import {
  parseValidatedPiSessionJsonl,
  validatePiSessionEntries,
} from "./session-validation";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiPreheatedResourceSnapshot,
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
  PiMemoryToolSourceUse,
} from "./api-types";
import type { PiPreparationObserver } from "./preparation-timing";
import type { PiAgentModelConfig } from "./types";

export interface PiLangfuseRuntimeConfig {
  readonly relay: { readonly endpoint: string; readonly token: string };
  readonly userId?: string;
  readonly environment?: string;
}

const LANGFUSE_RUNTIME_ENVIRONMENT = {
  traceId: "LANGFUSE_PI_PARENT_TRACE_ID",
  spanId: "LANGFUSE_PI_PARENT_SPAN_ID",
  sessionId: "LANGFUSE_PI_PARENT_SESSION_ID",
  depth: "LANGFUSE_PI_PARENT_DEPTH",
  sandboxWaitStartedAt: "OKOU_PI_LANGFUSE_SANDBOX_WAIT_STARTED_AT",
} as const;

const LANGFUSE_CONFIG_ENVIRONMENT = {
  publicKey: "LANGFUSE_PUBLIC_KEY",
  secretKey: "LANGFUSE_SECRET_KEY",
  baseUrl: "LANGFUSE_BASE_URL",
  userId: "LANGFUSE_USER_ID",
  environment: "LANGFUSE_TRACING_ENVIRONMENT",
  relayEndpoint: "OKOU_PI_LANGFUSE_OTLP_ENDPOINT",
  relayToken: "OKOU_PI_LANGFUSE_OTLP_TOKEN",
} as const;

export function installLangfuseRuntimeEnvironment(
  parent: PiLangfuseParent | undefined,
  config?: PiLangfuseRuntimeConfig,
): () => void {
  const enabled = process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED === "true";
  const managedNames = [
    ...Object.values(LANGFUSE_RUNTIME_ENVIRONMENT),
    ...(config ? Object.values(LANGFUSE_CONFIG_ENVIRONMENT) : []),
  ];
  const previous = Object.fromEntries(
    managedNames.map((name) => {
      return [name, process.env[name]];
    }),
  );
  for (const name of managedNames) {
    delete process.env[name];
  }
  if (enabled && config) {
    process.env[LANGFUSE_CONFIG_ENVIRONMENT.relayEndpoint] =
      config.relay.endpoint;
    process.env[LANGFUSE_CONFIG_ENVIRONMENT.relayToken] = config.relay.token;
    if (config.userId) {
      process.env[LANGFUSE_CONFIG_ENVIRONMENT.userId] = config.userId;
    }
    if (config.environment) {
      process.env[LANGFUSE_CONFIG_ENVIRONMENT.environment] = config.environment;
    }
  }
  if (enabled && parent) {
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.traceId] = parent.traceId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.spanId] = parent.spanId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.sessionId] = parent.sessionId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.depth] = "0";
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.sandboxWaitStartedAt] = String(
      parent.sandboxWaitStartedAt,
    );
  }

  return () => {
    for (const name of managedNames) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

function resolveSessionManager(args: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}): SessionManager {
  // Keep the read, validation and SDK open synchronous: opening can migrate
  // and rewrite a legacy file. Reject invalid bytes and identity before that.
  const { header } = parseValidatedPiSessionJsonl(
    new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(args.sessionFile),
    ),
  );
  if (header.id !== args.sessionId) {
    throw new Error("Pi handoff session id does not match the launch session");
  }
  const sessionManager = SessionManager.open(
    args.sessionFile,
    args.sessionDir,
    args.cwd,
  );
  if (sessionManager.getSessionId() !== args.sessionId) {
    throw new Error("Pi handoff session id does not match the launch session");
  }
  // Validate the actual SDK-loaded entries before any context traversal, too.
  validatePiSessionEntries(sessionManager.getEntries());
  return sessionManager;
}

function createRuntimeFactory(args: {
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly enableLangfuseObservability: boolean;
}): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const created = await createPiAgentSessionForRuntime({
      cwd,
      agentDir,
      sessionManager,
      model: args.model,
      appendSystemPrompt: args.appendSystemPrompt,
      memoryRecall: args.memoryRecall,
      resourceSnapshot: args.resourceSnapshot,
      onMemoryRecallOutcome: args.onMemoryRecallOutcome,
      onMemoryToolSourceUse: args.onMemoryToolSourceUse,
      onPreparationTiming: args.onPreparationTiming,
      sessionStartEvent,
      enableLangfuseObservability: args.enableLangfuseObservability,
    });
    return { ...created, diagnostics: created.services.diagnostics };
  };
}

/** Run Pi's official AgentSession RPC host until stdin closes. */
export async function runPiOfficialRpcMode(args: {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
  /** Sandbox-side session preparation phases. */
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly onFirstTool?: () => void;
  readonly sessionFile: string;
  readonly langfuseParent?: PiLangfuseParent;
  readonly langfuseConfig?: PiLangfuseRuntimeConfig;
}): Promise<never> {
  const enableLangfuseObservability =
    process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED === "true" &&
    args.langfuseConfig !== undefined;
  const restoreLangfuseEnvironment = installLangfuseRuntimeEnvironment(
    args.langfuseParent,
    args.langfuseConfig,
  );
  try {
    const createRuntime = createRuntimeFactory({
      ...args,
      enableLangfuseObservability,
    });
    const sessionManager = resolveSessionManager(args);
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: args.cwd,
      agentDir: args.agentDir,
      sessionManager,
    });
    let firstTool = true;
    const unsubscribe = runtime.session.subscribe((event) => {
      if (firstTool && event.type === "tool_execution_start") {
        firstTool = false;
        args.onFirstTool?.();
      }
    });
    try {
      return await runRpcMode(runtime);
    } finally {
      unsubscribe();
    }
  } finally {
    restoreLangfuseEnvironment();
  }
}
