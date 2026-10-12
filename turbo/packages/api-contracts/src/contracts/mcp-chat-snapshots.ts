import { z } from "zod";
import { chatEventRowSchema } from "./chat-event-rows";
import { chatThreadEventsContract, chatThreadsContract } from "./chat-threads";
import { mcpRunIdSchema, mcpThreadIdSchema } from "./mcp-identifiers";

const nativeEvent =
  chatThreadsContract.events.responses[200].shape.events.element;
const mcpThreadEventSchema = nativeEvent
  .omit({ chatThreadId: true })
  .extend({ threadId: mcpThreadIdSchema });

const [firstRow, ...remainingRows] = chatEventRowSchema.options;
const mcpRowReferences = {
  threadId: mcpThreadIdSchema,
  runId: mcpRunIdSchema.nullable(),
};
const mcpChatEventRowSchema = z.discriminatedUnion("eventType", [
  firstRow.omit({ chatThreadId: true }).extend(mcpRowReferences),
  ...remainingRows.map((row) => {
    return row.omit({ chatThreadId: true }).extend(mcpRowReferences);
  }),
]);

/** Native snapshot metadata and one inline page with canonical Thread references. */
export const mcpGetChatThreadInputSchema = chatThreadsContract.events.query;
export const mcpGetChatThreadOutputSchema = z.object({
  snapshot: chatThreadsContract.snapshot.responses[200],
  ...chatThreadsContract.events.responses[200].shape,
  events: z.array(mcpThreadEventSchema),
});

const path = z.object({ threadId: mcpThreadIdSchema });
const [start, continuation] = chatThreadEventsContract.rows.query.options;
/** Omit the cursor initially; subsequent calls use the Web paired cursor. */
export const mcpGetChatMessagesInputSchema = z.union([
  path.extend({
    limit: start.shape.limit,
    sinceSeqId: z.undefined().optional(),
    sinceEventId: z.undefined().optional(),
  }),
  start.extend(path.shape),
  continuation.extend(path.shape),
]);
export const mcpGetChatMessagesOutputSchema = z.object({
  snapshot: chatThreadEventsContract.snapshot.responses[200].nullable(),
  ...chatThreadEventsContract.rows.responses[200].shape,
  rows: z.array(mcpChatEventRowSchema),
});
