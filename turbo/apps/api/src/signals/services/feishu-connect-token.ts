import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { env } from "../../lib/env";
import { now } from "../../lib/time";

const CONNECT_LINK_MAX_AGE_SECONDS = 10 * 60;

function payload(args: {
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
}): string {
  return JSON.stringify([
    args.installationId,
    args.openId,
    args.chatId,
    args.timestamp,
  ]);
}

function signFeishuConnectToken(args: {
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(payload(args))
    .digest("hex");
}

export function verifyFeishuConnectToken(args: {
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
  readonly signature: string;
}): boolean {
  const currentTimestamp = Math.floor(now() / 1000);
  if (
    args.timestamp > currentTimestamp + 60 ||
    currentTimestamp - args.timestamp > CONNECT_LINK_MAX_AGE_SECONDS
  ) {
    return false;
  }
  const expected = Buffer.from(
    signFeishuConnectToken({
      installationId: args.installationId,
      openId: args.openId,
      chatId: args.chatId,
      timestamp: args.timestamp,
    }),
    "utf8",
  );
  const actual = Buffer.from(args.signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildFeishuConnectUrl(args: {
  readonly platform?: FeishuPlatform;
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly publicBrand: PublicBrand;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const params = new URLSearchParams({
    connect: "account",
    installationId: args.installationId,
    openId: args.openId,
    chatId: args.chatId,
    ts: String(timestamp),
    sig: signFeishuConnectToken({ ...args, timestamp }),
  });
  const url = new URL(
    FEISHU_PLATFORMS[args.platform ?? "feishu"].settingsPath,
    env("APP_URL"),
  );
  url.search = params.toString();
  return url.toString();
}
