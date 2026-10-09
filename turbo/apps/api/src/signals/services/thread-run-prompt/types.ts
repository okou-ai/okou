import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { agentRuns } from "@okouai/db/schema/agent-run";
import type {
  ChatEventUserMessage,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/schema/chat-thread";

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

export interface IntegrationPromptVariables {
  readonly userPromptVariables: {
    readonly message: string;
  };
  readonly systemPromptVariables: {
    readonly integrationContext: string;
    readonly channelUserIdentity: string;
  };
}

export interface CommonPromptVariables {
  readonly userIdentity: string;
  readonly continuationContext: string;
  readonly generationTemplatePrompt: string;
  readonly computerUseContext: string;
}

export interface ThreadPrompt {
  readonly userPrompt: string;
  readonly systemPrompt: string;
}
