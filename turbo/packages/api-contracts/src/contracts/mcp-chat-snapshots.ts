import {
  array,
  discriminatedUnion,
  object,
  union,
  undefined as zUndefined,
} from "zod";
import { chatEventRowSchema } from "./chat-event-rows";
import { chatThreadEventsContract, chatThreadsContract } from "./chat-threads";
import {
  mcpEventIdSchema,
  mcpRunIdSchema,
  mcpThreadIdSchema,
} from "./mcp-identifiers";

const nativeEvent =
  chatThreadsContract.events.responses[200].shape.events.element;
const mcpThreadEventSchema = nativeEvent
  .omit({ id: true, chatThreadId: true })
  .extend({ eventId: mcpEventIdSchema, threadId: mcpThreadIdSchema });

const [firstRow, ...remainingRows] = chatEventRowSchema.options;
const mcpRowReferences = {
  eventId: mcpEventIdSchema,
  threadId: mcpThreadIdSchema,
  runId: mcpRunIdSchema.nullable(),
  revokesEventId: mcpEventIdSchema.nullable(),
};
const mcpChatEventRowSchema = discriminatedUnion("eventType", [
  firstRow.omit({ id: true, chatThreadId: true }).extend(mcpRowReferences),
  ...remainingRows.map((row) => {
    return row.omit({ id: true, chatThreadId: true }).extend(mcpRowReferences);
  }),
]);

const [threadPointer, emptyThreads] =
  chatThreadsContract.snapshot.responses[200].options;
/** Native snapshot metadata and one inline page with canonical entity references. */
export const mcpGetChatThreadInputSchema = chatThreadsContract.events.query;
export const mcpGetChatThreadOutputSchema = object({
  snapshot: union([
    threadPointer.extend({ latestEventId: mcpEventIdSchema.nullable() }),
    emptyThreads,
  ]),
  ...chatThreadsContract.events.responses[200].shape,
  events: array(mcpThreadEventSchema),
});

const path = object({ threadId: mcpThreadIdSchema });
const [start, continuation] = chatThreadEventsContract.rows.query.options;
/** Omit the cursor initially; subsequent calls use the Web paired cursor. */
export const mcpGetChatMessagesInputSchema = union([
  path.extend({
    limit: start.shape.limit,
    sinceSeqId: zUndefined().optional(),
    sinceEventId: zUndefined().optional(),
  }),
  start.extend(path.shape),
  continuation.extend({ ...path.shape, sinceEventId: mcpEventIdSchema }),
]);
const [emptySnapshot, continuedSnapshot] =
  chatThreadEventsContract.snapshot.responses[200].options;
const [emptyCursor, continuedCursor] =
  chatThreadEventsContract.rows.responses[200].shape.cursor.options;
export const mcpGetChatMessagesOutputSchema = object({
  snapshot: union([
    emptySnapshot,
    continuedSnapshot.extend({ lastEventId: mcpEventIdSchema }),
  ]).nullable(),
  ...chatThreadEventsContract.rows.responses[200].shape,
  rows: array(mcpChatEventRowSchema),
  cursor: union([
    emptyCursor,
    continuedCursor.extend({ lastEventId: mcpEventIdSchema }),
  ]),
});
