import { describe, it, expect } from "vitest";
import {
  getModelProviderEnvBindings,
  getFrameworkForType,
  getModelProviderPresentationLabel,
  getCatalogRunModelRouteAccess,
  normalizeRunModelId,
  getSecretNameForType,
  getModelProviderFirewall,
  getModelProviderCodexCatalogForModel,
  isOkouRunModel,
  getSecretsForAuthMethod,
  isBuiltInModelProviderType,
  modelProviderCredentialScopeSchema,
  modelProviderResponseSchema,
  availableRunModelSchema,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
} from "../model-providers";
import {
  findMatchingPermissions,
  matchFirewallRequestDecision,
} from "@okouai/connectors/firewall-rule-matcher";

describe("model-first canonical catalog", () => {
  it("exposes canonical model provider env placeholders", () => {
    expect(Object.keys(MODEL_PROVIDER_ENV_PLACEHOLDERS).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
    ]);
    expect(MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN).toMatch(
      /^sk-ant-oat01-/,
    );
    expect(MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY).toMatch(/^sk-proj-/);
    expect(
      MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN.split("."),
    ).toHaveLength(1);
  });

  it("validates credential scopes", () => {
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
    expect(normalizeRunModelId("anthropic/claude-opus-5.5")).toBe(
      "claude-opus-5-5",
    );
    expect(normalizeRunModelId("anthropic/claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(normalizeRunModelId("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek-v4.1-flash",
    );
    expect(normalizeRunModelId("custom/model")).toBe("custom/model");
  });

  it("decides restricted-plan access from the catalog model's policy", () => {
    const freeModel = { builtInOnRestrictedPlans: true };
    const paidModel = { builtInOnRestrictedPlans: false };
    expect(getCatalogRunModelRouteAccess(freeModel, "built-in", true)).toBe(
      "allowed",
    );
    expect(getCatalogRunModelRouteAccess(freeModel, null, true)).toBe(
      "allowed",
    );
    expect(
      getCatalogRunModelRouteAccess(freeModel, "codex-oauth-token", true),
    ).toBe("pro_required");
    expect(getCatalogRunModelRouteAccess(paidModel, "built-in", true)).toBe(
      "pro_required",
    );
    expect(getCatalogRunModelRouteAccess(paidModel, "built-in", false)).toBe(
      "allowed",
    );
    expect(
      getCatalogRunModelRouteAccess(paidModel, "codex-oauth-token", false),
    ).toBe("allowed");
  });

  it("recognizes only own Okou model IDs", () => {
    expect(isOkouRunModel("okou-1.0")).toBeTruthy();
    expect(isOkouRunModel("okou-1-0")).toBeFalsy();
    expect(isOkouRunModel("toString")).toBeFalsy();
    expect(isOkouRunModel("__proto__")).toBeFalsy();
  });

  it.each([
    {
      model: "okou-1.0",
      preset: "@preset/okou-1-0",
      displayName: "Auto",
      sourceModel: "GPT-6 Luna",
      sourceModelId: "openai/gpt-6-luna",
      reasoningEffort: "max",
    },
  ] as const)(
    "projects Codex metadata for Okou $model to its OpenRouter Preset",
    ({
      model,
      preset,
      displayName,
      sourceModel,
      sourceModelId,
      reasoningEffort,
    }) => {
      const catalog = getModelProviderCodexCatalogForModel(model, preset);

      expect(catalog?.models).toHaveLength(1);
      expect(catalog?.models).toEqual([
        expect.objectContaining({
          slug: preset,
          display_name: displayName,
          description: expect.stringContaining(
            `${sourceModel} (${sourceModelId})`,
          ),
          default_reasoning_level: reasoningEffort,
          supported_reasoning_levels: [
            expect.objectContaining({ effort: reasoningEffort }),
          ],
          supports_reasoning_effort_updates: false,
          context_window: 1_050_000,
          max_context_window: 1_050_000,
          effective_context_window_percent: 87,
          input_modalities: ["text", "image"],
          truncation_policy: { mode: "tokens", limit: 10_000 },
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text_and_image",
          supports_search_tool: true,
          tool_mode: "code_mode_only",
          model_messages: expect.objectContaining({
            instructions_template: expect.stringContaining(
              "You are Codex, an agent based on GPT-6.",
            ),
          }),
        }),
      ]);
    },
  );
});

describe("model selection for Anthropic-native providers", () => {
  it("claude-code-oauth-token maps ANTHROPIC_MODEL via env bindings", () => {
    const envBindings = getModelProviderEnvBindings("claude-code-oauth-token");
    expect(envBindings).toBeDefined();
    expect(envBindings!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("$secret");
    expect(envBindings!["ANTHROPIC_MODEL"]).toBe("$model");
  });
});

describe("firewall base URL scoped to /v1/messages (#9560)", () => {
  it.each([
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
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
      "claude-code-oauth-token",
      "CLAUDE_CODE_OAUTH_TOKEN",
      MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
    ],
    [
      "openrouter-codex",
      "OPENROUTER_API_KEY",
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

  it("supports only the auth_json multi-auth shape with CHATGPT_* fields", () => {
    expect(
      getSecretsForAuthMethod("codex-oauth-token", "oauth"),
    ).toBeUndefined();
    const authJsonSecrets = getSecretsForAuthMethod(
      "codex-oauth-token",
      "auth_json",
    )!;
    expect(Object.keys(authJsonSecrets).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CODEX_AUTH_JSON",
    ]);
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

  it("firewall includes the ChatGPT backend API and auth denial APIs", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis).toHaveLength(2);
    expect(config.apis[0]!.base).toBe("https://chatgpt.com/backend-api");
    expect(config.apis[1]!.base).toBe("https://auth.openai.com");
  });

  it("firewall injects Authorization and ChatGPT-Account-ID for the backend API", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
      "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
    });
  });

  it("firewall allows the ChatGPT backend API subtree under GET/POST", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.permissions).toEqual([
      {
        name: "codex:api",
        description:
          "Access the ChatGPT backend API with GET and POST requests.",
        rules: ["GET /{path*}", "POST /{path*}"],
      },
    ]);
  });

  it.each([
    ["GET", "/codex/models"],
    ["GET", "/codex/responses"],
    ["POST", "/codex/responses"],
    ["POST", "/codex/responses/compact"],
    ["GET", "/codex/responses/abc123"],
    ["POST", "/codex/analytics-events/events"],
    ["GET", "/wham/accounts/check"],
    ["GET", "/wham/settings/user"],
    ["GET", "/wham/usage"],
    ["POST", "/wham/rate-limit-reset-credits/consume"],
    ["GET", "/future/backend-route"],
  ] as const)("codex:api permission matches %s %s", (method, path) => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const fwConfig = { name: config.name, apis: [config.apis[0]!] };
    expect(findMatchingPermissions(method, path, fwConfig)).toEqual([
      "codex:api",
    ]);
  });

  it.each([
    ["DELETE", "/codex/responses/abc123"],
    ["PUT", "/codex/responses/abc123"],
    ["PATCH", "/wham/settings/user"],
  ] as const)(
    "codex:api permission rejects %s %s (method narrowing)",
    (method, path) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
      const fwConfig = { name: config.name, apis: [config.apis[0]!] };
      expect(findMatchingPermissions(method, path, fwConfig)).toEqual([]);
    },
  );

  it("authenticates GET and POST throughout the ChatGPT backend API", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const policies = {
      [config.name]: {
        allow: ["codex:api"],
        deny: [],
        ask: [],
        unknownPolicy: "deny",
      },
    };
    const decide = (method: string, path: string) => {
      return matchFirewallRequestDecision(
        [config],
        method,
        `https://chatgpt.com${path}`,
        policies,
      );
    };

    expect(decide("GET", "/backend-api/wham/accounts/check")).toMatchObject({
      kind: "allow",
      firewallName: config.name,
      permission: "codex:api",
    });
    expect(decide("POST", "/backend-api/wham/accounts/check")).toMatchObject({
      kind: "allow",
      permission: "codex:api",
    });
    expect(decide("GET", "/backend-api/wham/settings/user")).toMatchObject({
      kind: "allow",
      permission: "codex:api",
    });
    expect(decide("DELETE", "/backend-api/wham/accounts/check")).toMatchObject({
      kind: "block",
      reason: "unknown_endpoint",
    });
    expect(decide("GET", "/backend-api-other/wham/accounts/check")).toEqual({
      kind: "no_match",
    });
  });

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

describe("model provider primary firewall bases", () => {
  it.each([
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["codex-oauth-token", "https://chatgpt.com/backend-api"],
    ["openrouter-codex", "https://openrouter.ai/api/v1/responses"],
  ] as const)("%s firewall base URL is %s", (type, expected) => {
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS[type]!.apis[0]!.base).toBe(expected);
  });
});

describe("Auto concrete provider (openrouter-codex)", () => {
  it.each(["openrouter-codex"] as const)(
    "%s declares codex framework",
    (type) => {
      expect(getFrameworkForType(type)).toBe("codex");
    },
  );

  it.each(["openrouter-codex"] as const)(
    "%s maps OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL",
    (type) => {
      const envBindings = getModelProviderEnvBindings(type);
      expect(envBindings).toBeDefined();
      expect(envBindings!["OPENAI_API_KEY"]).toBe("$secret");
      expect(envBindings!["OPENAI_BASE_URL"]).toMatch(/^https:\/\//);
      expect(envBindings!["OPENAI_MODEL"]).toBe("$model");
    },
  );

  it.each(["openrouter-codex"] as const)(
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

describe("built-in provider discriminator contract", () => {
  const providerResponse = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "built-in",
    framework: "claude-code",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    needsReconnect: false,
    lastRefreshErrorCode: null,
  } as const;
  const policyResponse = {
    id: "22222222-2222-4222-8222-222222222222",
    model: "okou-1.0",
    modelLabel: "Auto",
    modelProviderId: null,
    memberEffective: {
      providerType: "built-in",
      runtimeProviderType: "openrouter-codex",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    },
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
    expect(
      availableRunModelSchema.parse(policyResponse).memberEffective
        .providerType,
    ).toBe("built-in");
  });

  it("exposes built-in exactly once without a firewall", () => {
    expect(MODEL_PROVIDER_TYPES).toHaveProperty("built-in");
    expect(getFrameworkForType("built-in")).toBe("codex");
    expect(getModelProviderPresentationLabel("built-in")).toBe(
      "Built-in model",
    );
    expect(getSecretNameForType("built-in")).toBeUndefined();
    expect(getModelProviderFirewall("openrouter-codex")).toBeDefined();
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS).not.toHaveProperty("built-in");
  });
});
