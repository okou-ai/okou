import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

export const pickedThreadColumns = Object.freeze({
  id: chatThreads.id,
  userId: chatThreads.userId,
  projectId: chatThreads.projectId,
  computerUseHostId: chatThreads.computerUseHostId,
  cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
  framework: chatThreads.framework,
  frameworkSessionId: chatThreads.frameworkSessionId,
  frameworkSessionRunId: chatThreads.frameworkSessionRunId,
  title: chatThreads.title,
  renamedAt: chatThreads.renamedAt,
});

export type PickedChatThread = Readonly<
  Pick<typeof chatThreads.$inferSelect, keyof typeof pickedThreadColumns>
>;

/** Preparation facts only: neither a connector grant nor commit-time authority. */
export interface ChatRunPreparationFacts {
  readonly isOfficialWorkflowThread: boolean;
  readonly captureNetworkBodies: boolean;
}

/** Canonical facts of the input published by a Chat send. */
export interface EnqueuedChatInputFacts {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly id: string;
  readonly userMessage: UserMessageDocument;
  readonly modelSelection: ChatInputModelSelection;
  readonly requiredOfficialWorkflowIds: readonly string[] | undefined;
  readonly captureNetworkBodies: boolean;
  /** Route-entry time of the `POST /api/chat/events` request. */
  readonly requestReceivedAt?: number;
  /** Ephemeral join key for pre-Run enqueue observations. */
  readonly enqueueObservationId?: string;
}
