import * as z from "zod";

export const vncObservationChangedPayloadSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();

/** Connection evidence only; never authorization, session input or raw peer errors. */
export const VNC_NATIVE_CONNECTION_FAILURE_REASONS = [
  "access_rejected",
  "access_tls_failure",
  "access_protocol_failure",
  "origin_tls_failure",
  "tailscale_unavailable",
] as const;

export const vncConnectionFailureReasonSchema = z.enum([
  "invalid_credential",
  "unsafe_destination",
  "network_failure",
  "protocol",
  "timed_out",
  "disconnected",
  "authentication_failed",
  "unsupported_profile",
  "kerberos_expired",
  "kerberos_non_renewable",
  "kerberos_renewal_exhausted",
  ...VNC_NATIVE_CONNECTION_FAILURE_REASONS,
]);

export const vncConnectionObservationSchema = z
  .object({
    connectionId: z.uuid(),
    connectionCreatedAt: z.string().datetime(),
    generation: z.int().positive().max(2_147_483_647),
    observedAt: z.string().datetime(),
    failureReason: vncConnectionFailureReasonSchema.nullable(),
  })
  .strict();

export type VncConnectionObservation = z.infer<
  typeof vncConnectionObservationSchema
>;
