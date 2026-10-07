import { createHash } from "node:crypto";
import { delay } from "signal-timers";
import { z } from "zod";

import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import { awaitWithSignal, onRejection, settle, tapError } from "../utils";

interface CodexExpiryOwner {
  readonly orgId: string;
  readonly userId: string;
}

interface Credentials {
  readonly accessToken: string;
  readonly accountId: string;
}

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  waiters: number;
}

interface Entry {
  readonly ownerKey: string;
  readonly binding: string | null;
  credentialKey: string | undefined;
  accountKey: string | undefined;
  version: number;
  expiresAt: Date | null;
  trustedUntil: number;
  cooldownUntil: number;
  flight: Flight | undefined;
}

const DETAILS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const TTL_MS = 5 * 60_000;
const COOLDOWN_MS = 60_000;
const DETAILS_TIMEOUT_MS = 5000;
// Best-effort warm-instance LRU, including in-flight entries. Eviction aborts
// owned work and invalidates every outstanding reader; cold instances are independent.
const MAX_ENTRIES = 256;
const entries = singleton(() => {
  return new Map<string, Entry>();
});
const L = logger("codex-reset-credit-expiry.service");
const observation = singleton(() => {
  return {
    since: now(),
    counts: {
      cached: 0,
      coalesced: 0,
      cooldown: 0,
      success: 0,
      rate_limited: 0,
      unavailable: 0,
      local_timeout: 0,
      unexpected_failure: 0,
    },
  };
});

function record(outcome: keyof ReturnType<typeof observation>["counts"]): void {
  const summary = observation();
  summary.counts[outcome] = Math.min(
    Number.MAX_SAFE_INTEGER,
    summary.counts[outcome] + 1,
  );
  if (now() - summary.since >= COOLDOWN_MS) {
    // Demand-driven, at most one aggregate per minute per warm instance. Never
    // include owner keys, account IDs, credentials, or per-waiter log records.
    L.info("codex reset credit expiry outcomes", {
      windowMs: now() - summary.since,
      ...summary.counts,
    });
    observation.reset();
  }
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function ownerKey(owner: CodexExpiryOwner): string {
  return digest([owner.orgId, owner.userId]);
}

function invalidate(entry: Entry): void {
  entry.version += 1;
  entry.expiresAt = null;
  entry.trustedUntil = 0;
  entry.cooldownUntil = 0;
  const flight = entry.flight;
  entry.flight = undefined;
  // This is owned cache invalidation, not a caller AbortError or local timeout.
  flight?.controller.abort(new Error("Codex expiry read invalidated"));
}

export function invalidateCodexResetCreditExpiry(
  expiryOwner: CodexExpiryOwner,
  target: { readonly binding: string | null } | { readonly accountId: string },
): void {
  const owner = ownerKey(expiryOwner);
  const accountKey =
    "accountId" in target ? digest([target.accountId]) : undefined;
  for (const entry of entries().values()) {
    if (entry.ownerKey !== owner) {
      continue;
    }
    const matches =
      "binding" in target
        ? entry.binding === target.binding
        : entry.binding === null ||
          entry.binding === "connect" ||
          entry.accountKey === undefined ||
          entry.accountKey === accountKey;
    if (matches) {
      // Reconnect may replace the legacy slot, but must preserve another
      // concrete account's cached value and retained Retry-After deadline.
      invalidate(entry);
    }
  }
}

function httpDateTimestamp(header: string): number {
  // HTTP-date permits IMF-fixdate and the two obsolete wire forms. Normalize
  // before parsing so Date.parse cannot admit ISO dates or normalized bad dates.
  const normalized = header
    .replace(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2}-[A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/,
      (
        _match: string,
        weekday: string,
        dayMonth: string,
        year: string,
        time: string,
      ) => {
        const currentYear = new Date(now()).getUTCFullYear();
        let fullYear = Math.floor(currentYear / 100) * 100 + Number(year);
        if (fullYear > currentYear + 50) {
          fullYear -= 100;
        } else if (fullYear < currentYear - 50) {
          fullYear += 100;
        }
        return `${weekday.slice(0, 3)}, ${dayMonth.replace("-", " ")} ${fullYear} ${time} GMT`;
      },
    )
    .replace(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/,
      "$1, $3 $2 $5 $4 GMT",
    )
    .replace(/, {2}(\d) /, ", 0$1 ");
  const timestamp = Date.parse(normalized);
  return new Date(timestamp).toUTCString() === normalized
    ? timestamp
    : Number.NaN;
}

function retryAfterDeadline(value: string | null): number {
  const current = now();
  const fallback = current + COOLDOWN_MS;
  if (!value || value.length > 128) {
    return fallback;
  }
  const header = value.trim();
  const deadline = /^\d+$/.test(header)
    ? current + Number(header) * 1000
    : httpDateTimestamp(header);
  return Number.isSafeInteger(deadline) &&
    deadline > current &&
    deadline <= 8_640_000_000_000_000
    ? deadline
    : fallback;
}

const detailsSchema = z.object({
  credits: z
    .array(
      z.object({
        status: z.string().nullable().optional(),
        expires_at: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

async function fetchDetails(args: Credentials, signal: AbortSignal) {
  const response = await fetch(DETAILS_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "chatgpt-account-id": args.accountId,
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.0.0",
    },
    signal,
  });
  if (response.status === 429) {
    return {
      outcome: "rate_limited" as const,
      cooldownUntil: retryAfterDeadline(response.headers.get("retry-after")),
    };
  }
  if (response.status === 503) {
    return {
      outcome: "unavailable" as const,
      cooldownUntil: now() + COOLDOWN_MS,
    };
  }
  if (!response.ok) {
    throw new Error(
      `Codex reset credit details request failed with status ${response.status}`,
    );
  }
  const parsed = detailsSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Codex reset credit details response shape unrecognized");
  }
  let expiresAt: Date | null = null;
  for (const credit of parsed.data.credits ?? []) {
    if (credit.status !== "available" || !credit.expires_at) {
      continue;
    }
    const candidate = new Date(credit.expires_at);
    if (candidate.getTime() > now() && (!expiresAt || candidate < expiresAt)) {
      expiresAt = candidate;
    }
  }
  return { outcome: "success" as const, expiresAt };
}

async function load(
  entry: Entry,
  args: Credentials,
  signal: AbortSignal,
): Promise<void> {
  const version = entry.version;
  const controller = new AbortController();
  const detailsSignal = AbortSignal.any([signal, controller.signal]);
  let timedOut = false;
  const deadline = tapError(
    (async () => {
      await awaitWithSignal(
        delay(DETAILS_TIMEOUT_MS, { signal: detailsSignal }),
        detailsSignal,
      );
      timedOut = true;
      controller.abort(
        new DOMException("Codex expiry deadline", "TimeoutError"),
      );
    })(),
  );
  const finishDeadline = async () => {
    controller.abort(new Error("Codex expiry read settled"));
    await deadline;
  };
  const result = await onRejection(
    settle(awaitWithSignal(fetchDetails(args, detailsSignal), detailsSignal)),
    finishDeadline,
  );
  await finishDeadline();
  if (entry.version !== version) {
    return;
  }
  if (result.ok) {
    record(result.value.outcome);
    if (result.value.outcome === "success") {
      entry.expiresAt = result.value.expiresAt;
      entry.trustedUntil = now() + TTL_MS;
    } else {
      entry.cooldownUntil = result.value.cooldownUntil;
    }
  } else if (timedOut) {
    record("local_timeout");
    entry.cooldownUntil = now() + COOLDOWN_MS;
  } else {
    record("unexpected_failure");
    L.warn("failed to read codex reset credit expiry", { error: result.error });
  }
}

/** Capture before credential resolution so invalidation also fences readers
 * still awaiting credentials. The returned accessor rechecks at serialization,
 * after the independent main usage GET/body may have finished much later. */
export function prepareCodexResetCreditExpiryRead(
  expiryOwner: CodexExpiryOwner,
  binding: string | null = null,
) {
  const owner = ownerKey(expiryOwner);
  const key = digest([owner, binding]);
  const cache = entries();
  let entry = cache.get(key);
  if (entry) {
    cache.delete(key);
  } else {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.entries().next().value;
      if (oldest) {
        invalidate(oldest[1]);
        cache.delete(oldest[0]);
      }
    }
    entry = {
      ownerKey: owner,
      binding,
      credentialKey: undefined,
      accountKey: undefined,
      version: 0,
      expiresAt: null,
      trustedUntil: 0,
      cooldownUntil: 0,
      flight: undefined,
    };
  }
  cache.set(key, entry);
  return readerForEntry(cache, key, entry);
}

function readerForEntry(cache: Map<string, Entry>, key: string, entry: Entry) {
  let version = entry.version;
  const current = () => {
    return cache.get(key) === entry && entry.version === version;
  };
  const value = () => {
    return current() &&
      entry.trustedUntil > now() &&
      entry.expiresAt &&
      entry.expiresAt.getTime() > now()
      ? entry.expiresAt
      : null;
  };
  return async (args: Credentials, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!current()) {
      return value;
    }
    const credentialKey = digest([args.accountId, args.accessToken]);
    if (entry.credentialKey !== credentialKey) {
      if (entry.credentialKey !== undefined) {
        invalidate(entry);
        version = entry.version;
      }
      entry.credentialKey = credentialKey;
      entry.accountKey = digest([args.accountId]);
    }
    if (entry.cooldownUntil > now()) {
      record("cooldown");
      return value;
    }
    if (entry.trustedUntil > now()) {
      record("cached");
      return value;
    }
    let flight = entry.flight;
    if (flight) {
      record("coalesced");
    } else {
      const controller = new AbortController();
      flight = {
        controller,
        waiters: 0,
        promise: load(entry, args, controller.signal).finally(() => {
          if (entry.flight?.controller === controller) {
            entry.flight = undefined;
          }
        }),
      };
      entry.flight = flight;
    }
    const ownedFlight = flight;
    ownedFlight.waiters += 1;
    const leave = async () => {
      ownedFlight.waiters -= 1;
      if (ownedFlight.waiters === 0 && entry.flight === ownedFlight) {
        invalidate(entry);
        await ownedFlight.promise;
      }
    };
    await onRejection(awaitWithSignal(ownedFlight.promise, signal), leave);
    await leave();
    signal.throwIfAborted();
    return value;
  };
}
