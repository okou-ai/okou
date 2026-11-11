import {
  boolean,
  literal,
  number,
  object,
  uuid,
  type infer as zInfer,
} from "zod";

/** Observed process capability, not public reachability or Run ownership. */
export const runnerIngressObservationSchema = object({
  processNonce: uuid(),
  caddyServiceActive: boolean(),
  listenerReady: boolean(),
  protocolVersion: literal(1),
  // Zero means transport only. A later receiver advertises its supported version.
  dispatchProtocolVersion: number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});

export type RunnerIngressObservation = zInfer<
  typeof runnerIngressObservationSchema
>;
