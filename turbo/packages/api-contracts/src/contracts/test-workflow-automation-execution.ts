import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testWorkflowAutomationCallbackDispatchRequestSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        run_id: z.string().uuid(),
        status: z.literal("completed"),
        dispatch_count: z.number().int().min(1).max(8),
      })
      .strict(),
    z
      .object({
        run_id: z.string().uuid(),
        status: z.literal("failed"),
        error: z.string().min(1),
        dispatch_count: z.number().int().min(1).max(8),
      })
      .strict(),
  ]);

export const testWorkflowAutomationCallbackDispatchResponseSchema = z.object({
  success: z.literal(true),
  dispatches: z.number().int().nonnegative(),
  callback_results: z.number().int().nonnegative(),
  successful_callbacks: z.number().int().nonnegative(),
});

export const testWorkflowAutomationExecutionContract = c.router({
  dispatchCallbacks: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/dispatch-callbacks",
    body: testWorkflowAutomationCallbackDispatchRequestSchema,
    responses: {
      200: testWorkflowAutomationCallbackDispatchResponseSchema,
      404: z.string(),
    },
    summary: "Dispatch terminal workflow automation callbacks in API tests",
  },
});
export type TestWorkflowAutomationCallbackDispatchRequest = z.infer<
  typeof testWorkflowAutomationCallbackDispatchRequestSchema
>;
export type TestWorkflowAutomationExecutionContract =
  typeof testWorkflowAutomationExecutionContract;
