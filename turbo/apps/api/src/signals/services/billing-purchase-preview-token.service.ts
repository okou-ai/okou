import { createHmac, timingSafeEqual } from "node:crypto";

import * as z from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { safeJsonParse } from "../utils";

export const BILLING_PURCHASE_PREVIEW_TTL_MS = 15 * 60 * 1000;

const billingPaymentMethodPreviewTokenSchema = z.object({
  version: z.literal(1),
  operation: z.enum([
    "concurrency",
    "usage_pack_allocation",
    "usage_pack_invitation",
    "usage_pack_subscription",
  ]),
  operationId: z.string().min(1),
  orgId: z.string().min(1),
  customerId: z.string().min(1),
  subscriptionId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  returnUrl: z.string().url(),
  expiresAt: z.iso.datetime(),
});

export type BillingPaymentMethodPreviewToken = z.infer<
  typeof billingPaymentMethodPreviewTokenSchema
>;

function billingPreviewSignature(encodedPayload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest();
}

export function createBillingPreviewToken(payload: unknown): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const encodedSignature =
    billingPreviewSignature(encodedPayload).toString("base64url");
  return `${encodedPayload}.${encodedSignature}`;
}

export function parseBillingPreviewToken<T>(
  token: string,
  schema: z.ZodType<T>,
): T | null {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return null;
  }
  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = billingPreviewSignature(encodedPayload);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }
  const parsed = safeJsonParse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function billingPreviewExpiresAt(at = nowDate()): string {
  return new Date(at.getTime() + BILLING_PURCHASE_PREVIEW_TTL_MS).toISOString();
}

export function createBillingPaymentMethodPreviewToken(
  payload: BillingPaymentMethodPreviewToken,
): string {
  return createBillingPreviewToken(payload);
}

export function parseBillingPaymentMethodPreviewToken(
  token: string,
): BillingPaymentMethodPreviewToken | null {
  return parseBillingPreviewToken(
    token,
    billingPaymentMethodPreviewTokenSchema,
  );
}
