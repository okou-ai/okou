import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectPiMemoryCitationSegments } from "@okouai/api-contracts/contracts/pi-memory-citations";

import { piAgentStreamForConfig } from "./model";
import {
  measurePiPreparation,
  measurePiPreparationSync,
} from "./preparation-timing";
import { assertPiApiFirstTurnCompactionSafe } from "./compaction-preflight";
import { MemoryPiSession, runPiFirstModelTurn } from "./session-memory";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiObservedServiceTier,
} from "./api-types";
import { UnsupportedPiResourceSnapshotError } from "./errors";
import {
  classifyPiApiProviderFailure,
  projectPiApiModelFailure,
} from "./api-failure";

function projectAssistantContent(message: AssistantMessage): {
  readonly content: PiApiAssistantContent[];
  readonly memoryCitation?: PiApiAssistantMessage["memoryCitation"];
} {
  const textBlocks = message.content.flatMap((content) => {
    return content.type === "text" ? [content.text] : [];
  });
  const projection = projectPiMemoryCitationSegments(textBlocks);
  let textIndex = 0;
  const content = message.content.flatMap(
    (content): PiApiAssistantContent[] => {
      switch (content.type) {
        case "text": {
          const text = projection.visibleSegments[textIndex] ?? "";
          textIndex += 1;
          return [{ type: "text", text }];
        }
        case "toolCall": {
          return [
            {
              type: "toolCall",
              id: content.id,
              name: content.name,
              arguments: content.arguments,
            },
          ];
        }
        case "thinking": {
          return [];
        }
        default: {
          const unsupportedContent: never = content;
          return unsupportedContent;
        }
      }
    },
  );
  return {
    content,
    ...(projection.citation ? { memoryCitation: projection.citation } : {}),
  };
}

export function projectPiApiAssistantMessage(
  message: AssistantMessage,
  responseStatus?: number,
): PiApiAssistantMessage {
  const projection = projectAssistantContent(message);
  const failureReason =
    message.stopReason === "error" &&
    message.api === "openai-codex-responses" &&
    message.provider === "openai-codex"
      ? classifyPiApiProviderFailure(message.errorMessage)
      : undefined;
  const projected = {
    content: projection.content,
    ...(projection.memoryCitation
      ? { memoryCitation: projection.memoryCitation }
      : {}),
    model: message.model,
    responseId: message.responseId,
    ...(failureReason ? { failureReason } : {}),
    timestamp: message.timestamp,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: message.usage.cacheWrite1h }),
    },
  };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      ...projected,
      stopReason: message.stopReason,
      failureDiagnostic: projectPiApiModelFailure(
        message.errorMessage,
        responseStatus,
      ),
    };
  }
  return { ...projected, stopReason: message.stopReason };
}

/** Run exactly one provider request using Pi's official prompt and tool schemas. */
export async function runPiApiFirstTurn(
  args: PiApiFirstTurnArgs,
  signal?: AbortSignal,
): Promise<PiApiFirstTurnResult> {
  const memorySession = measurePiPreparationSync(
    args.onPreparationTiming,
    "history",
    () => {
      const memorySession = args.sessionJsonl
        ? MemoryPiSession.fromJsonl(args.sessionJsonl)
        : MemoryPiSession.create({ cwd: args.cwd, id: args.sessionId });
      if (memorySession.getSessionId() !== args.sessionId) {
        throw new Error(
          "Pi resume session id does not match the launch session id",
        );
      }

      return memorySession;
    },
    signal,
  );

  let shell: Awaited<ReturnType<typeof createPiAgentSessionForRuntime>>;
  try {
    shell = await measurePiPreparation(
      args.onPreparationTiming,
      "runtime_initialize",
      () => {
        return createPiAgentSessionForRuntime(
          {
            cwd: args.cwd,
            agentDir: args.agentDir,
            sessionManager: SessionManager.inMemory(args.cwd, {
              id: args.sessionId,
            }),
            model: args.model,
            appendSystemPrompt: args.appendSystemPrompt,
            resourceSnapshot: args.resourceSnapshot,
            onMemoryRecallOutcome: args.onMemoryRecallOutcome,
            onPreparationTiming: args.onPreparationTiming,
          },
          signal,
        );
      },
      signal,
    );
  } catch (error) {
    throw new UnsupportedPiResourceSnapshotError(
      "Pi could not load the preheated resource snapshot",
      { cause: error },
    );
  }
  try {
    measurePiPreparationSync(
      args.onPreparationTiming,
      "compaction_preflight",
      () => {
        return assertPiApiFirstTurnCompactionSafe({
          model: shell.model,
          session: memorySession,
          settings: shell.services.settingsManager.getCompactionSettings(),
        });
      },
      signal,
    );
    let observedServiceTier: PiObservedServiceTier;
    const turn = await runPiFirstModelTurn({
      model: shell.model,
      session: memorySession,
      stream: piAgentStreamForConfig(args.model),
      systemPrompt: shell.session.systemPrompt,
      tools: shell.session.agent.state.tools,
      prompt: args.prompt,
      thinkingLevel: args.model.thinkingLevel,
      streamOptions: {
        apiKey: args.model.apiKey,
        signal,
        ...(args.model.provider === "openrouter"
          ? {
              onObservedServiceTier: (serviceTier: PiObservedServiceTier) => {
                observedServiceTier = serviceTier;
              },
            }
          : {}),
        ...(args.model.serviceTier === undefined
          ? {}
          : { serviceTier: args.model.serviceTier }),
      },
      ownership: args.ownership,
      providerRequestBoundary: args.providerRequestBoundary,
      onPreparationTiming: args.onPreparationTiming,
    });
    return {
      assistantMessage: projectPiApiAssistantMessage(
        turn.assistantMessage,
        turn.responseStatus,
      ),
      handoffRequired: turn.handoffRequired,
      observedServiceTier,
      sessionJsonl: memorySession.toJsonl(),
    };
  } finally {
    shell.session.dispose();
  }
}
