import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

export interface ProjectReferenceRow {
  readonly id: string;
  readonly name: string;
}

export const pickedThreadColumns = Object.freeze({
  // Drizzle uses the first column to detect an absent left-joined Chat.
  cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
  projectId: chatThreads.projectId,
  framework: chatThreads.framework,
  frameworkSessionId: chatThreads.frameworkSessionId,
  frameworkSessionRunId: chatThreads.frameworkSessionRunId,
});

export type PickedChatThread = Readonly<
  Pick<
    typeof chatThreads.$inferSelect,
    keyof typeof pickedThreadColumns | "id" | "userId"
  > & { titled: boolean }
>;

/** Preparation facts only: neither a connector grant nor commit-time authority. */
export interface ChatRunPreparationFacts {
  readonly isOfficialWorkflowThread: boolean;
  readonly hasCompletedPredecessorHistory: boolean;
  readonly captureNetworkBodies: boolean;
  readonly computerUseHostGrant: {
    readonly hostId: string;
    readonly displayName: string;
  } | null;
  readonly phoneUseGrant: {
    readonly deviceId: string;
    readonly grantId: string;
  } | null;
  readonly currentProject: ProjectReferenceRow | null;
  readonly projectReferences: readonly ProjectReferenceRow[];
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
  readonly sourceAutonomyBudget?: number;
  readonly captureNetworkBodies: boolean;
  readonly projectReferences?: readonly ProjectReferenceRow[];
  /** Route-entry time of the `POST /api/chat/events` request. */
  readonly requestReceivedAt?: number;
  /** Ephemeral join key for pre-Run enqueue observations. */
  readonly enqueueObservationId?: string;
}
