import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { piModelConfigSchema } from "@okouai/api-contracts/contracts/runners";
import { materializePiAgentModelConfig } from "./credential";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";

const CODEX_ROUTE = {
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5.6-terra",
  apiKey: "opaque-not-a-jwt",
  accountId: "account-id-from-binding",
  dialect: "openai-codex-responses",
  transport: "sse",
} as const;

async function codexFailureResult(response: () => Response) {
  const model = resolvePiAgentModel(CODEX_ROUTE);
  if (!model || model.api !== "openai-codex-responses") {
    throw new Error("Expected a native Codex Responses model");
  }
  const providerFetch = vi.fn(() => {
    return Promise.resolve(response());
  });
  const stream = piAgentStreamForConfig(CODEX_ROUTE)(
    model,
    {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    },
    {
      apiKey: CODEX_ROUTE.apiKey,
      fetch: providerFetch,
      signal: AbortSignal.timeout(5_000),
    },
  );
  for await (const _event of stream) {
    // Drain the failing provider answer before inspecting its canonical result.
  }
  return { providerFetch, result: await stream.result() };
}

const OPENAI_TERRA = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
  dialect: "openai-responses",
  transport: "sse",
} as const;

async function retryableCodexProvider() {
  const requests: Array<{
    url: string | undefined;
    headers: IncomingHttpHeaders;
    body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: JSON.parse(
          (request.headers["content-encoding"] === "zstd"
            ? zstdDecompressSync(bytes)
            : bytes
          ).toString("utf8"),
        ) as unknown,
      });
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "stop" } }));
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP provider address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

describe("Pi agent model adapter", () => {
  it("sends canonical Gen1 to public Responses with the selected credential", async () => {
    const provider = await retryableCodexProvider();
    try {
      const config = await materializePiAgentModelConfig({
        config: {
          provider: "openai",
          baseUrl: provider.baseUrl,
          model: "gpt-5.6-terra",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialSecretName: "OPENAI_API_KEY",
        },
        target: "direct",
        resolveCredential: () => {
          return "selected-public-key";
        },
      });
      const model = resolvePiAgentModel(config);
      if (!model) throw new Error("Expected a public model");
      const result = await piAgentStreamForConfig(config)(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        { apiKey: config.apiKey },
      ).result();
      expect(result.stopReason).toBe("error");
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        url: "/responses",
        headers: { authorization: "Bearer selected-public-key" },
        body: { model: "gpt-5.6-terra", stream: true, store: false },
      });
      expect(provider.requests[0]?.headers).not.toHaveProperty(
        "chatgpt-account-id",
      );
    } finally {
      await provider.close();
    }
  });

  it("projects public Responses catalog capabilities onto the SDK model", () => {
    const model = resolvePiAgentModel(OPENAI_TERRA);

    expect(model).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 4,
            output: 18,
            cacheRead: 0.4,
            cacheWrite: 5,
          },
        ],
      },
      contextWindow: 272_000,
      maxTokens: 128_000,
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true,
      },
    });
    expect(model).not.toHaveProperty("samplingParams");
  });

  it.each([
    {
      name: "direct DeepSeek Flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
    },
    {
      name: "direct DeepSeek Pro",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-pro",
    },
    {
      name: "OpenRouter DeepSeek Flash",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-flash",
    },
    {
      name: "OpenRouter DeepSeek Pro",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-pro",
    },
    {
      name: "OpenRouter Terra",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6-terra",
    },
  ])(
    "projects $name catalog metadata onto Responses without Chat fields",
    async ({ name: _name, ...config }) => {
      const materialized = await materializePiAgentModelConfig({
        config: piModelConfigSchema.parse({
          ...config,
          apiKeyEnv: "OPENAI_API_KEY",
          credentialSecretName: "OPENAI_API_KEY",
        }),
        target: "direct",
        resolveCredential: () => {
          return "test-key";
        },
      });
      const model = resolvePiAgentModel(materialized);

      expect(model).toMatchObject({
        id: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        api: "openai-responses",
      });
      expect(model).not.toHaveProperty("compat");
      expect(model).not.toHaveProperty("samplingParams");
    },
  );

  it.each([
    {
      name: "public Responses",
      config: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "gpt-5.6-terra",
        dialect: "openai-responses",
        transport: "sse",
      } as const,
    },
    {
      name: "Codex Responses",
      config: {
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKey: "opaque-not-a-jwt",
        accountId: "account-id-from-binding",
        model: "gpt-5.6-terra",
        dialect: "openai-codex-responses",
        transport: "sse",
      } as const,
    },
  ])(
    "reports transport evidence instead of an upstream $name error page",
    async ({ config }) => {
      const page = [
        "<html>",
        "  <head><style global>body{font-family:Arial}.logo{color:#8e8ea0}</style></head>",
        '  <body><svg viewBox="0 0 41 41"><path d="M37.5324 16.8707" /></svg></body>',
        "</html>",
      ].join("\n");
      const providerFetch = vi.fn(() => {
        return Promise.resolve(
          new Response(page, {
            status: 502,
            statusText: "Bad Gateway",
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      });
      const model = resolvePiAgentModel(config);
      if (!model) {
        throw new Error("Expected a resolvable model");
      }

      const result = await piAgentStreamForConfig(config)(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: config.apiKey, fetch: providerFetch },
      ).result();

      expect(providerFetch).toHaveBeenCalled();
      expect(result.stopReason).toBe("error");
      const errorMessage = result.errorMessage ?? "";
      expect(errorMessage).toContain("upstream_non_api_response");
      expect(errorMessage).toContain("status=502");
      expect(errorMessage).toContain("content_type=html");
      expect(errorMessage).not.toContain("<html");
      expect(errorMessage).not.toContain("<svg");
      expect(errorMessage).not.toContain("8e8ea0");
    },
  );

  it("uses product admission instead of a second runtime model allowlist", () => {
    expect(
      resolvePiAgentModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        model: "openai/gpt-5.6-sol",
        dialect: "openai-responses",
        transport: "sse",
      }),
    ).toMatchObject({
      id: "openai/gpt-5.6-sol",
      api: "openai-responses",
      provider: "openrouter",
    });
  });

  it.each([
    {
      provider: "deepseek",
      catalogModel: "deepseek-v4-flash",
      model: "company-deepseek-production",
    },
    {
      provider: "openai",
      catalogModel: "gpt-5.6-terra",
      model: "company-terra-production",
    },
  ])(
    "uses $provider/$catalogModel metadata for gateway request model $model",
    (config) => {
      expect(
        resolvePiAgentModel({
          ...config,
          baseUrl: "https://gateway.example.com/v1",
          apiKey: "unused",
          dialect: "openai-responses",
          transport: "sse",
        }),
      ).toMatchObject({
        id: config.model,
        provider: config.provider,
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-responses",
      });
    },
  );

  it.each([
    { provider: "deepseek", model: "deepseek-v4.2-flash" },
    { provider: "openrouter", model: "deepseek/deepseek-v4.2-flash" },
    { provider: "openai", model: "deepseek-v4.1-flash" },
    { provider: "unknown", model: "gpt-5.6-terra" },
    { provider: "openai", model: "unknown-model" },
    { provider: "openrouter", model: "unknown/model" },
    {
      provider: "deepseek",
      model: "company-model",
      catalogModel: "unknown-catalog-model",
    },
  ])("fails closed for unknown catalog pair $provider/$model", (config) => {
    expect(
      resolvePiAgentModel({
        ...config,
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        dialect: "openai-responses",
        transport: "sse",
      }),
    ).toBeNull();
  });

  it("selects the native OpenAI Codex catalog only from the Codex dialect", () => {
    expect(
      resolvePiAgentModel({
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-5.6-terra",
        apiKey: "opaque-access-token",
        accountId: "account-id",
        dialect: "openai-codex-responses",
        transport: "sse",
      }),
    ).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    });
    const invalid = { ...CODEX_ROUTE };
    Object.defineProperty(invalid, "provider", { value: "openai" });
    expect(resolvePiAgentModel(invalid)).toBeNull();
  });

  it.each([
    { dialect: "openai-responses", serviceTier: "fast" },
    { dialect: "openai-codex-responses", serviceTier: "priority" },
  ] as const)(
    "rejects $serviceTier on $dialect before a provider request",
    (policy) => {
      const config =
        policy.dialect === "openai-codex-responses"
          ? { ...CODEX_ROUTE }
          : { ...OPENAI_TERRA };
      const model = resolvePiAgentModel(config);
      if (!model) throw new Error("Expected a supported standard model");
      // Untyped callers can still tamper with an otherwise valid config. The
      // transport boundary must reject it independently of the internal types.
      Object.defineProperty(config, "serviceTier", {
        value: policy.serviceTier,
      });
      expect(resolvePiAgentModel(config)).toBeNull();
      expect(() => {
        return piAgentStreamForConfig(config)(model, {
          messages: [],
          tools: [],
        });
      }).toThrow("service tier");
    },
  );

  it.each([undefined, "fast"] as const)(
    "normalizes native config tier %s with exact credentials and no retry over SSE",
    async (serviceTier) => {
      const provider = await retryableCodexProvider();
      try {
        const config = {
          provider: "openai-codex",
          baseUrl: provider.baseUrl,
          model: "gpt-5.6-terra",
          apiKey: "opaque-not-a-jwt",
          accountId: "account-id-from-binding",
          dialect: "openai-codex-responses",
          transport: "sse",
          serviceTier,
        } as const;
        const model = resolvePiAgentModel(config);
        if (!model || model.api !== "openai-codex-responses") {
          throw new Error("Expected a native Codex Responses model");
        }
        const stream = piAgentStreamForConfig(config)(
          model,
          {
            messages: [{ role: "user", content: "hello", timestamp: 1 }],
            tools: [],
          },
          { apiKey: config.apiKey, serviceTier: "priority" },
        );
        for await (const _event of stream) {
          // Drain the retryable provider error so the adapter completes its task.
        }
        expect(provider.requests).toHaveLength(1);
        const request = provider.requests[0];
        if (serviceTier === undefined) {
          expect(request?.body).not.toHaveProperty("service_tier");
        } else {
          expect(config.serviceTier).toBe("fast");
          expect(request?.body).toMatchObject({ service_tier: "priority" });
        }
        expect(request?.body).toMatchObject({
          model: "gpt-5.6-terra",
          store: false,
          stream: true,
        });
        expect(request?.body).not.toHaveProperty("previous_response_id");
        expect(request?.headers.authorization).toBe("Bearer opaque-not-a-jwt");
        expect(request?.headers["chatgpt-account-id"]).toBe(
          "account-id-from-binding",
        );
      } finally {
        await provider.close();
      }
    },
  );

  it("preserves a native Codex Responses tool call over forced SSE", async () => {
    const config = {
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-terra",
      apiKey: "opaque-not-a-jwt",
      accountId: "account-id-from-binding",
      dialect: "openai-codex-responses",
      transport: "sse",
    } as const;
    const model = resolvePiAgentModel(config);
    if (!model || model.api !== "openai-codex-responses") {
      throw new Error("Expected a native Codex Responses model");
    }
    const call = {
      type: "function_call",
      id: "fc_native_tool",
      call_id: "call_native_tool",
      name: "bash",
      arguments: '{"command":"okou --help"}',
      status: "completed",
    };
    const response = {
      id: "resp_native_tool",
      object: "response",
      status: "completed",
      output: [call],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    const providerEvents = [
      {
        type: "response.created",
        response: {
          ...response,
          status: "in_progress",
          output: [],
          usage: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: call.id,
        delta: call.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: call.id,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response },
    ]
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join("");
    const providerFetch = vi.fn(async () => {
      return new Response(providerEvents, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const stream = piAgentStreamForConfig(config)(
      model,
      {
        messages: [{ role: "user", content: "use a tool", timestamp: 1 }],
        tools: [],
      },
      {
        apiKey: config.apiKey,
        fetch: providerFetch,
        signal: AbortSignal.timeout(5_000),
      },
    );
    for await (const _event of stream) {
      // Drain the native event stream before inspecting its canonical result.
    }

    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "call_native_tool|fc_native_tool",
          name: "bash",
          arguments: { command: "okou --help" },
        },
      ],
    });
  });

  it("keeps a gateway status in an opaque Codex Responses failure", async () => {
    const { providerFetch, result } = await codexFailureResult(() => {
      return new Response("no healthy upstream", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    });

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "provider HTTP 503: no healthy upstream",
    });
    // The recorded status is what lets the session retry budget recover a
    // transient gateway answer instead of ending the run on its first hit.
    expect(isRetryableAssistantError(result)).toBe(true);
  });

  it("leaves a provider-authored usage limit terminal and unchanged", async () => {
    const { providerFetch, result } = await codexFailureResult(() => {
      return new Response(
        JSON.stringify({
          error: { code: "usage_limit_reached", plan_type: "Plus" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
    });
    expect(isRetryableAssistantError(result)).toBe(false);
  });
});
