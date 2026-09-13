import { readFileSync } from "node:fs";

import type { PiLangfuseParent } from "@okouai/api-contracts/contracts/runners";
import {
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import {
  parseValidatedPiSessionJsonl,
  validatePiSessionEntries,
} from "./session-validation";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
  PiMemoryToolSourceUse,
} from "./api-types";
import type { PiAgentModelConfig } from "./types";

export type PiSandboxOwnershipTransferMode =
  | "sandbox-first"
  | "pending-tool-continuation"
  | "settled-session-continuation";

const LANGFUSE_RUNTIME_ENVIRONMENT = {
  traceId: "LANGFUSE_PI_PARENT_TRACE_ID",
  spanId: "LANGFUSE_PI_PARENT_SPAN_ID",
  sessionId: "LANGFUSE_PI_PARENT_SESSION_ID",
  depth: "LANGFUSE_PI_PARENT_DEPTH",
  continuation: "PI_LANGFUSE_CONTINUATION",
} as const;

export function installLangfuseRuntimeEnvironment(
  parent: PiLangfuseParent | undefined,
  ownershipTransferMode: PiSandboxOwnershipTransferMode,
): () => void {
  const enabled = process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED === "true";
  const previous = Object.fromEntries(
    Object.values(LANGFUSE_RUNTIME_ENVIRONMENT).map((name) => {
      return [name, process.env[name]];
    }),
  );
  for (const name of Object.values(LANGFUSE_RUNTIME_ENVIRONMENT)) {
    delete process.env[name];
  }
  if (enabled && parent) {
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.traceId] = parent.traceId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.spanId] = parent.spanId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.sessionId] = parent.sessionId;
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.depth] = "0";
  }
  if (enabled && ownershipTransferMode === "pending-tool-continuation") {
    process.env[LANGFUSE_RUNTIME_ENVIRONMENT.continuation] = "true";
  }

  return () => {
    for (const name of Object.values(LANGFUSE_RUNTIME_ENVIRONMENT)) {
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
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
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
      onMemoryRecallOutcome: args.onMemoryRecallOutcome,
      onMemoryToolSourceUse: args.onMemoryToolSourceUse,
      sessionStartEvent,
      enableLangfuseObservability: args.enableLangfuseObservability,
    });
    return { ...created, diagnostics: created.services.diagnostics };
  };
}

export async function resumePiApiFirstTurn(
  session: AgentSession,
  options?: Parameters<AgentSession["continuePendingTools"]>[0],
): Promise<void> {
  await session.continuePendingTools(options);
}

function installOwnershipTransferStartup(
  session: AgentSession,
  mode: PiSandboxOwnershipTransferMode,
): void {
  if (mode === "sandbox-first") {
    return;
  }
  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (_text, options) => {
    if (mode === "pending-tool-continuation") {
      await resumePiApiFirstTurn(session, {
        preflightResult(success) {
          // Both native owners are established before ordinary input or RPC ack.
          session.prompt = originalPrompt;
          options?.preflightResult?.(success);
        },
      });
    } else {
      session.prompt = originalPrompt;
      options?.preflightResult?.(true);
    }
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
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
  readonly sessionFile: string;
  readonly ownershipTransferMode: PiSandboxOwnershipTransferMode;
  readonly langfuseParent?: PiLangfuseParent;
}): Promise<never> {
  const restoreLangfuseEnvironment = installLangfuseRuntimeEnvironment(
    args.langfuseParent,
    args.ownershipTransferMode,
  );
  try {
    const createRuntime = createRuntimeFactory({
      ...args,
      enableLangfuseObservability:
        process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED === "true",
    });
    const sessionManager = resolveSessionManager(args);
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: args.cwd,
      agentDir: args.agentDir,
      sessionManager,
    });
    installOwnershipTransferStartup(
      runtime.session,
      args.ownershipTransferMode,
    );
    return await runRpcMode(runtime);
  } finally {
    restoreLangfuseEnvironment();
  }
}
