import { z } from "zod";
import { chatThreadActivitySummaryContract } from "./chat-thread-activity-summary";
import {
  chatEventNormalSendBodySchema,
  chatEventsContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  indicatorsSchema,
} from "./chat-threads";
import { mcpRunIdSchema, mcpThreadIdSchema } from "./mcp-identifiers";
import { runsCancelContract } from "./run-routes";

const normal = chatEventNormalSendBodySchema.shape;
export const mcpSendChatMessageInputSchema = z
  .object({
    agentId: normal.agentId,
    prompt: normal.prompt,
    threadId: mcpThreadIdSchema.optional(),
    model: normal.model,
    clientEventId: normal.clientEventId,
  })
  .strict();

export const mcpRevokeQueuedMessageInputSchema =
  chatEventsContract.send.body.options[1].extend({
    threadId: mcpThreadIdSchema,
  });

export const mcpSendChatMessageOutputSchema =
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
    .extend({ threadId: mcpThreadIdSchema })
    .strict();
export const mcpUpdateChatThreadModelInputSchema =
  chatThreadModelSelectionContract.update.body
    .extend({ threadId: mcpThreadIdSchema })
    .strict();

export const mcpCancelRunInputSchema = z
  .object({ runId: mcpRunIdSchema })
  .strict();
export const mcpCancelRunOutputSchema = runsCancelContract.cancel.responses[200]
  .omit({ id: true })
  .extend({ runId: mcpRunIdSchema });

export const mcpGetChatIndicatorsOutputSchema = indicatorsSchema.extend({
  threads: z.record(
    mcpThreadIdSchema,
    indicatorsSchema.shape.threads.valueType,
  ),
  unreadAt: z.record(
    mcpThreadIdSchema,
    indicatorsSchema.shape.unreadAt.valueType,
  ),
});
