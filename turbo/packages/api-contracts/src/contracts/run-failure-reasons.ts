import { z } from "zod";

export const runFailureReasonTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export type RunFailureReasonToken = z.infer<typeof runFailureReasonTokenSchema>;

export const knownRunFailureReasonSchema = z.enum([
  "session_history_limit",
  "execution_timeout",
  "insufficient_credits",
  "provider_insufficient_credits",
  "invalid_api_key",
  "invalid_credentials",
  "terms_acceptance_required",
  "context_window_exceeded",
  "input_too_large",
  "output_token_limit",
  "provider_rate_limited",
  "provider_overloaded",
  "provider_stream_timeout",
  "provider_server_error",
  "response_connection_lost",
  "safety_policy_refusal",
  "reconnect_required",
  "unsupported_model",
  "usage_limit",
]);

export type KnownRunFailureReason = z.infer<typeof knownRunFailureReasonSchema>;
