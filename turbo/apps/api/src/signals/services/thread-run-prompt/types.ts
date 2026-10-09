import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { agentRuns } from "@okouai/db/schema/agent-run";
import type {
  ChatEventUserMessage,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/runtime/chat-thread";

/** The complete picked input projection, including canonical payload leaves. */
export type PickedThreadInputEvent = Readonly<
  Pick<
    typeof chatEvents.$inferSelect,
    | "id"
    | "chatThreadId"
    | "createdAt"
    | "seqId"
    | "eventType"
    | "contextType"
    | "contextId"
    | "requiredOfficialWorkflowIds"
    | "modelSelection"
  > &
    Pick<typeof chatThreads.$inferSelect, "userId" | "agentId"> & {
      userMessage: ChatEventUserMessage | null;
      canonicalModelSelection: typeof chatEvents.$inferSelect.modelSelection;
      sourceAutonomyBudget: typeof agentRuns.$inferSelect.autonomyBudget | null;
    }
>;

export interface ThreadPromptSource {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly event: PickedThreadInputEvent;
  readonly featureSwitchContext: FeatureSwitchContext;
}
