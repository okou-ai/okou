import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { crc32 } from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { piModelConfigSchema } from "@okouai/api-contracts/contracts/runners";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "@okouai/api-contracts/contracts/pi-native";
import fixtures from "../../api-contracts/src/contracts/__tests__/fixtures/pi-native.json";
import { MemoryPiSession } from "./session-memory";
import { assertPiApiFirstTurnCompactionSafe } from "./compaction-preflight";
import { PiApiFirstTurnCompactionRequiredError } from "./errors";
import { materializePiAgentModelConfig } from "./credential";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { createPiApiFirstTurnOwnership, runPiApiFirstTurn } from "./api";

const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => {
  return server.close();
});

function messagesResponse(model = "claude-sonnet-4-6") {
  const events = [
    {
      type: "message_start",
      message: {
        id: "native-response",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 11,
          output_tokens: 0,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 5,
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            ephemeral_1h_input_tokens: 2,
          },
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "native reasoning" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "opaque-signature" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "native-tool",
        name: "read",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  return new HttpResponse(
    events
      .map((event) => {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function bedrockFrame(event: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": event,
      ":content-type": "application/json",
    }).map(([name, value]) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(Buffer.byteLength(value));
      return Buffer.concat([
        Buffer.from([name.length]),
        Buffer.from(name),
        Buffer.from([7]),
        length,
        Buffer.from(value),
      ]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32BE(16 + headers.length + body.length);
  prefix.writeUInt32BE(headers.length, 4);
  prefix.writeUInt32BE(crc32(prefix.subarray(0, 8)), 8);
  const data = Buffer.concat([prefix, headers, body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([data, checksum]);
}

function bedrockResponse() {
  const frames = [
    bedrockFrame("messageStart", { role: "assistant" }),
    bedrockFrame("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { reasoningContent: { text: "native reasoning" } },
    }),
    bedrockFrame("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { reasoningContent: { signature: "opaque-signature" } },
    }),
    bedrockFrame("contentBlockStop", { contentBlockIndex: 0 }),
    bedrockFrame("contentBlockStart", {
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: "native-tool", name: "read" } },
    }),
    bedrockFrame("contentBlockDelta", {
      contentBlockIndex: 1,
      delta: { toolUse: { input: '{"path":"README.md"}' } },
    }),
    bedrockFrame("contentBlockStop", { contentBlockIndex: 1 }),
    bedrockFrame("messageStop", { stopReason: "tool_use" }),
    bedrockFrame("metadata", {
      usage: {
        inputTokens: 11,
        outputTokens: 3,
        cacheReadInputTokens: 7,
        cacheWriteInputTokens: 5,
        totalTokens: 26,
      },
    }),
  ];
  return new HttpResponse(new Uint8Array(Buffer.concat(frames)), {
    headers: {
      "content-type": "application/vnd.amazon.eventstream",
      "x-amzn-requestid": "native-response",
    },
  });
}

async function materialize(
  value: unknown,
  target: "direct" | "sandbox-firewall" = "direct",
) {
  return await materializePiAgentModelConfig({
    config: piModelConfigSchema.parse(value),
    target,
    resolveCredential: () => {
      return target === "direct"
        ? "explicit-native-key"
        : PI_NATIVE_CREDENTIAL_PLACEHOLDER;
    },
  });
}

describe("native Pi execution edges", () => {
  it.each(piNativeCatalogModelSchema.options)(
    "retains %s catalog capabilities for opaque cloud deployments",
    async (catalogModel) => {
      for (const dialect of ["anthropic-messages", "bedrock-converse-stream"]) {
        const fixture = fixtures.find(({ config }) => {
          return config.dialect === dialect;
        });
        if (!fixture) throw new Error("Missing native fixture");
        const config = piModelConfigV4Schema.parse({
          ...fixture.config,
          catalogModel,
          model: "opaque-deployment",
        });
        server.use(
          http.post(piNativeInferenceUrl(config), () => {
            return dialect === "anthropic-messages"
              ? messagesResponse()
              : bedrockResponse();
          }),
        );
        const materialized = await materialize(config);
        const model = resolvePiAgentModel(materialized);
        if (!model) throw new Error("Missing native model");
        expect(model.id).toBe("opaque-deployment");
        expect(model.input).toContain("image");
        expect(model.contextWindow).toBeGreaterThanOrEqual(200000);
        const result = await piAgentStreamForConfig(materialized)(
          model,
          { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
          { apiKey: materialized.apiKey },
        ).result();
        expect(result.stopReason).toBe("toolUse");
        const session = MemoryPiSession.create({
          cwd: "/home/user/workspace",
          id: "e8295b1b-0a85-4f68-89fb-dc5c06b251aa",
        });
        session.appendMessage({
          role: "user",
          content: "prior turn",
          timestamp: 1,
        });
        session.appendMessage({
          ...result,
          stopReason: "stop",
          content: [{ type: "text", text: "settled" }],
          usage: {
            ...result.usage,
            input: model.contextWindow,
            totalTokens: model.contextWindow,
          },
        });
        expect(() => {
          return assertPiApiFirstTurnCompactionSafe({
            model,
            session,
            settings: {
              enabled: true,
              reserveTokens: 16384,
              keepRecentTokens: 20000,
            },
          });
        }).toThrow(PiApiFirstTurnCompactionRequiredError);
      }
    },
  );

  it.each(
    fixtures.flatMap((fixture) => {
      return ["direct", "sandbox-firewall"].map((target) => {
        return { ...fixture, target };
      });
    }),
  )(
    "executes $name in $target through its exact native protocol with one request",
    async ({ config: input, target }) => {
      const config = piModelConfigV4Schema.parse(input);
      const requests: {
        url: string;
        headers: Headers;
        body: Record<string, unknown>;
      }[] = [];
      server.use(
        http.post(piNativeInferenceUrl(config), async ({ request }) => {
          // API failure diagnostics must retain the native credential-safe
          // fetch policy, including refusal to follow redirects.
          if (config.dialect === "anthropic-messages") {
            expect(request.redirect).toBe("error");
          }
          requests.push({
            url: request.url,
            headers: request.headers,
            body: (await request.json()) as Record<string, unknown>,
          });
          return config.dialect === "anthropic-messages"
            ? messagesResponse()
            : bedrockResponse();
        }),
      );
      const credentialTarget =
        target === "direct" ? "direct" : "sandbox-firewall";
      const key =
        target === "direct"
          ? "explicit-native-key"
          : PI_NATIVE_CREDENTIAL_PLACEHOLDER;
      const model = await materialize(config, credentialTarget);
      const result = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/tmp/pi-native-agent",
        sessionId: "e8295b1b-0a85-4f68-89fb-dc5c06b251aa",
        prompt: "read the file",
        appendSystemPrompt: null,
        model,
        resourceSnapshot: {
          schemaVersion: 2,
          agentsFiles: [],
          skills: [],
          memoryRecall: {
            status: "no-content",
            memoryStorageId: "native-memory",
            storageVersionId: "native-memory-version",
          },
        },
        ownership: createPiApiFirstTurnOwnership(),
      });
      expect(result.assistantMessage.stopReason).toBe("toolUse");
      expect(result.handoffRequired).toBe(true);
      expect(result.assistantMessage.responseId).toBe("native-response");
      expect(result.sessionJsonl).toContain("opaque-signature");
      expect(result.assistantMessage.usage).toMatchObject({
        input: 11,
        output: 3,
        cacheRead: 7,
        cacheWrite: 5,
      });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) throw new Error("Missing native request");
      if (config.dialect === "anthropic-messages")
        expect(request.body.model).toBe(config.model);
      else expect(request.url).toBe(piNativeInferenceUrl(config));
      expect(request.headers.get("user-agent")).toContain("okou-pi-agent");
      if (config.dialect === "anthropic-messages") {
        const binding = config.credentialBindings[0];
        if (!binding) throw new Error("Missing binding");
        expect(request.headers.get(binding.credentialHeader.name)).toBe(
          target === "direct"
            ? binding.credentialHeader.valueTemplate.replace("{{secret}}", key)
            : key,
        );
        if (binding.credentialHeader.name.toLowerCase() !== "authorization")
          expect(request.headers.get("authorization")).toBeNull();
        if (binding.credentialHeader.name.toLowerCase() !== "x-api-key")
          expect(request.headers.get("x-api-key")).toBeNull();
        expect(request.body.thinking).toMatchObject({ type: "adaptive" });
        expect(request.body.max_tokens).toBe(128000);
        expect(result.assistantMessage.usage.cacheWrite1h).toBe(2);
      } else {
        expect(request.body.additionalModelRequestFields).toMatchObject({
          thinking: { type: "adaptive" },
        });
        if (config.authMode === "bearer")
          expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        else {
          expect(request.headers.get("authorization")).toContain(
            `Credential=${key}/`,
          );
          expect(request.headers.get("authorization")).toContain(
            "/us-east-1/bedrock/aws4_request",
          );
          expect(request.headers.get("x-amz-security-token")).toBe(
            config.credentialBindings.length === 3 ? key : null,
          );
        }
      }
    },
  );

  it.each(fixtures)(
    "limits $name to one actual HTTP attempt on 429",
    async ({ config: input }) => {
      const config = piModelConfigV4Schema.parse(input);
      let attempts = 0;
      server.use(
        http.post(piNativeInferenceUrl(config), () => {
          attempts += 1;
          return HttpResponse.json({ message: "throttled" }, { status: 429 });
        }),
      );
      const materialized = await materialize(config);
      const model = resolvePiAgentModel(materialized);
      if (!model) throw new Error("Missing native model");
      const result = await piAgentStreamForConfig(materialized)(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: materialized.apiKey },
      ).result();
      expect(result.stopReason).toBe("error");
      expect(attempts).toBe(1);
    },
  );

  // Bedrock reaches its upstream through the AWS SDK request handler rather
  // than the adapter fetch, so only the Messages route crosses this boundary.
  it.each(
    fixtures.filter(({ config }) => {
      return config.dialect === "anthropic-messages";
    }),
  )(
    "reports transport evidence instead of an upstream $name error page",
    async ({ config: input }) => {
      const config = piModelConfigV4Schema.parse(input);
      const page =
        "<html><head><style global>.logo{color:#8e8ea0}</style></head>" +
        '<body><svg viewBox="0 0 41 41"><path d="M37.5324 16.8707" /></svg></body></html>';
      server.use(
        http.post(piNativeInferenceUrl(config), () => {
          return new HttpResponse(page, {
            status: 503,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }),
      );
      const materialized = await materialize(config);
      const model = resolvePiAgentModel(materialized);
      if (!model) throw new Error("Missing native model");

      const result = await piAgentStreamForConfig(materialized)(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: materialized.apiKey },
      ).result();

      expect(result.stopReason).toBe("error");
      const errorMessage = result.errorMessage ?? "";
      expect(errorMessage).toContain("upstream_non_api_response");
      expect(errorMessage).toContain("status=503");
      expect(errorMessage).toContain("content_type=html");
      expect(errorMessage).not.toContain("<svg");
      expect(errorMessage).not.toContain("8e8ea0");
    },
  );

  it.each(fixtures)(
    "cancels $name at the actual request boundary without a retry",
    async ({ config: input }) => {
      const config = piModelConfigV4Schema.parse(input);
      const controller = new AbortController();
      let attempts = 0;
      server.use(
        http.post(piNativeInferenceUrl(config), () => {
          attempts += 1;
          controller.abort();
          return config.dialect === "anthropic-messages"
            ? messagesResponse()
            : bedrockResponse();
        }),
      );
      const materialized = await materialize(config);
      const model = resolvePiAgentModel(materialized);
      if (!model) throw new Error("Missing native model");
      const result = await piAgentStreamForConfig(materialized)(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: materialized.apiKey, signal: controller.signal },
      ).result();
      expect(result.stopReason).toBe("aborted");
      expect(attempts).toBe(1);
    },
  );

  it.each(fixtures)(
    "preserves $name native thinking, tool history and images without ambient auth",
    async ({ config: input }) => {
      const config = piModelConfigV4Schema.parse(input);
      for (const key of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
        "AWS_REGION",
      ])
        vi.stubEnv(key, "ambient-must-not-be-used");
      const bodies: string[] = [];
      server.use(
        http.post(piNativeInferenceUrl(config), async ({ request }) => {
          expect(JSON.stringify([...request.headers])).not.toContain(
            "ambient-must-not-be-used",
          );
          bodies.push(await request.text());
          return config.dialect === "anthropic-messages"
            ? messagesResponse(config.model)
            : bedrockResponse();
        }),
      );
      const materialized = await materialize(config);
      const model = resolvePiAgentModel(materialized);
      if (!model) throw new Error("Missing native model");
      const stream = piAgentStreamForConfig(materialized);
      const user = {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "inspect the image" },
          {
            type: "image" as const,
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
          },
        ],
        timestamp: 1,
      };
      const first = await stream(
        model,
        { messages: [user] },
        { apiKey: materialized.apiKey },
      ).result();
      const second = await stream(
        model,
        {
          messages: [
            user,
            first,
            {
              role: "toolResult",
              toolCallId: "native-tool",
              toolName: "read",
              content: [{ type: "text", text: "tool-result-content" }],
              isError: false,
              timestamp: 2,
            },
          ],
        },
        { apiKey: materialized.apiKey },
      ).result();
      expect(second.stopReason).toBe("toolUse");
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain("opaque-signature");
      expect(bodies[1]).toContain("tool-result-content");
      expect(bodies[1]).toContain("iVBORw0KGgo=");
      await stream(
        model,
        { messages: [user, { ...first, model: "unselected-upstream-model" }] },
        { apiKey: materialized.apiKey },
      ).result();
      expect(bodies[2]).not.toContain("opaque-signature");
    },
  );

  it.each(fixtures)(
    "keeps $name sandbox credentials opaque",
    async ({ config }) => {
      const model = await materialize(config, "sandbox-firewall");
      expect(JSON.stringify(model)).not.toContain("explicit-native-key");
      await expect(
        materializePiAgentModelConfig({
          config: piModelConfigSchema.parse(config),
          target: "sandbox-firewall",
          resolveCredential: () => {
            return "real-secret";
          },
        }),
      ).rejects.toThrow("opaque firewall markers");
    },
  );

  it.each([
    "sk-ant-oat01-secret",
    "sk-ant-ort01-secret",
    "Bearer sk-ant-oat01-secret",
  ])("rejects subscription material before transport: %s", async (secret) => {
    for (const { config } of fixtures) {
      await expect(
        materializePiAgentModelConfig({
          config: piModelConfigSchema.parse(config),
          target: "direct",
          resolveCredential: () => {
            return secret;
          },
        }),
      ).rejects.toThrow("subscription token");
    }
  });
});
