import { z } from "zod";
import { getRunResponseSchema } from "./runs";

/** Native execution status; input consumption is read with get_chat_input. */
export const mcpGetRunStatusInputSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
});
export const mcpGetRunStatusOutputSchema = getRunResponseSchema;
export type McpGetRunStatusInput = z.infer<typeof mcpGetRunStatusInputSchema>;
export type McpGetRunStatusOutput = z.infer<typeof mcpGetRunStatusOutputSchema>;
export type McpRunStatusResult =
  | { readonly kind: "ok"; readonly data: McpGetRunStatusOutput }
  | { readonly kind: "not_found"; readonly message: string };
