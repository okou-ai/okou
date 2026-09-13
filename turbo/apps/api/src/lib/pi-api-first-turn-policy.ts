import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { PI_API_FIRST_TURN_SESSION_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import type {
  PiApiFirstTurnOwnershipStage,
  PiApiModelFailureDiagnostic,
} from "@okouai/pi-agent-runtime/api";

type PiApiFirstTurnErrorCode =
  | "PI_API_COMMIT_FAILED"
  | "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
  | "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
  | "PI_API_FIRST_TURN_NOT_COMMITTABLE"
  | "PI_API_MODEL_FAILED"
  | "PI_API_MODEL_OUTPUT_INCOMPLETE"
  | "PI_API_MODEL_CREDENTIAL_INVALID"
  | "PI_API_NATIVE_INPUT_REQUIRED"
  | "PI_API_PREHEAT_FAILED"
  | "PI_API_RESOURCE_INVALID"
  | "PI_API_RESOURCE_PREPARATION_FAILED"
  | "PI_API_RESOURCE_UNSUPPORTED"
  | "PI_API_SANDBOX_FALLBACK_FAILED"
  | "PI_H0_DECOMPRESSION_FAILED"
  | "PI_H0_DOWNLOAD_FAILED"
  | "PI_H0_ENCODING_UNSUPPORTED"
  | "PI_H0_HASH_MISMATCH"
  | "PI_H0_JSONL_INVALID"
  | "PI_H0_METADATA_INVALID"
  | "PI_H0_SESSION_MISMATCH"
  | "PI_H0_SESSION_UNSUPPORTED"
  | "PI_H0_TOO_LARGE"
  | "PI_H1_INVALID"
  | "PI_H1_TOO_LARGE"
  | "PI_LAUNCH_CONFIG_INVALID";

export class PiApiFirstTurnError extends Error {
  readonly code: PiApiFirstTurnErrorCode;
  readonly failureReason: RunFailureReasonToken | undefined;

  constructor(
    code: PiApiFirstTurnErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly failureReason?: RunFailureReasonToken;
    },
  ) {
    super(
      `[${code}] ${message}`,
      options && "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "PiApiFirstTurnError";
    this.code = code;
    this.failureReason = options?.failureReason;
  }
}

export class PiApiFirstTurnCodexReconnectRequiredError extends PiApiFirstTurnError {
  constructor() {
    super(
      "PI_API_MODEL_CREDENTIAL_INVALID",
      "Pi API first-turn subscription access token is unavailable",
      { failureReason: "reconnect_required" },
    );
  }
}

export class PiApiFirstTurnModelFailureError extends PiApiFirstTurnError {
  constructor(
    readonly diagnostic: PiApiModelFailureDiagnostic,
    failureReason?: RunFailureReasonToken,
  ) {
    super("PI_API_MODEL_FAILED", "Pi API first-turn model request failed", {
      failureReason,
    });
  }
}

export class PiApiFirstTurnActiveInputBeforeProviderError extends Error {
  constructor() {
    super("Active input committed before Pi provider ownership");
    this.name = "PiApiFirstTurnActiveInputBeforeProviderError";
  }
}

export class PiApiFirstTurnCanonicalCancellationError extends Error {
  constructor() {
    super("Canonical Run cancellation owns the Pi API first turn");
    this.name = "PiApiFirstTurnCanonicalCancellationError";
  }
}

export function piApiFirstTurnError(
  code: PiApiFirstTurnErrorCode,
  message: string,
  cause?: unknown,
  failureReason?: RunFailureReasonToken,
): PiApiFirstTurnError {
  return new PiApiFirstTurnError(
    code,
    message,
    cause === undefined && failureReason === undefined
      ? undefined
      : { cause, failureReason },
  );
}

export type PiSandboxFallbackReason =
  | "PI_API_COMPACTION_PREFLIGHT_REQUIRED"
  | "PI_API_NATIVE_INPUT_REQUIRED"
  | "PI_API_PREHEAT_FAILED"
  | "PI_API_RESOURCE_PREPARATION_FAILED";

export type PiSandboxFirstReason =
  | PiSandboxFallbackReason
  | "active_input"
  | "api_model_failed"
  | "api_attempt_timed_out";

export function normalizedApiFirstTurnFailure(
  error: unknown,
  aborted: boolean,
): PiApiFirstTurnError {
  if (error instanceof PiApiFirstTurnError) {
    return error;
  }
  return piApiFirstTurnError(
    aborted ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED" : "PI_API_MODEL_FAILED",
    aborted ? "Pi API first-turn deadline elapsed" : "Pi API first turn failed",
    error,
  );
}

export function normalizedSandboxFallbackFailure(
  error: unknown,
  aborted: boolean,
): PiApiFirstTurnError {
  if (error instanceof PiApiFirstTurnError) {
    return error;
  }
  return piApiFirstTurnError(
    aborted
      ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
      : "PI_API_SANDBOX_FALLBACK_FAILED",
    aborted
      ? "Pi API first-turn deadline elapsed during sandbox fallback"
      : "Pi sandbox fallback publication failed",
    error,
  );
}

/** Metadata has already passed the native raw/encoded bounds and encoding checks. */
export function decideApiFirstTurnHistory(metadata: {
  readonly rawSize: number;
  readonly encodedSize: number;
}): "api" | "sandbox" {
  return metadata.rawSize <= PI_API_FIRST_TURN_SESSION_MAX_BYTES &&
    metadata.encodedSize <= PI_API_FIRST_TURN_SESSION_MAX_BYTES
    ? "api"
    : "sandbox";
}

type ApiFirstTurnCommitDecision =
  | { readonly outcome: "complete" }
  | {
      readonly outcome: "transfer";
      readonly mode:
        | "pending-tool-continuation"
        | "settled-session-continuation";
      readonly reason:
        | "pending_tool_continuation"
        | "active_input_pending_tool"
        | "active_input_settled_session";
    };

/** Apply only after the guarded H1 effect has reread lifecycle and identity. */
export function decideApiFirstTurnCommit(facts: {
  readonly pendingTools: boolean;
  readonly activeInput: boolean;
}): ApiFirstTurnCommitDecision {
  if (facts.pendingTools) {
    return {
      outcome: "transfer",
      mode: "pending-tool-continuation",
      reason: facts.activeInput
        ? "active_input_pending_tool"
        : "pending_tool_continuation",
    };
  }
  if (facts.activeInput) {
    return {
      outcome: "transfer",
      mode: "settled-session-continuation",
      reason: "active_input_settled_session",
    };
  }
  return { outcome: "complete" };
}

interface ApiFirstTurnRecoveryFacts {
  readonly failure: PiApiFirstTurnError;
  readonly activeInputBeforeProvider: boolean;
  readonly ownershipStage: PiApiFirstTurnOwnershipStage;
  readonly commitStarted: boolean;
  readonly coordinationAborted: boolean;
  readonly coordinationDeadlineAt: number;
  readonly observedAt: number;
}

type ApiFirstTurnRecoveryDecision = {
  readonly modelFailure: PiApiModelFailureDiagnostic | undefined;
  readonly resourceFallbackReason: PiSandboxFallbackReason | null;
  readonly logAttemptTimeout: boolean;
  readonly suppressCompletionFailureLog: boolean;
} & (
  | { readonly outcome: "sandbox-first"; readonly reason: PiSandboxFirstReason }
  | { readonly outcome: "arbitrate-terminal" }
);

function resourceFallbackReason(
  facts: ApiFirstTurnRecoveryFacts,
): PiSandboxFallbackReason | null {
  if (
    facts.activeInputBeforeProvider ||
    facts.coordinationAborted ||
    facts.ownershipStage !== "pre-provider"
  ) {
    return null;
  }
  switch (facts.failure.code) {
    case "PI_API_NATIVE_INPUT_REQUIRED":
    case "PI_API_PREHEAT_FAILED":
    case "PI_API_COMPACTION_PREFLIGHT_REQUIRED":
    case "PI_API_RESOURCE_PREPARATION_FAILED": {
      return facts.failure.code;
    }
    default: {
      return null;
    }
  }
}

/**
 * One observed attempt, not another lifecycle. Classify before private abort;
 * every selected effect must still acquire the canonical lifecycle lock.
 * #32751 permits same-route H0 recovery only at the named pre-commit boundaries.
 */
export function decideApiFirstTurnRecovery(
  facts: ApiFirstTurnRecoveryFacts,
): ApiFirstTurnRecoveryDecision {
  const { failure } = facts;
  const modelFailure =
    failure instanceof PiApiFirstTurnModelFailureError
      ? failure.diagnostic
      : undefined;
  const resourceReason = resourceFallbackReason(facts);
  const apiOwnershipExpired =
    failure.code === "PI_API_FIRST_TURN_DEADLINE_EXCEEDED" &&
    !facts.commitStarted &&
    !facts.coordinationAborted;
  const coordinationRemains = facts.observedAt < facts.coordinationDeadlineAt;
  const apiModelFailed =
    failure instanceof PiApiFirstTurnModelFailureError &&
    !failure.failureReason &&
    failure.diagnostic.httpStatus !== 401 &&
    failure.diagnostic.httpStatus !== 403 &&
    !facts.commitStarted &&
    !facts.coordinationAborted &&
    coordinationRemains;
  const diagnostics = {
    modelFailure,
    resourceFallbackReason: resourceReason,
    logAttemptTimeout: apiOwnershipExpired && coordinationRemains,
    suppressCompletionFailureLog: apiOwnershipExpired || apiModelFailed,
  };
  // Publication may have succeeded even when its response was lost. Only the
  // guarded terminal effect can arbitrate failure after this irreversible edge.
  if (facts.commitStarted) {
    return { ...diagnostics, outcome: "arbitrate-terminal" };
  }
  const reason = facts.activeInputBeforeProvider
    ? "active_input"
    : apiOwnershipExpired && coordinationRemains
      ? "api_attempt_timed_out"
      : apiModelFailed
        ? "api_model_failed"
        : resourceReason;
  return reason
    ? { ...diagnostics, outcome: "sandbox-first", reason }
    : { ...diagnostics, outcome: "arbitrate-terminal" };
}

/** Called with fresh durable status under the existing database lifecycle lock. */
export function decideApiFirstTurnTerminal(
  status: string | undefined,
): "cancelled" | "already-terminal" | "fail" {
  if (status === "cancelled") {
    return "cancelled";
  }
  return status === "pending" || status === "running"
    ? "fail"
    : "already-terminal";
}
