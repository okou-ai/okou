import { object, record } from "zod";
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
import { runsCancelContract } from "./run-routes";

const normal = chatEventNormalSendBodySchema.shape;
export const mcpSendChatMessageInputSchema = object({
  agentId: normal.agentId,
  prompt: normal.prompt,
  threadId: mcpThreadIdSchema.optional(),
  model: normal.model,
}).strict();

export const mcpRevokeQueuedMessageInputSchema = object({
  agentId: chatEventsContract.send.body.options[1].shape.agentId,
  threadId: mcpThreadIdSchema,
  eventId: mcpEventIdSchema,
}).strict();

export const mcpSendChatMessageOutputSchema =
  chatEventsContract.send.responses[201].extend({
    threadId: mcpThreadIdSchema,
    eventId: mcpEventIdSchema,
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
