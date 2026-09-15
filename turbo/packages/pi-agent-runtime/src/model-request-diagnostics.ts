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

interface ModelRequestObservation {
  httpStatus?: number;
  transportAttempts: number;
  failureReason?: KnownRunFailureReason;
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
      const failureReason =
        this.observation.failureReason ??
        classifyProviderFailure(
          message.errorMessage ?? "",
          this.observation.httpStatus,
        );
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

/** Retain only status and allowlisted reasons from this model call's bounded error body. */
export function streamWithModelRequestDiagnostics(
  start: (
    fetch: NonNullable<SimpleStreamOptions["fetch"]>,
  ) => AssistantMessageEventStream,
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
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
    const response = await fetchImpl(input, init);
    observation.httpStatus = response.status;
    observation.failureReason = classifyProviderHttpFailure(response.status);
    return response;
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
