import { createServer, type RequestListener } from "node:http";
import { EventEmitter, once } from "node:events";
import { describe, expect, it, onTestFinished } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { projectPiApiAssistantMessage } from "./api-turn";
import terminatedMessage from "./test/fixtures/codex-stream-terminated.json";
import {
  modelTransportFailure,
  observeModelResponseBody,
} from "./model-transport-diagnostics";

async function provider(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const config = {
    provider: "openai-codex",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "gpt-5.6-terra",
    apiKey: "synthetic-token",
    accountId: "synthetic-account",
    dialect: "openai-codex-responses",
    transport: "sse",
  } as const;
  const model = resolvePiAgentModel(config);
  if (!model) throw new Error("Missing Codex test model");
  return (signal?: AbortSignal) => {
    return piAgentStreamForConfig(config)(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      },
      { apiKey: config.apiKey, signal },
    );
  };
}

describe("Pi causal transport evidence", () => {
  it.each(["events", "result"])(
    "retains a prematurely ended HTTP body through %s and API projection",
    async (consumer) => {
      const stream = await provider((request, response) => {
        request.resume();
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "content-length": "10000",
          connection: "close",
        });
        response.end(
          'data: {"type":"response.created","response":{"id":"test"}}\n\n',
        );
      });
      const response = stream();
      if (consumer === "events") {
        for await (const event of response) {
          if (event.type === "error")
            expect(event.error.diagnostics).toMatchObject([
              {
                details: {
                  transportFailure: {
                    causeCode: "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
                  },
                },
              },
            ]);
        }
      }
      const result = await response.result();
      expect(result).toMatchObject(terminatedMessage);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("terminated");
      const transportFailure = {
        phase: "response_body",
        signalAborted: false,
        errorName: "TypeError",
        causeCode: "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
      };
      expect(result.diagnostics).toMatchObject([
        {
          details: { httpStatus: 200, transportAttempts: 1, transportFailure },
        },
      ]);
      expect(projectPiApiAssistantMessage(result, 200)).toMatchObject({
        stopReason: "error",
        failureReason: "response_connection_lost",
        failureDiagnostic: {
          category: "stream_terminated",
          httpStatus: 200,
          transportFailure,
        },
      });
      expect(JSON.stringify(result.diagnostics)).not.toContain("127.0.0.1");
    },
  );

  it("distinguishes a pre-response rejection and clears it on recovery and abort", async () => {
    let fail = true;
    const stream = await provider((request, response) => {
      request.resume();
      if (fail) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "recovered",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        })}`,
      );
    });
    const failed = await stream().result();
    expect(failed.stopReason).toBe("error");
    expect(failed.diagnostics).toMatchObject([
      {
        details: {
          transportAttempts: 1,
          transportFailure: {
            phase: "request",
            signalAborted: false,
            errorName: "TypeError",
            causeCode: "UND_ERR_SOCKET",
          },
        },
      },
    ]);
    expect(failed.diagnostics?.[0]?.details?.httpStatus).toBeUndefined();
    fail = false;
    const recovered = await stream().result();
    expect(recovered.stopReason).toBe("stop");
    expect(recovered.diagnostics).toBeUndefined();
    const aborted = await stream(AbortSignal.abort()).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(aborted.diagnostics).toBeUndefined();
  });

  it("bounds nested causes and strips private exception values at both projections", () => {
    const nested = Object.assign(new Error("private address"), {
      code: "ECONNRESET",
    });
    const error = Object.assign(
      new TypeError("private-token", {
        cause: new Error("private", { cause: nested }),
      }),
      { code: "private-code" },
    );
    const evidence = modelTransportFailure(error, "response_body", false);
    expect(evidence).toStrictEqual({
      phase: "response_body",
      signalAborted: false,
      errorName: "TypeError",
      causeCode: "ECONNRESET",
    });
    const cycle = Object.assign(new Error("private"), {
      code: "private",
      cause: {},
    });
    cycle.cause = cycle;
    expect(modelTransportFailure(cycle, "request", true)).toStrictEqual({
      phase: "request",
      signalAborted: true,
      errorName: "Error",
    });
    const message = {
      ...fauxAssistantMessage(""),
      stopReason: "error" as const,
      errorMessage: "terminated",
      diagnostics: [
        {
          type: "okou_model_request",
          timestamp: 1,
          details: {
            transportFailure: {
              ...evidence,
              errorName: "private-name",
              errorCode: "private-code",
              cause: error,
            },
          },
        },
      ],
    };
    const projected = projectPiApiAssistantMessage(message, 200);
    expect(projected.failureDiagnostic?.transportFailure).toStrictEqual({
      phase: "response_body",
      signalAborted: false,
      causeCode: "ECONNRESET",
    });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(
      projectPiApiAssistantMessage({ ...message, stopReason: "aborted" }, 200)
        .failureDiagnostic?.transportFailure,
    ).toBeUndefined();
  });

  it("forwards bytes and the identical body error without reading ahead", async () => {
    const failure = new TypeError("terminated", {
      cause: { code: "UND_ERR_SOCKET" },
    });
    let pulls = 0;
    const original = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3]));
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const observed: unknown[] = [];
    const response = observeModelResponseBody(
      new Response(original),
      (error) => {
        observed.push(error);
      },
    );
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    expect(await reader.read()).toStrictEqual({
      done: false,
      value: new Uint8Array([1, 2, 3]),
    });
    expect(pulls).toBe(1);
    await expect(reader.read()).rejects.toBe(failure);
    expect(observed).toStrictEqual([failure]);
    expect(original.locked).toBe(false);
    reader.releaseLock();
  });

  it("cancels a pending body read without reporting a transport failure", async () => {
    const lifecycle = new EventEmitter();
    const started = once(lifecycle, "read");
    let cancellation: unknown;
    const original = new ReadableStream<Uint8Array>(
      {
        pull() {
          lifecycle.emit("read");
        },
        cancel(reason) {
          cancellation = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const observed: unknown[] = [];
    const response = observeModelResponseBody(
      new Response(original),
      (error) => {
        observed.push(error);
      },
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    await started;
    const reason = new Error("consumer cancellation");
    await reader.cancel(reason);
    expect(await pending).toStrictEqual({ done: true, value: undefined });
    expect(cancellation).toBe(reason);
    expect(observed).toStrictEqual([]);
    expect(original.locked).toBe(false);
    reader.releaseLock();
  });
});
