import { command, type Command } from "ccstate";
import { createForwardAgentComposerSignals } from "../okou-page/agent-composer-signals.ts";
import { createChatEventSignals } from "./chat-event-signals.ts";
import type {
  ChatForwardComposerState,
  ChatForwardContext,
  ChatForwardTarget,
} from "./chat-forward.ts";
import { createThreadComposerSignals } from "./create-chat-thread.ts";

export function createChatForwardComposerSignals(
  target: ChatForwardTarget,
  forward: ChatForwardContext,
  onOptimisticSend: () => void,
): {
  readonly prepare$: Command<
    ChatForwardComposerState | Promise<ChatForwardComposerState>,
    [AbortSignal]
  >;
} {
  if (target.kind === "agent") {
    const composer = createForwardAgentComposerSignals(
      target.id,
      forward,
      onOptimisticSend,
    );
    const prepare$ = command(
      ({ set }, signal: AbortSignal): ChatForwardComposerState => {
        signal.throwIfAborted();
        set(composer.feedback.add$, forward);
        return { target, composer };
      },
    );
    return { prepare$ };
  }
  const chatEvents = createChatEventSignals(target.id);
  const composer = createThreadComposerSignals(
    target.id,
    target.agentId,
    chatEvents,
    { forward, onOptimisticSend },
  );
  const prepare$ = command(
    async ({ set }, signal: AbortSignal): Promise<ChatForwardComposerState> => {
      signal.throwIfAborted();
      set(composer.feedback.add$, forward);
      await set(chatEvents.setup$, signal);
      await set(chatEvents.catchUp$, signal);
      signal.throwIfAborted();
      return { target, composer };
    },
  );
  return { prepare$ };
}
