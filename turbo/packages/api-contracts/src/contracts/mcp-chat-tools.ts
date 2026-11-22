import { object, record, uuid } from "zod";
import { chatThreadActivitySummaryContract } from "./chat-thread-activity-summary";
import {
  chatEventsContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  indicatorsSchema,
} from "./chat-threads";
import { chatEventNormalSendBodySchema } from "./chat-event-send";
import {
  mcpEventIdSchema,
  mcpRunIdSchema,
  mcpThreadIdSchema,
} from "./mcp-identifiers";
import { initContract } from "./base";
import { runsCancelContract } from "./run-routes";

const normal = chatEventNormalSendBodySchema.shape;
export const mcpSendChatMessageInputSchema = object({
  prompt: normal.prompt.optional(),
  userMessage: normal.userMessage.optional(),
  threadId: mcpThreadIdSchema.optional(),
  projectId: uuid().toLowerCase().optional(),
  model: normal.model,
})
  .strict()
  .refine(
    (input) => {
      return (input.prompt === undefined) !== (input.userMessage === undefined);
    },
    { message: "Provide either prompt or userMessage", path: ["prompt"] },
  )
  .refine(
    (input) => {
      return input.threadId === undefined || input.projectId === undefined;
    },
    {
      message: "projectId is only allowed when starting a new Chat",
      path: ["projectId"],
    },
  )
  .meta({ oneOf: [{ required: ["prompt"] }, { required: ["userMessage"] }] });

export const mcpRevokeQueuedMessageInputSchema = object({
  threadId: mcpThreadIdSchema,
  eventId: mcpEventIdSchema,
}).strict();

export const mcpSendChatMessageOutputSchema =
  chatEventsContract.send.responses[201].extend({
    threadId: mcpThreadIdSchema,
    eventId: mcpEventIdSchema,
  });

// Dispatched only inside the authenticated MCP route slice.
export const mcpChatCommandContract = initContract().router({
  send: {
    ...chatEventsContract.send,
    path: "/internal/mcp/chat/send",
    body: mcpSendChatMessageInputSchema,
    responses: {
      ...chatEventsContract.send.responses,
      201: mcpSendChatMessageOutputSchema,
    },
  },
  revoke: {
    ...chatEventsContract.send,
    path: "/internal/mcp/chat/revoke",
    body: mcpRevokeQueuedMessageInputSchema,
  },
});

// The published MCP output keeps its always-null runId; the Web send response
// no longer carries one.
export const mcpRevokeQueuedMessageOutputSchema =
  chatEventsContract.send.responses[201].extend({
    threadId: mcpThreadIdSchema,
    runId: mcpRunIdSchema.nullable(),
  });

export const mcpGetChatActivitySummaryInputSchema =
  chatThreadActivitySummaryContract.summarize.body
    .extend({ threadId: mcpThreadIdSchema, runId: mcpRunIdSchema })
    .strict();
export const mcpGetChatActivitySummaryOutputSchema =
  chatThreadActivitySummaryContract.summarize.responses[200].extend({
    runId: mcpRunIdSchema,
  });

export const mcpRenameChatThreadInputSchema =
  chatThreadRenameContract.rename.body
    .extend({
      threadId: mcpThreadIdSchema,
      eventId: mcpEventIdSchema.optional(),
    })
    .strict();
export const mcpUpdateChatThreadModelInputSchema =
  chatThreadModelSelectionContract.update.body
    .extend({
      threadId: mcpThreadIdSchema,
      eventId: mcpEventIdSchema.optional(),
      serviceTierEventId: mcpEventIdSchema.optional(),
    })
    .strict();

export const mcpCancelRunInputSchema = object({
  runId: mcpRunIdSchema,
}).strict();
export const mcpCancelRunOutputSchema = runsCancelContract.cancel.responses[200]
  .omit({ id: true })
  .extend({ runId: mcpRunIdSchema });

export const mcpGetChatIndicatorsOutputSchema = indicatorsSchema.extend({
  threads: record(mcpThreadIdSchema, indicatorsSchema.shape.threads.valueType),
  unreadAt: record(
    mcpThreadIdSchema,
    indicatorsSchema.shape.unreadAt.valueType,
  ),
});
