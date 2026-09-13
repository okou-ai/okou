import { describe, it, expect } from "vitest";
import {
  hasModelSelection,
  getModels,
  getDefaultModel,
  getModelProviderCodexRuntimeConfig,
  getModelProviderEnvBindings,
  getFrameworkForType,
  getModelProviderPresentationLabel,
  getBuiltInVisibleModels,
  normalizeBuiltInModelId,
  getModelImageInputSupport,
  modelSupportsImageInput,
  getSelectableProviderTypes,
  getCanonicalModelDisplayName,
  getDefaultOrgModelPolicySeed,
  getProviderRuntimeModel,
  getProvidersForModel,
  getBuiltInApiModel,
  getBuiltInConcreteProviderType,
  getBuiltInVendor,
  getBuiltInModelRouteCandidates,
  getBuiltInModelRouteVendors,
  getBuiltInModelPriceTier,
  isModelSupportedByProvider,
  isCodexFastModeModel,
  isSupportedRunModel,
  normalizeRunModelId,
  getAuthMethodsForType,
  getSecretNameForType,
  getModelProviderFirewall,
  getModelProviderCodexCatalogForModel,
  getSecretsForAuthMethod,
  isLimitedFree1RestrictedRunModel,
  isBuiltInModelProviderType,
  modelProviderCredentialScopeSchema,
  modelProviderResponseSchema,
  orgModelPolicySchema,
  supportedRunModelSchema,
  modelProviderWriteTypeSchema,
  upsertModelProviderRequestSchema,
  updateOrgModelPolicySchema,
  updateOrgModelPoliciesRequestSchema,
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  BUILT_IN_MODEL_TO_PROVIDER,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
  CODEX_FAST_MODE_MODELS,
  MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  SUPPORTED_RUN_MODELS,
  ACTIVE_RUN_MODELS,
  BUILT_IN_MODEL_PRICE_TIER,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
  modelProviderFrameworkSchema,
  type ModelProviderWriteType,
} from "../model-providers";
import { findMatchingPermissions } from "@okouai/connectors/firewall-rule-matcher";
import { getModelProviderTypeForSurfaceProtocol } from "../model-provider-gateways";
import { modelProvidersByTypeContract } from "../model-provider-routes";

describe("model-first canonical catalog", () => {
  it("recognizes Codex fast mode models", () => {
    expect(CODEX_FAST_MODE_MODELS).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(isCodexFastModeModel("gpt-5.5")).toBe(false);
    expect(isCodexFastModeModel("gpt-6-astra")).toBe(true);
    expect(isCodexFastModeModel("openai/gpt-6-astra")).toBe(true);
    expect(isCodexFastModeModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isCodexFastModeModel("gpt-5.6-terra")).toBe(true);
    expect(isCodexFastModeModel("gpt-5.6-luna")).toBe(true);
    expect(isCodexFastModeModel("custom-model")).toBe(false);
    expect(isCodexFastModeModel(null)).toBe(false);
  });

  it("exposes canonical model provider env placeholders", () => {
    expect(Object.keys(MODEL_PROVIDER_ENV_PLACEHOLDERS).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
    ]);
    expect(MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY).toMatch(
      /^sk-ant-api03-/,
    );
    expect(MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN).toMatch(
      /^sk-ant-oat01-/,
    );
    expect(MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY).toMatch(/^sk-proj-/);
    expect(
      MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN.split("."),
    ).toHaveLength(1);
  });

  it("exposes the curated flat model list only", () => {
    expect(SUPPORTED_RUN_MODELS).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("validates canonical models and credential scopes", () => {
    expect(supportedRunModelSchema.safeParse("custom-model").success).toBe(
      false,
    );
    expect(supportedRunModelSchema.safeParse("gpt-6-astra").success).toBe(true);
    expect(supportedRunModelSchema.safeParse("gpt-5.6-sol").success).toBe(true);
    expect(supportedRunModelSchema.safeParse("gpt-5.6-terra").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("gpt-5.6-luna").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("gpt-5.5").success).toBe(true);
    expect(supportedRunModelSchema.safeParse("claude-sonnet-5").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("claude-fable-5-1").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("claude-fable-5").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("claude-opus-5").success).toBe(
      true,
    );
    expect(
      supportedRunModelSchema.safeParse("deepseek-v4.1-flash").success,
    ).toBe(true);
    expect(supportedRunModelSchema.safeParse("deepseek-v4-flash").success).toBe(
      true,
    );
    expect(supportedRunModelSchema.safeParse("deepseek-v4-pro").success).toBe(
      true,
    );
    expect(modelProviderCredentialScopeSchema.safeParse("org").success).toBe(
      true,
    );
    expect(modelProviderCredentialScopeSchema.safeParse("member").success).toBe(
      true,
    );
    expect(
      modelProviderCredentialScopeSchema.safeParse("personal").success,
    ).toBe(false);
  });

  it("preserves an omitted surface id for active policy requests", () => {
    const parsed = updateOrgModelPoliciesRequestSchema.parse({
      policies: [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "vercel-ai-gateway",
          credentialScope: "org",
          modelProviderId: null,
        },
      ],
    });
    expect(parsed.policies).toHaveLength(1);
    expect(parsed.policies[0]).not.toHaveProperty("modelProviderSurfaceId");
  });

  it("identifies models blocked on limited-free-1", () => {
    expect(isLimitedFree1RestrictedRunModel("gpt-6-astra")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("openai/gpt-6-astra")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("gpt-5.6-sol")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("gpt-5.6-terra")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("openai/gpt-5.6-terra")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("gpt-5.6-luna")).toBe(false);
    expect(isLimitedFree1RestrictedRunModel("openai/gpt-5.6-luna")).toBe(false);
    expect(isLimitedFree1RestrictedRunModel("deepseek-v4.1-flash")).toBe(false);
    expect(
      isLimitedFree1RestrictedRunModel("deepseek/deepseek-v4.1-flash"),
    ).toBe(false);
    expect(isLimitedFree1RestrictedRunModel("deepseek-v4-flash")).toBe(false);
    expect(isLimitedFree1RestrictedRunModel("deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(isLimitedFree1RestrictedRunModel("deepseek-v4-pro")).toBe(false);
    expect(isLimitedFree1RestrictedRunModel("deepseek/deepseek-v4-pro")).toBe(
      false,
    );
    expect(isLimitedFree1RestrictedRunModel("gpt-5.5")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("openai/gpt-5.5")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("claude-fable-5-1")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("anthropic/claude-fable-5.1")).toBe(
      true,
    );
    expect(isLimitedFree1RestrictedRunModel("claude-opus-5")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("anthropic/claude-opus-5")).toBe(
      true,
    );
    expect(isLimitedFree1RestrictedRunModel("claude-opus-4-8")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("anthropic/claude-opus-4.8")).toBe(
      true,
    );
    expect(isLimitedFree1RestrictedRunModel("claude-sonnet-5")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("anthropic/claude-sonnet-5")).toBe(
      true,
    );
    expect(isLimitedFree1RestrictedRunModel("claude-sonnet-4-6")).toBe(true);
    expect(
      isLimitedFree1RestrictedRunModel("anthropic/claude-sonnet-4.6"),
    ).toBe(true);
    expect(
      isLimitedFree1RestrictedRunModel("anthropic/claude-sonnet-4.5"),
    ).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("glm-5.2")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("z-ai/glm-5.2")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("MiniMax-M3")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("custom/model")).toBe(true);
    expect(isLimitedFree1RestrictedRunModel("   ")).toBe(false);
    expect(isLimitedFree1RestrictedRunModel(null)).toBe(false);
  });

  it("surfaces display labels for canonical models", () => {
    expect(getCanonicalModelDisplayName("claude-fable-5-1")).toBe(
      "Claude Fable 5.1",
    );
    expect(getCanonicalModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
    expect(getCanonicalModelDisplayName("claude-opus-4-8")).toBe(
      "Claude Opus 4.8",
    );
    expect(getCanonicalModelDisplayName("claude-sonnet-5")).toBe(
      "Claude Sonnet 5",
    );
    expect(getCanonicalModelDisplayName("claude-fable-5")).toBe(
      "Claude Fable 5",
    );
    expect(getCanonicalModelDisplayName("gpt-6-astra")).toBe("GPT 6 Astra");
    expect(getCanonicalModelDisplayName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(getCanonicalModelDisplayName("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(getCanonicalModelDisplayName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(getCanonicalModelDisplayName("gpt-5.5")).toBe("GPT 5.5");
    expect(getCanonicalModelDisplayName("deepseek-v4.1-flash")).toBe(
      "DeepSeek V4.1 Flash",
    );
    expect(getCanonicalModelDisplayName("deepseek-v4-pro")).toBe(
      "DeepSeek V4 Pro",
    );
    expect(getCanonicalModelDisplayName("custom/model")).toBe("custom/model");
  });

  it("normalizes provider aliases without accepting unsupported models", () => {
    expect(normalizeRunModelId("anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
    expect(normalizeRunModelId("anthropic/claude-fable-5.1")).toBe(
      "claude-fable-5-1",
    );
    expect(normalizeRunModelId("anthropic/claude-fable-5")).toBe(
      "claude-fable-5",
    );
    expect(normalizeRunModelId("anthropic/claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(normalizeRunModelId("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek-v4.1-flash",
    );
    expect(normalizeRunModelId("custom/model")).toBe("custom/model");
    expect(isSupportedRunModel("claude-fable-5-1")).toBe(true);
    expect(isSupportedRunModel("claude-fable-5")).toBe(true);
    expect(isSupportedRunModel("claude-opus-5")).toBe(true);
    expect(isSupportedRunModel("gpt-6-astra")).toBe(true);
    expect(isSupportedRunModel("gpt-5.6-sol")).toBe(true);
    expect(isSupportedRunModel("openai/gpt-5.6-sol")).toBe(false);
    expect(isSupportedRunModel("deepseek-v4.1-flash")).toBe(true);
    expect(isSupportedRunModel("deepseek-v4-flash")).toBe(true);
    expect(isSupportedRunModel("deepseek-v4-pro")).toBe(true);
  });

  it("keeps historical models readable in the shared schema catalog", () => {
    expect(SUPPORTED_RUN_MODELS).toEqual([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
    expect(SUPPORTED_RUN_MODELS).toContain("gpt-5.5");
    expect(SUPPORTED_RUN_MODELS).toContain("claude-sonnet-4-6");
  });

  it("returns compatible provider types for canonical models", () => {
    expect(getProvidersForModel("claude-fable-5-1")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("anthropic/claude-fable-5.1")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("claude-opus-5")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("anthropic/claude-opus-5")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("claude-opus-4-8")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("anthropic/claude-sonnet-5")).toEqual([
      "built-in",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
      "azure-foundry",
      "aws-bedrock",
    ]);
    expect(getProvidersForModel("gpt-6-astra")).toEqual([
      "built-in",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
    ]);
    expect(getProvidersForModel("gpt-5.5")).toEqual([
      "built-in",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
      "vercel-ai-gateway-codex",
    ]);
    expect(getProvidersForModel("gpt-5.6-sol")).toEqual([
      "built-in",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
      "vercel-ai-gateway-codex",
    ]);
    expect(getProvidersForModel("gpt-5.6-terra")).toEqual([
      "built-in",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
      "vercel-ai-gateway-codex",
    ]);
    expect(getProvidersForModel("gpt-5.6-luna")).toEqual([
      "built-in",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
      "vercel-ai-gateway-codex",
    ]);
    expect(getProvidersForModel("openai/gpt-5.6-sol")).toEqual([]);
    expect(getProvidersForModel("deepseek-v4.1-flash")).toEqual([
      "built-in",
      "openrouter-codex",
    ]);
    expect(getProvidersForModel("deepseek-v4-flash")).toEqual([
      "built-in",
      "deepseek",
      "openrouter-codex",
    ]);
    expect(getProvidersForModel("deepseek-v4-pro")).toEqual([
      "built-in",
      "deepseek",
      "openrouter-codex",
    ]);
    expect(getProvidersForModel("kimi-k3")).toEqual([]);
    expect(getProvidersForModel("glm-5.2")).toEqual([]);
    expect(getProvidersForModel("mimo-v2.5")).toEqual([]);
    expect(getProvidersForModel("hy3-preview")).toEqual([]);
    expect(getProvidersForModel("anthropic/claude-haiku-4.5")).toEqual([]);
    expect(getProvidersForModel("minimax/minimax-m2.7")).toEqual([]);
    expect(getProvidersForModel("MiniMax-M3")).toEqual([]);
    expect(getProvidersForModel("custom/model")).toEqual([]);
  });

  it("checks model/provider compatibility", () => {
    expect(isModelSupportedByProvider("gpt-6-astra", "built-in")).toBe(true);
    expect(isModelSupportedByProvider("gpt-6-astra", "openai-api-key")).toBe(
      true,
    );
    expect(isModelSupportedByProvider("gpt-6-astra", "codex-oauth-token")).toBe(
      true,
    );
    expect(isModelSupportedByProvider("gpt-6-astra", "openrouter-codex")).toBe(
      true,
    );
    expect(
      isModelSupportedByProvider("gpt-6-astra", "vercel-ai-gateway-codex"),
    ).toBe(false);
    expect(isModelSupportedByProvider("gpt-5.6-sol", "built-in")).toBe(true);
    expect(isModelSupportedByProvider("gpt-5.6-sol", "openai-api-key")).toBe(
      true,
    );
    expect(isModelSupportedByProvider("gpt-5.6-sol", "codex-oauth-token")).toBe(
      true,
    );
    expect(isModelSupportedByProvider("gpt-5.6-sol", "openrouter-codex")).toBe(
      true,
    );
    expect(
      isModelSupportedByProvider("gpt-5.6-sol", "vercel-ai-gateway-codex"),
    ).toBe(true);
    expect(isModelSupportedByProvider("gpt-5.5", "openai-api-key")).toBe(true);
    expect(isModelSupportedByProvider("gpt-5.5", "anthropic-api-key")).toBe(
      false,
    );
    expect(
      isModelSupportedByProvider("deepseek-v4.1-flash", "openrouter-codex"),
    ).toBe(true);
    expect(isModelSupportedByProvider("deepseek-v4.1-flash", "deepseek")).toBe(
      false,
    );
    expect(isModelSupportedByProvider("deepseek-v4-pro", "deepseek")).toBe(
      true,
    );
    expect(
      isModelSupportedByProvider("anthropic/claude-opus-4.8", "built-in"),
    ).toBe(true);
    expect(
      isModelSupportedByProvider("anthropic/claude-opus-5", "built-in"),
    ).toBe(true);
    expect(isModelSupportedByProvider("MiniMax-M3", "openrouter-api-key")).toBe(
      false,
    );
    expect(isModelSupportedByProvider("glm-5.2", "openrouter-api-key")).toBe(
      false,
    );
    expect(isModelSupportedByProvider("glm-5.2", "anthropic-api-key")).toBe(
      false,
    );
    expect(isModelSupportedByProvider("mimo-v2.5", "openrouter-api-key")).toBe(
      false,
    );
    expect(
      isModelSupportedByProvider("hy3-preview", "openrouter-api-key"),
    ).toBe(false);
  });

  it("maps canonical models to provider runtime model ids", () => {
    expect(getProviderRuntimeModel("openrouter-api-key", "glm-5.2")).toBe(
      "glm-5.2",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "mimo-v2.5")).toBe(
      "mimo-v2.5",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "hy3-preview")).toBe(
      "hy3-preview",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "MiniMax-M3")).toBe(
      "MiniMax-M3",
    );
    expect(
      getProviderRuntimeModel("anthropic-api-key", "claude-opus-4-8"),
    ).toBe("claude-opus-4-8");
    expect(getProviderRuntimeModel("anthropic-api-key", "claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(getProviderRuntimeModel("vercel-ai-gateway", "claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(
      getProviderRuntimeModel("anthropic-api-key", "claude-sonnet-5"),
    ).toBe("claude-sonnet-5");
    expect(
      getProviderRuntimeModel("openrouter-api-key", "claude-sonnet-5"),
    ).toBe("anthropic/claude-sonnet-5");
    expect(
      getProviderRuntimeModel("vercel-ai-gateway", "claude-sonnet-5"),
    ).toBe("anthropic/claude-sonnet-5");
    expect(
      getProviderRuntimeModel("openrouter-api-key", "claude-fable-5-1"),
    ).toBe("anthropic/claude-fable-5.1");
    expect(
      getProviderRuntimeModel("vercel-ai-gateway", "claude-fable-5-1"),
    ).toBe("anthropic/claude-fable-5.1");
    expect(getProviderRuntimeModel("openai-api-key", "gpt-5.5")).toBe(
      "gpt-5.5",
    );
    expect(getProviderRuntimeModel("openai-api-key", "gpt-6-astra")).toBe(
      "gpt-6-astra",
    );
    expect(getProviderRuntimeModel("openrouter-codex", "gpt-6-astra")).toBe(
      "openai/gpt-6-astra",
    );
    expect(getProviderRuntimeModel("built-in", "gpt-6-astra")).toBe(
      "gpt-6-astra",
    );
    expect(getBuiltInConcreteProviderType("gpt-6-astra")).toBe(
      "openai-api-key",
    );
    expect(getBuiltInVendor("gpt-6-astra")).toBe("openai");
    expect(getProviderRuntimeModel("openai-api-key", "gpt-5.6-sol")).toBe(
      "gpt-5.6-sol",
    );
    expect(getProviderRuntimeModel("built-in", "gpt-5.6-sol")).toBe(
      "gpt-5.6-sol",
    );
    expect(getBuiltInConcreteProviderType("gpt-5.6-sol")).toBe(
      "openai-api-key",
    );
    expect(getBuiltInVendor("gpt-5.6-sol")).toBe("openai");
    expect(
      getProviderRuntimeModel("openrouter-codex", "deepseek-v4.1-flash"),
    ).toBe("deepseek/deepseek-v4.1-flash");
    expect(getProviderRuntimeModel("built-in", "deepseek-v4.1-flash")).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "custom/model")).toBe(
      "custom/model",
    );
  });

  it("routes GPT 6 Astra through OpenAI with an OpenRouter fallback", () => {
    expect(getBuiltInModelRouteCandidates("gpt-6-astra")).toEqual([
      {
        selectedModel: "gpt-6-astra",
        providerType: "openai-api-key",
        upstreamModel: "gpt-6-astra",
        vendor: "openai",
      },
      {
        selectedModel: "gpt-6-astra",
        providerType: "openrouter-codex",
        upstreamModel: "openai/gpt-6-astra",
        vendor: "openrouter",
      },
    ]);
  });

  it("routes DeepSeek V4.1 Flash through OpenRouter", () => {
    expect(getBuiltInModelRouteCandidates("deepseek-v4.1-flash")).toEqual([
      {
        selectedModel: "deepseek-v4.1-flash",
        providerType: "openrouter-codex",
        upstreamModel: "deepseek/deepseek-v4.1-flash",
        vendor: "openrouter",
      },
    ]);
    expect(getBuiltInConcreteProviderType("deepseek-v4.1-flash")).toBe(
      "openrouter-codex",
    );
    expect(getBuiltInVendor("deepseek-v4.1-flash")).toBe("openrouter");
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "routes built-in model %s directly through DeepSeek",
    (model) => {
      expect(getBuiltInConcreteProviderType(model)).toBe("deepseek");
      expect(getBuiltInVendor(model)).toBe("deepseek");
      expect(getBuiltInApiModel(model)).toBe(model);
      expect(getProviderRuntimeModel("built-in", model)).toBe(model);
    },
  );

  it.each([
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
  ] as const)(
    "routes built-in model %s directly through Anthropic",
    (model) => {
      expect(getBuiltInConcreteProviderType(model)).toBe("anthropic-api-key");
      expect(getBuiltInVendor(model)).toBe("anthropic");
      expect(getBuiltInApiModel(model)).toBe(model);
      expect(getProviderRuntimeModel("built-in", model)).toBe(model);
    },
  );

  it("defines statically compilable built-in routes for every active model", () => {
    expect(Object.keys(BUILT_IN_MODEL_TO_PROVIDER)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(getBuiltInModelRouteVendors()).toEqual([
      "anthropic",
      "openrouter",
      "deepseek",
      "openai",
    ]);

    for (const model of ACTIVE_RUN_MODELS) {
      const candidates = getBuiltInModelRouteCandidates(model);
      expect(candidates).toHaveLength(model === "deepseek-v4.1-flash" ? 1 : 2);
      expect(candidates[0]?.providerType).toBe(
        getBuiltInConcreteProviderType(model),
      );
      expect(candidates[0]?.upstreamModel).toBe(getBuiltInApiModel(model));
      expect(
        new Set(
          candidates.map((candidate) => {
            return `${candidate.providerType}:${candidate.upstreamModel}`;
          }),
        ).size,
      ).toBe(candidates.length);

      const frameworks = new Set(
        candidates.map((candidate) => {
          const config = MODEL_PROVIDER_TYPES[candidate.providerType];
          expect(getSecretNameForType(candidate.providerType)).toBeTruthy();
          expect(
            getModelProviderEnvBindings(candidate.providerType),
          ).toBeTruthy();
          expect(getModelProviderFirewall(candidate.providerType)).toBeTruthy();
          expect(config.models).toContain(candidate.upstreamModel);
          return getFrameworkForType(candidate.providerType);
        }),
      );
      expect(frameworks.size).toBe(1);
    }
  });

  it.each([
    ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"],
    ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
  ] as const)(
    "projects Codex metadata for OpenRouter %s",
    (model, upstreamModel) => {
      const catalog = getModelProviderCodexCatalogForModel(
        model,
        upstreamModel,
        "openrouter-codex",
      );
      expect(catalog?.models).toEqual([
        expect.objectContaining({
          slug: upstreamModel,
          apply_patch_tool_type: null,
        }),
      ]);
    },
  );

  it("builds the default org policy seed from the workspace defaults", () => {
    expect(DEFAULT_ORG_MODEL_POLICY_MODELS).toEqual([
      "gpt-6-astra",
      "gpt-5.6-luna",
      "deepseek-v4.1-flash",
    ]);
    expect(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL).toBe("deepseek-v4.1-flash");
    expect(LIMITED_FREE1_DEFAULT_RUN_MODEL).toBe("deepseek-v4.1-flash");
    expect(getDefaultModel("built-in")).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
    expect(getDefaultOrgModelPolicySeed()).toEqual(
      DEFAULT_ORG_MODEL_POLICY_MODELS.map((model) => {
        return {
          model,
          isDefault: model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        };
      }),
    );
    expect(
      getDefaultOrgModelPolicySeed(LIMITED_FREE1_DEFAULT_RUN_MODEL).find(
        (seed) => {
          return seed.isDefault;
        },
      )?.model,
    ).toBe(LIMITED_FREE1_DEFAULT_RUN_MODEL);
  });

  it("exposes price tiers for built-in reasoning models", () => {
    expect(BUILT_IN_MODEL_PRICE_TIER).toEqual(
      expect.objectContaining({
        "claude-fable-5-1": "$$$$",
        "claude-fable-5": "$$$$",
        "claude-opus-5": "$$$",
        "gpt-6-astra": "$$$$",
        "gpt-5.6-sol": "$$$",
        "gpt-5.6-terra": "$$",
        "gpt-5.6-luna": "$",
        "claude-opus-4-8": "$$$",
        "claude-sonnet-5": "$$",
        "deepseek-v4.1-flash": "$",
        "deepseek-v4-flash": "$",
        "deepseek-v4-pro": "$",
      }),
    );
    expect(getBuiltInModelPriceTier("claude-fable-5-1")).toBe("$$$$");
    expect(getBuiltInModelPriceTier("claude-fable-5")).toBe("$$$$");
    expect(getBuiltInModelPriceTier("claude-opus-5")).toBe("$$$");
    expect(getBuiltInModelPriceTier("gpt-6-astra")).toBe("$$$$");
    expect(getBuiltInModelPriceTier("gpt-5.6-sol")).toBe("$$$");
    expect(getBuiltInModelPriceTier("gpt-5.6-terra")).toBe("$$");
    expect(getBuiltInModelPriceTier("gpt-5.6-luna")).toBe("$");
    expect(getBuiltInModelPriceTier("claude-opus-4-8")).toBe("$$$");
    expect(getBuiltInModelPriceTier("claude-sonnet-5")).toBe("$$");
    expect(getBuiltInModelPriceTier("deepseek-v4.1-flash")).toBe("$");
    expect(getBuiltInModelPriceTier("deepseek-v4-flash")).toBe("$");
    expect(getBuiltInModelPriceTier("deepseek-v4-pro")).toBe("$");
    expect(getBuiltInModelPriceTier("claude-opus-4-7")).toBeUndefined();
    expect(getBuiltInModelPriceTier("kimi-k3")).toBeUndefined();
    expect(getBuiltInModelPriceTier("custom/model")).toBeUndefined();
    expect(MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS["gpt-6-astra"]).toBe(
      272_001,
    );
  });
});

describe("model selection for Anthropic-native providers", () => {
  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s supports model selection",
    (type) => {
      expect(hasModelSelection(type)).toBe(true);
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s offers fable, sonnet, and opus models",
    (type) => {
      const models = getModels(type);
      expect(models).toContain("claude-fable-5-1");
      expect(models).toContain("claude-opus-5");
      expect(models).toContain("claude-sonnet-5");
      expect(models).toContain("claude-sonnet-4-6");
      expect(models).toContain("claude-opus-4-8");
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s defaults to claude-sonnet-5",
    (type) => {
      expect(getDefaultModel(type)).toBe("claude-sonnet-5");
    },
  );

  it("anthropic-api-key maps ANTHROPIC_MODEL via env bindings", () => {
    const envBindings = getModelProviderEnvBindings("anthropic-api-key");
    expect(envBindings).toBeDefined();
    expect(envBindings!["ANTHROPIC_API_KEY"]).toBe("$secret");
    expect(envBindings!["ANTHROPIC_MODEL"]).toBe("$model");
  });

  it("claude-code-oauth-token maps ANTHROPIC_MODEL via env bindings", () => {
    const envBindings = getModelProviderEnvBindings("claude-code-oauth-token");
    expect(envBindings).toBeDefined();
    expect(envBindings!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("$secret");
    expect(envBindings!["ANTHROPIC_MODEL"]).toBe("$model");
  });
});

describe("model selection for Claude-compatible gateway providers", () => {
  it("openrouter-api-key exposes current Claude models", () => {
    expect(getModels("openrouter-api-key")).toEqual([
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.5",
    ]);
  });

  it.each(["openrouter-api-key", "vercel-ai-gateway"] as const)(
    "%s supports current Anthropic models",
    (type) => {
      expect(getModels(type)).toContain("anthropic/claude-fable-5.1");
      expect(
        isModelSupportedByProvider("anthropic/claude-fable-5.1", type),
      ).toBe(true);
      expect(getProviderRuntimeModel(type, "claude-fable-5-1")).toBe(
        "anthropic/claude-fable-5.1",
      );
      expect(getModels(type)).toContain("anthropic/claude-opus-5");
      expect(isModelSupportedByProvider("anthropic/claude-opus-5", type)).toBe(
        true,
      );
      expect(getProviderRuntimeModel(type, "claude-opus-5")).toBe(
        "anthropic/claude-opus-5",
      );
    },
  );

  it.each([
    "anthropic-api-key",
    "claude-code-oauth-token",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ] as const)("%s keeps Claude Code attachments enabled", (type) => {
    const envBindings = getModelProviderEnvBindings(type);
    expect(envBindings).toBeDefined();
    expect(envBindings!["CLAUDE_CODE_DISABLE_ATTACHMENTS"]).toBeUndefined();
  });
});

describe("getBuiltInVisibleModels", () => {
  it("returns only active built-in models", () => {
    const models = getBuiltInVisibleModels();
    expect(models).toEqual(ACTIVE_RUN_MODELS);
    expect(models).toContain("gpt-5.5");
    expect(models).toContain("claude-sonnet-4-6");
  });
});

describe("normalizeBuiltInModelId", () => {
  it.each([
    ["anthropic/claude-fable-5.1", "claude-fable-5-1"],
    ["anthropic/claude-fable-5", "claude-fable-5"],
    ["anthropic/claude-opus-5", "claude-opus-5"],
    ["anthropic/claude-opus-4.8", "claude-opus-4-8"],
    ["anthropic/claude-sonnet-5", "claude-sonnet-5"],
    ["anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"],
  ])("normalizes %s to %s", (model, expected) => {
    expect(normalizeBuiltInModelId(model)).toBe(expected);
  });

  it("keeps unknown model ids unchanged", () => {
    expect(normalizeBuiltInModelId("custom/model")).toBe("custom/model");
  });
});

describe("model image input support", () => {
  it.each([
    "gpt-6-astra",
    "openai/gpt-6-astra",
    "deepseek-v4.1-flash",
    "deepseek/deepseek-v4.1-flash",
    "claude-fable-5-1",
    "anthropic/claude-fable-5.1",
    "claude-opus-5",
    "anthropic/claude-opus-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "anthropic/claude-sonnet-5",
    "claude-opus-4-8",
  ])("marks %s as image-input capable", (model) => {
    expect(modelSupportsImageInput(model)).toBe(true);
    expect(getModelImageInputSupport(model)).toBe("supported");
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
    "marks %s as not image-input capable",
    (model) => {
      expect(modelSupportsImageInput(model)).toBe(false);
      expect(getModelImageInputSupport(model)).toBe("unsupported");
    },
  );

  it("treats unknown model ids as unknown rather than unsupported", () => {
    expect(modelSupportsImageInput("custom/model")).toBe(false);
    expect(getModelImageInputSupport("custom/model")).toBe("unknown");
  });
});

describe("deepseek Responses provider", () => {
  it("uses the Codex framework with the DeepSeek API key", () => {
    expect(modelProviderTypeSchema.safeParse("deepseek").success).toBe(true);
    expect(getSelectableProviderTypes()).toContain("deepseek");
    expect(getFrameworkForType("deepseek")).toBe("codex");
    expect(getSecretNameForType("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(getModels("deepseek")).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(getDefaultModel("deepseek")).toBe("deepseek-v4-flash");
  });

  it("configures the official DeepSeek Responses model catalog", () => {
    expect(getModelProviderCodexRuntimeConfig("deepseek")).toMatchObject({
      providerId: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      envKey: "OPENAI_API_KEY",
      requiresOpenaiAuth: false,
      wireApi: "responses",
      supportsWebsockets: false,
      modelCatalog: {
        models: [
          expect.objectContaining({
            slug: "deepseek-v4-flash",
            default_reasoning_level: "high",
            context_window: 1_048_576,
            minimal_client_version: "0.144.0",
            experimental_supported_tools: [],
            supports_search_tool: true,
            default_service_tier: null,
            supports_reasoning_summaries: true,
            base_instructions: expect.stringContaining("You are Codex"),
            model_messages: expect.objectContaining({
              instructions_template: expect.stringContaining("You are Codex"),
            }),
          }),
          expect.objectContaining({
            slug: "deepseek-v4-pro",
            display_name: "DeepSeek-V4-Pro",
            default_reasoning_level: "high",
            context_window: 1_048_576,
            model_messages: expect.objectContaining({
              instructions_template: expect.stringContaining("You are Codex"),
            }),
          }),
        ],
      },
    });
  });

  it("scopes the firewall to the native Responses endpoint", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS.deepseek;
    expect(config.apis[0]!.base).toBe("https://api.deepseek.com/responses");
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.DEEPSEEK_API_KEY }}",
    });
  });

  it("keeps Pi credential injection on the Responses endpoint", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS.deepseek;
    expect(
      config.apis.map((api) => {
        return api.base;
      }),
    ).toEqual(["https://api.deepseek.com/responses"]);
    for (const api of config.apis) {
      expect(api.auth.headers).toEqual({
        Authorization: "Bearer ${{ secrets.DEEPSEEK_API_KEY }}",
      });
    }
  });
});

describe("openai-api-key codex provider", () => {
  it("declares codex framework", () => {
    expect(getFrameworkForType("openai-api-key")).toBe("codex");
  });

  it("maps OPENAI_API_KEY and OPENAI_MODEL via env bindings", () => {
    const envBindings = getModelProviderEnvBindings("openai-api-key");
    expect(envBindings).toBeDefined();
    expect(envBindings!["OPENAI_API_KEY"]).toBe("$secret");
    expect(envBindings!["OPENAI_MODEL"]).toBe("$model");
  });

  it("offers codex-compatible models with gpt-5.6-sol default", () => {
    expect(getModels("openai-api-key")).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(getDefaultModel("openai-api-key")).toBe("gpt-5.6-sol");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("openai-api-key")).toBe(true);
  });

  it("firewall scopes to OpenAI Responses API", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["openai-api-key"];
    expect(config.apis[0]!.base).toBe("https://api.openai.com/v1/responses");
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.OPENAI_API_KEY }}",
    });
  });

  it("also covers the Pi sandbox chat-completions path, still scoped", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["openai-api-key"];
    expect(
      config.apis.map((api) => {
        return api.base;
      }),
    ).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/chat/completions",
    ]);
  });

  it("modelProviderTypeSchema accepts openai-api-key", () => {
    expect(modelProviderTypeSchema.safeParse("openai-api-key").success).toBe(
      true,
    );
  });

  it("modelProviderFrameworkSchema accepts codex", () => {
    expect(modelProviderFrameworkSchema.safeParse("codex").success).toBe(true);
  });
});

describe("firewall base URL scoped to /v1/messages (#9560)", () => {
  it.each([
    ["anthropic-api-key", "https://api.anthropic.com/v1/messages"],
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1/messages"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/messages"],
  ] as const)(
    "%s scopes firewall to /v1/messages path prefix",
    (type, expectedBase) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      // Pi-capable providers carry a second, equally scoped entry for the
      // sandbox loop's chat-completions call; the Anthropic base stays first.
      expect(config.apis[0]!.base).toBe(expectedBase);
      for (const api of config.apis) {
        expect(api.base).toMatch(/\/(v1\/messages|chat\/completions)$/);
      }
    },
  );

  it("keeps single-secret firewall base URLs aligned with provider env bindings", () => {
    for (const type of Object.keys(MODEL_PROVIDER_FIREWALL_CONFIGS) as Array<
      keyof typeof MODEL_PROVIDER_FIREWALL_CONFIGS
    >) {
      if (getSecretNameForType(type) === undefined) {
        continue;
      }

      const envBindings = getModelProviderEnvBindings(type);
      const actualBase = MODEL_PROVIDER_FIREWALL_CONFIGS[type].apis[0]!.base;
      if (getFrameworkForType(type) === "codex") {
        const providerBase =
          envBindings?.OPENAI_BASE_URL?.replace(/\/+$/, "") ??
          "https://api.openai.com/v1";
        expect(actualBase).toBe(`${providerBase}/responses`);
        continue;
      }

      const expectedBase = `${(envBindings?.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
      expect(actualBase).toBe(expectedBase);
    }
  });
});

describe("model provider firewall placeholders", () => {
  it.each([
    [
      "anthropic-api-key",
      "ANTHROPIC_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY,
    ],
    [
      "claude-code-oauth-token",
      "CLAUDE_CODE_OAUTH_TOKEN",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
    ],
    [
      "openrouter-api-key",
      "OPENROUTER_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
    ],
    [
      "deepseek",
      "DEEPSEEK_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    ],
    [
      "vercel-ai-gateway",
      "VERCEL_AI_GATEWAY_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
    ],
    [
      "openrouter-codex",
      "OPENROUTER_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    ],
    [
      "vercel-ai-gateway-codex",
      "VERCEL_AI_GATEWAY_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    ],
    [
      "openai-api-key",
      "OPENAI_API_KEY",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    ],
  ] as const)(
    "%s uses the canonical placeholder for %s",
    (type, secretName, placeholder) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      expect(config.placeholders).toMatchObject({
        [secretName]: placeholder,
      });
    },
  );

  it("keeps single-secret firewall placeholders aligned with provider secret names", () => {
    for (const type of Object.keys(MODEL_PROVIDER_FIREWALL_CONFIGS) as Array<
      keyof typeof MODEL_PROVIDER_FIREWALL_CONFIGS
    >) {
      const secretName = getSecretNameForType(type);
      if (secretName === undefined) {
        continue;
      }
      expect(MODEL_PROVIDER_FIREWALL_CONFIGS[type].placeholders).toHaveProperty(
        secretName,
      );
    }
  });
});

describe("codex-oauth-token codex provider", () => {
  it("declares codex framework", () => {
    expect(getFrameworkForType("codex-oauth-token")).toBe("codex");
  });

  it("appears in selectable provider types", () => {
    expect(getSelectableProviderTypes()).toContain("codex-oauth-token");
  });

  it("supports only the auth_json multi-auth shape with CHATGPT_* fields", () => {
    const methods = getAuthMethodsForType("codex-oauth-token");
    expect(methods).toBeDefined();
    expect(Object.keys(methods!)).toEqual(["auth_json"]);
    const authJsonSecrets = methods!.auth_json!.secrets;
    expect(Object.keys(authJsonSecrets).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CODEX_AUTH_JSON",
    ]);
  });

  it("defaultAuthMethod is auth_json", () => {
    const config = MODEL_PROVIDER_TYPES["codex-oauth-token"];
    expect(
      "defaultAuthMethod" in config ? config.defaultAuthMethod : undefined,
    ).toBe("auth_json");
  });

  it("marks refresh and id tokens as serverOnly under auth_json", () => {
    const secrets = getSecretsForAuthMethod("codex-oauth-token", "auth_json")!;
    expect(secrets.CHATGPT_REFRESH_TOKEN!.serverOnly).toBe(true);
    expect(secrets.CHATGPT_ID_TOKEN!.serverOnly).toBe(true);
    // Access token + account ID are NOT server-only — they reach the sandbox
    // as placeholder values, substituted by the firewall token-replacement
    // layer at egress.
    expect(secrets.CHATGPT_ACCESS_TOKEN!.serverOnly).not.toBe(true);
    expect(secrets.CHATGPT_ACCOUNT_ID!.serverOnly).not.toBe(true);
  });

  it("CODEX_AUTH_JSON wire-shape secret is optional and serverOnly (raw blob never persisted nor reaches sandbox)", () => {
    const secrets = getSecretsForAuthMethod("codex-oauth-token", "auth_json")!;
    expect(secrets.CODEX_AUTH_JSON!.serverOnly).toBe(true);
    expect(secrets.CODEX_AUTH_JSON!.required).toBe(false);
  });

  it("envBindings does NOT reference refresh or id tokens", () => {
    const envBindings = getModelProviderEnvBindings("codex-oauth-token")!;
    const values = Object.values(envBindings).join(" ");
    expect(values).not.toContain("CHATGPT_REFRESH_TOKEN");
    expect(values).not.toContain("CHATGPT_ID_TOKEN");
  });

  it("envBindings injects access token, account id, and model", () => {
    const envBindings = getModelProviderEnvBindings("codex-oauth-token")!;
    expect(envBindings.CHATGPT_ACCESS_TOKEN).toBe(
      "$secrets.CHATGPT_ACCESS_TOKEN",
    );
    expect(envBindings.CHATGPT_ACCOUNT_ID).toBe("$secrets.CHATGPT_ACCOUNT_ID");
    expect(envBindings.OPENAI_MODEL).toBe("$model");
  });

  it("offers current GPT models with gpt-5.6-sol default", () => {
    expect(getModels("codex-oauth-token")).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(getDefaultModel("codex-oauth-token")).toBe("gpt-5.6-sol");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("codex-oauth-token")).toBe(true);
  });

  it("firewall entry has both ChatGPT and auth.openai.com APIs", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis).toHaveLength(2);
    expect(config.apis[0]!.base).toBe("https://chatgpt.com/backend-api/codex");
    expect(config.apis[1]!.base).toBe("https://auth.openai.com");
  });

  it("firewall injects Authorization and ChatGPT-Account-ID headers", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
      "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
    });
  });

  it("firewall allows the entire ChatGPT Codex backend subtree under GET/POST", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.permissions).toEqual([
      {
        name: "codex:api",
        description:
          "Access the ChatGPT Codex backend with GET and POST requests.",
        rules: ["GET /{path*}", "POST /{path*}"],
      },
    ]);
  });

  it.each([
    ["GET", "/models"],
    ["GET", "/responses"],
    ["POST", "/responses"],
    ["POST", "/responses/compact"],
    ["GET", "/responses/abc123"],
    ["POST", "/analytics-events/events"],
  ] as const)("codex:api permission matches %s %s", (method, path) => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const fwConfig = { name: config.name, apis: [config.apis[0]!] };
    expect(findMatchingPermissions(method, path, fwConfig)).toEqual([
      "codex:api",
    ]);
  });

  it.each([
    ["DELETE", "/responses/abc123"],
    ["PUT", "/responses/abc123"],
    ["PATCH", "/settings"],
  ] as const)(
    "codex:api permission rejects %s %s (method narrowing)",
    (method, path) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
      const fwConfig = { name: config.name, apis: [config.apis[0]!] };
      expect(findMatchingPermissions(method, path, fwConfig)).toEqual([]);
    },
  );

  it("firewall denies auth.openai.com via unknown endpoint policy", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.defaultPolicies).toEqual({
      unknownPolicy: "deny",
    });
    expect(config.apis[1]!.permissions).toEqual([]);
  });

  it.each([
    ["GET", "/"],
    ["POST", "/oauth/token"],
    ["DELETE", "/sessions/abc"],
  ] as const)(
    "auth.openai.com matches no allow permission for %s %s",
    (method, path) => {
      // auth.openai.com intentionally exposes no grantable permissions. The
      // deny is delivered by defaultPolicies.unknownPolicy: "deny", so traffic
      // to auth.openai.com must NOT resolve to any permission name on apis[1].
      // This pins behavior so a future edit to `apis[1].permissions` breaks the
      // test rather than silently widening auth.openai.com.
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
      const fwConfig = { name: config.name, apis: [config.apis[1]!] };
      expect(findMatchingPermissions(method, path, fwConfig)).toEqual([]);
    },
  );

  it("CHATGPT_ACCESS_TOKEN placeholder is an opaque marker (not a JWT)", () => {
    // Codex doesn't read this environment name in ChatGPT mode — it reads the real
    // JWT from ~/.codex/auth.json (written by guest-agent #11877). The
    // firewall only needs a stable, non-empty marker to match-and-substitute
    // at egress. A JWT-shaped placeholder triggers Semgrep's
    // detected-jwt-token rule even though the contents are obvious dummies.
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const token = config.placeholders!.CHATGPT_ACCESS_TOKEN!;
    expect(token.length).toBeGreaterThan(20);
    // Not a 3-segment JWT — a single dotless string is fine.
    expect(token.split(".")).toHaveLength(1);
  });

  it("firewall placeholders expose the Codex OAuth fake marker bytes", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.placeholders).toEqual({
      CHATGPT_ACCESS_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
      CHATGPT_ACCOUNT_ID: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
      CHATGPT_REFRESH_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN,
    });
  });

  it("modelProviderTypeSchema accepts codex-oauth-token", () => {
    expect(modelProviderTypeSchema.safeParse("codex-oauth-token").success).toBe(
      true,
    );
  });
});

describe("model provider primary firewall inference paths", () => {
  it.each([
    ["anthropic-api-key", "https://api.anthropic.com/v1/messages"],
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1/messages"],
    ["deepseek", "https://api.deepseek.com/responses"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/messages"],
    ["openai-api-key", "https://api.openai.com/v1/responses"],
    ["codex-oauth-token", "https://chatgpt.com/backend-api/codex"],
    ["openrouter-codex", "https://openrouter.ai/api/v1/responses"],
    ["vercel-ai-gateway-codex", "https://ai-gateway.vercel.sh/v1/responses"],
  ] as const)("%s firewall base URL is %s", (type, expected) => {
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS[type]!.apis[0]!.base).toBe(expected);
  });
});

describe("codex-framework gateway providers (openrouter-codex, vercel-ai-gateway-codex)", () => {
  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s declares codex framework",
    (type) => {
      expect(getFrameworkForType(type)).toBe("codex");
    },
  );

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s maps OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL",
    (type) => {
      const envBindings = getModelProviderEnvBindings(type);
      expect(envBindings).toBeDefined();
      expect(envBindings!["OPENAI_API_KEY"]).toBe("$secret");
      expect(envBindings!["OPENAI_BASE_URL"]).toMatch(/^https:\/\//);
      expect(envBindings!["OPENAI_MODEL"]).toBe("$model");
    },
  );

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s offers current GPT models with gpt-5.6-luna default",
    (type) => {
      expect(getModels(type)).toEqual(
        expect.arrayContaining([
          "openai/gpt-5.6-sol",
          "openai/gpt-5.6-terra",
          "openai/gpt-5.6-luna",
          "openai/gpt-5.5",
        ]),
      );
      if (type === "openrouter-codex") {
        expect(getModels(type)).toEqual(
          expect.arrayContaining([
            "openai/gpt-6-astra",
            "deepseek/deepseek-v4.1-flash",
            "deepseek/deepseek-v4-flash",
            "deepseek/deepseek-v4-pro",
          ]),
        );
      }
      if (type === "vercel-ai-gateway-codex") {
        expect(getModels(type)).not.toContain("openai/gpt-6-astra");
      }
      expect(getDefaultModel(type)).toBe("openai/gpt-5.6-luna");
    },
  );

  it("appear in selectable provider types", () => {
    const selectable = getSelectableProviderTypes();
    expect(selectable).toContain("openrouter-codex");
    expect(selectable).toContain("vercel-ai-gateway-codex");
  });

  it("translates canonical models to vendor-prefixed runtime IDs", () => {
    expect(getProviderRuntimeModel("openrouter-codex", "gpt-6-astra")).toBe(
      "openai/gpt-6-astra",
    );
    expect(getProviderRuntimeModel("openrouter-codex", "gpt-5.5")).toBe(
      "openai/gpt-5.5",
    );
    expect(
      getProviderRuntimeModel("openrouter-codex", "deepseek-v4.1-flash"),
    ).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("share the secretName with their claude-code twin gateway", () => {
    // Same API key powers both protocols on the same upstream gateway.
    // The codex twin must not invent a separate secret environment name.
    const openrouterCodex = MODEL_PROVIDER_TYPES["openrouter-codex"];
    const openrouterClaudeCode = MODEL_PROVIDER_TYPES["openrouter-api-key"];
    expect(openrouterCodex.secretName).toBe(openrouterClaudeCode.secretName);

    const vercelCodex = MODEL_PROVIDER_TYPES["vercel-ai-gateway-codex"];
    const vercelClaudeCode = MODEL_PROVIDER_TYPES["vercel-ai-gateway"];
    expect(vercelCodex.secretName).toBe(vercelClaudeCode.secretName);
  });

  it("modelProviderTypeSchema accepts both new types", () => {
    expect(modelProviderTypeSchema.safeParse("openrouter-codex").success).toBe(
      true,
    );
    expect(
      modelProviderTypeSchema.safeParse("vercel-ai-gateway-codex").success,
    ).toBe(true);
  });

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s injects Authorization only on exact OpenAI inference paths",
    (type) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      const providerBase = getModelProviderEnvBindings(type)?.OPENAI_BASE_URL;
      expect(providerBase).toBeDefined();
      expect(
        config.apis.map((api) => {
          return api.base;
        }),
      ).toStrictEqual([
        `${providerBase}/responses`,
        `${providerBase}/chat/completions`,
      ]);
      for (const api of config.apis) {
        expect(api.auth.headers).toMatchObject({
          Authorization: expect.stringMatching(
            /^Bearer \$\{\{ secrets\.[A-Z_]+ \}\}$/,
          ),
        });
      }
    },
  );
});

describe("custom model gateway provider types", () => {
  it("mirror the surface protocol instead of an unrelated vendor", () => {
    expect(getModelProviderTypeForSurfaceProtocol("anthropic-messages")).toBe(
      "custom-anthropic-messages",
    );
    expect(getModelProviderTypeForSurfaceProtocol("openai-responses")).toBe(
      "custom-openai-responses",
    );
  });

  it("resolve the framework the runtime adapter needs", () => {
    expect(getFrameworkForType("custom-anthropic-messages")).toBe(
      "claude-code",
    );
    expect(getFrameworkForType("custom-openai-responses")).toBe("codex");
  });

  it("stay out of the provider picker", () => {
    const selectable = getSelectableProviderTypes();
    expect(selectable).not.toContain("custom-anthropic-messages");
    expect(selectable).not.toContain("custom-openai-responses");
  });

  it("are accepted by modelProviderTypeSchema so stored rows parse", () => {
    expect(
      modelProviderTypeSchema.safeParse("custom-anthropic-messages").success,
    ).toBe(true);
    expect(
      modelProviderTypeSchema.safeParse("custom-openai-responses").success,
    ).toBe(true);
  });

  it("carry no static credential, binding, or model catalog", () => {
    // The runtime is compiled from the surface row, so a static entry here
    // would be a second source of truth.
    for (const type of [
      "custom-anthropic-messages",
      "custom-openai-responses",
    ] as const) {
      expect(getSecretNameForType(type)).toBeUndefined();
      expect(getAuthMethodsForType(type)).toBeUndefined();
      expect(getModelProviderEnvBindings(type)).toBeUndefined();
      expect(getModels(type)).toBeUndefined();
      expect(getDefaultModel(type)).toBeUndefined();
      expect(hasModelSelection(type)).toBe(false);
    }
  });

  it("leave the genuine Vercel BYOK types intact", () => {
    expect(getSecretNameForType("vercel-ai-gateway")).toBe(
      "VERCEL_AI_GATEWAY_API_KEY",
    );
    expect(
      getModelProviderEnvBindings("vercel-ai-gateway-codex")?.OPENAI_BASE_URL,
    ).toBe("https://ai-gateway.vercel.sh/v1");
    const selectable = getSelectableProviderTypes();
    expect(selectable).toContain("vercel-ai-gateway");
    expect(selectable).toContain("vercel-ai-gateway-codex");
  });
});

describe("built-in provider discriminator contract", () => {
  const providerResponse = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "built-in",
    framework: "claude-code",
    secretName: null,
    authMethod: null,
    secretNames: null,
    isDefault: true,
    selectedModel: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    needsReconnect: false,
    lastRefreshErrorCode: null,
  } as const;
  const policyResponse = {
    id: "22222222-2222-4222-8222-222222222222",
    model: "gpt-5.6-sol",
    modelLabel: "GPT 5.6 Sol",
    isDefault: true,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  } as const;

  it("recognizes the canonical built-in discriminator", () => {
    expect(isBuiltInModelProviderType("built-in")).toBe(true);
  });

  it("accepts built-in in read contracts", () => {
    expect(modelProviderTypeSchema.parse("built-in")).toBe("built-in");
    expect(modelProviderResponseSchema.parse(providerResponse).type).toBe(
      "built-in",
    );
    expect(orgModelPolicySchema.parse(policyResponse).defaultProviderType).toBe(
      "built-in",
    );
  });

  it("accepts built-in in write contracts", () => {
    expect(modelProviderWriteTypeSchema.parse("built-in")).toBe("built-in");
    expect(
      upsertModelProviderRequestSchema.parse({ type: "built-in" }).type,
    ).toBe("built-in");
    expect(
      modelProvidersByTypeContract.delete.pathParams.parse({
        type: "built-in",
      }).type,
    ).toBe("built-in");

    const policy = {
      model: "gpt-5.6-sol",
      isDefault: true,
      credentialScope: "org",
      modelProviderId: null,
    } as const;
    expect(
      updateOrgModelPolicySchema.parse({
        ...policy,
        defaultProviderType: "built-in",
      }).defaultProviderType,
    ).toBe("built-in");
  });

  it("exposes built-in exactly once without a firewall", () => {
    expect(MODEL_PROVIDER_TYPES).toHaveProperty("built-in");
    expect(getFrameworkForType("built-in")).toBe("claude-code");
    expect(getModelProviderPresentationLabel("built-in")).toBe(
      "Built-in model",
    );
    expect(isModelSupportedByProvider("gpt-5.6-sol", "built-in")).toBe(true);
    expect(getProviderRuntimeModel("built-in", "gpt-5.6-sol")).toBe(
      "gpt-5.6-sol",
    );
    expect(getSecretNameForType("built-in")).toBeUndefined();
    expect(getModelProviderFirewall("anthropic-api-key")).toBeDefined();
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS).not.toHaveProperty("built-in");

    const selectable = getSelectableProviderTypes();
    expect(
      selectable.filter((type) => {
        return type === "built-in";
      }),
    ).toHaveLength(1);
    expect(getProvidersForModel("gpt-5.6-sol")).toContain("built-in");
  });

  it("emits the canonical writer value from default policy seeds", () => {
    expect(
      getDefaultOrgModelPolicySeed().every((policy) => {
        return policy.defaultProviderType === "built-in";
      }),
    ).toBe(true);

    const writeType: ModelProviderWriteType = "built-in";
    expect(writeType).toBe("built-in");
  });
});
