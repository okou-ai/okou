import type {
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  classifyProviderFailure,
  classifyProviderHttpFailure,
} from "@okouai/api-contracts/contracts/provider-failure";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { preserveProviderErrorStatus } from "./provider-error-body";
import { guardPiUpstreamErrorBody } from "./upstream-error-body";
import {
  modelTransportFailure,
  observeModelResponseBody,
  parseModelTransportFailure,
  type PiModelTransportFailure,
} from "./model-transport-diagnostics";

interface ModelRequestObservation {
  httpStatus?: number;
  transportAttempts: number;
  failureReason?: KnownRunFailureReason;
  transportFailure?: PiModelTransportFailure;
}

/** Decorate both native consumption paths without starting another stream pump. */
class ModelRequestEventStream extends AssistantMessageEventStream {
  private diagnosed = false;

  constructor(
    private readonly source: AssistantMessageEventStream,
    private readonly observation: ModelRequestObservation,
  ) {
    super();
  }

  private diagnose(message: AssistantMessage): AssistantMessage {
    if (!this.diagnosed && message.stopReason === "error") {
      this.diagnosed = true;
      const terminalReason = classifyProviderFailure(
        message.errorMessage ?? "",
        this.observation.httpStatus,
      );
      const observedReason = this.observation.failureReason;
      const failureReason =
        terminalReason === "provider_queue_timeout" &&
        (observedReason === undefined ||
          observedReason === "provider_server_error" ||
          observedReason === "provider_overloaded")
          ? terminalReason
          : (observedReason ?? terminalReason);
      message.diagnostics = [
        ...(message.diagnostics ?? []),
        {
          type: "okou_model_request",
          timestamp: Date.now(),
          details: {
            ...this.observation,
            ...(failureReason ? { failureReason } : {}),
          },
        },
      ];
    }
    return message;
  }

  override async *[Symbol.asyncIterator]() {
    for await (const event of this.source) {
      if (event.type === "error") this.diagnose(event.error);
      yield event;
    }
  }

  override async result(): Promise<AssistantMessage> {
    return this.diagnose(await this.source.result());
  }
}

/** Retain content-free provider and transport evidence before SDK normalization. */
export function streamWithModelRequestDiagnostics(
  start: (
    fetch: NonNullable<SimpleStreamOptions["fetch"]>,
  ) => AssistantMessageEventStream,
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  const observation: ModelRequestObservation = { transportAttempts: 0 };
  const observedFetch: NonNullable<SimpleStreamOptions["fetch"]> = async (
    input,
    init,
  ) => {
    observation.transportAttempts++;
    // A later network failure must not inherit an earlier response's status.
    observation.httpStatus = undefined;
    observation.failureReason = undefined;
    observation.transportFailure = undefined;
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      observation.transportFailure = modelTransportFailure(
        error,
        "request",
        signal?.aborted === true,
      );
      throw error;
    }
    observation.httpStatus = response.status;
    observation.failureReason = classifyProviderHttpFailure(response.status);
    return observeModelResponseBody(response, (error) => {
      observation.transportFailure = modelTransportFailure(
        error,
        "response_body",
        signal?.aborted === true,
      );
    });
  };
  const source = start(
    preserveProviderErrorStatus(
      guardPiUpstreamErrorBody(observedFetch),
      (status, body) => {
        observation.failureReason = classifyProviderFailure(body, status);
      },
    ),
  );
  return new ModelRequestEventStream(source, observation);
}

/** Transport evidence belongs only to the selected failed model message. */
export function piModelTransportFailure(
  message: AssistantMessage,
): PiModelTransportFailure | undefined {
  if (message.stopReason !== "error") return undefined;
  const diagnostic = message.diagnostics
    ?.slice()
    .reverse()
    .find((item) => {
      return item.type === "okou_model_request";
    });
  return parseModelTransportFailure(diagnostic?.details?.transportFailure);
}

/** Read only our bounded runtime diagnostic; provider prose is never a reason token. */
export function piModelFailureReason(
  message: AssistantMessage,
): KnownRunFailureReason | undefined {
  if (message.stopReason === "length") return "output_token_limit";
  if (message.stopReason !== "error") return undefined;
  const diagnostic = message.diagnostics
    ?.slice()
    .reverse()
    .find((item) => {
      return item.type === "okou_model_request";
    });
  const reason = knownRunFailureReasonSchema.safeParse(
    diagnostic?.details?.failureReason,
  );
  return reason.success
    ? reason.data
    : classifyProviderFailure(message.errorMessage ?? "");
}
