import { computed } from "ccstate";
import { searchParams$ } from "../route.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
/** Project navigation retains the Agent selected at entry across member Threads. */
export const projectCreationAgentId$ = computed(async (get) => {
  return (
    get(searchParams$).get("projectAgent") ??
    (await get(currentChatAgentRecordId$))
  );
});
