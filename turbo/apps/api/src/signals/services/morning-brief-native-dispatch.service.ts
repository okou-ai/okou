import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import type { NativeDispatchTask } from "./morning-brief-native-executor.service";

const log = logger("MorningBriefNativeDispatch");
const WORKER_PATH = "/api/internal/morning-brief-worker";
const AUTH_SKEW_MS = 60_000;

export function nativeHttpFanoutEnabled(): boolean {
  return env("MORNING_BRIEF_HTTP_FANOUT") === "true";
}

function signature(
  secret: string,
  task: {
    readonly orgId: string;
    readonly userId: string;
    readonly scheduledFor: string;
  },
  timestamp: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`POST\n${WORKER_PATH}\n${timestamp}\n${JSON.stringify(task)}`)
    .digest();
}

/** A public URL is not private ingress: only a current, signed internal dispatch is admitted. */
export function verifyNativeWorkerDispatch(
  task: {
    readonly orgId: string;
    readonly userId: string;
    readonly scheduledFor: string;
  },
  timestamp: string | undefined,
  digest: string | undefined,
): boolean {
  const secret = env("MORNING_BRIEF_WORKER_SECRET");
  if (
    !secret ||
    !timestamp ||
    !digest ||
    !/^\d{13}$/.test(timestamp) ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return false;
  }
  if (Math.abs(nowDate().getTime() - Number(timestamp)) > AUTH_SKEW_MS) {
    return false;
  }
  const actual = Buffer.from(digest, "hex");
  const expected = signature(secret, task, timestamp);
  return timingSafeEqual(actual, expected);
}

/** Await only short admission, never the model or delivery. The database is the retry source. */
export async function dispatchNativeWorker(
  task: NativeDispatchTask,
  signal: AbortSignal,
): Promise<boolean> {
  const secret = env("MORNING_BRIEF_WORKER_SECRET");
  if (!secret) {
    throw new Error("Morning Brief worker dispatch secret is not configured");
  }
  const payload = {
    orgId: task.orgId,
    userId: task.userId,
    scheduledFor: task.scheduledFor.toISOString(),
  };
  const timestamp = String(nowDate().getTime());
  const result = await settleIncludingAbort(
    fetch(new URL(WORKER_PATH, internalApiBaseUrl()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-morning-brief-timestamp": timestamp,
        "x-morning-brief-signature": signature(
          secret,
          payload,
          timestamp,
        ).toString("hex"),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
    }),
  );
  if (!result.ok) {
    if (!signal.aborted) {
      log.warn("Morning Brief worker dispatch failed", {
        orgId: task.orgId,
        scheduledFor: payload.scheduledFor,
        error: result.error,
      });
    }
    return false;
  }
  if (result.value.status === 202) {
    return true;
  }
  log.warn("Morning Brief worker dispatch was not accepted", {
    orgId: task.orgId,
    scheduledFor: payload.scheduledFor,
    status: result.value.status,
  });
  return false;
}
