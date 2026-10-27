import { string, enum as zEnum, type infer as zInfer } from "zod";

export const runFailureReasonTokenSchema = string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export type RunFailureReasonToken = zInfer<typeof runFailureReasonTokenSchema>;

export const knownRunFailureReasonSchema = zEnum([
  "session_history_limit",
  "guest_root_filesystem_full",
  "guest_home_filesystem_full",
  "execution_timeout",
  "insufficient_credits",
  "provider_insufficient_credits",
  "invalid_api_key",
  "invalid_credentials",
  "terms_acceptance_required",
  "context_window_exceeded",
  "input_too_large",
  "provider_image_too_large",
  "output_token_limit",
  "provider_rate_limited",
  "provider_overloaded",
  "provider_stream_timeout",
  "provider_queue_timeout",
  "provider_server_error",
  "response_connection_lost",
  "safety_policy_refusal",
  "reconnect_required",
  "codex_access_program_unavailable",
  "unsupported_model",
  "provider_model_restricted",
  "usage_limit",
]);

export type KnownRunFailureReason = zInfer<typeof knownRunFailureReasonSchema>;
