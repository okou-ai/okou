import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { join } from "node:path";

import { runPiOfficialRpcMode } from "../../rpc";

const root = process.argv[2];
const boundary = process.argv[3];
if (!root) throw new Error("The RPC fixture requires a temporary directory");
let requests = 0;
let initialPrompt = true;
const server = setupServer(
  http.post(
    "https://pending-tools.example/v1/responses",
    async ({ request }) => {
      if (initialPrompt) {
        initialPrompt = false;
        const items = Array.from(
          { length: boundary === "wire-boundaries" ? 17 : 1 },
          (_, index) => {
            return {
              type: "function_call",
              id: `call-${index}`,
              call_id: `call-${index}`,
              name: "controlled",
              arguments: JSON.stringify({ path: join(root, "effect.txt") }),
              status: "completed",
            };
          },
        );
        return HttpResponse.text(
          [
            ...items.flatMap((item, outputIndex) => {
              return [
                {
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item: { ...item, arguments: "" },
                },
                {
                  type: "response.function_call_arguments.delta",
                  output_index: outputIndex,
                  delta: item.arguments,
                },
                {
                  type: "response.output_item.done",
                  output_index: outputIndex,
                  item,
                },
              ];
            }),
            {
              type: "response.completed",
              response: {
                id: "initial_tool_response",
                status: "completed",
                output: items,
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]
            .map((event) => {
              return `data: ${JSON.stringify(event)}\n\n`;
            })
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      requests += 1;
      process.send?.({ type: "http-start", count: requests });
      if (boundary === "http" && requests === 1) {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              process.send?.({ type: "http-aborted" });
              resolve();
            },
            { once: true },
          );
        });
        return HttpResponse.json(
          { error: { message: "synthetic retryable error" } },
          { status: 503 },
        );
      }
      return HttpResponse.text(
        [
          ...(boundary === "wire-boundaries"
            ? [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "message_fixture",
                    role: "assistant",
                    status: "in_progress",
                    content: [],
                  },
                },
                {
                  type: "response.output_text.delta",
                  output_index: 0,
                  content_index: 0,
                  delta: "complete",
                },
              ]
            : []),
          {
            type: "response.completed",
            response: {
              id: "response_fixture",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "message_fixture",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "complete", annotations: [] },
                  ],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            },
          },
        ]
          .map((event) => {
            return `data: ${JSON.stringify(event)}\n\n`;
          })
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  ),
);
server.listen({ onUnhandledRequest: "error" });
await runPiOfficialRpcMode({
  cwd: root,
  agentDir: join(root, "agent"),
  sessionDir: root,
  sessionId: "00000000-0000-4000-8000-000000000915",
  sessionFile: join(root, "session.jsonl"),
  appendSystemPrompt: null,
  model: {
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    dialect: "openai-responses",
    transport: "sse",
    apiKey: "synthetic-key",
    baseUrl: "https://pending-tools.example/v1",
  },
});
