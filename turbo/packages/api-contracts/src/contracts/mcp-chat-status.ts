import { z } from "zod";
import { getRunResponseSchema } from "./runs";

/** Read an ordinary Run; discover run IDs from the conversation's events/messages. */
export const mcpGetChatStatusInputSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
});
export const mcpGetChatStatusOutputSchema = getRunResponseSchema;
export type McpGetChatStatusInput = z.infer<typeof mcpGetChatStatusInputSchema>;
export type McpGetChatStatusOutput = z.infer<
  typeof mcpGetChatStatusOutputSchema
>;
export type McpChatStatusResult =
  | { readonly kind: "ok"; readonly data: McpGetChatStatusOutput }
  | { readonly kind: "not_found"; readonly message: string };
