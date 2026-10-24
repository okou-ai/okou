import { syncBuiltinESMExports } from "node:module";
import { zstdDecompressSync } from "node:zlib";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Imported before the real CLI/RPC entry point. Only the external model provider
// is replaced; all launch parsing, prompt building and tool execution stay real.
const calls = [
  { name: "memories_list", arguments: {} },
  {
    name: "memories_search",
    arguments: { query: "harbor", path: "MEMORY.md" },
  },
  { name: "memories_read", arguments: { path: "MEMORY.md" } },
  { name: "memories_read", arguments: { path: "details/harbor.md" } },
];
let requestNumber = 0;
const server = setupServer(
  http.post(
    "https://memory-provider.example/v1/codex/responses",
    async ({ request }) => {
      const raw = Buffer.from(await request.arrayBuffer());
      const bytes =
        request.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(raw)
          : raw;
      if (!process.send)
        throw new Error("The Memory provider fixture requires IPC");
      process.send({
        type: "memory-provider-request",
        body: JSON.parse(bytes.toString("utf8")) as unknown,
      });
      const call = calls[requestNumber++];
      const item = call
        ? {
            type: "function_call",
            id: `fc_${requestNumber}`,
            call_id: `call_${requestNumber}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            status: "completed",
          }
        : {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Read complete", annotations: [] },
            ],
          };
      const events = [
        {
          type: "response.created",
          response: {
            id: "resp_memory",
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
            ...item,
            ...(call ? { arguments: "" } : { content: [] }),
            status: "in_progress",
          },
        },
        ...(call
          ? [
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              },
            ]
          : [
              {
                type: "response.output_text.delta",
                output_index: 0,
                item_id: item.id,
                delta: "Read complete",
              },
            ]),
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_memory",
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          },
        },
      ];
      return new HttpResponse(
        events
          .map((event) => {
            return `data: ${JSON.stringify(event)}\n\n`;
          })
          .join("")
          // Drain the final frame at EOF, including SDK body observers.
          .trimEnd(),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  ),
);
server.listen({ onUnhandledRequest: "error" });
syncBuiltinESMExports();
process.once("exit", () => {
  server.close();
});
