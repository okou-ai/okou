import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { join } from "node:path";

import { runPiOfficialRpcMode } from "../../rpc";

const root = process.argv[2];
const boundary = process.argv[3];
if (!root) throw new Error("The RPC fixture requires a temporary directory");
let requests = 0;
const server = setupServer(
  http.post(
    "https://pending-tools.example/v1/responses",
    async ({ request }) => {
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
        `data: ${JSON.stringify({
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
        })}\n\n`,
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
  ownershipTransferMode: "pending-tool-continuation",
  model: {
    provider: "openai",
    model: "gpt-5.6-terra",
    dialect: "openai-responses",
    transport: "sse",
    apiKey: "synthetic-key",
    baseUrl: "https://pending-tools.example/v1",
  },
});
