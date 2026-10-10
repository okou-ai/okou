import { z } from "zod";
import { chatThreadEventsContract, chatThreadsContract } from "./chat-threads";

/** Organization conversation-list snapshot and one Web lifecycle-event page. */
export const mcpGetChatThreadInputSchema = chatThreadsContract.events.query;
export const mcpGetChatThreadOutputSchema = z.object({
  snapshot: chatThreadsContract.snapshot.responses[200],
  ...chatThreadsContract.events.responses[200].shape,
});

const path = chatThreadEventsContract.rows.pathParams;
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
});
