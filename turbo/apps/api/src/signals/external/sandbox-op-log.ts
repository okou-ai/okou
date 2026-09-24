import { Axiom } from "@axiomhq/js";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { safeSync, tapError } from "../utils";

interface AxiomIngestClient {
  readonly ingest: (
    dataset: string,
    events: readonly Record<string, unknown>[],
  ) => Promise<unknown> | unknown;
}

interface SandboxOperationAttrs {
  readonly sandboxType: "runner" | "docker" | "chat";
  readonly actionType: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly runId: string;
  readonly timestamp?: string;
  readonly dimensions?: Record<string, unknown>;
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
      sandbox_type: attrs.sandboxType,
      duration_ms: attrs.durationMs,
      success: attrs.success,
      run_id: attrs.runId,
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
