import { computed } from "ccstate";
import { chatListResizing$ } from "../okou-page/unified-chat-workspace.ts";
import { chatThreadSidebarResizing$ } from "./chat-thread-sidebar-layout.ts";

/** A direct gesture owns every width it can change in the shared workspace. */
export const workspaceResizing$ = computed((get) => {
  return get(chatListResizing$) || get(chatThreadSidebarResizing$);
});
