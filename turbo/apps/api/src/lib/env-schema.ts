import { createEnv } from "@t3-oss/env-core";
import {
  array,
  coerce,
  email,
  object,
  record,
  string,
  url,
  uuid,
  enum as zEnum,
} from "zod";

import { singleton } from "./singleton";

/**
 * Deployment tooling validates its environment with this schema and publishes
 * the decoded result under this name. Runtimes that receive it only parse it.
 */
export const VALIDATED_API_ENV = "API_VALIDATED_ENV";

// Split by concern only to keep each schema builder readable.
function coreEnvSchema() {
  return {
    APNS_PRIVATE_KEY_BASE64: string().min(1).optional(),
    APNS_KEY_ID: string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    APNS_TEAM_ID: string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    APNS_SANDBOX_PRIVATE_KEY_BASE64: string().min(1).optional(),
    APNS_SANDBOX_KEY_ID: string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    APNS_SANDBOX_TEAM_ID: string()
      .regex(/^[A-Z0-9]{10}$/u)
      .optional(),
    DATABASE_URL: string().min(1),
    CLERK_SECRET_KEY: string().min(1),
    CLERK_PUBLISHABLE_KEY: string().min(1),
    MCP_RESOURCE_URL: url().optional(),
    MCP_OAUTH_ISSUER: url().optional(),
    SECRETS_ENCRYPTION_KEY: string().length(64),
    SECRETS_KMS_KEY_ID: string().min(1).optional(),
    OFFICIAL_RUNNER_SECRET: string().length(64),
    OPENAI_API_KEY: string().min(1),
    FAL_KEY: string().min(1).optional(),
    // Validated together at the Google LLM operation boundary.
    GCP_LLM_PROJECT_ID: string().optional(),
    GCP_LLM_WORKLOAD_IDENTITY_PROVIDER: string().optional(),
    GCP_LLM_SERVICE_ACCOUNT_EMAIL: string().optional(),
    GCP_MTLS_CERTIFICATE_CHAIN: string().optional(),
    OKOU_DATA_ROUTER_URL: url().optional(),
    OKOU_DATA_TOKEN: string().min(1).optional(),
    OKOU_BROWSER_USE_API_KEY: string().min(1).optional(),
    OKOU_BROWSER_USE_EXTENSION_ID: string().trim().pipe(uuid()),
    STEAM_WEB_API_KEY: string().min(1).optional(),
    LINK_OAUTH_CLIENT_ID: string().min(1).optional(),
    LINK_OAUTH_CLIENT_SECRET: string().min(1).optional(),
    LINK_STRIPE_PUBLISHABLE_KEY: string()
      .regex(/^pk_(live|test)_/)
      .optional(),
    FINICITY_APP_KEY: string().min(1).optional(),
    FINICITY_APP_SECRET: string().min(1).optional(),
    FINICITY_PARTNER_ID: string().min(1).optional(),
    FINICITY_WEBHOOK_BASE_URL: url().optional(),
    SENTRY_DSN: url().optional(),
    GIT_COMMIT_SHA: string(),
    ENV: zEnum(["production", "preview", "development"]),
    VITEST: zEnum(["true", "false"]).default("false"),
    OKOU_DEBUG: string().default(""),
    VERCEL_AUTOMATION_BYPASS_SECRET: string().min(1).optional(),
  } as const;
}

function serviceEnvSchema() {
  return {
    // Direct origin of the API backend for self-dispatched internal callbacks
    // (`/api/internal/**`). Optional; when unset, production defaults to the API
    // backend origin and other environments fall back to the configured web URL.
    OKOU_API_BACKEND_URL: url().optional(),
    FEISHU_CALLBACK_BASE_URL: url(),
    OKOU_WEB_URL: url(),
    APP_URL: url(),
    RESEND_API_KEY: string().min(1).optional(),
    RESEND_WEBHOOK_SECRET: string().min(1).optional(),
    RESEND_FROM_DOMAIN: string().min(1).optional(),
    GMAIL_PUBSUB_TOPIC_NAME: string().min(1).optional(),
    GMAIL_PUBSUB_PUSH_AUDIENCE: url().optional(),
    GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: email().optional(),
    GOOGLE_FORMS_PUBSUB_TOPIC_NAME: string().min(1).optional(),
    GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE: url().optional(),
    GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: email().optional(),
    GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME: string().min(1).optional(),
    GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE: url().optional(),
    GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL:
      email().optional(),
    CRON_SECRET: string().min(1),
    // Enable only after Stage 1 API writers have drained and cannot be rolled back.
    WORKFLOW_ATTACHMENT_CLEANUP_ENABLED: zEnum(["true", "false"]).default(
      "false",
    ),
    R2_ACCESS_KEY_ID: string().min(1),
    R2_ACCOUNT_ID: string().min(1),
    R2_SECRET_ACCESS_KEY: string().min(1),
    R2_USER_STORAGES_BUCKET_NAME: string().min(1),
    R2_PRIVATE_ARTIFACTS_BUCKET_NAME: string().min(1).optional(),
    R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID: string().min(1).optional(),
    R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY: string().min(1).optional(),
    R2_USER_ARTIFACTS_BUCKET_NAME: string().min(1),
    R2_USER_ARTIFACTS_ACCESS_KEY_ID: string().min(1),
    R2_USER_ARTIFACTS_SECRET_ACCESS_KEY: string().min(1),
    // Link layouts (lib/link-layout.ts): OKOU_* origins serve the current
    // layout; PUBLIC_ARTIFACTS_BASE_URL and ZERO_HOST_* only rebuild links for
    // content stored in the read-only legacy layout.
    PUBLIC_ARTIFACTS_BASE_URL: url(),
    OKOU_PUBLIC_ARTIFACTS_BASE_URL: url(),
    PUBLIC_ARTIFACT_SHARES_BASE_URL: url().optional(),
    R2_HOSTED_SITES_BUCKET_NAME: string().min(1).optional(),
    R2_HOSTED_SITES_ACCESS_KEY_ID: string().min(1).optional(),
    R2_HOSTED_SITES_SECRET_ACCESS_KEY: string().min(1).optional(),
    OKOU_PUBLIC_HOST_DOMAIN: string().min(1),
    OKOU_HOST_SCHEME: zEnum(["http", "https"]),
    // Legacy-layout sites.vm0.io URLs retain their own domain and scheme.
    ZERO_HOST_DOMAIN: string().min(1).default("sites.vm0.io"),
    ZERO_HOST_SCHEME: zEnum(["http", "https"]).default("https"),
    S3_ENDPOINT: url().optional(),
    S3_REGION: string().min(1).optional(),
    S3_FORCE_PATH_STYLE: zEnum(["true", "false"]).optional(),
    S3_PUBLIC_ENDPOINT: url().optional(),
  } as const;
}

function billingAndMessagingEnvSchema() {
  const priceIdsSchema = string()
    .optional()
    .transform((value) => {
      return value
        ?.split(",")
        .map((priceId) => {
          return priceId.trim();
        })
        .filter((priceId) => {
          return priceId.length > 0;
        });
    });

  return {
    AXIOM_TOKEN_SESSIONS: string().min(1),
    AXIOM_TOKEN_TELEMETRY: string().min(1),
    AXIOM_DATASET_SUFFIX: zEnum(["dev", "prod"]),
    STRIPE_SECRET_KEY: string().min(1),
    ATOM_URL: url().optional(),
    ATOM_GRANT_PRICE: string().min(1).optional(),
    OKOU_PRICE_PRO: priceIdsSchema,
    OKOU_PRICE_TEAM: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_PLAN_PRO: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_PLAN_TEAM: priceIdsSchema,
    OKOU_PRICE_CUSTOM: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_20: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_50: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_100: priceIdsSchema,
    OKOU_PRICE_USAGE_PACK_200: priceIdsSchema,
    OKOU_PRICE_CUSTOM_CREDIT_UNIT: string().min(1).optional(),
    OKOU_PRICE_CONCURRENCY: priceIdsSchema,
    OKOU_ONE_TIME_CAMPAIGN: string()
      .optional()
      .transform((val) => {
        if (!val) {
          return undefined;
        }
        return record(
          string(),
          object({ priceId: string(), couponId: string() }),
        ).parse(JSON.parse(val));
      }),
    ABLY_API_KEY: string().min(1),
    GOOGLE_OAUTH_CLIENT_ID: string().min(1).optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: string().min(1).optional(),
    DB_POOL_MAX: coerce.number().int().min(1).default(10),
    DB_POOL_IDLE_TIMEOUT_MS: coerce.number().int().min(0).default(5000),
    DB_POOL_CONNECT_TIMEOUT_MS: coerce.number().int().min(0).optional(),
    TELEGRAM_OFFICIAL_BOT_TOKEN: string().optional(),
    TELEGRAM_OFFICIAL_BOT_USERNAME: string().optional(),
    TELEGRAM_OFFICIAL_WEBHOOK_SECRET: string().optional(),
    WHATSAPP_ALLOWED_COUNTRY_PREFIXES: string()
      .default("")
      .transform((value) => {
        return value.trim()
          ? value.split(",").map((prefix) => {
              return prefix.trim();
            })
          : [];
      })
      .pipe(array(string().regex(/^\+[1-9]\d{0,2}$/u))),
    SLACK_OAUTH_CLIENT_ID: string().optional(),
    DISCORD_OAUTH_CLIENT_SECRET: string().min(1).optional(),
    DISCORD_BOT_TOKEN: string().min(1).optional(),
    DISCORD_APPLICATION_ID: string()
      .regex(/^\d{17,20}$/)
      .optional(),
    DISCORD_PUBLIC_KEY: string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    LINK_APPROVAL_WORKER_URL: url().optional(),
    LINK_APPROVAL_WORKER_SECRET: string().optional(),
    LINK_APPROVAL_CONTROL_SECRET: string().optional(),
    WECHAT_GATEWAY_URL: url().optional(),
    WECHAT_GATEWAY_SECRET: string().optional(),
    WECHAT_GATEWAY_CONTROL_SECRET: string().optional(),
    DISCORD_GATEWAY_SECRET: string().min(32).optional(),
    MICROSOFT_OAUTH_CLIENT_ID: string().min(1).optional(),
    MICROSOFT_OAUTH_CLIENT_SECRET: string().min(1).optional(),
    MICROSOFT_TEAMS_BOT_APP_ID: string().min(1).optional(),
    MICROSOFT_TEAMS_BOT_APP_PASSWORD: string().min(1).optional(),
    MICROSOFT_TEAMS_APP_TENANT_ID: string().min(1).optional(),
    CONCURRENT_RUN_LIMIT_CAP: coerce.number().int().min(0).optional(),
    // Independent DB-coordinated API inference protection. These limits are
    // technical safeguards, not customer quota or Sandbox capacity.
    PI_INFERENCE_ORG_MAX_IN_FLIGHT: coerce.number().int().positive().default(8),
    PI_INFERENCE_PROVIDER_MAX_IN_FLIGHT: coerce
      .number()
      .int()
      .positive()
      .default(128),
  } as const;
}

function createApiEnvSchema() {
  return {
    ...coreEnvSchema(),
    ...serviceEnvSchema(),
    ...billingAndMessagingEnvSchema(),
  };
}

// Constructing every Zod schema costs measurable Worker startup CPU, so build
// it only for validation: deployment tooling, mocks, and local processes.
export const apiEnvSchema = singleton(createApiEnvSchema);

export type ApiEnvSchema = ReturnType<typeof createApiEnvSchema>;

export function decodeApiEnv(
  runtimeEnv: Readonly<Record<string, string | undefined>>,
) {
  return createEnv<undefined, ApiEnvSchema>({
    server: apiEnvSchema(),
    runtimeEnv: {
      ...runtimeEnv,
      S3_PUBLIC_ENDPOINT:
        runtimeEnv.S3_PUBLIC_ENDPOINT || runtimeEnv.S3_ENDPOINT,
    },
    emptyStringAsUndefined: true,
  });
}

export type ApiEnv = ReturnType<typeof decodeApiEnv>;
