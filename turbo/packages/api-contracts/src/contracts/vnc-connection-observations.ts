import { z } from "zod";

export const vncObservationChangedPayloadSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();

/** Connection evidence only; never authorization, session input or raw peer errors. */
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
]);

export const vncConnectionObservationSchema = z
  .object({
    connectionId: z.uuid(),
    generation: z.int().positive().max(2_147_483_647),
    observedAt: z.string().datetime(),
    failureReason: vncConnectionFailureReasonSchema.nullable(),
  })
  .strict();

export type VncConnectionObservation = z.infer<
  typeof vncConnectionObservationSchema
>;
