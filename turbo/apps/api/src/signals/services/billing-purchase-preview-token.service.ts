import { createHmac, timingSafeEqual } from "node:crypto";

import {
  iso,
  literal,
  object,
  string,
  url,
  enum as zEnum,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { safeJsonParse } from "../utils";

export const BILLING_PURCHASE_PREVIEW_TTL_MS = 15 * 60 * 1000;

const billingPaymentMethodPreviewTokenSchema = object({
  version: literal(1),
  operation: zEnum([
    "concurrency",
    "usage_pack_allocation",
    "usage_pack_invitation",
    "usage_pack_subscription",
  ]),
  operationId: string().min(1),
  orgId: string().min(1),
  customerId: string().min(1),
  subscriptionId: string().min(1),
  paymentMethodId: string().min(1),
  returnUrl: url(),
  expiresAt: iso.datetime(),
});

export type BillingPaymentMethodPreviewToken = zInfer<
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
  schema: ZodType<T>,
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
