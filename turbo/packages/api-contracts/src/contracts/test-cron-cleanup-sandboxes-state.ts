import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testCronCleanupSandboxesStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-run",
      "seed-run-ownership",
      "delete-run",
      "delete-run-ownership",
      "get-run",
      "get-run-ownership",
      "get-connector-diagnostic-registration",
      "corrupt-connector-diagnostic-registration",
      "delete-connector-diagnostic-registration",
      "transition-run-terminal",
    ]),
  })
  .passthrough();

export const testCronCleanupSandboxesStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testCronCleanupSandboxesStateErrorSchema = z.object({
  error: z.string(),
});

export const testCronCleanupSandboxesStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-cleanup-sandboxes-state/action",
    body: testCronCleanupSandboxesStateActionBodySchema,
    responses: {
      200: testCronCleanupSandboxesStateActionResponseSchema,
      400: testCronCleanupSandboxesStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate or inspect cron cleanup sandboxes test state",
  },
});

export type TestCronCleanupSandboxesStateActionBody = z.infer<
  typeof testCronCleanupSandboxesStateActionBodySchema
>;
export type TestCronCleanupSandboxesStateActionResponse = z.infer<
  typeof testCronCleanupSandboxesStateActionResponseSchema
>;
export type TestCronCleanupSandboxesStateContract =
  typeof testCronCleanupSandboxesStateContract;
