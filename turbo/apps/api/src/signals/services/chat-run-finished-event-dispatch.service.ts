import { command, createStore, state, type Command } from "ccstate";

import type { ChatRunFinishedEvent } from "./chat-run-finished-event";

type ChatRunFinishedEventCommand = Command<
  Promise<void>,
  [ChatRunFinishedEvent, AbortSignal]
>;

const configuredChatRunFinishedEventCommand$ = state<
  ChatRunFinishedEventCommand | undefined
>(undefined);
// eslint-disable-next-line ccstate/no-create-store -- Legacy command registry; replace with an explicit process owner.
const configurationStore = createStore();

/** Configure the chat-run-finished implementation from the API composition root. */
export function configureChatRunFinishedEventCommand(
  commandValue: ChatRunFinishedEventCommand,
): void {
  const configuredCommand = configurationStore.get(
    configuredChatRunFinishedEventCommand$,
  );
  if (configuredCommand !== undefined && configuredCommand !== commandValue) {
    throw new Error("Chat run finished event command is already configured");
  }
  configurationStore.set(configuredChatRunFinishedEventCommand$, commandValue);
}

export const dispatchConfiguredChatRunFinishedEvent$ = command(
  async (
    { set },
    event: ChatRunFinishedEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const commandValue = configurationStore.get(
      configuredChatRunFinishedEventCommand$,
    );
    if (commandValue === undefined) {
      throw new Error("Chat run finished event command is not configured");
    }
    await set(commandValue, event, signal);
  },
);
