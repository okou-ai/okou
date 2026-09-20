import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
  type RunFailureReasonToken,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import type {
  PiApiFirstTurnOwnershipStage,
  PiApiModelFailureDiagnostic,
} from "@okouai/pi-agent-runtime/api";

import type { PiApiFirstTurnError } from "../../lib/pi-api-first-turn-policy";
import { logger } from "../../lib/log";

interface PiApiFirstTurnRouteEvidence {
  readonly dialect: string;
  readonly executionOwner: "api-first";
  readonly productProvider?: string;
}

interface LogPiApiFirstTurnExecutionFailureInput {
  readonly runId: string;
  readonly route: PiApiFirstTurnRouteEvidence;
  readonly failureCode: PiApiFirstTurnError["code"];
  readonly failureReason?: RunFailureReasonToken;
  readonly ownershipStage: PiApiFirstTurnOwnershipStage;
  readonly modelFailureDiagnostic?: PiApiModelFailureDiagnostic;
}

const L = logger("pi-api-first-turn");

const INFO_FAILURE_REASON_POLICY = Object.freeze({
  session_history_limit: false,
  guest_root_filesystem_full: true,
  codex_access_program_unavailable: true,
  execution_timeout: true,
  insufficient_credits: true,
  provider_insufficient_credits: true,
  invalid_api_key: true,
  invalid_credentials: true,
  terms_acceptance_required: true,
  context_window_exceeded: true,
  input_too_large: true,
  output_token_limit: true,
  provider_rate_limited: true,
  provider_overloaded: true,
  provider_stream_timeout: true,
  provider_queue_timeout: true,
  provider_server_error: true,
  response_connection_lost: true,
  safety_policy_refusal: true,
  reconnect_required: true,
  unsupported_model: true,
  usage_limit: true,
} satisfies Record<KnownRunFailureReason, boolean>);

function isInfoLevelFailure(
  reason: RunFailureReasonToken | undefined,
): boolean {
  const parsed = knownRunFailureReasonSchema.safeParse(reason);
  return parsed.success && INFO_FAILURE_REASON_POLICY[parsed.data];
}

/** Mirror Runner failure diagnostics without extending canonical completion. */
export function logPiApiFirstTurnExecutionFailure(
  input: LogPiApiFirstTurnExecutionFailureInput,
): void {
  const diagnostic = input.modelFailureDiagnostic;
  const fields = {
    runId: input.runId,
    ...input.route,
    outcome: "terminal_failure",
    reason: input.failureCode,
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    ownershipStage: input.ownershipStage,
    ...(diagnostic
      ? {
          modelFailureCategory: diagnostic.category,
          ...(diagnostic.httpStatus === undefined
            ? {}
            : { modelFailureHttpStatus: diagnostic.httpStatus }),
          ...(diagnostic.transportFailure
            ? { modelTransportFailure: diagnostic.transportFailure }
            : {}),
        }
      : {}),
  };
  if (isInfoLevelFailure(input.failureReason)) {
    L.info("Pi API first-turn execution failed", fields);
    return;
  }
  L.error("Pi API first-turn execution failed", fields);
}
