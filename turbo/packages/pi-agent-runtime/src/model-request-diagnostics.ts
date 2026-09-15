import type {
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

interface ModelRequestObservation {
  httpStatus?: number;
  transportAttempts: number;
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
      message.diagnostics = [
        ...(message.diagnostics ?? []),
        {
          type: "okou_model_request",
          timestamp: Date.now(),
          details: { ...this.observation },
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

/** Observe only this model call's fetch attempts; never inspect provider content. */
export function streamWithModelRequestDiagnostics(
  start: (
    fetch: NonNullable<SimpleStreamOptions["fetch"]>,
  ) => AssistantMessageEventStream,
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
): AssistantMessageEventStream {
  const observation: ModelRequestObservation = { transportAttempts: 0 };
  const source = start(async (input, init) => {
    observation.transportAttempts++;
    // A later network failure must not inherit an earlier response's status.
    observation.httpStatus = undefined;
    const response = await fetchImpl(input, init);
    observation.httpStatus = response.status;
    return response;
  });
  return new ModelRequestEventStream(source, observation);
}
