import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import type { NativeDispatchTask } from "./morning-brief-native-executor.service";

const log = logger("MorningBriefNativeDispatch");
const WORKER_PATH = "/api/internal/morning-brief-worker";
const AUTH_SKEW_MS = 60_000;
const WORKER_KEY_CONTEXT = "okou:morning-brief-worker-dispatch:v1";

export function nativeHttpFanoutEnabled(): boolean {
  return env("MORNING_BRIEF_HTTP_FANOUT") === "true";
}

function workerSigningKey(): Buffer {
  // The full configured string is the HKDF input; permissive hex decoding of
  // a malformed value could otherwise produce a predictable empty key.
  return Buffer.from(
    hkdfSync(
      "sha256",
      env("SECRETS_ENCRYPTION_KEY"),
      "",
      WORKER_KEY_CONTEXT,
      32,
    ),
  );
}

function signature(
  task: {
    readonly orgId: string;
    readonly userId: string;
    readonly scheduledFor: string;
  },
  timestamp: string,
): Buffer {
  return createHmac("sha256", workerSigningKey())
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
  if (
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
  const expected = signature(task, timestamp);
  return timingSafeEqual(actual, expected);
}

/** Await only short admission, never the model or delivery. The database is the retry source. */
export async function dispatchNativeWorker(
  task: NativeDispatchTask,
  signal: AbortSignal,
): Promise<boolean> {
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
        "x-morning-brief-signature": signature(payload, timestamp).toString(
          "hex",
        ),
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
