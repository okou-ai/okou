import { createEnv } from "@t3-oss/env-core";
import { z, type ZodType } from "zod";

import { testOverride } from "./singleton";

const priceIdsSchema = z
  .string()
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

const SCHEMA = {
  DATABASE_URL: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  MCP_RESOURCE_URL: z.url().optional(),
  MCP_OAUTH_ISSUER: z.url().optional(),
  SECRETS_ENCRYPTION_KEY: z.string().length(64),
  SECRETS_KMS_KEY_ID: z.string().min(1).optional(),
  OFFICIAL_RUNNER_SECRET: z.string().length(64),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_IMAGE_WEBHOOK_SECRET: z.string().min(1).optional(),
  FAL_KEY: z.string().min(1).optional(),
  // Validated together at the Google LLM operation boundary.
  GCP_LLM_PROJECT_ID: z.string().optional(),
  GCP_LLM_WORKLOAD_IDENTITY_PROVIDER: z.string().optional(),
  GCP_LLM_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  OKOU_WEATHER_GOOGLE_WEATHER_TOKEN: z.string().min(1).optional(),
  OKOU_SCRAPE_FIRECRAWL_TOKEN: z.string().min(1).optional(),
  OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  OKOU_WEB_SEARCH_PERPLEXITY_TOKEN: z.string().min(1).optional(),
  OKOU_SOCIAL_SOCIALKIT_TOKEN: z.string().min(1).optional(),
  OKOU_SOCIAL_MONID_API_KEY: z.string().min(1).optional(),
  OKOU_FINANCE_APIDOJO_TOKEN: z.string().min(1).optional(),
  OKOU_SEO_DATAFORSEO_LOGIN: z.string().min(1).optional(),
  OKOU_SEO_DATAFORSEO_PASSWORD: z.string().min(1).optional(),
  OKOU_BROWSER_USE_API_KEY: z.string().min(1).optional(),
  STEAM_WEB_API_KEY: z.string().min(1).optional(),
  LINK_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  LINK_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  LINK_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(live|test)_/)
    .optional(),
  FINICITY_APP_KEY: z.string().min(1).optional(),
  FINICITY_APP_SECRET: z.string().min(1).optional(),
  FINICITY_PARTNER_ID: z.string().min(1).optional(),
  FINICITY_WEBHOOK_BASE_URL: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
  GIT_COMMIT_SHA: z.string(),
  ENV: z.enum(["production", "preview", "development"]),
  VITEST: z.enum(["true", "false"]).default("false"),
  OKOU_DEBUG: z.string().default(""),
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().min(1).optional(),
  // Direct origin of the API backend for self-dispatched internal callbacks
  // (`/api/internal/**`). Optional; when unset, production defaults to the API
  // backend origin and other environments fall back to the configured web URL.
  OKOU_API_BACKEND_URL: z.url().optional(),
  FEISHU_CALLBACK_BASE_URL: z.url(),
  OKOU_WEB_URL: z.url(),
  APP_URL: z.url(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_FROM_DOMAIN: z.string().min(1).optional(),
  GMAIL_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GMAIL_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  GOOGLE_FORMS_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME: z.string().min(1).optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE: z.url().optional(),
  GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: z
    .email()
    .optional(),
  CRON_SECRET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_USER_STORAGES_BUCKET_NAME: z.string().min(1),
  R2_PRIVATE_ARTIFACTS_BUCKET_NAME: z.string().min(1).optional(),
  R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_USER_ARTIFACTS_BUCKET_NAME: z.string().min(1),
  R2_USER_ARTIFACTS_ACCESS_KEY_ID: z.string().min(1),
  R2_USER_ARTIFACTS_SECRET_ACCESS_KEY: z.string().min(1),
  // Link layouts (lib/link-layout.ts): OKOU_* origins serve the current
  // layout; PUBLIC_ARTIFACTS_BASE_URL and ZERO_HOST_* only rebuild links for
  // content stored in the read-only legacy layout.
  PUBLIC_ARTIFACTS_BASE_URL: z.url(),
  OKOU_PUBLIC_ARTIFACTS_BASE_URL: z.url(),
  PUBLIC_ARTIFACT_SHARES_BASE_URL: z.url().optional(),
  R2_HOSTED_SITES_BUCKET_NAME: z.string().min(1).optional(),
  R2_HOSTED_SITES_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_HOSTED_SITES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OKOU_PUBLIC_HOST_DOMAIN: z.string().min(1),
  OKOU_HOST_SCHEME: z.enum(["http", "https"]),
  // Legacy-layout sites.vm0.io URLs retain their own domain and scheme.
  ZERO_HOST_DOMAIN: z.string().min(1).default("sites.vm0.io"),
  ZERO_HOST_SCHEME: z.enum(["http", "https"]).default("https"),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  AXIOM_TOKEN_SESSIONS: z.string().min(1),
  AXIOM_TOKEN_TELEMETRY: z.string().min(1),
  AXIOM_DATASET_SUFFIX: z.enum(["dev", "prod"]),
  STRIPE_SECRET_KEY: z.string().min(1),
  ATOM_URL: z.url().optional(),
  ATOM_GRANT_PRICE: z.string().min(1).optional(),
  OKOU_PRICE_PRO: priceIdsSchema,
  OKOU_PRICE_TEAM: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_PLAN_PRO: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_PLAN_TEAM: priceIdsSchema,
  OKOU_PRICE_CUSTOM: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_20: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_50: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_100: priceIdsSchema,
  OKOU_PRICE_USAGE_PACK_200: priceIdsSchema,
  OKOU_PRICE_CUSTOM_CREDIT_UNIT: z.string().min(1).optional(),
  OKOU_PRICE_CONCURRENCY: priceIdsSchema,
  OKOU_ONE_TIME_CAMPAIGN: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) {
        return undefined;
      }
      return z
        .record(
          z.string(),
          z.object({ priceId: z.string(), couponId: z.string() }),
        )
        .parse(JSON.parse(val));
    }),
  ABLY_API_KEY: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
  DB_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  TELEGRAM_OFFICIAL_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OFFICIAL_BOT_USERNAME: z.string().optional(),
  TELEGRAM_OFFICIAL_WEBHOOK_SECRET: z.string().optional(),
  SLACK_OAUTH_CLIENT_ID: z.string().optional(),
  DISCORD_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_APPLICATION_ID: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  DISCORD_PUBLIC_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  LINK_APPROVAL_WORKER_URL: z.string().url().optional(),
  LINK_APPROVAL_WORKER_SECRET: z.string().optional(),
  LINK_APPROVAL_CONTROL_SECRET: z.string().optional(),
  WECHAT_GATEWAY_URL: z.string().url().optional(),
  WECHAT_GATEWAY_SECRET: z.string().optional(),
  WECHAT_GATEWAY_CONTROL_SECRET: z.string().optional(),
  DISCORD_GATEWAY_SECRET: z.string().min(32).optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_TEAMS_BOT_APP_ID: z.string().min(1).optional(),
  MICROSOFT_TEAMS_BOT_APP_PASSWORD: z.string().min(1).optional(),
  MICROSOFT_TEAMS_APP_TENANT_ID: z.string().min(1).optional(),
  CONCURRENT_RUN_LIMIT_CAP: z.coerce.number().int().min(0).optional(),
  // Independent DB-coordinated API inference protection. These limits are
  // technical safeguards, not customer quota or Sandbox capacity.
  PI_INFERENCE_ORG_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(8),
  PI_INFERENCE_PROVIDER_MAX_IN_FLIGHT: z.coerce
    .number()
    .int()
    .positive()
    .default(128),
} as const;

// Workers deploy encrypted configuration in bounded chunks rather than one
// binding per setting. Explicit process variables retain Node/local precedence.
const configParts = process.env.API_ENV_JSON_PARTS;
const packedConfig = configParts
  ? Array.from(
      { length: z.coerce.number().int().min(1).max(126).parse(configParts) },
      (_, index) => {
        return z.string().parse(process.env[`API_ENV_JSON_${index}`]);
      },
    ).join("")
  : undefined;
const packedEnv = Object.freeze(
  packedConfig
    ? z.record(z.string(), z.string()).parse(JSON.parse(packedConfig))
    : {},
);
const runtimeEnv = Object.freeze({ ...packedEnv, ...process.env });

const baseEnv = createEnv<undefined, typeof SCHEMA>({
  server: SCHEMA,
  runtimeEnv: {
    ...runtimeEnv,
    S3_PUBLIC_ENDPOINT: runtimeEnv.S3_PUBLIC_ENDPOINT || runtimeEnv.S3_ENDPOINT,
  },
  emptyStringAsUndefined: true,
});

type EnvShape = typeof baseEnv;
type EnvName = keyof EnvShape;

const {
  get: getOverrideEnv,
  set: setOverrideEnv,
  clear: clearOverrideEnv,
} = testOverride<Partial<EnvShape>>(() => {
  return {};
});

const {
  get: getOptionalOverrideEnv,
  set: setOptionalOverrideEnv,
  clear: clearOptionalOverrideEnv,
} = testOverride<Readonly<Record<string, string | undefined>>>(() => {
  return {};
});

export function env<K extends EnvName>(name: K): EnvShape[K] {
  const overrideEnv = getOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as EnvShape[K];
  }
  return baseEnv[name];
}

export function optionalEnv(name: string): string | undefined {
  const overrideEnv = getOptionalOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name];
  }
  return process.env[name] || packedEnv[name] || undefined;
}

export function mockEnv<K extends EnvName>(
  name: K,
  value: z.input<(typeof SCHEMA)[K]>,
): void {
  const schema = SCHEMA[name] as ZodType;
  setOverrideEnv({
    ...getOverrideEnv(),
    [name]: schema.parse(value) as EnvShape[K],
  });
}

export function mockOptionalEnv(name: string, value: string | undefined): void {
  setOptionalOverrideEnv({
    ...getOptionalOverrideEnv(),
    [name]: value,
  });
}

export function clearMockedEnv(): void {
  clearOverrideEnv();
  clearOptionalOverrideEnv();
}
