import {
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { createPiAgentSessionForRuntime } from "./session-runtime";
import type { PiPreheatedResourceSnapshot } from "./api-types";
import {
  measurePiPreparation,
  measurePiPreparationSync,
  type PiPreparationObserver,
} from "./preparation-timing";
import type { PiAgentModelConfig } from "./types";

function resolveSessionManager(args: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly continueNative: boolean;
}): SessionManager {
  return args.continueNative
    ? SessionManager.continueRecent(args.cwd, args.sessionDir)
    : SessionManager.create(args.cwd, args.sessionDir);
}

function createRuntimeFactory(args: {
  readonly sessionRole?: "parent" | "child";
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly onSessionCreated: (retainImageHistory: () => void) => void;
}): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const created = await createPiAgentSessionForRuntime({
      cwd,
      agentDir,
      sessionManager,
      model: args.model,
      sessionRole: args.sessionRole,
      appendSystemPrompt: args.appendSystemPrompt,
      resourceSnapshot: args.resourceSnapshot,
      onPreparationTiming: args.onPreparationTiming,
      sessionStartEvent,
    });
    args.onSessionCreated(created.retainImageHistory);
    return { ...created, diagnostics: created.services.diagnostics };
  };
}

/** Run Pi's official AgentSession RPC host until stdin closes. */
export async function runPiOfficialRpcMode(args: {
  readonly sessionRole?: "parent" | "child";
  readonly continueNative: boolean;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  /** Sandbox-side session preparation phases. */
  readonly onPreparationTiming?: PiPreparationObserver;
  readonly onFirstTool?: () => void;
}): Promise<never> {
  let retainImageHistory: () => void;
  const createRuntime = createRuntimeFactory({
    ...args,
    onSessionCreated(retain) {
      retainImageHistory = retain;
    },
  });
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
  runtime.setBeforeSessionInvalidate(() => {
    const session = runtime.session;
    if (session.isStreaming || session.isCompacting || session.isRetrying) {
      return;
    }
    try {
      retainImageHistory();
    } catch {
      // Retention must not fail a completed answer or expose session content.
      process.stderr.write(
        `${JSON.stringify({ type: "pi_image_history_retention", outcome: "error" })}\n`,
      );
    }
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
}
