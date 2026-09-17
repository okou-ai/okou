import { z } from "zod";

/** Connection evidence only, never command failure or authorization state. */
export const sshConnectionFailureReasonSchema = z.enum([
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

export const sshConnectionObservationSchema = z
  .object({
    connectionId: z.uuid(),
    generation: z.int().positive().max(2_147_483_647),
    observedAt: z.string().datetime(),
    failureReason: sshConnectionFailureReasonSchema.nullable(),
  })
  .strict();

export type SshConnectionObservation = z.infer<
  typeof sshConnectionObservationSchema
>;
