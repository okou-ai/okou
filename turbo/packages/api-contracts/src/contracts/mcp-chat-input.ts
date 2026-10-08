import { z } from "zod";
import { mcpChatOutputTimestampSchema } from "./mcp-chat-time";
import { mcpGetRunStatusOutputSchema } from "./mcp-run-status";

/** eventId is the original accepted prompt, never a replacement row ID. */
export const mcpGetChatInputInputSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  eventId: z.uuid().toLowerCase(),
});

const inputIdentityShape = {
  threadId: z.uuid(),
  eventId: z.uuid(),
  createdAt: mcpChatOutputTimestampSchema,
};
const inputRejectionSchema = z.strictObject({
  code: z.enum(["insufficient_credits", "pro_required", "input_rejected"]),
  message: z.string().max(512),
});
const runObservationSchema = mcpGetRunStatusOutputSchema
  .pick({ runId: true, status: true })
  .strict();

export const mcpGetChatInputOutputSchema = z
  .discriminatedUnion("inputStatus", [
    z.strictObject({
      ...inputIdentityShape,
      inputStatus: z.literal("queued"),
      run: z.null(),
      error: z.null(),
    }),
    z.strictObject({
      ...inputIdentityShape,
      inputStatus: z.literal("consumed"),
      run: runObservationSchema,
      error: z.null(),
    }),
    z.strictObject({
      ...inputIdentityShape,
      inputStatus: z.literal("rejected"),
      run: z.null(),
      error: inputRejectionSchema,
    }),
    z.strictObject({
      ...inputIdentityShape,
      inputStatus: z.literal("recalled"),
      run: z.null(),
      error: z.null(),
    }),
  ])
  .meta({ type: "object" });

export type McpGetChatInputInput = z.infer<typeof mcpGetChatInputInputSchema>;
export type McpGetChatInputOutput = z.infer<typeof mcpGetChatInputOutputSchema>;
export type McpChatInputReadError = {
  readonly kind: "not_found" | "history_limit" | "history_unavailable";
  readonly message: string;
};
export type McpChatInputReadResult =
  | { readonly kind: "ok"; readonly data: McpGetChatInputOutput }
  | McpChatInputReadError;
