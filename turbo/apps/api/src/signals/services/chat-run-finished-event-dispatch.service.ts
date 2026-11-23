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

type ProjectRecallArgs = [
  {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
  },
  Date,
  AbortSignal,
];
type ProjectRecallCommand = Command<Promise<void>, ProjectRecallArgs>;

const projectRecallCommand$ = state<ProjectRecallCommand | undefined>(
  undefined,
);

export const configureProjectRecallCommand$ = command(
  ({ set }, implementation: ProjectRecallCommand) => {
    set(projectRecallCommand$, implementation);
  },
);

export const dispatchProjectRecall$ = command(
  async ({ get, set }, ...args: ProjectRecallArgs): Promise<void> => {
    const implementation = get(projectRecallCommand$);
    if (!implementation) {
      throw new Error("Project recall command is not configured");
    }
    await set(implementation, ...args);
  },
);
