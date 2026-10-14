import { z } from "zod";
import { chatEventRowSchema } from "./chat-event-rows";

/** Bounded Memory-owned input; this is not a native session archive. */
export const piMemoryChatInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    threadId: z.uuid(),
    sourceRunId: z.uuid(),
    lastSeqId: z.number().int().positive(),
    events: z.array(chatEventRowSchema).min(1),
  })
  .strict();
