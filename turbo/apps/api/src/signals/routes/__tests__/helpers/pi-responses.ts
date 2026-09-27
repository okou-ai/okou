export function piResponsesTextSse(
  text: string,
  sequence: number,
  usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly input_tokens_details?: {
      readonly cached_tokens?: number;
      readonly cache_write_tokens?: number;
    };
  } = { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  observedServiceTier?: string | null,
): string {
  const responseId = `resp_pi_api_${sequence.toString()}`;
  const messageId = `msg_pi_api_${sequence.toString()}`;
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        ...(observedServiceTier === undefined
          ? {}
          : { service_tier: observedServiceTier }),
        usage,
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}
