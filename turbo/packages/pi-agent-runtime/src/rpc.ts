import { readFileSync } from "node:fs";

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
import {
  measurePiPreparation,
  measurePiPreparationSync,
  type PiPreparationObserver,
} from "./preparation-timing";
import type { PiAgentModelConfig } from "./types";

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
}): Promise<never> {
  const createRuntime = createRuntimeFactory(args);
  const sessionManager = measurePiPreparationSync(
    args.onPreparationTiming,
    "session_manager",
    () => {
      return resolveSessionManager(args);
    },
  );
  const runtime = await measurePiPreparation(
    args.onPreparationTiming,
    "runtime_initialize",
    () => {
      return createAgentSessionRuntime(createRuntime, {
        cwd: args.cwd,
        agentDir: args.agentDir,
        sessionManager,
      });
    },
  );
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
}
