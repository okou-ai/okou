import { Readable, Transform, pipeline } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { classifyProviderHttpFailure } from "@okouai/api-contracts/contracts/provider-failure";

import type { ModelRequestObservation } from "./model-request-diagnostics";
import { modelTransportFailure } from "./model-transport-diagnostics";

/** Retain the existing handler's proxy, DNS, signing and cancellation policy. */
export class PiBedrockHttpHandler extends NodeHttpHandler {
  readonly #observation: ModelRequestObservation;
  readonly #onResponseStatus: ((status: number) => void) | undefined;

  constructor(
    options: ConstructorParameters<typeof NodeHttpHandler>[0],
    observation: ModelRequestObservation,
    onResponseStatus: ((status: number) => void) | undefined,
  ) {
    super(options);
    this.#observation = observation;
    this.#onResponseStatus = onResponseStatus;
  }

  override async handle(...args: Parameters<NodeHttpHandler["handle"]>) {
    const observation = this.#observation;
    observation.transportAttempts++;
    observation.httpStatus = undefined;
    observation.failureReason = undefined;
    observation.transportFailure = undefined;
    const result = await super.handle(...args).catch((error: unknown) => {
      observation.transportFailure = modelTransportFailure(
        error,
        "request",
        args[1]?.abortSignal?.aborted === true,
      );
      throw error;
    });
    observation.httpStatus = result.response.statusCode;
    observation.failureReason = classifyProviderHttpFailure(
      result.response.statusCode,
    );
    this.#onResponseStatus?.(result.response.statusCode);
    const source: unknown = result.response.body;
    if (
      !(source instanceof Readable) ||
      !result.response.headers["content-type"]
        ?.toLowerCase()
        .includes("application/vnd.amazon.eventstream")
    ) {
      return result;
    }
    const body = new Transform({
      transform(chunk: unknown, _encoding, callback) {
        callback(null, chunk);
      },
    });
    // Pipeline propagates source errors and destroys the source on SDK cancel.
    // The SDK owns consumption/errors; this callback records transport failure.
    pipeline(source, body, (error) => {
      if (error) {
        observation.transportFailure = modelTransportFailure(
          error,
          "response_body",
          args[1]?.abortSignal?.aborted === true,
        );
      }
    });
    result.response.body = body;
    return result;
  }
}
