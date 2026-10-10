import type { agentRuns } from "@okouai/db/schema/agent-run";
import type {
  ChatEventUserMessage,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { ChatThreadRequestRow } from "../chat-thread-request-facts";

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
      readonly thread: ChatThreadRequestRow;
      userMessage: ChatEventUserMessage | null;
      canonicalModelSelection: typeof chatEvents.$inferSelect.modelSelection;
      sourceAutonomyBudget: typeof agentRuns.$inferSelect.autonomyBudget | null;
    }
>;
