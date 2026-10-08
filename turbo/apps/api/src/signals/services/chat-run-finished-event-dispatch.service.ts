import { command, state, type Command } from "ccstate";

import type { ChatRunFinishedEvent } from "./chat-run-finished-event";

type ChatRunFinishedEventCommand = Command<
  Promise<void>,
  [ChatRunFinishedEvent, AbortSignal]
>;

const configuredChatRunFinishedEventCommand$ = state<
  ChatRunFinishedEventCommand | undefined
>(undefined);

/** Initialize the request's implementation from the API composition root. */
export const configureChatRunFinishedEventCommand$ = command(
  ({ get, set }, commandValue: ChatRunFinishedEventCommand): void => {
    const configuredCommand = get(configuredChatRunFinishedEventCommand$);
    if (configuredCommand !== undefined && configuredCommand !== commandValue) {
      throw new Error("Chat run finished event command is already configured");
    }
    set(configuredChatRunFinishedEventCommand$, commandValue);
  },
);

export const dispatchConfiguredChatRunFinishedEvent$ = command(
  async (
    { get, set },
    event: ChatRunFinishedEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const commandValue = get(configuredChatRunFinishedEventCommand$);
    if (commandValue === undefined) {
      throw new Error("Chat run finished event command is not configured");
    }
    await set(commandValue, event, signal);
  },
);
