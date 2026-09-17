import { Command } from "commander";

import { cancelCommand } from "./cancel";
import { createCommand } from "./create";
import { getCommand } from "./get";
import { listCommand } from "./list";
import { messagesCommand } from "./messages";
import { modelCommand } from "./model";
import { renameCommand } from "./rename";
import { sendCommand } from "./send";

export const chatCommand = new Command()
  .name("chat")
  .description("Manage web chat threads")
  .addCommand(createCommand)
  .addCommand(sendCommand)
  .addCommand(cancelCommand)
  .addCommand(getCommand)
  .addCommand(messagesCommand)
  .addCommand(listCommand)
  .addCommand(modelCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create a chat:     okou chat create "Launch plan"
  Send a message:    okou chat send --text "Continue"
  Cancel a run:      okou chat cancel --thread-id <thread-id> --run-id <run-id>
  List agent chats:  okou chat list
  Show this chat:    okou chat get
  Show another:      okou chat get --thread-id <thread-id>
  Sync messages:     okou chat messages --thread-id <thread-id> --output-dir threads
  Switch model:      okou chat model claude-sonnet-5
  Switch another:    okou chat model --thread <thread-id> claude-sonnet-5
  Rename this chat:  okou chat rename "Launch plan"
  Rename another:    okou chat rename --thread <thread-id> "Launch plan"

Run lifecycle:
  create makes an empty thread; it does not start a run or copy conversation history.
  Send a self-contained first message. send starts or queues a target run and
  returns without waiting; the target run's lifetime is independent.
  messages is a point-in-time read, not a completion subscription. For
  event-driven completion, use a chat-run-finished workflow automation rather
  than polling.`,
  );
