import {
  isBuiltInModelProviderType,
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  supportedRunModelSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
  type RunFailureReasonToken,
} from "@okouai/api-contracts/contracts/run-failure-reasons";

import { logger } from "../../lib/log";

export interface AgentRunFailureLogSnapshot {
  readonly launchSnapshot: {
    readonly framework: "claude-code" | "codex" | "pi";
  } | null;
  readonly modelProvider: string | null;
  readonly modelProviderCredentialScope: string | null;
  readonly selectedModel: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}

interface LogAgentRunFailureInput {
  readonly runId: string;
  readonly exitCode: number;
  readonly error?: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly executionOwner: "api-first" | "sandbox";
  readonly run: AgentRunFailureLogSnapshot;
}

type ModelCredentialOwner =
  | "platform"
  | "member"
  | "organization"
  | "unresolved";

const L = logger("webhook:complete");

const KNOWN_FAILURE_LOG_POLICY = Object.freeze({
  // Input and execution limits need no operator action for either key owner.
  safety_policy_refusal: "suppress",
  input_too_large: "suppress",
  execution_timeout: "suppress",
  insufficient_credits: "suppress-caller-owned",
  provider_insufficient_credits: "suppress-caller-owned",
  invalid_api_key: "suppress-caller-owned",
  invalid_credentials: "suppress-caller-owned",
  terms_acceptance_required: "suppress-caller-owned",
  context_window_exceeded: "suppress-caller-owned",
  output_token_limit: "suppress-caller-owned",
  provider_rate_limited: "suppress-caller-owned",
  provider_overloaded: "suppress-caller-owned",
  provider_stream_timeout: "suppress-caller-owned",
  provider_queue_timeout: "suppress-caller-owned",
  provider_server_error: "suppress-caller-owned",
  response_connection_lost: "suppress-caller-owned",
  reconnect_required: "suppress-caller-owned",
  usage_limit: "suppress-caller-owned",
  session_history_limit: "retain",
  guest_root_filesystem_full: "retain",
  unsupported_model: "retain",
} satisfies Record<
  KnownRunFailureReason,
  "suppress" | "suppress-caller-owned" | "retain"
>);

function parsedModelProvider(
  run: AgentRunFailureLogSnapshot,
): ModelProviderType | undefined {
  const result = modelProviderTypeSchema.safeParse(run.modelProvider);
  return result.success ? result.data : undefined;
}

function parsedSelectedModel(
  run: AgentRunFailureLogSnapshot,
): string | undefined {
  const result = supportedRunModelSchema.safeParse(run.selectedModel);
  return result.success ? result.data : undefined;
}

function modelCredentialOwner(
  run: AgentRunFailureLogSnapshot,
  modelProvider: ModelProviderType | undefined,
): ModelCredentialOwner {
  if (!modelProvider) {
    return "unresolved";
  }
  if (isBuiltInModelProviderType(modelProvider)) {
    return "platform";
  }
  const scope = modelProviderCredentialScopeSchema.safeParse(
    run.modelProviderCredentialScope,
  );
  if (!scope.success) {
    return "unresolved";
  }
  return scope.data === "member" ? "member" : "organization";
}

function shouldSuppressKnownFailureLog(
  credentialOwner: ModelCredentialOwner,
  failureReason: KnownRunFailureReason,
): boolean {
  switch (KNOWN_FAILURE_LOG_POLICY[failureReason]) {
    case "suppress": {
      return true;
    }
    case "suppress-caller-owned": {
      return credentialOwner === "member" || credentialOwner === "organization";
    }
    case "retain": {
      return false;
    }
  }
}

function projectFailureEvidence(input: LogAgentRunFailureInput) {
  const modelProvider = parsedModelProvider(input.run);
  const credentialOwner = modelCredentialOwner(input.run, modelProvider);
  const runtimeRoute =
    modelProvider &&
    isBuiltInModelProviderType(modelProvider) &&
    input.run.modelRuntimeProvider &&
    input.run.modelRuntimeModel
      ? {
          modelRuntimeProvider: input.run.modelRuntimeProvider,
          modelRuntimeModel: input.run.modelRuntimeModel,
        }
      : {};
  return {
    framework: input.run.launchSnapshot?.framework ?? "unknown",
    executionOwner: input.executionOwner,
    modelProvider: modelProvider ?? "unknown",
    selectedModel: parsedSelectedModel(input.run) ?? "unknown",
    modelCredentialOwner: credentialOwner,
    ...runtimeRoute,
  };
}

/** Emit the one post-arbitration terminal failure record for every framework. */
export function logAgentRunFailure(input: LogAgentRunFailureInput): void {
  const evidence = projectFailureEvidence(input);
  const knownFailureReason = knownRunFailureReasonSchema.safeParse(
    input.failureReason,
  );
  if (
    knownFailureReason.success &&
    shouldSuppressKnownFailureLog(
      evidence.modelCredentialOwner,
      knownFailureReason.data,
    )
  ) {
    return;
  }

  const fields = {
    runId: input.runId,
    exitCode: input.exitCode,
    error: input.error,
    failureReason: input.failureReason,
    ...evidence,
  };
  if (input.failureReason === "insufficient_credits") {
    L.debug("Run stopped: insufficient credits", fields);
    return;
  }
  if (input.failureReason === "guest_root_filesystem_full") {
    L.info("Run failed", fields);
    return;
  }
  if (
    input.failureReason === "provider_overloaded" &&
    evidence.modelCredentialOwner === "platform"
  ) {
    L.error("Run failed", fields);
    return;
  }
  L.warn("Run failed", fields);
}
