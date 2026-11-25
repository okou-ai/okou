import { createHmac, timingSafeEqual } from "node:crypto";
import { number, object, string } from "zod";
import { env } from "./env";
import { now } from "./time";

const offerSchema = object({
  orgId: string().min(1),
  userId: string().min(1),
  environment: string(),
  expiresAt: number().int(),
});

export function signBillingFeedbackOffer(identity: {
  readonly orgId: string;
  readonly userId: string;
}): string | null {
  const secret = env("BILLING_FEEDBACK_WEBHOOK_SECRET");
  if (!secret) {
    return null;
  }
  const payload = Buffer.from(
    JSON.stringify({
      ...identity,
      environment: env("ENV"),
      expiresAt: now() + 24 * 60 * 60 * 1000,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyBillingFeedbackOffer(token: string): {
  readonly orgId: string;
  readonly userId: string;
} | null {
  const secret = env("BILLING_FEEDBACK_WEBHOOK_SECRET");
  const [payload, signature, extra] = token.split(".");
  if (!secret || !payload || !signature || extra !== undefined) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  // Only the server can produce a valid signature over this JSON.
  const offer = offerSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  return offer.environment === env("ENV") && offer.expiresAt > now()
    ? offer
    : null;
}
