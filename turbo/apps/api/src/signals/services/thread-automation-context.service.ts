import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { computed, type Computed } from "ccstate";
import { eq } from "drizzle-orm";
import { db$ } from "../external/db";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

type ThreadAutomationContext = Readonly<
  Pick<
    typeof chatAutomationContext.$inferSelect,
    | "automationId"
    | "triggerBrief"
    | "workflowName"
    | "eventType"
    | "eventPayload"
    | "connectorSourceId"
  > & {
    id: string;
    chatThreadId: string;
  }
>;

export function createThreadAutomationContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
): Computed<Promise<ThreadAutomationContext | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      !pickedEvent ||
      pickedEvent.contextType !== "automation" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    const [context] = await get(db$)
      .select({
        automationId: chatAutomationContext.automationId,
        triggerBrief: chatAutomationContext.triggerBrief,
        workflowName: chatAutomationContext.workflowName,
        eventType: chatAutomationContext.eventType,
        eventPayload: chatAutomationContext.eventPayload,
        connectorSourceId: chatAutomationContext.connectorSourceId,
      })
      .from(chatAutomationContext)
      .where(eq(chatAutomationContext.id, pickedEvent.contextId))
      .limit(1);
    return context
      ? {
          id: pickedEvent.id,
          chatThreadId: pickedEvent.chatThreadId,
          ...context,
        }
      : null;
  });
}
