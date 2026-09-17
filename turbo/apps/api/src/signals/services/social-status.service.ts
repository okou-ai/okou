import {
  socialOperationBindings,
  type SocialPlatform,
  type SocialStatusResponse,
} from "@okouai/api-contracts/contracts/social-discovery";
import { findManagedSocialKitTool } from "@okouai/api-contracts/contracts/social";
import { command } from "ccstate";
import { z } from "zod";

import { now } from "../../lib/time";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse } from "../utils";

const STATUS_URL = "https://api.socialkit.dev/status";
// Okou's observation policy, not an upstream freshness guarantee.
const STALE_AFTER_SECONDS = 300;
const MAX_FUTURE_SKEW_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;
const MAX_STATUS_BYTES = 256 * 1024;

const statusEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({
    overall: z.unknown(),
    generatedAt: z.unknown(),
    tools: z.array(z.unknown()),
  }),
});
const toolIdentitySchema = z.object({ id: z.string() });
const toolStatusSchema = toolIdentitySchema.extend({
  status: z.unknown(),
  updatedAt: z.unknown(),
});
const timestampSchema = z.iso.datetime({ offset: true });
const providerHealthSchema = z.enum(["green", "yellow", "red"]);
const healthByColor = {
  green: "healthy",
  yellow: "degraded",
  red: "unavailable",
} as const;
type Observation = SocialStatusResponse["overall"];
type UnknownReason = NonNullable<Observation["reason"]>;

function unknown(
  reason: UnknownReason,
  updatedAt: string | null = null,
): Observation {
  return { status: "unknown", updatedAt, reason };
}

function observation(
  status: unknown,
  timestamp: unknown,
  observedAt: number,
): Observation {
  const parsedTime = timestampSchema.safeParse(timestamp);
  if (!parsedTime.success) {
    return unknown("invalid_timestamp");
  }
  const age = observedAt - Date.parse(parsedTime.data);
  if (age < -MAX_FUTURE_SKEW_MS) {
    return unknown("invalid_timestamp", parsedTime.data);
  }
  if (age > STALE_AFTER_SECONDS * 1000) {
    return unknown("stale", parsedTime.data);
  }
  const health = providerHealthSchema.safeParse(status);
  if (!health.success) {
    return unknown("invalid_response", parsedTime.data);
  }
  return {
    status: healthByColor[health.data],
    updatedAt: parsedTime.data,
    reason: null,
  };
}

function statusId(
  entry: ReturnType<typeof socialOperationBindings>[number],
): string {
  if (entry.tool === null) {
    // Durable V2 downloads are separate from the legacy download tools.
    return `${entry.platform}.async-download`;
  }
  const tool = findManagedSocialKitTool(entry.tool);
  if (!tool) {
    throw new Error("Social discovery has an unreviewed tool binding");
  }
  return tool.path.slice(1).replace("/", ".");
}

function toolObservation(
  id: string,
  tools: readonly unknown[],
  observedAt: number,
): Observation {
  const matches = tools.filter((entry) => {
    const identity = toolIdentitySchema.safeParse(entry);
    return identity.success && identity.data.id === id;
  });
  if (matches.length === 0) {
    return unknown("missing_entry");
  }
  if (matches.length > 1) {
    return unknown("duplicate_entry");
  }
  const parsed = toolStatusSchema.safeParse(matches[0]);
  return parsed.success
    ? observation(parsed.data.status, parsed.data.updatedAt, observedAt)
    : unknown("invalid_response");
}

function normalizeStatus(
  body: unknown,
  platform: SocialPlatform | undefined,
  observedAt: number,
  failure?: UnknownReason,
): SocialStatusResponse {
  const parsed = statusEnvelopeSchema.safeParse(body);
  const snapshot =
    parsed.success && !failure
      ? observation(
          parsed.data.data.overall,
          parsed.data.data.generatedAt,
          observedAt,
        )
      : unknown(failure ?? "invalid_response");
  const operations = socialOperationBindings(platform).map((entry) => {
    const health =
      parsed.success && snapshot.status !== "unknown"
        ? toolObservation(statusId(entry), parsed.data.data.tools, observedAt)
        : snapshot;
    return {
      platform: entry.platform,
      operation: entry.operation,
      variant: entry.variant,
      ...health,
    };
  });
  // Never summarize a selected unknown or impaired operation as healthy.
  const priority = {
    healthy: 0,
    unknown: 1,
    degraded: 2,
    unavailable: 3,
  } as const;
  const worst = operations.reduce<Observation>((current, entry) => {
    return priority[entry.status] > priority[current.status] ? entry : current;
  }, snapshot);
  return {
    observedAt: new Date(observedAt).toISOString(),
    staleAfterSeconds: STALE_AFTER_SECONDS,
    overall: {
      status: worst.status,
      updatedAt: snapshot.updatedAt,
      reason: worst.reason,
    },
    operations,
  };
}

export const socialStatus$ = command(
  async (
    { get },
    platform: SocialPlatform | undefined,
    signal: AbortSignal,
  ): Promise<SocialStatusResponse> => {
    const callerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    callerSignal.throwIfAborted();
    const requestSignal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(STATUS_TIMEOUT_MS),
    ]);
    // Transport/body aborts can be caused by our deadline. Caller cancellation
    // remains owned by callerSignal and is propagated before normalization.
    const [result] = await Promise.allSettled([
      (async () => {
        const response = await fetch(STATUS_URL, {
          headers: { accept: "application/json" },
          signal: requestSignal,
          redirect: "error",
          cache: "no-store",
        });
        const text = await readBoundedResponseText(response, MAX_STATUS_BYTES);
        return {
          ok: response.ok,
          body:
            text.kind === "too_large" ? undefined : safeJsonParse(text.text),
        };
      })(),
    ]);
    signal.throwIfAborted();
    callerSignal.throwIfAborted();
    if (result.status === "rejected") {
      return normalizeStatus(undefined, platform, now(), "network_error");
    }
    return normalizeStatus(
      result.value.body,
      platform,
      now(),
      result.value.ok ? undefined : "status_unavailable",
    );
  },
);
