import { z } from "zod";

import {
  MODEL_PROVIDER_TYPE_IDS,
  isBuiltInModelProviderType,
  type ModelProviderFramework,
  type ModelProviderType,
} from "./model-provider-types";
import {
  OKOU_MODEL_CODEX_CATALOG,
  OKOU_RUN_MODELS,
  type OkouRunModel,
} from "./okou-model-metadata";
export {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  MODEL_PROVIDER_PI_APIS,
  getModelProviderFirewall,
  getModelProviderPiEndpoint,
} from "./model-provider-firewalls";
export type {
  ModelProviderPiApi,
  ModelProviderPiEndpoint,
} from "./model-provider-firewalls";
export {
  isBuiltInModelProviderType,
  isPersonalSubscriptionProviderType,
} from "./model-provider-types";
export type {
  BuiltInModelProviderType,
  ModelProviderFramework,
  ModelProviderType,
  PersonalSubscriptionProviderType,
} from "./model-provider-types";

/**
 * Secret field configuration for multi-secret providers
 */
interface SecretFieldConfig {
  required: boolean;
  /**
   * When true, this secret is persisted server-side and MUST NOT flow to the
   * runner/sandbox. Used for OAuth refresh tokens and ID tokens that the
   * server holds for refresh + plan-type validation but the sandbox must
   * never see (per #7365). Honored by `resolveMultiAuthProviderSecrets`.
   */
  serverOnly?: boolean;
}

/**
 * Auth method configuration for providers with multiple auth options
 */
interface AuthMethodConfig {
  secrets: Record<string, SecretFieldConfig>;
}

export type ModelProviderEnvBindings = Record<string, string>;

export const modelProviderCodexRuntimeConfigSchema = z.object({
  providerId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  baseUrl: z.url(),
  envKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  requiresOpenaiAuth: z.boolean().optional(),
  wireApi: z.literal("responses"),
  supportsWebsockets: z.boolean(),
  modelCatalog: z.record(z.string(), z.unknown()).optional(),
});

export type ModelProviderCodexRuntimeConfig = z.infer<
  typeof modelProviderCodexRuntimeConfigSchema
>;

export type ModelProviderCodexRuntimeCapabilities = Pick<
  ModelProviderCodexRuntimeConfig,
  "supportsWebsockets"
>;

const MODEL_PROVIDER_CODEX_RUNTIME_CAPABILITIES: Partial<
  Record<ModelProviderType, ModelProviderCodexRuntimeCapabilities>
> = {
  "openrouter-codex": {
    supportsWebsockets: false,
  },
};

/**
 * A run model ID on the wire. The global model catalog (served by
 * `GET /api/model-catalog`) is the authority; the API validates and resolves
 * the ID against it, so clients can pass catalog models this package does
 * not list.
 */
export const runModelIdSchema = z.string().trim().min(1).max(255);

export const modelProviderCredentialScopeSchema = z.enum(["org", "member"]);

export type ModelProviderCredentialScope = z.infer<
  typeof modelProviderCredentialScopeSchema
>;

export { OKOU_RUN_MODELS, type OkouRunModel };

const OKOU_RUN_MODEL_SET: ReadonlySet<string> = new Set(OKOU_RUN_MODELS);

export function isOkouRunModel(
  model: string | null | undefined,
): model is OkouRunModel {
  return typeof model === "string" && OKOU_RUN_MODEL_SET.has(model);
}

// Retirement and replacement are owned by the global model catalog
// (`run_model_catalog.replaced_by`).
export const RETIRED_RUN_MODEL_MESSAGE =
  "This model has been retired. Select another available model.";

/**
 * Plan policy of one catalog model (`run_model_catalog`) for organizations
 * whose plan restricts Built-in models.
 */
export interface RestrictedPlanModelAccess {
  readonly builtInOnRestrictedPlans: boolean;
}

/**
 * Plan access of a catalog model on a route. A restricted plan runs only
 * catalog models flagged `builtInOnRestrictedPlans`, and only on Built-in
 * routes (a missing or unknown provider type is treated as Built-in). A
 * member's personal subscription route is not a plan entitlement; when the
 * subscription is verified the API decides access before it calls this (it
 * passes an unrestricted plan). A model outside the catalog (`access` undefined) is
 * never allowed on a restricted plan.
 */
export function getCatalogRunModelRouteAccess(
  access: RestrictedPlanModelAccess | undefined,
  providerType: string | null | undefined,
  restrictedBuiltInModels = false,
): "allowed" | "pro_required" {
  if (!restrictedBuiltInModels) {
    return "allowed";
  }
  const ownRoute = MODEL_PROVIDER_TYPE_IDS.some((type) => {
    return type === providerType && !isBuiltInModelProviderType(type);
  });
  return !ownRoute && access?.builtInOnRestrictedPlans === true
    ? "allowed"
    : "pro_required";
}

/**
 * Model Provider type configuration
 * Maps type to framework, secret name, and display label
 *
 * For providers with `envBindings`, the secret is mapped to framework variables:
 * - `$secret` → the stored single secret (`secretName`)
 * - `$secrets.X` → lookup secret X from the `authMethods` secrets map
 * - `$model` → the selected model
 * - Other values are passed through as literals
 */
const BUILT_IN_MODEL_PROVIDER_CONFIG = {
  // Auto's protocol provider is `openrouter-codex`.
  framework: "codex" as const,
  label: "Built-in model",
};

export const MODEL_PROVIDER_TYPES = {
  "claude-code-oauth-token": {
    framework: "claude-code" as const,
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code (OAuth Token)",
    envBindings: {
      CLAUDE_CODE_OAUTH_TOKEN: "$secret",
      ANTHROPIC_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
  },
  // Concrete provider behind the platform Auto route (OpenAI Responses via
  // OpenRouter).
  "openrouter-codex": {
    framework: "codex" as const,
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter (Codex)",
    envBindings: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
  },
  "codex-oauth-token": {
    framework: "codex" as const,
    label: "ChatGPT (Codex)",
    authMethods: {
      // Paste-based auth: client posts CODEX_AUTH_JSON, server parses it via
      // codex-auth-json-parser.ts and persists the four derived CHATGPT_*
      // fields. The raw blob is NEVER stored. The wire-shape secret
      // (CODEX_AUTH_JSON) is declared optional+serverOnly so the contract
      // accepts it on POST without persisting; the four CHATGPT_* fields are
      // the canonical stored secrets and the firewall layer reads from those.
      auth_json: {
        secrets: {
          CODEX_AUTH_JSON: {
            required: false,
            serverOnly: true,
          },
          // CHATGPT_ACCESS_TOKEN and CHATGPT_ACCOUNT_ID reach the sandbox env
          // as placeholder values (substituted by the firewall token-replacement
          // layer at egress) — keeping them non-serverOnly preserves the
          // placeholder injection path. CHATGPT_REFRESH_TOKEN and
          // CHATGPT_ID_TOKEN stay serverOnly per the #7365 invariant. The
          // server-side parser populates all four from CODEX_AUTH_JSON.
          CHATGPT_ACCESS_TOKEN: {
            required: true,
          },
          CHATGPT_REFRESH_TOKEN: {
            required: true,
            serverOnly: true,
          },
          CHATGPT_ACCOUNT_ID: {
            required: true,
          },
          CHATGPT_ID_TOKEN: {
            required: true,
            serverOnly: true,
          },
        },
      },
    } satisfies Record<string, AuthMethodConfig>,
    envBindings: {
      CHATGPT_ACCESS_TOKEN: "$secrets.CHATGPT_ACCESS_TOKEN",
      CHATGPT_ACCOUNT_ID: "$secrets.CHATGPT_ACCOUNT_ID",
      OPENAI_MODEL: "$model",
    } satisfies ModelProviderEnvBindings,
  },
  "built-in": BUILT_IN_MODEL_PROVIDER_CONFIG,
} as const satisfies Record<ModelProviderType, unknown>;

export function getModelProviderPresentationLabel(
  type: ModelProviderType,
): string {
  return MODEL_PROVIDER_TYPES[type].label;
}

const CANONICAL_RUN_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek/deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek/deepseek-v4-pro": "deepseek-v4-pro",
  "anthropic/claude-fable-5.1": "claude-fable-5-1",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-opus-5.5": "claude-opus-5-5",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-4.8": "claude-opus-4-8",
  "anthropic/claude-sonnet-5-5": "claude-sonnet-5-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
};

export function normalizeRunModelId(model: string): string {
  return CANONICAL_RUN_MODEL_ALIASES[model] ?? model;
}

export const modelProviderTypeSchema = z.enum(MODEL_PROVIDER_TYPE_IDS);

export const modelProviderFrameworkSchema = z.enum(["claude-code", "codex"]);

/**
 * Get framework for a model provider type
 */
export function getFrameworkForType(
  type: ModelProviderType,
): ModelProviderFramework {
  return MODEL_PROVIDER_TYPES[type]?.framework ?? "claude-code";
}

/**
 * Get secret name for a single-secret model provider type
 * Returns undefined for multi-auth providers
 */
export function getSecretNameForType(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return undefined;
  return "secretName" in config ? config.secretName : undefined;
}

/**
 * Check if a model provider type has multiple auth methods
 */
export function hasAuthMethods(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return false;
  return "authMethods" in config;
}

/**
 * Get secrets config for a specific auth method
 * Returns undefined if provider doesn't have auth methods or auth method doesn't exist
 */
export function getSecretsForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): Record<string, SecretFieldConfig> | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  const authMethods: Record<string, AuthMethodConfig> | undefined =
    "authMethods" in config ? config.authMethods : undefined;
  if (!authMethods || !(authMethod in authMethods)) {
    return undefined;
  }
  const method = authMethods[authMethod];
  return method?.secrets;
}

/**
 * Get secret names for a specific auth method
 * Returns array of secret names required for the auth method
 */
export function getSecretNamesForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): string[] | undefined {
  const secrets = getSecretsForAuthMethod(type, authMethod);
  if (!secrets) {
    return undefined;
  }
  return Object.keys(secrets);
}

/**
 * Get runtime environment bindings for a model provider type.
 * Returns undefined for providers without env bindings (use secret directly).
 */
export function getModelProviderEnvBindings(
  type: ModelProviderType,
): ModelProviderEnvBindings | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "envBindings" in config ? config.envBindings : undefined;
}

/**
 * Get Codex runtime capabilities that apply independently from model metadata.
 */
export function getModelProviderCodexRuntimeCapabilities(
  type: ModelProviderType,
): ModelProviderCodexRuntimeCapabilities | undefined {
  return MODEL_PROVIDER_CODEX_RUNTIME_CAPABILITIES[type];
}

/**
 * Project an Okou model's Codex catalog record onto the model ID used at
 * runtime. Returns undefined for a model without Okou metadata.
 */
export function getModelProviderCodexCatalogForModel(
  logicalModel: string,
  runtimeModel: string,
): Record<string, unknown> | undefined {
  const sourceModel = OKOU_MODEL_CODEX_CATALOG.models.find((model) => {
    return model.slug === logicalModel;
  });
  if (!sourceModel) {
    return undefined;
  }
  return {
    ...OKOU_MODEL_CODEX_CATALOG,
    models: [{ ...sourceModel, slug: runtimeModel }],
  };
}

export const modelProviderSubscriptionUsageWindowSchema = z.object({
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  resetAt: z.string().nullable(),
  windowSeconds: z.number().nullable(),
});

export const modelProviderSubscriptionUsageSchema = z.object({
  fiveHour: modelProviderSubscriptionUsageWindowSchema.nullable(),
  weekly: modelProviderSubscriptionUsageWindowSchema.nullable(),
});

/**
 * Model provider response
 */
export const modelProviderResponseSchema = z.object({
  id: z.uuid(),
  // Present for concrete personal subscription accounts. `id` is the exact
  // credential identity pinned to a run, while `modelProviderId` is the
  // logical model route retained for compatibility with existing settings.
  modelProviderId: z.uuid().optional(),
  isActive: z.boolean().optional(),
  type: modelProviderTypeSchema,
  framework: modelProviderFrameworkSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  // OAuth account metadata populated by provider-specific connect flows. Other
  // provider types omit these.
  accountEmail: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  // Subscription quota metadata. Providers omit these until an upstream source
  // exposes the reset cadence or next reset timestamp.
  subscriptionResetPeriod: z.string().nullable().optional(),
  subscriptionNextResetAt: z.string().nullable().optional(),
  subscriptionUsage: modelProviderSubscriptionUsageSchema.nullable().optional(),
  // A provider capability, independent of the currently available reset credits.
  subscriptionResetSupported: z.boolean().optional(),
  subscriptionResetCredits: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional(),
  // Soonest expiry among the reset credits the account can still redeem. Null
  // when nothing expires, and also when the upstream detail read degraded to a
  // bare count, so the UI must treat it as decoration on top of the count.
  subscriptionResetCreditsNextExpiresAt: z.string().nullable().optional(),
  // OAuth refresh state. `needsReconnect` flips to true when the firewall's
  // refresh attempt fails (written on the model_provider_accounts row).
  // `lastRefreshErrorCode` carries the typed code from `ChatgptRefreshError`
  // (e.g. `refresh_token_expired`) so the UI can render an actionable
  // re-connect message. Both fields are always emitted for OAuth-typed
  // providers; non-OAuth types default to false / null.
  needsReconnect: z.boolean(),
  lastRefreshErrorCode: z.string().nullable(),
});

export type ModelProviderResponse = z.infer<typeof modelProviderResponseSchema>;

/**
 * List model providers response
 */
export const modelProviderListResponseSchema = z.object({
  modelProviders: z.array(modelProviderResponseSchema),
});

export type ModelProviderListResponse = z.infer<
  typeof modelProviderListResponseSchema
>;

/**
 * Connect or update a personal subscription.
 *
 * Claude Code sends its OAuth token as `secret`. Codex sends
 * `authMethod: "auth_json"` with `secrets.CODEX_AUTH_JSON`.
 */
export const upsertModelProviderRequestSchema = z.object({
  type: z.enum(["claude-code-oauth-token", "codex-oauth-token"]),
  secret: z.string().min(1).optional(),
  authMethod: z.string().optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});

export type UpsertModelProviderRequest = z.infer<
  typeof upsertModelProviderRequestSchema
>;

/**
 * Upsert response includes created flag
 */
export const upsertModelProviderResponseSchema = z.object({
  provider: modelProviderResponseSchema,
  created: z.boolean(),
});

export type UpsertModelProviderResponse = z.infer<
  typeof upsertModelProviderResponseSchema
>;

export const availableRunModelSchema = z.object({
  model: runModelIdSchema,
  modelLabel: z.string(),
  modelProviderId: z.uuid().nullable(),
  // Present on member subscription models projected from the subscription
  // catalog; absent on Auto.
  subscriptionOptions: z
    .object({
      efforts: z.array(
        z.enum([
          "low",
          "medium",
          "high",
          "xhigh",
          "extra",
          "max",
          "ultra",
          "ultracode",
        ]),
      ),
      serviceTier: z.enum(["priority"]).nullable(),
    })
    .optional(),
  // Caller-specific, response-only routing. A candidate has not captured a
  // concrete subscription account for a run.
  memberEffective: z.object({
    providerType: modelProviderTypeSchema,
    runtimeProviderType: modelProviderTypeSchema.nullable(),
    credentialScope: modelProviderCredentialScopeSchema,
    availability: z.enum([
      "available",
      "reconnect_required",
      "plan_restricted",
    ]),
    accountSelection: z.enum(["capture_required", "not_applicable"]),
  }),
});

export type AvailableRunModel = z.infer<typeof availableRunModelSchema>;

export const availableRunModelsResponseSchema = z.object({
  defaultModel: z.string(),
  models: z.array(availableRunModelSchema),
});

export type AvailableRunModelsResponse = z.infer<
  typeof availableRunModelsResponseSchema
>;
