import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const emailOutboxItemIdListSchema = z.array(z.string().uuid()).min(1);
const emailOutboxItemStatusSchema = z.enum([
  "pending",
  "sending",
  "sent",
  "failed",
]);

export const testEmailOutboxStateItemSchema = z.object({
  id: z.string().uuid(),
  from_address: z.string(),
  to_addresses: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  headers: z.record(z.string(), z.string()).nullable(),
  public_brand: z.enum(["vm0", "okou"]),
  template: z.unknown(),
  source_run_id: z.string().uuid().nullable(),
  source_workflow_automation_id: z.string().uuid().nullable(),
  status: emailOutboxItemStatusSchema,
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  resend_id: z.string().nullable(),
  provider_idempotency_key: z.string().nullable(),
  has_provider_request: z.boolean(),
});

export const testOfficialAutomationResultEmailClaimSchema = z.object({
  source_run_id: z.string().uuid(),
  source_workflow_automation_id: z.string().uuid(),
  email_outbox_id: z.string().uuid(),
});

export const testEmailOutboxStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-item"),
      to_address: z.string().min(1),
      subject: z.string().min(1),
      status: z.enum(["pending", "failed"]),
      created_at: z.iso.datetime(),
    }),
    z.object({
      action: z.literal("find-item"),
      to_address: z.string().min(1),
      subject: z.string().min(1),
    }),
    z.object({
      action: z.literal("find-source"),
      source_run_id: z.string().uuid(),
      source_workflow_automation_id: z.string().uuid(),
    }),
    z.object({
      action: z.literal("read-items"),
      item_ids: emailOutboxItemIdListSchema,
    }),
    z.object({
      action: z.literal("delete-items"),
      item_ids: emailOutboxItemIdListSchema,
    }),
  ],
);

export const testEmailOutboxStateActionResponseSchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-item"),
      item: testEmailOutboxStateItemSchema,
    }),
    z.object({
      action: z.literal("find-item"),
      items: z.array(testEmailOutboxStateItemSchema),
    }),
    z.object({
      action: z.literal("find-source"),
      items: z.array(testEmailOutboxStateItemSchema),
      claim: testOfficialAutomationResultEmailClaimSchema.nullable(),
    }),
    z.object({
      action: z.literal("read-items"),
      items: z.array(testEmailOutboxStateItemSchema),
    }),
    z.object({
      action: z.literal("delete-items"),
      deleted: z.number().int().nonnegative(),
    }),
  ],
);

export const testEmailOutboxStateDrainBodySchema = z.object({
  item_ids: emailOutboxItemIdListSchema,
});

export const testEmailOutboxStateDrainResponseSchema = z.object({
  drained: z.number().int().nonnegative(),
});

export const testEmailOutboxStateCleanupBodySchema = z.object({
  item_ids: emailOutboxItemIdListSchema,
});

export const testEmailOutboxStateCleanupResponseSchema = z.object({
  cleaned: z.number().int().nonnegative(),
});

export const testEmailOutboxStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/email-outbox-state/action",
    body: testEmailOutboxStateActionBodySchema,
    responses: {
      200: testEmailOutboxStateActionResponseSchema,
      404: z.string(),
    },
    summary: "Mutate and read email outbox API test support state",
  },
  drain: {
    method: "POST",
    path: "/api/test/email-outbox-state/drain",
    body: testEmailOutboxStateDrainBodySchema,
    responses: {
      200: testEmailOutboxStateDrainResponseSchema,
      404: z.string(),
    },
    summary: "Drain selected email outbox items in API tests",
  },
  cleanup: {
    method: "POST",
    path: "/api/test/email-outbox-state/cleanup",
    body: testEmailOutboxStateCleanupBodySchema,
    responses: {
      200: testEmailOutboxStateCleanupResponseSchema,
      404: z.string(),
    },
    summary: "Clean up selected expired email outbox items in API tests",
  },
});

export type TestEmailOutboxStateItem = z.infer<
  typeof testEmailOutboxStateItemSchema
>;
export type TestOfficialAutomationResultEmailClaim = z.infer<
  typeof testOfficialAutomationResultEmailClaimSchema
>;
export type TestEmailOutboxStateActionBody = z.infer<
  typeof testEmailOutboxStateActionBodySchema
>;
export type TestEmailOutboxStateActionResponse = z.infer<
  typeof testEmailOutboxStateActionResponseSchema
>;
export type TestEmailOutboxStateContract = typeof testEmailOutboxStateContract;
