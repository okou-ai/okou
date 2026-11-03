import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";

function signature(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`friend-referral-visit:v1:${payload}`)
    .digest();
}

export function friendReferralVisitToken(code: string, at: Date): string {
  const payload = `${code}.${at.getTime()}`;
  return `${payload}.${signature(payload).toString("hex")}`;
}

/** The browser cannot backdate a visit to make an existing account eligible. */
export function readFriendReferralVisit(token: string, at: Date) {
  const match = /^([a-f0-9-]{36})\.([0-9]{13})\.([a-f0-9]{64})$/u.exec(token);
  if (!match) {
    return null;
  }
  const [, code, timestamp, mac] = match;
  if (!code || !timestamp || !mac) {
    return null;
  }
  const visitedAt = Number(timestamp);
  const actual = Buffer.from(mac, "hex");
  const expected = signature(`${code}.${timestamp}`);
  if (visitedAt > at.getTime() || !timingSafeEqual(actual, expected)) {
    return null;
  }
  return { code, visitedAt };
}
