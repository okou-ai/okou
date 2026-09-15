import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testWorkflowAutomationExecutionRequestSchema = z.object({
  automation_id: z.string().uuid(),
});

export const testWorkflowAutomationAgentExecutionRequestSchema = z.object({
  agent_id: z.string().uuid(),
});

export const testWorkflowAutomationExecutionResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

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

export const testWorkflowAutomationCallbackInterruptionRequestSchema = z
  .object({
    run_id: z.string().uuid(),
  })
  .strict();

export const testWorkflowAutomationCallbackInterruptionResponseSchema = z
  .object({
    success: z.literal(true),
    callback_id: z.string().uuid(),
    skipped: z.boolean(),
  })
  .strict();

export const testWorkflowAutomationExecutionContract = c.router({
  enrollMorningBrief: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/enroll-morning-brief",
    body: z
      .object({ orgId: z.string().min(1), userId: z.string().min(1) })
      .strict(),
    responses: {
      200: z.object({ attempted: z.number().int().nonnegative() }),
      404: z.string(),
    },
    summary: "Run Morning Brief enrollment for one test-owned member",
  },
  execute: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/execute",
    body: testWorkflowAutomationExecutionRequestSchema,
    responses: {
      200: testWorkflowAutomationExecutionResponseSchema,
      404: z.string(),
    },
    summary: "Execute one workflow automation in API tests",
  },
  executeForAgent: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/execute-for-agent",
    body: testWorkflowAutomationAgentExecutionRequestSchema,
    responses: {
      200: testWorkflowAutomationExecutionResponseSchema,
      404: z.string(),
    },
    summary: "Execute visible workflow automations for one agent in API tests",
  },
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
  interruptResultEmailCallback: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/interrupt-result-email-callback",
    body: testWorkflowAutomationCallbackInterruptionRequestSchema,
    responses: {
      200: testWorkflowAutomationCallbackInterruptionResponseSchema,
      404: z.string(),
    },
    summary:
      "Interrupt an Official result email callback after enqueue in API tests",
  },
});

export type TestWorkflowAutomationExecutionRequest = z.infer<
  typeof testWorkflowAutomationExecutionRequestSchema
>;
export type TestWorkflowAutomationAgentExecutionRequest = z.infer<
  typeof testWorkflowAutomationAgentExecutionRequestSchema
>;
export type TestWorkflowAutomationExecutionResponse = z.infer<
  typeof testWorkflowAutomationExecutionResponseSchema
>;
export type TestWorkflowAutomationCallbackDispatchRequest = z.infer<
  typeof testWorkflowAutomationCallbackDispatchRequestSchema
>;
export type TestWorkflowAutomationCallbackInterruptionRequest = z.infer<
  typeof testWorkflowAutomationCallbackInterruptionRequestSchema
>;
export type TestWorkflowAutomationExecutionContract =
  typeof testWorkflowAutomationExecutionContract;
