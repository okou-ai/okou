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

export type ModelRequestObservation = {
  httpStatus?: number;
  transportAttempts: number;
  failureReason?: KnownRunFailureReason;
  transportFailure?: PiModelTransportFailure;
};

/** Inspect the actual response before SDKs can turn a nested message into prose. */
function opaqueBadRequestReason(
  errorBody: string,
  httpStatus: number,
): KnownRunFailureReason | undefined {
  if (httpStatus !== 400) return undefined;
  try {
    const body: unknown = JSON.parse(errorBody);
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      "detail" in body &&
      body.detail === "Bad Request"
    ) {
      return "provider_bad_request";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Decorate both native consumption paths without starting another stream pump. */
export class ModelRequestEventStream extends AssistantMessageEventStream {
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
      const { failureReason: responseReason, ...requestObservation } =
        this.observation;
      const terminalReason = classifyProviderFailure(
        message.errorMessage ?? "",
        this.observation.httpStatus,
      );
      // Codex SSE errors can lose their code when the SDK formats the message.
      // Its failed-result owner preserves only known codes, without payloads.
      const providerCode = message.diagnostics
        ?.slice()
        .reverse()
        .find((diagnostic) => {
          return diagnostic.type === "okou_codex_provider_error";
        })?.details?.code;
      const codeReason =
        typeof providerCode === "string"
          ? classifyProviderFailure(
              JSON.stringify({ error: { code: providerCode } }),
              this.observation.httpStatus,
            )
          : undefined;
      // Opaque request rejection must not outrank any semantic failure evidence.
      const observedReason =
        codeReason ??
        (responseReason === "provider_bad_request"
          ? undefined
          : responseReason);
      const specificReason =
        terminalReason === "provider_queue_timeout" &&
        (observedReason === undefined ||
          observedReason === "provider_server_error" ||
          observedReason === "provider_overloaded")
          ? terminalReason
          : (observedReason ?? terminalReason);
      const failureReason =
        specificReason ??
        (responseReason === "provider_bad_request" &&
        message.api === "openai-codex-responses"
          ? responseReason
          : undefined);
      message.diagnostics = [
        ...(message.diagnostics ?? []),
        {
          type: "okou_model_request",
          timestamp: Date.now(),
          details: {
            ...requestObservation,
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
        observation.failureReason =
          classifyProviderFailure(body, status) ??
          opaqueBadRequestReason(body, status);
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
