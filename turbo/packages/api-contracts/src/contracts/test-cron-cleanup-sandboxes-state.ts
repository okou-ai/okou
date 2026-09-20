import { z } from "zod";

import { initContract } from "./base";
import { cleanupResponseSchema } from "./cron";

const c = initContract();

export const testCronCleanupSandboxesStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-run",
      "seed-run-ownership",
      "attach-run-thread",
      "delete-run",
      "delete-run-ownership",
      "delete-run-thread",
      "seed-runner-job",
      "seed-queue-entry",
      "seed-queue-marker",
      "seed-export-job",
      "delete-export-job",
      "get-run",
      "get-run-ownership",
      "get-runner-job",
      "get-queue-entry",
      "get-queue-marker-revoker",
      "get-export-job",
      "seed-connector-diagnostic-registration",
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

export const testCronCleanupSandboxesScopeSchema = z.object({
  chatThreadIds: z.array(z.string().uuid()),
  runIds: z.array(z.string().uuid()),
  orgIds: z.array(z.string().min(1)),
  exportJobIds: z.array(z.string().uuid()),
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
  cleanup: {
    method: "POST",
    path: "/api/test/cron-cleanup-sandboxes-state/cleanup",
    body: testCronCleanupSandboxesScopeSchema,
    responses: {
      200: cleanupResponseSchema,
      400: testCronCleanupSandboxesStateErrorSchema,
      404: z.string(),
    },
    summary: "Clean up explicitly registered sandbox test resources",
  },
});

export type TestCronCleanupSandboxesStateActionBody = z.infer<
  typeof testCronCleanupSandboxesStateActionBodySchema
>;
export type TestCronCleanupSandboxesStateActionResponse = z.infer<
  typeof testCronCleanupSandboxesStateActionResponseSchema
>;
export type TestCronCleanupSandboxesScope = z.infer<
  typeof testCronCleanupSandboxesScopeSchema
>;
export type TestCronCleanupSandboxesStateContract =
  typeof testCronCleanupSandboxesStateContract;
