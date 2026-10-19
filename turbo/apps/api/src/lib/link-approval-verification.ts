import { createHmac, timingSafeEqual } from "node:crypto";
import { now } from "./time";

export function verifyLinkApprovalSignature(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  body: string,
): boolean {
  if (
    !timestamp ||
    !/^\d{1,12}$/u.test(timestamp) ||
    !signature ||
    !/^[a-f0-9]{64}$/u.test(signature) ||
    Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
