import { command } from "ccstate";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../chat-page/chat-thread-panes.ts";

/**
 * Starts choosing messages to share in the open thread the composer belongs
 * to. The sharing flow lives on the thread's panel, which the composer does
 * not hold, so this finds it among the open panes.
 */
export const startComposerThreadSharing$ = command(
  ({ get, set }, threadId: string, signal: AbortSignal) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === threadId;
      },
    );
    return thread ? set(thread.sharing.start$, signal) : undefined;
  },
);
