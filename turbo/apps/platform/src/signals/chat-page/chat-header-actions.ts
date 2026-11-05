import { computed } from "ccstate";

import { currentChatThreadId$ } from "../agent-chat.ts";
import { searchParams$ } from "../route.ts";

/** The chat the route asks the secondary pane to show, if any. */
export const secondaryHeaderThreadId$ = computed((get) => {
  const primary = get(currentChatThreadId$);
  const secondary = get(searchParams$).get("sidebar");
  return primary === null || secondary === primary ? null : secondary;
});
