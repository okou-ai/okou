import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const BILLING_RECONCILIATION_FIXTURE_KINDS = [
  "plan-subscription",
  "atom-grant",
  "concurrency",
  "usage-allowance",
  "usage-pack-subscription",
  "usage-pack-subscription-change",
  "usage-pack-allocation-change",
  "usage-pack-refund",
  "usage-pack-migration",
  "usage-pack-invitation",
] as const;

const fixtureKindSchema = z.enum(BILLING_RECONCILIATION_FIXTURE_KINDS);
const markerSchema = z.string().uuid();
const fixtureModeSchema = z.enum(["stale", "active", "unbound"]);

const fixtureReferenceSchema = z.object({
  kind: fixtureKindSchema,
  orgId: z.string().min(1),
  stripeSubscriptionId: z.string().nullable(),
  stripeCheckoutSessionId: z.string().nullable(),
  stripePaymentIntentId: z.string().nullable(),
});

const candidateStateSchema = z.object({
  kind: fixtureKindSchema,
  orgId: z.string().min(1),
  status: z.string().min(1),
  tier: z.string().nullable(),
  credits: z.number().int().nullable(),
  stripeSubscriptionId: z.string().nullable(),
});

export const testBillingReconciliationStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seed"),
      marker: markerSchema,
      mode: fixtureModeSchema.optional(),
    }),
    z.object({ action: z.literal("read"), marker: markerSchema }),
    z.object({ action: z.literal("cleanup"), marker: markerSchema }),
  ]);

export const testBillingReconciliationStateActionResponseSchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seeded"),
      fixtures: z.array(fixtureReferenceSchema),
    }),
    z.object({
      action: z.literal("read"),
      candidates: z.array(candidateStateSchema),
      creditExpirations: z.array(
        z.object({
          stripeInvoiceId: z.string().min(1),
          expiresAt: z.iso.datetime(),
        }),
      ),
    }),
    z.object({ action: z.literal("ok") }),
  ]);

export const testBillingReconciliationStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/billing-reconciliation-state/action",
    body: testBillingReconciliationStateActionBodySchema,
    responses: {
      200: testBillingReconciliationStateActionResponseSchema,
      404: z.string(),
      500: z.object({ error: z.string() }),
    },
    summary: "Manage organization-owned billing reconciliation fixtures",
  },
});

export type BillingReconciliationFixtureKind =
  (typeof BILLING_RECONCILIATION_FIXTURE_KINDS)[number];
export type TestBillingReconciliationStateActionBody = z.infer<
  typeof testBillingReconciliationStateActionBodySchema
>;
export type TestBillingReconciliationStateActionResponse = z.infer<
  typeof testBillingReconciliationStateActionResponseSchema
>;
