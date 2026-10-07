import type { ExpandedFirewallConfig } from "@okouai/connectors/firewall-types";
import {
  getOpenRouterBaseUrl,
  type OpenRouterRoutingContext,
} from "./openrouter-routing";

import type {
  ModelProviderFramework,
  ModelProviderType,
} from "./model-provider-types";

export const MODEL_PROVIDER_PI_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
] as const;

export type ModelProviderPiApi = (typeof MODEL_PROVIDER_PI_APIS)[number];

export interface ModelProviderPiEndpoint {
  readonly baseUrl: string;
  readonly inferenceUrl: string;
}

type FirewallSupportedProvider = Exclude<ModelProviderType, "built-in">;
type LegacySingleSecretProvider = Exclude<
  FirewallSupportedProvider,
  "codex-oauth-token"
>;

interface SingleSecretFirewallProviderConfig {
  readonly framework: ModelProviderFramework;
  readonly secretName: string;
  readonly anthropicBaseUrl?: string;
  readonly openaiBaseUrl?: string;
  /**
   * OpenAI-compatible transports supported by the in-sandbox Pi agent loop.
   *
   * Runtime base URLs and exact firewall credential-injection paths are both
   * derived from this declaration so a transport change cannot make them drift.
   */
  readonly piApis?: readonly Exclude<
    ModelProviderPiApi,
    "openai-codex-responses"
  >[];
}

export const MODEL_PROVIDER_ENV_PLACEHOLDERS = {
  // Placeholder: sk-ant-api03-{93 word/hyphen chars}AA (108 chars total)
  // Source: Semgrep regex \Bsk-ant-api03-[\w\-]{93}AA\B
  //   https://semgrep.dev/blog/2025/secrets-story-and-prefixed-secrets/
  ANTHROPIC_API_KEY:
    "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  // Placeholder: sk-ant-oat01-{93 word/hyphen chars}AA (108 chars total)
  // Source: same structure as API key; prefix from claude setup-token output
  //   https://github.com/anthropics/claude-code/issues/18340
  //   Example: sk-ant-oat01-xxxxx...xxxxx (1-year OAuth token)
  CLAUDE_CODE_OAUTH_TOKEN:
    "sk-ant-oat01-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  // Generic bearer-token marker for Claude-compatible gateways that map
  // provider-specific secrets into ANTHROPIC_AUTH_TOKEN.
  ANTHROPIC_AUTH_TOKEN: "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  // Placeholder: sk-proj-{chars}T3BlbkFJ{chars} (typical project key shape)
  // Source: mirrors the OpenAI connector firewall placeholder shape.
  OPENAI_API_KEY:
    "sk-proj-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocaT3BlbkFJCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoca",
  // Opaque fake marker, not a JWT. Codex ChatGPT mode reads auth.json, while
  // firewall auth substitutes this marker at egress.
  CHATGPT_ACCESS_TOKEN:
    "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
  CHATGPT_ACCOUNT_ID: "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
  CHATGPT_REFRESH_TOKEN: "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
} as const;

const MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS: Record<
  LegacySingleSecretProvider,
  SingleSecretFirewallProviderConfig
> = {
  "claude-code-oauth-token": {
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
  },
  "openrouter-codex": {
    framework: "codex",
    secretName: "OPENROUTER_API_KEY",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
    piApis: ["openai-completions", "openai-responses"],
  },
};

const ANTHROPIC_API_BASE = "https://api.anthropic.com";

function getFirewallBaseUrl(type: LegacySingleSecretProvider): string {
  const config = MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type];
  if (config.framework === "codex") {
    return (
      getModelProviderPiEndpoint(type, "openai-responses")?.inferenceUrl ??
      config.openaiBaseUrl?.replace(/\/+$/, "") ??
      "https://api.openai.com/v1/responses"
    );
  }

  const base = (config.anthropicBaseUrl ?? ANTHROPIC_API_BASE).replace(
    /\/+$/,
    "",
  );
  return `${base}/v1/messages`;
}

function mpFirewall(
  type: LegacySingleSecretProvider,
  authHeader: { name: string; valuePrefix?: string },
  placeholderValue: string,
): ExpandedFirewallConfig {
  const secretName = MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type].secretName;
  const secretRef = `\${{ secrets.${secretName} }}`;
  const headerValue = authHeader.valuePrefix
    ? `${authHeader.valuePrefix} ${secretRef}`
    : secretRef;
  const auth = { headers: { [authHeader.name]: headerValue } };
  const config = MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type];
  const piInferenceUrls = (config.piApis ?? []).flatMap((api) => {
    const endpoint = getModelProviderPiEndpoint(type, api);
    return endpoint ? [endpoint.inferenceUrl] : [];
  });
  const authBases = [
    ...new Set([getFirewallBaseUrl(type), ...piInferenceUrls]),
  ];
  return {
    name: `model-provider:${type}`,
    apis: authBases.map((base) => {
      return { base, auth, permissions: [] };
    }),
    placeholders: { [secretName]: placeholderValue },
  };
}

/**
 * Firewall gateway configs for model providers with static base URLs.
 * Used to auto-generate firewall entries that protect API tokens from sandbox exposure.
 *
 * Claude Code scopes to /v1/messages so credentials are only injected on LLM
 * inference paths, not vendor admin endpoints.
 */
export const MODEL_PROVIDER_FIREWALL_CONFIGS = {
  "claude-code-oauth-token": mpFirewall(
    "claude-code-oauth-token",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
  ),
  // The platform Auto route's concrete provider. The sandbox env name is
  // OPENAI_API_KEY because Codex hits OpenAI-compatible paths
  // (/chat/completions, /responses) under https://openrouter.ai/api/v1.
  "openrouter-codex": mpFirewall(
    "openrouter-codex",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
  ),
  // Personal ChatGPT subscription: backend API GET/POST injection and auth.openai.com deny.
  "codex-oauth-token": {
    name: "model-provider:codex-oauth-token",
    apis: [
      {
        base: "https://chatgpt.com/backend-api",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
          },
        },
        permissions: [
          {
            name: "codex:api",
            description:
              "Access the ChatGPT backend API with GET and POST requests.",
            rules: ["GET /{path*}", "POST /{path*}"],
          },
        ],
      },
      {
        base: "https://auth.openai.com",
        auth: { headers: {} },
        permissions: [],
      },
    ],
    defaultPolicies: {
      unknownPolicy: "deny",
    },
    placeholders: {
      CHATGPT_ACCESS_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
      CHATGPT_ACCOUNT_ID: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
      CHATGPT_REFRESH_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN,
    },
  },
} as const satisfies Record<FirewallSupportedProvider, ExpandedFirewallConfig>;

function isFirewallSupported(
  type: ModelProviderType,
): type is FirewallSupportedProvider {
  return type in MODEL_PROVIDER_FIREWALL_CONFIGS;
}

/**
 * API-aware endpoint the Pi runtime and firewall share for one provider.
 */
export function getModelProviderPiEndpoint(
  type: ModelProviderType,
  api: ModelProviderPiApi,
  routing?: OpenRouterRoutingContext,
): ModelProviderPiEndpoint | undefined {
  if (type === "codex-oauth-token") {
    return api === "openai-codex-responses"
      ? {
          baseUrl: "https://chatgpt.com/backend-api",
          inferenceUrl: "https://chatgpt.com/backend-api/codex/responses",
        }
      : undefined;
  }
  if (api === "openai-codex-responses") {
    return undefined;
  }
  const config = (
    MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS as Partial<
      Record<ModelProviderType, SingleSecretFirewallProviderConfig>
    >
  )[type];
  if (!config?.piApis?.includes(api)) {
    return undefined;
  }
  const baseUrl =
    type === "openrouter-codex" && routing
      ? getOpenRouterBaseUrl(
          api === "openai-completions" ? "chat/completions" : "responses",
          routing,
        )
      : (config.openaiBaseUrl ?? "https://api.openai.com/v1");
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl,
    inferenceUrl:
      api === "openai-completions"
        ? `${normalizedBaseUrl}/chat/completions`
        : `${normalizedBaseUrl}/responses`,
  };
}

export function getModelProviderFirewall(
  type: ModelProviderType,
  routing?: OpenRouterRoutingContext,
): ExpandedFirewallConfig | undefined {
  const firewall = isFirewallSupported(type)
    ? MODEL_PROVIDER_FIREWALL_CONFIGS[type]
    : undefined;
  if (!firewall || !routing || type !== "openrouter-codex") {
    return firewall;
  }
  const apis = firewall.apis.map((api) => {
    const path = api.base.slice("https://openrouter.ai/api/v1/".length);
    if (path !== "responses" && path !== "chat/completions") {
      return api;
    }
    const base = `${getOpenRouterBaseUrl(path, routing)}/${path}`;
    return base === api.base ? api : { ...api, base };
  });
  return apis.every((api, index) => {
    return api === firewall.apis[index];
  })
    ? firewall
    : { ...firewall, apis };
}
