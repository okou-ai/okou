import { HttpResponse } from "msw";
import { zstdDecompressSync } from "node:zlib";

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

type PiResponsesSemanticBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "toolCall";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    };

export function piResponsesContentSse(args: {
  readonly blocks: readonly PiResponsesSemanticBlock[];
  readonly sequence: number;
  readonly includeReasoning?: boolean;
  readonly observedServiceTier?: string | null;
  readonly incomplete?: boolean;
  readonly usage?: Parameters<typeof piResponsesTextSse>[2];
}): string {
  const responseId = `resp_pi_content_${args.sequence.toString()}`;
  const output: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [
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
  ];
  if (args.includeReasoning) {
    const reasoningText = "API-first reasoning preserved for Sandbox resume";
    const reasoningItem = {
      type: "reasoning",
      id: `rs_pi_content_${args.sequence.toString()}`,
      content: [{ type: "reasoning_text", text: reasoningText }],
      summary: [],
    };
    output.push(reasoningItem);
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoningItem, content: [] },
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 0,
        delta: reasoningText,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoningItem,
      },
    );
  }
  const outputIndexOffset = output.length;
  for (const [blockIndex, block] of args.blocks.entries()) {
    const outputIndex = outputIndexOffset + blockIndex;
    if (block.type === "text") {
      const item = {
        type: "message",
        id: `msg_pi_content_${args.sequence.toString()}_${blockIndex.toString()}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      };
      output.push(item);
      events.push(
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: outputIndex,
          content_index: 0,
          delta: block.text,
        },
        { type: "response.output_item.done", output_index: outputIndex, item },
      );
      continue;
    }
    const functionArguments = JSON.stringify(block.arguments);
    const itemId = `fc_pi_content_${args.sequence.toString()}_${blockIndex.toString()}`;
    const item = {
      type: "function_call",
      id: itemId,
      call_id: block.callId,
      name: block.name,
      arguments: functionArguments,
      status: "completed",
    };
    output.push(item);
    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: itemId,
        delta: functionArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        item_id: itemId,
        arguments: functionArguments,
      },
      { type: "response.output_item.done", output_index: outputIndex, item },
    );
  }
  events.push({
    type: args.incomplete ? "response.incomplete" : "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: args.incomplete ? "incomplete" : "completed",
      ...(args.incomplete
        ? { incomplete_details: { reason: "max_output_tokens" } }
        : {}),
      output,
      ...(args.observedServiceTier === undefined
        ? {}
        : { service_tier: args.observedServiceTier }),
      usage: args.usage ?? {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      },
    },
  });
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

export function piResponsesToolSse(args: {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly sequence: number;
  readonly observedServiceTier?: string | null;
}): string {
  const responseId = `resp_pi_tool_${args.sequence.toString()}`;
  const reasoningId = `rs_pi_tool_${args.sequence.toString()}`;
  const itemId = `fc_pi_tool_${args.sequence.toString()}`;
  const functionArguments = JSON.stringify(args.arguments);
  const reasoningText = "API-first reasoning preserved for Sandbox resume";
  const reasoningItem = {
    type: "reasoning",
    id: reasoningId,
    content: [{ type: "reasoning_text", text: reasoningText }],
    summary: [],
  };
  const item = {
    type: "function_call",
    id: itemId,
    call_id: args.callId,
    name: args.name,
    arguments: functionArguments,
    status: "completed",
  };
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
      item: { ...reasoningItem, content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: reasoningText,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [reasoningItem, item],
        ...(args.observedServiceTier === undefined
          ? {}
          : { service_tier: args.observedServiceTier }),
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

export function nativeCodexSseResponse(body: string): Response {
  return new HttpResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export async function readCodexRequestJson(request: Request): Promise<unknown> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const body =
    request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes)
      : bytes;
  return JSON.parse(body.toString("utf8")) as unknown;
}
