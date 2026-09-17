import { eventStreamSerdeProvider } from "@smithy/core/event-streams";
import { classifyProviderFailureCode } from "@okouai/api-contracts/contracts/provider-failure";
import type { ModelRequestObservation } from "./model-request-diagnostics";

/** Classify only events consumed by the SDK, never a later buffered frame. */
export function observeBedrockEventStreamFailures(
  observation: ModelRequestObservation,
): typeof eventStreamSerdeProvider {
  return (options) => {
    const serde = eventStreamSerdeProvider(options);
    return {
      serialize(input, serializer) {
        return serde.serialize(input, serializer);
      },
      async *deserialize(body, deserializer) {
        try {
          yield* serde.deserialize(body, async (event) => {
            const decoded = await deserializer(event);
            // Smithy constructs this single-key envelope from the frame header.
            // Await decoding first: malformed payloads are not provider refusals.
            const [code] = Object.keys(event);
            const reason = classifyProviderFailureCode(code);
            if (reason) observation.failureReason = reason;
            return decoded;
          });
        } catch (error) {
          // Unmodeled error frames throw before the deserializer callback.
          if (error instanceof Error) {
            const reason = classifyProviderFailureCode(error.name);
            if (reason) observation.failureReason = reason;
          }
          throw error;
        }
      },
    };
  };
}
