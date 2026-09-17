import { Readable, Transform, pipeline } from "node:stream";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type { PiUsageObserver } from "./usage-observation";

const MAX_FRAME_BYTES = 256 * 1024;
type SseDialect = "responses" | "codex-responses" | "messages";
const MESSAGE_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

function sseEventName(lines: string[]): string | undefined {
  let name: string | undefined;
  for (const line of lines) {
    if (line === "event") name = "";
    else if (line.startsWith("event:")) {
      name = line.slice(6).replace(/^ /u, "");
    }
  }
  return name;
}

/** The pinned Codex adapter stops consuming at its first terminal event. */
function endsCodexStream(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return false;
  }
  return (
    event.type === "response.done" ||
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed" ||
    event.type === "error"
  );
}

/** Responses errors stop either the OpenAI decoder or Pi's event adapter. */
function endsResponsesStream(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  return (
    ("error" in event && Boolean(event.error)) ||
    ("type" in event &&
      (event.type === "error" || event.type === "response.failed"))
  );
}

function observeJson(
  text: string,
  observe: (value: unknown) => void,
  observer: PiUsageObserver,
): void {
  try {
    const value: unknown = JSON.parse(text);
    observe(value);
  } catch {
    // Observation loss is explicit; the SDK still receives the original bytes.
    observer.loseCoverage();
  }
}

function sseReader(observer: PiUsageObserver, dialect: SseDialect) {
  const frame = Buffer.allocUnsafe(MAX_FRAME_BYTES);
  let size = 0;
  let dropped = false;
  let lineHasContent = false;
  let previousCr = false;
  let ended = false;
  const inspect = (): void => {
    if (dropped) return;
    const lines = frame.toString("utf8", 0, size).split(/\r\n|\r|\n/u);
    const name = sseEventName(lines);
    if (dialect === "messages") {
      // The pinned Messages decoder rejects errors before parsing their data.
      if (name === "error") {
        ended = true;
        return;
      }
      if (name === undefined || !MESSAGE_EVENTS.has(name)) return;
    }
    const data = lines
      .filter((line) => {
        return line === "data" || line.startsWith("data:");
      })
      .map((line) => {
        return line.startsWith("data:") ? line.slice(5).replace(/^ /u, "") : "";
      })
      .join("\n");
    if (dialect === "responses" && data.startsWith("[DONE]")) {
      ended = true;
      return;
    }
    if (data === "" || data === "[DONE]") return;
    observeJson(
      data,
      (event) => {
        // OpenAI wraps thread events; Pi never sees their data as Responses.
        if (dialect === "responses" && name?.startsWith("thread.")) return;
        if (dialect === "messages") observer.messages(event);
        else observer.responses(event);
        if (
          (dialect === "codex-responses" && endsCodexStream(event)) ||
          (dialect === "responses" && endsResponsesStream(event))
        ) {
          ended = true;
        }
      },
      observer,
    );
  };
  return {
    push(chunk: Uint8Array): void {
      for (const byte of chunk) {
        if (ended) return;
        if (previousCr && byte === 10) {
          previousCr = false;
          continue;
        }
        previousCr = byte === 13;
        if (size < MAX_FRAME_BYTES) {
          frame[size] = byte;
          size += 1;
        } else {
          dropped = true;
          observer.loseCoverage();
        }
        if (byte === 10 || byte === 13) {
          if (!lineHasContent) {
            inspect();
            size = 0;
            dropped = false;
          }
          lineHasContent = false;
        } else {
          lineHasContent = true;
        }
      }
    },
    end(): void {
      if (ended) return;
      if (size !== 0 || dropped) {
        inspect();
        observer.loseCoverage();
      }
    },
  };
}

/** Observe in the consumer's stream, without teeing or buffering a second body. */
export function observePiUsageFetch(
  fetch: typeof globalThis.fetch,
  dialect: SseDialect,
  observer: PiUsageObserver | undefined,
): typeof globalThis.fetch {
  if (!observer) return fetch;
  return async (input, init) => {
    const response = await fetch(input, init);
    observer.beginResponse();
    if (
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      return response;
    }
    const reader = sseReader(observer, dialect);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          reader.push(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          reader.end();
        },
      }),
    );
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function bedrockReader(observer: PiUsageObserver) {
  const codec = new EventStreamCodec(
    (bytes) => {
      return Buffer.from(bytes).toString("utf8");
    },
    (text) => {
      return Buffer.from(text, "utf8");
    },
  );
  const frame = Buffer.allocUnsafe(MAX_FRAME_BYTES);
  let size = 0;
  let length = 4;
  let disabled = false;
  const inspect = (): void => {
    try {
      const message = codec.decode(frame.subarray(0, size));
      if (
        message.headers[":message-type"]?.value === "event" &&
        message.headers[":event-type"]?.value === "metadata"
      ) {
        observeJson(
          Buffer.from(message.body).toString("utf8"),
          (event) => {
            observer.bedrock(event);
          },
          observer,
        );
      }
    } catch {
      observer.loseCoverage();
    }
  };
  return {
    push(chunk: Uint8Array): void {
      if (disabled) return;
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(length - size, chunk.length - offset);
        frame.set(chunk.subarray(offset, offset + count), size);
        offset += count;
        size += count;
        if (size === 4) {
          length = frame.readUInt32BE(0);
          if (length < 16 || length > MAX_FRAME_BYTES) {
            observer.loseCoverage();
            disabled = true;
            return;
          }
        }
        if (size === length) {
          inspect();
          size = 0;
          length = 4;
        }
      }
    },
    end(): void {
      if (size !== 0) observer.loseCoverage();
    },
  };
}

/** Retain the existing handler's proxy, DNS, signing and cancellation policy. */
export class PiUsageHttpHandler extends NodeHttpHandler {
  readonly #observer: PiUsageObserver | undefined;

  constructor(
    options: ConstructorParameters<typeof NodeHttpHandler>[0],
    observer: PiUsageObserver | undefined,
  ) {
    super(options);
    this.#observer = observer;
  }

  override async handle(...args: Parameters<NodeHttpHandler["handle"]>) {
    const result = await super.handle(...args);
    const observer = this.#observer;
    if (!observer) return result;
    observer.beginResponse();
    const source: unknown = result.response.body;
    if (
      !(source instanceof Readable) ||
      !result.response.headers["content-type"]?.includes(
        "application/vnd.amazon.eventstream",
      )
    ) {
      return result;
    }
    const reader = bedrockReader(observer);
    const body = new Transform({
      transform(chunk: unknown, _encoding, callback) {
        if (chunk instanceof Uint8Array) reader.push(chunk);
        else observer.loseCoverage();
        callback(null, chunk);
      },
      flush(callback) {
        reader.end();
        callback();
      },
    });
    // Pipeline propagates source errors and destroys the source on SDK cancel.
    // The SDK owns consumption/errors; this callback records observation loss.
    pipeline(source, body, (error) => {
      if (error) observer.loseCoverage();
    });
    result.response.body = body;
    return result;
  }
}
