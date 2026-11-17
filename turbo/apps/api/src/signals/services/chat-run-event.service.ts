import { command } from "ccstate";
import { publishThreadListChanged } from "../external/realtime";
import { publishChatThreadMessageCreated$ } from "./chat-event-publication.service";

/** Publish committed queue-first input to realtime clients and search. */
export const finalizeClaimedRunUserMessage$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly threadId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(publishChatThreadMessageCreated$, params, signal);
    signal.throwIfAborted();
    await publishThreadListChanged(params);
    signal.throwIfAborted();
  },
);
