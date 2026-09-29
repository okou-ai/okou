import { Axiom } from "@axiomhq/js";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { monotonicNow, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { safeSync, settleIncludingAbort, tapError } from "../utils";

interface AxiomIngestClient {
  readonly ingest: (
    dataset: string,
    events: readonly Record<string, unknown>[],
  ) => Promise<unknown> | unknown;
}

interface OperationTimingAttrs {
  readonly actionType: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly timestamp?: string;
  readonly dimensions?: Record<string, unknown>;
}

interface SandboxOperationAttrs extends OperationTimingAttrs {
  readonly sandboxType: "runner" | "docker" | "chat";
  readonly runId: string;
}

interface UnlinkedOperationAttrs extends OperationTimingAttrs {
  readonly operationDomain: "billing" | "api";
}

const telemetryAxiomClient = singleton((): Axiom => {
  return new Axiom({ token: env("AXIOM_TOKEN_TELEMETRY") });
});
const L = logger("SandboxOpLog");

function hasIngest(client: Axiom): client is Axiom & AxiomIngestClient {
  return (
    "ingest" in client &&
    typeof (client as { readonly ingest: unknown }).ingest === "function"
  );
}

export function recordSandboxOperation(attrs: SandboxOperationAttrs): void {
  recordSandboxOperations([attrs]);
}

export function recordSandboxOperations(
  attrsList: readonly SandboxOperationAttrs[],
): void {
  recordOperationTimings(attrsList);
}

/** Billing work shares the operation-timing dataset but has no sandbox or run. */
export function recordBillingOperationTimings(
  attrsList: readonly OperationTimingAttrs[],
): void {
  recordOperationTimings(
    attrsList.map((attrs) => {
      return { ...attrs, operationDomain: "billing" as const };
    }),
  );
}

/** Aggregate API operation observations without a Run or user identifier. */
export function recordApiOperationTimings(
  attrsList: readonly OperationTimingAttrs[],
): void {
  recordOperationTimings(
    attrsList.map((attrs) => {
      return { ...attrs, operationDomain: "api" as const };
    }),
  );
}

export type McpClientNameLookupOutcome =
  | "ineligible"
  | "validated"
  | "invalid_metadata"
  | "http_unavailable"
  | "unsafe_url"
  | "lookup_failed"
  | "timeout"
  | "caller_cancelled";

/** One content-free lookup observation; even abort-shaped sink errors are optional. */
export async function recordMcpClientNameLookup(args: {
  readonly outcome: McpClientNameLookupOutcome;
  readonly fetchInvoked: boolean;
  readonly startedAt: number;
}): Promise<void> {
  await settleIncludingAbort(() => {
    const elapsed = monotonicNow() - args.startedAt;
    recordApiOperationTimings([
      {
        actionType: "mcp_client_display_name_lookup",
        durationMs: Number.isFinite(elapsed)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
          : 0,
        success: args.outcome === "validated",
        dimensions: {
          lookup_outcome: args.outcome,
          fetch_invoked: args.fetchInvoked,
        },
      },
    ]);
  });
}

function recordOperationTimings(
  attrsList: readonly (SandboxOperationAttrs | UnlinkedOperationAttrs)[],
): void {
  if (attrsList.length === 0) {
    return;
  }

  const client = telemetryAxiomClient();
  if (!hasIngest(client)) {
    return;
  }

  const dataset = `vm0-sandbox-op-log-${env("AXIOM_DATASET_SUFFIX")}`;
  const events = attrsList.map((attrs) => {
    return {
      _time: attrs.timestamp ?? nowDate().toISOString(),
      source: "api",
      op_type: attrs.actionType,
      duration_ms: attrs.durationMs,
      success: attrs.success,
      ...("operationDomain" in attrs
        ? { operation_domain: attrs.operationDomain }
        : { sandbox_type: attrs.sandboxType, run_id: attrs.runId }),
      ...attrs.dimensions,
    };
  });
  const ingestResult = safeSync(() => {
    return client.ingest(dataset, events);
  });
  if ("error" in ingestResult) {
    L.warn("Failed to ingest sandbox operation log", {
      error: ingestResult.error,
    });
    return;
  }

  waitUntil(
    tapError(Promise.resolve(ingestResult.ok), (error) => {
      L.warn("Failed to ingest sandbox operation log", { error });
    }),
  );
}

function claimResponseJsonSizeBucket(bytes: number): string {
  if (bytes < 4 * 1024) {
    return "lt_4_kib";
  }
  if (bytes < 16 * 1024) {
    return "4_16_kib";
  }
  if (bytes < 64 * 1024) {
    return "16_64_kib";
  }
  if (bytes < 256 * 1024) {
    return "64_256_kib";
  }
  if (bytes < 1024 * 1024) {
    return "256_kib_1_mib";
  }
  return "ge_1_mib";
}

/** The API JSON representation before any intermediary-controlled transfer. */
export function recordClaimResponseJsonSerialization(args: {
  readonly runId: string;
  readonly byteLength: number;
  readonly serializationDurationMs: number;
}): void {
  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "api_claim_response_json_serialize",
      durationMs: args.serializationDurationMs,
      success: true,
      runId: args.runId,
      dimensions: {
        serialized_json_size_bucket: claimResponseJsonSizeBucket(
          args.byteLength,
        ),
      },
    },
  ]);
}
