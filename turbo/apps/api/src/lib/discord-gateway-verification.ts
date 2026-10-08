import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DISCORD_GATEWAY_MAX_CLOCK_SKEW_SECONDS,
  discordGatewaySigningPayload,
} from "@okouai/api-contracts/contracts/discord-gateway";

import { now } from "./time";

export function verifyDiscordGatewaySignature(args: {
  readonly secret: string;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly body: string;
}): boolean {
  if (
    !args.timestamp ||
    !/^\d{1,12}$/.test(args.timestamp) ||
    !args.signature ||
    !/^[0-9a-f]{64}$/i.test(args.signature)
  ) {
    return false;
  }
  const requestTime = Number(args.timestamp);
  if (
    Math.abs(Math.floor(now() / 1000) - requestTime) >
    DISCORD_GATEWAY_MAX_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  const expected = createHmac("sha256", args.secret)
    .update(discordGatewaySigningPayload(args.timestamp, args.body))
    .digest();
  return timingSafeEqual(Buffer.from(args.signature, "hex"), expected);
}
