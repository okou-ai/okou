import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";

/** Ordinary request facts, never signals or a second identity context. */
export function chatThreadRequestSelection() {
  return {
    id: chatThreads.id,
    userId: chatThreads.userId,
    agentId: chatThreads.agentId,
    selectedModel: chatThreads.selectedModel,
    modelSettings: chatThreads.modelSettings,
    codexServiceTier: chatThreads.codexServiceTier,
    computerUseHostId: chatThreads.computerUseHostId,
    cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    agentSessionId: chatThreads.agentSessionId,
    agentSessionRunId: chatThreads.agentSessionRunId,
  };
}

export type ChatThreadRequestRow = Readonly<
  Pick<
    typeof chatThreads.$inferSelect,
    keyof ReturnType<typeof chatThreadRequestSelection>
  >
>;

export interface ChatThreadRequestFacts {
  readonly orgId: string;
  readonly thread: ChatThreadRequestRow;
  readonly input: {
    readonly id: string;
    readonly userMessage: UserMessageDocument;
    readonly modelSelection: ChatInputModelSelection;
    readonly requiredOfficialWorkflowIds: readonly string[] | undefined;
    readonly captureNetworkBodies: boolean;
  };
}
