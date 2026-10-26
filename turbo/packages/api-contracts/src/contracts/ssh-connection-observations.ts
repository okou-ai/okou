import {
  int,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

/** Connection evidence only, never command failure or authorization state. */
export const sshConnectionFailureReasonSchema = zEnum([
  "invalid_credential",
  "unsupported_credential",
  "credential_resource_limit",
  "unsafe_destination",
  "network_failure",
  "host_key_mismatch",
  "unsupported_host_key",
  "authentication_failed",
  "protocol",
  "timed_out",
  "access_rejected",
  "access_tls_failure",
  "access_protocol_failure",
]);

export const sshConnectionObservationSchema = object({
  connectionId: uuid(),
  connectionCreatedAt: string().datetime(),
  generation: int().positive().max(2_147_483_647),
  observedAt: string().datetime(),
  failureReason: sshConnectionFailureReasonSchema.nullable(),
}).strict();

export type SshConnectionObservation = zInfer<
  typeof sshConnectionObservationSchema
>;
