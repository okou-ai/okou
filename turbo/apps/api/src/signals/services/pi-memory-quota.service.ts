import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  awaitWithSignal,
  readBoundedResponseText,
  safeJsonParse,
  settleIncludingAbort,
} from "../utils";
import { readPiMemoryBuiltinQuota } from "./pi-memory-builtin-quota.service";

export type PiMemoryQuotaSource =
  | { readonly providerClass: "builtin" | "api_key" }
  | {
      readonly providerClass: "codex";
      readonly accessToken: string;
      readonly accountId: string;
    };

export interface PiMemoryQuotaDecision {
  readonly decision: "allowed" | "denied" | "unknown" | "unavailable";
  readonly reason:
    | "quota_available"
    | "quota_below_threshold"
    | "quota_limit_reached"
    | "quota_unavailable"
    | "metadata_missing"
    | "metadata_unrecognized"
    | "metadata_read_failed"
    | "metadata_timeout"
    | "not_supported"
    | "cash_percentage_unknown"
    | "entitlement_stale";
  readonly bucket?:
    | "primary"
    | "secondary"
    | "short"
    | "weekly"
    | "member_pool";
  readonly remainingPercent?: number;
}

export class PiMemoryQuotaError extends Error {
  constructor(
    readonly errorClass:
      | "quota_below_threshold"
      | "quota_limit_reached"
      | "quota_unavailable",
  ) {
    super("Pi memory quota admission failed");
    this.name = "PiMemoryQuotaError";
  }
}

const log = logger("PiMemoryQuota");
const REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function absentMetadata(value: unknown): boolean {
  return value === null || value === undefined;
}

function codexLimitReached(
  root: Record<string, unknown> | undefined,
  rate: Record<string, unknown> | undefined,
): boolean {
  const reached = object(root?.rate_limit_reached_type)?.type;
  return (
    (typeof reached === "string" &&
      REACHED_TYPES.some((type) => {
        return type === reached;
      })) ||
    rate?.allowed === false ||
    rate?.limit_reached === true
  );
}

function codexDecision(payload: unknown): PiMemoryQuotaDecision {
  const root = object(payload);
  const rate = object(root?.rate_limit);
  // Parse independently: unrelated malformed fields must never erase a denial.
  if (codexLimitReached(root, rate)) {
    return { decision: "denied", reason: "quota_limit_reached" };
  }
  let limiting: PiMemoryQuotaDecision | undefined;
  let unknown = !absentMetadata(root?.rate_limit_reached_type);
  for (const bucket of ["primary", "secondary"] as const) {
    const used = object(rate?.[`${bucket}_window`])?.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
      unknown = true;
      continue;
    }
    const remainingPercent = Math.max(100 - used, 0);
    if (used > 75) {
      return {
        decision: "denied",
        reason: "quota_below_threshold",
        bucket,
        remainingPercent,
      };
    }
    if (!limiting || remainingPercent < (limiting.remainingPercent ?? 100)) {
      limiting = {
        decision: "allowed",
        reason: "quota_available",
        bucket,
        remainingPercent,
      };
    }
  }
  if (unknown || !limiting) {
    return {
      ...limiting,
      decision: "unknown",
      reason:
        absentMetadata(root?.rate_limit) &&
        absentMetadata(root?.rate_limit_reached_type)
          ? "metadata_missing"
          : "metadata_unrecognized",
    };
  }
  return limiting;
}

async function readCodexQuota(
  source: Extract<PiMemoryQuotaSource, { providerClass: "codex" }>,
  signal: AbortSignal,
): Promise<PiMemoryQuotaDecision> {
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(5000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  // Metadata timeout is an owned unknown outcome; caller cancellation is
  // rethrown below even when fetch reports it as a generic transport failure.
  const result = await settleIncludingAbort(
    awaitWithSignal(fetchCodexQuota(source, requestSignal), requestSignal),
  );
  signal.throwIfAborted();
  return result.ok
    ? result.value
    : {
        decision: "unknown",
        reason: timeout.aborted ? "metadata_timeout" : "metadata_read_failed",
      };
}

async function fetchCodexQuota(
  source: Extract<PiMemoryQuotaSource, { providerClass: "codex" }>,
  signal: AbortSignal,
): Promise<PiMemoryQuotaDecision> {
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      authorization: `Bearer ${source.accessToken}`,
      "chatgpt-account-id": source.accountId,
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.0.0",
    },
    redirect: "error",
    signal,
  });
  // Bound metadata, including error responses; these can still contain denial.
  const body = await readBoundedResponseText(response, 65_536);
  signal.throwIfAborted();
  if (body.kind === "too_large") {
    return { decision: "unknown", reason: "metadata_unrecognized" };
  }
  const decision = codexDecision(safeJsonParse(body.text));
  return response.ok || decision.decision === "denied"
    ? decision
    : { decision: "unknown", reason: "metadata_read_failed" };
}

/** One admission snapshot per new attempt; never a reservation or per-turn poll. */
export async function checkPiMemoryQuota(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly stage: "stage1" | "phase2";
    readonly source: PiMemoryQuotaSource;
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const decision =
    args.source.providerClass === "codex"
      ? await readCodexQuota(args.source, signal)
      : args.source.providerClass === "builtin"
        ? await readPiMemoryBuiltinQuota(db, args, nowDate(), signal)
        : ({ decision: "unknown", reason: "not_supported" } as const);
  signal.throwIfAborted();
  log.info("Pi memory quota admission", {
    stage: args.stage,
    providerClass: args.source.providerClass,
    thresholdPercent: 25,
    ...decision,
  });
  if (
    decision.reason === "quota_below_threshold" ||
    decision.reason === "quota_limit_reached" ||
    decision.reason === "quota_unavailable"
  ) {
    throw new PiMemoryQuotaError(decision.reason);
  }
}
