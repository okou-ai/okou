import { createServer } from "node:http";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

function fakeContext(): ExtensionContext {
  return {
    cwd: "/home/user/workspace",
    model: {
      id: "model-1",
      provider: "provider-1",
    },
    sessionManager: {
      getSessionId() {
        return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      },
      getEntries() {
        return [
          {
            type: "message",
            message: { role: "user", content: "continue this run" },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: "read",
                  arguments: {},
                },
              ],
            },
          },
        ];
      },
    },
  } as unknown as ExtensionContext;
}

const MANAGED_ENVIRONMENT = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_MEDIA_UPLOAD_ENABLED",
  "LANGFUSE_PI_PARENT_TRACE_ID",
  "LANGFUSE_PI_PARENT_SPAN_ID",
  "LANGFUSE_PI_PARENT_SESSION_ID",
  "PI_LANGFUSE_CONTINUATION",
] as const;
const originalEnvironment = Object.fromEntries(
  MANAGED_ENVIRONMENT.map((name) => {
    return [name, process.env[name]];
  }),
);

beforeEach(() => {
  vi.resetModules();
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
  process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED = "false";
  process.env.LANGFUSE_PI_PARENT_TRACE_ID = "1".repeat(32);
  process.env.LANGFUSE_PI_PARENT_SPAN_ID = "2".repeat(16);
  process.env.LANGFUSE_PI_PARENT_SESSION_ID =
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  process.env.PI_LANGFUSE_CONTINUATION = "true";
});

afterEach(() => {
  for (const name of MANAGED_ENVIRONMENT) {
    const value = originalEnvironment[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

async function loadHandlers(): Promise<Map<string, EventHandler[]>> {
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI;
  const extension = await import("@langfuse/pi-observability-plugin");
  extension.default(pi);
  return handlers;
}

function onlyHandler(
  handlers: Map<string, EventHandler[]>,
  event: string,
): EventHandler {
  const registered = handlers.get(event);
  const handler = registered?.[0];
  if (!handler || registered.length !== 1) {
    throw new Error(`Expected one ${event} handler`);
  }
  return handler;
}

async function captureExport(
  exercise: (handlers: Map<string, EventHandler[]>) => Promise<void>,
): Promise<Buffer> {
  const requests: Buffer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test server");
  }
  process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${address.port}`;

  const handlers = await loadHandlers();
  await exercise(handlers);
  await onlyHandler(handlers, "agent_settled")(
    { type: "agent_settled" },
    fakeContext(),
  );
  await onlyHandler(handlers, "session_shutdown")(
    { type: "session_shutdown", reason: "quit" },
    fakeContext(),
  );

  return Buffer.concat(requests);
}

describe("patched official Pi Langfuse extension", () => {
  it("exports a parented Sandbox Continuation on pending-tool agent_start", async () => {
    const payload = await captureExport(async (handlers) => {
      await onlyHandler(handlers, "agent_start")(
        { type: "agent_start" },
        fakeContext(),
      );
    });

    expect(payload.includes(Buffer.from("Sandbox Continuation"))).toBe(true);
    expect(payload.includes(Buffer.from("continue this run"))).toBe(true);
    expect(
      payload.includes(Buffer.from("1".repeat(32), "hex")) ||
        payload.includes(Buffer.from("1".repeat(32))),
    ).toBe(true);
    expect(
      payload.includes(Buffer.from("2".repeat(16), "hex")) ||
        payload.includes(Buffer.from("2".repeat(16))),
    ).toBe(true);
  }, 30_000);

  it("does not create a second root after before_agent_start", async () => {
    const payload = await captureExport(async (handlers) => {
      const context = fakeContext();
      await onlyHandler(handlers, "before_agent_start")(
        {
          type: "before_agent_start",
          prompt: "new prompt",
          images: [],
        },
        context,
      );
      await onlyHandler(handlers, "agent_start")(
        { type: "agent_start" },
        context,
      );
    });

    expect(payload.includes(Buffer.from("Subagent Turn"))).toBe(true);
    expect(payload.includes(Buffer.from("Sandbox Continuation"))).toBe(false);
  }, 30_000);
});
