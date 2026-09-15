#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { and, eq, inArray, sql } from "drizzle-orm";
import { escapeLiteral } from "pg";
import { getBuiltInModelRouteVendors } from "@okouai/api-contracts/contracts/model-providers";
import { MANAGED_SOCIALKIT_BILLING_CATEGORY } from "@okouai/api-contracts/contracts/social";
import { resolveSkillRef } from "@okouai/core/github-url";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { skills } from "@okouai/db/schema/skill";
import { storages } from "@okouai/db/schema/storage";
import { createStore } from "ccstate";

import { closeDbPool, db } from "../lib/db";
import { optionalEnv } from "../lib/env";
import { nowDate } from "../lib/time";
import { reconcileConnectorCatalogCompatibility$ } from "../signals/services/connector-catalog-compatibility.service";
import { syncConnectorCatalog$ } from "../signals/services/connector-catalog-sync.service";
import { onRejection } from "../signals/utils";
import rawDevSeedSkillVolumes from "./dev-seed-skill-volumes.json";

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Populate the development database with pricing, model keys, and skills.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Token prices use integer credits with a per-row token unit size.
 *
 * API keys are read from environment variables per vendor:
 *   DEV_MODEL_{VENDOR_UPPER}_KEY (e.g., DEV_MODEL_ANTHROPIC_KEY, DEV_MODEL_OPENAI_KEY)
 * Anthropic and OpenAI also fall back to their provider env names because
 * CI and local dev already use them for real model smoke tests.
 */

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

/** Video price with a 25% markup (20% gross margin): provider cost / 0.8. */
function videoUsd(providerCost: number): number {
  return Math.round((providerCost * USD_TO_CREDITS) / 0.8);
}

type UsagePricingRow = readonly [
  category: string,
  unitPrice: number,
  unitSize: number,
];

interface DevSeedSkillVolume {
  readonly url: string;
  readonly name: string;
  readonly s3Key: string;
  readonly message: string;
  readonly fullPath: string;
  readonly s3Prefix: string;
  readonly commitSha: string;
  readonly skillSize: number;
  readonly storageId: string;
  readonly frontmatter: Record<string, unknown>;
  readonly storageName: string;
  readonly storageSize: number;
  readonly versionHash: string;
  readonly versionSize: number;
  readonly skillFileCount: number;
  readonly storageFileCount: number;
  readonly versionFileCount: number;
}

const DEV_SEED_SKILL_VOLUMES: readonly DevSeedSkillVolume[] =
  rawDevSeedSkillVolumes;

const PREVIEW_E2E_VOLUME_SKILL_NAMES: readonly string[] = [
  ...SEED_SKILLS,
  "github",
  "slack",
  "discord-webhook",
  "zendesk",
  "serpapi",
  "replicate",
];

function getDevSeedSkillVolumes(): readonly DevSeedSkillVolume[] {
  if (optionalEnv("ENV") !== "preview") {
    return DEV_SEED_SKILL_VOLUMES;
  }
  const previewSkillNames = new Set(PREVIEW_E2E_VOLUME_SKILL_NAMES);
  return DEV_SEED_SKILL_VOLUMES.filter((volume) => {
    return previewSkillNames.has(volume.name);
  });
}

function usageGroup(
  kind: string,
  provider: string,
  rows: readonly UsagePricingRow[],
): (typeof usagePricing.$inferInsert)[] {
  return rows.map(([category, unitPrice, unitSize]) => {
    return { kind, provider, category, unitPrice, unitSize };
  });
}

const GPT_6_ASTRA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(10), 1_000_000],
  ["tokens.cache_read", usd(1), 1_000_000],
  ["tokens.cache_creation", usd(12.5), 1_000_000],
  ["tokens.output", usd(50), 1_000_000],
];

const GPT_5_6_SOL_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(5), 1_000_000],
  ["tokens.cache_read", usd(0.5), 1_000_000],
  ["tokens.cache_creation", usd(6.25), 1_000_000],
  ["tokens.output", usd(30), 1_000_000],
];

const GPT_5_6_TERRA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(2), 1_000_000],
  ["tokens.cache_read", usd(0.2), 1_000_000],
  ["tokens.cache_creation", usd(2.5), 1_000_000],
  ["tokens.output", usd(12), 1_000_000],
];

const GPT_5_6_LUNA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(0.2), 1_000_000],
  ["tokens.cache_read", usd(0.02), 1_000_000],
  ["tokens.cache_creation", usd(0.25), 1_000_000],
  ["tokens.output", usd(1.2), 1_000_000],
];

// OpenRouter MiMo-V2.5 recognition pricing retrieved 2026-08-05 from:
// https://openrouter.ai/xiaomi/mimo-v2.5
const MIMO_V2_5_RECOGNITION_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(0.14), 1_000_000],
  ["tokens.output", usd(0.28), 1_000_000],
  ["tokens.cache_read", usd(0.0028), 1_000_000],
  ["tokens.cache_creation", 0, 1_000_000],
];

const GPT_5_5_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(5), 1_000_000],
  ["tokens.cache_read", usd(0.5), 1_000_000],
  ["tokens.output", usd(30), 1_000_000],
];

function withLongContextPricing(
  rows: readonly UsagePricingRow[],
  inputFamilyMultiplier: number,
  outputMultiplier: number,
): readonly UsagePricingRow[] {
  return [
    ...rows,
    ...rows.map(([category, unitPrice, unitSize]) => {
      const multiplier =
        category === "tokens.output" ? outputMultiplier : inputFamilyMultiplier;
      return [
        `${category}.long_context`,
        unitPrice * multiplier,
        unitSize,
      ] as const;
    }),
  ];
}

function withFastPricing(
  rows: readonly UsagePricingRow[],
): readonly UsagePricingRow[] {
  return [
    ...rows,
    ...rows.map(([category, unitPrice, unitSize]) => {
      return [`${category}.fast`, unitPrice * 2, unitSize] as const;
    }),
  ];
}

function buildSeedSkillValues(
  names: readonly string[],
): (typeof skills.$inferInsert)[] {
  return names.map((name) => {
    const url = resolveSkillRef(name);
    const fullPath = url.replace("https://github.com/", "");
    return {
      url,
      name,
      fullPath,
      versionHash: null,
      frontmatter: {
        name,
        description: `${name} skill`,
      },
    };
  });
}

function buildStorageSeedSql(
  systemOrgId: string,
  volumeOrgUserId: string,
): string {
  // This fixture captured the legacy system-skill writer's encoded archive
  // length as versionSize. Preserve the historical size value while also
  // populating the final archive-size metadata for the same shared object.
  return `
  INSERT INTO storages (
    id, org_id, user_id, name, s3_prefix, size, file_count, updated_at
  )
  SELECT
    "storageId", ${systemOrgId}, ${volumeOrgUserId}, "storageName", "s3Prefix",
    "storageSize", "storageFileCount", seeded_at
  FROM dev_seed_skill_volumes
  ON CONFLICT (org_id, user_id, name) DO UPDATE SET
    s3_prefix = excluded.s3_prefix,
    size = excluded.size,
    file_count = excluded.file_count,
    updated_at = seeded_at
  WHERE (storages.s3_prefix, storages.size, storages.file_count)
    IS DISTINCT FROM
    (excluded.s3_prefix, excluded.size, excluded.file_count);

  INSERT INTO storage_versions (
    id, storage_id, s3_key, size, archive_size, file_count, message, created_by
  )
  SELECT
    volume."versionHash", storage.id, volume."s3Key", volume."versionSize",
    volume."versionSize", volume."versionFileCount", volume.message, 'system'
  FROM dev_seed_skill_volumes AS volume
  JOIN storages AS storage
    ON storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
  ON CONFLICT (id) DO UPDATE SET
    storage_id = excluded.storage_id,
    s3_key = excluded.s3_key,
    size = excluded.size,
    archive_size = excluded.archive_size,
    file_count = excluded.file_count,
    message = excluded.message,
    created_by = excluded.created_by
  WHERE (
    storage_versions.storage_id,
    storage_versions.s3_key,
    storage_versions.size,
    storage_versions.archive_size,
    storage_versions.file_count,
    storage_versions.message,
    storage_versions.created_by
  ) IS DISTINCT FROM (
    excluded.storage_id,
    excluded.s3_key,
    excluded.size,
    excluded.archive_size,
    excluded.file_count,
    excluded.message,
    excluded.created_by
  );

  UPDATE storages AS storage SET
    head_version_id = volume."versionHash",
    updated_at = seeded_at
  FROM dev_seed_skill_volumes AS volume
  WHERE storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
    AND storage.head_version_id IS DISTINCT FROM volume."versionHash";
`;
}

function buildSkillSeedSql(
  systemOrgId: string,
  volumeOrgUserId: string,
): string {
  return `
  INSERT INTO skills (
    url, name, full_path, storage_id, version_hash, commit_sha, frontmatter,
    s3_key, size, file_count, synced_at, updated_at
  )
  SELECT
    volume.url, volume.name, volume."fullPath", storage.id,
    volume."versionHash", volume."commitSha", volume.frontmatter,
    volume."s3Key", volume."skillSize", volume."skillFileCount", seeded_at,
    seeded_at
  FROM dev_seed_skill_volumes AS volume
  JOIN storages AS storage
    ON storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
  ON CONFLICT (url) DO UPDATE SET
    name = excluded.name,
    full_path = excluded.full_path,
    storage_id = excluded.storage_id,
    version_hash = excluded.version_hash,
    commit_sha = excluded.commit_sha,
    frontmatter = excluded.frontmatter,
    s3_key = excluded.s3_key,
    size = excluded.size,
    file_count = excluded.file_count,
    synced_at = excluded.synced_at,
    updated_at = seeded_at
  WHERE (
    skills.name,
    skills.full_path,
    skills.storage_id,
    skills.version_hash,
    skills.commit_sha,
    skills.frontmatter,
    skills.s3_key,
    skills.size,
    skills.file_count
  ) IS DISTINCT FROM (
    excluded.name,
    excluded.full_path,
    excluded.storage_id,
    excluded.version_hash,
    excluded.commit_sha,
    excluded.frontmatter,
    excluded.s3_key,
    excluded.size,
    excluded.file_count
  );
`;
}

async function seedOfficialSkillVolumes(
  database: ReturnType<typeof db>,
  seedSkillVolumes: readonly DevSeedSkillVolume[],
): Promise<number> {
  const seedVolumes = escapeLiteral(JSON.stringify(seedSkillVolumes));
  const systemOrgId = escapeLiteral(SYSTEM_ORG_ID);
  const volumeOrgUserId = escapeLiteral(VOLUME_ORG_USER_ID);
  const body = `
DECLARE
  seeded_at timestamp := CURRENT_TIMESTAMP;
  seed_volumes jsonb := ${seedVolumes}::jsonb;
BEGIN
  CREATE TEMP TABLE dev_seed_skill_volumes ON COMMIT DROP AS
  SELECT *
  FROM jsonb_to_recordset(seed_volumes) AS volume(
    url text,
    name text,
    "s3Key" text,
    message text,
    "fullPath" text,
    "s3Prefix" text,
    "commitSha" varchar(40),
    "skillSize" bigint,
    "storageId" uuid,
    frontmatter jsonb,
    "storageName" varchar(256),
    "storageSize" bigint,
    "versionHash" varchar(64),
    "versionSize" bigint,
    "skillFileCount" integer,
    "storageFileCount" integer,
    "versionFileCount" integer
  );
${buildStorageSeedSql(systemOrgId, volumeOrgUserId)}
${buildSkillSeedSql(systemOrgId, volumeOrgUserId)}
END`;
  await database.execute(sql.raw(`DO ${escapeLiteral(body)}`));

  return seedSkillVolumes.length;
}

const USAGE_PRICING: readonly (typeof usagePricing.$inferInsert)[] = [
  // Model usage in the unified usage_event ledger.
  ...usageGroup("model", "claude-sonnet-4-6", [
    ["tokens.input", usd(3), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
    ["tokens.cache_read", usd(0.3), 1_000_000],
    ["tokens.cache_creation", usd(3.75), 1_000_000],
  ]),
  ...usageGroup("model", "claude-sonnet-5", [
    ["tokens.input", usd(2), 1_000_000],
    ["tokens.output", usd(10), 1_000_000],
    ["tokens.cache_read", usd(0.2), 1_000_000],
    ["tokens.cache_creation", usd(2.5), 1_000_000],
  ]),
  ...usageGroup("model", "claude-opus-5", [
    ["tokens.input", usd(5), 1_000_000],
    ["tokens.output", usd(25), 1_000_000],
    ["tokens.cache_read", usd(0.5), 1_000_000],
    ["tokens.cache_creation", usd(6.25), 1_000_000],
  ]),
  ...usageGroup("model", "claude-opus-4-8", [
    ["tokens.input", usd(5), 1_000_000],
    ["tokens.output", usd(25), 1_000_000],
    ["tokens.cache_read", usd(0.5), 1_000_000],
    ["tokens.cache_creation", usd(6.25), 1_000_000],
  ]),
  // Anthropic pricing retrieved 2026-09-01 from:
  // https://www.anthropic.com/claude-fable-and-mythos-5-1
  ...usageGroup("model", "claude-fable-5-1", [
    ["tokens.input", usd(10), 1_000_000],
    ["tokens.output", usd(50), 1_000_000],
    ["tokens.cache_read", usd(0.25), 1_000_000],
    ["tokens.cache_creation", usd(12.5), 1_000_000],
  ]),
  ...usageGroup("model", "claude-fable-5", [
    ["tokens.input", usd(10), 1_000_000],
    ["tokens.output", usd(50), 1_000_000],
    ["tokens.cache_read", usd(1), 1_000_000],
    ["tokens.cache_creation", usd(12.5), 1_000_000],
  ]),
  ...usageGroup("model", "deepseek-v4.1-flash", [
    ["tokens.input", usd(37.5), 100_000_000],
    ["tokens.output", usd(150), 100_000_000],
    ["tokens.cache_read", usd(3.75), 100_000_000],
    ["tokens.cache_creation", 0, 100_000_000],
  ]),
  // Canonical Okou customer credit pricing for managed DeepSeek V4 Flash.
  // Keep this product rate independent of the selected upstream route.
  ...usageGroup("model", "deepseek-v4-flash", [
    ["tokens.input", usd(0.14), 1_000_000],
    ["tokens.output", usd(0.28), 1_000_000],
    ["tokens.cache_read", usd(0.0028), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  // GPT-6 Astra pricing retrieved 2026-09-04 from:
  // https://platform.openai.com/docs/models/gpt-6-astra
  ...usageGroup(
    "model",
    "gpt-6-astra",
    withFastPricing(withLongContextPricing(GPT_6_ASTRA_PRICING, 2, 1.5)),
  ),
  // OpenAI API pricing retrieved 2026-07-31 from:
  // https://developers.openai.com/api/docs/pricing
  ...usageGroup(
    "model",
    "gpt-5.6-sol",
    withFastPricing(withLongContextPricing(GPT_5_6_SOL_PRICING, 2, 1.5)),
  ),
  ...usageGroup(
    "model",
    "gpt-5.6-terra",
    withFastPricing(withLongContextPricing(GPT_5_6_TERRA_PRICING, 2, 1.5)),
  ),
  ...usageGroup(
    "model",
    "gpt-5.6-luna",
    withFastPricing(withLongContextPricing(GPT_5_6_LUNA_PRICING, 2, 1.5)),
  ),
  ...usageGroup(
    "model",
    "gpt-5.5",
    withLongContextPricing(GPT_5_5_PRICING, 2, 1.5),
  ),
  // OpenRouter-backed edit helpers. Pricing retrieved 2026-07-10 from:
  // https://developers.openai.com/api/docs/models/gpt-4.1-mini
  // https://ai.google.dev/gemini-api/docs/pricing
  ...usageGroup("model", "openai/gpt-4.1-mini", [
    ["tokens.input", usd(0.4), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.output", usd(1.6), 1_000_000],
  ]),
  ...usageGroup("model", "google/gemini-3.5-flash", [
    ["tokens.input", usd(1.5), 1_000_000],
    ["tokens.cache_read", usd(0.15), 1_000_000],
    ["tokens.output", usd(9), 1_000_000],
  ]),

  // Local development pricing for managed image tasks, billed under
  // task-scoped kinds at the backing model's token rates.
  ...usageGroup(
    "image-recognition",
    "xiaomi/mimo-v2.5",
    MIMO_V2_5_RECOGNITION_PRICING,
  ),
  ...usageGroup("image-recognition", "google/gemini-3.5-flash", [
    ["tokens.input", usd(1.5), 1_000_000],
    ["tokens.cache_read", usd(0.15), 1_000_000],
    ["tokens.output", usd(9), 1_000_000],
  ]),
  // OpenRouter Qwen2.5 7B pricing retrieved 2026-08-06 from:
  // https://openrouter.ai/qwen/qwen-2.5-7b-instruct
  ...usageGroup("translation", "qwen/qwen-2.5-7b-instruct", [
    ["tokens.input", usd(0.1), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.output", usd(0.2), 1_000_000],
  ]),
  // X connector — https://docs.x.com/x-api/getting-started/pricing
  ...usageGroup("connector", "x", [
    // Reads — $/resource
    ["posts.read", usd(0.005), 1],
    ["user.read", usd(0.01), 1],
    ["dm_event.read", usd(0.01), 1],
    ["following_followers.read", usd(0.01), 1],
    ["list.read", usd(0.005), 1],
    ["space.read", usd(0.005), 1],
    ["community.read", usd(0.005), 1],
    ["note.read", usd(0.005), 1],
    ["media.read", usd(0.005), 1],
    ["analytics.read", usd(0.005), 1],
    ["trend.read", usd(0.01), 1],
    // Writes — $/request
    ["content.create", usd(0.015), 1],
    ["content.create_with_url", usd(0.2), 1],
    ["dm_interaction.create", usd(0.015), 1],
    ["user_interaction.create", usd(0.015), 1],
    ["interaction.delete", usd(0.01), 1],
    ["content.manage", usd(0.005), 1],
    ["list.create", usd(0.01), 1],
    ["list.manage", usd(0.005), 1],
    ["bookmark", usd(0.005), 1],
    ["media_metadata", usd(0.005), 1],
    ["privacy.update", usd(0.01), 1],
    ["mute.delete", usd(0.005), 1],
    ["counts.recent", usd(0.005), 1],
    ["counts.all", usd(0.01), 1],
    // Fallback — priced at the minimum bucket rate across the table above,
    // so an unknown includes key can never be billed at more than X charges
    // for the cheapest known bucket.
    ["__fallback__", usd(0.005), 1],
  ]),

  // Firecrawl single-page scrape fixed Okou product pricing. Requests disable
  // document parsers so provider cost stays bounded to the exposed modes.
  ...usageGroup("scrape", "firecrawl", [
    ["standard.markdown", usd(0.004), 1],
    ["standard.links", usd(0.004), 1],
    ["enhanced.markdown", usd(0.02), 1],
    ["enhanced.links", usd(0.02), 1],
  ]),

  // Perplexity Search API — https://docs.perplexity.ai/docs/getting-started/pricing
  // Raw provider cost is $5 per 1,000 requests with no token charge.
  ...usageGroup("web-search", "perplexity", [["request", usd(0.005), 1]]),
  // SocialKit Growth costs $95 per 50,000 requests. A 25% markup is
  // $0.002375, rounded up to 3 whole Okou credits per successful request.
  ...usageGroup("social", "socialkit", [
    [MANAGED_SOCIALKIT_BILLING_CATEGORY, usd(0.003), 1],
  ]),
  // APIDojo Yahoo Finance — https://rapidapi.com/apidojo/api/yahoo-finance1/pricing
  // Pro is $10 per 10,000 requests, so one successful request costs 1 credit.
  ...usageGroup("finance", "apidojo", [["request", usd(0.001), 1]]),

  // Managed SEO provider costs with a 25% markup. DataForSEO reports the
  // actual USD cost per response.
  ...usageGroup("seo", "dataforseo", [
    ["provider_cost_usd_micros", 1250, 1_000_000],
  ]),

  // Perplexity Agent API People Search fixed Okou product pricing, reviewed
  // 2026-07-23. The $0.020 retail price covers the $0.005 tool invocation,
  // gpt-5-mini model tokens, and operating margin.
  ...usageGroup("people-search", "perplexity", [["request", usd(0.02), 1]]),

  // Gemini 2.5 Flash Image — https://cloud.google.com/vertex-ai/generative-ai/pricing
  // $30/1M output tokens × 1290 tokens per 1024×1024 image = $0.0387/image.
  ...usageGroup("image", "gemini-2.5-flash-image", [
    ["output_image", usd(0.0387), 1],
  ]),

  // Fal-hosted GPT Image models. The endpoints return image URLs without
  // token usage, so built-in generation bills per output image tier at the
  // raw provider cost. Large tiers use the highest documented non-1024x1024
  // price. gpt-image-1.5 and gpt-image-1-mini are no longer selectable, but
  // their rows stay so already-recorded usage keeps pricing.
  ...usageGroup("image", "gpt-image-2", [
    ["output_image.low.standard", usd(0.006), 1],
    ["output_image.low.large", usd(0.012), 1],
    ["output_image.medium.standard", usd(0.053), 1],
    ["output_image.medium.large", usd(0.101), 1],
    ["output_image.high.standard", usd(0.211), 1],
    ["output_image.high.large", usd(0.401), 1],
  ]),
  ...usageGroup("image", "gpt-image-1.5", [
    ["output_image.low.standard", usd(0.009), 1],
    ["output_image.low.large", usd(0.013), 1],
    ["output_image.medium.standard", usd(0.034), 1],
    ["output_image.medium.large", usd(0.051), 1],
    ["output_image.high.standard", usd(0.133), 1],
    ["output_image.high.large", usd(0.2), 1],
  ]),
  ...usageGroup("image", "gpt-image-1", [
    ["output_image.low.standard", usd(0.011), 1],
    ["output_image.low.large", usd(0.016), 1],
    ["output_image.medium.standard", usd(0.042), 1],
    ["output_image.medium.large", usd(0.063), 1],
    ["output_image.high.standard", usd(0.167), 1],
    ["output_image.high.large", usd(0.25), 1],
  ]),
  ...usageGroup("image", "gpt-image-1-mini", [
    ["output_image.low.standard", usd(0.005), 1],
    ["output_image.low.large", usd(0.006), 1],
    ["output_image.medium.standard", usd(0.011), 1],
    ["output_image.medium.large", usd(0.015), 1],
    ["output_image.high.standard", usd(0.036), 1],
    ["output_image.high.large", usd(0.052), 1],
  ]),

  // fal.ai image generation — billed by model-specific output unit at the raw
  // provider cost.
  ...usageGroup("image", "fal-ai/flux-pro/v1.1", [
    ["output_megapixel", usd(0.04), 1],
  ]),
  ...usageGroup("image", "fal-ai/flux-pro/v1.1-ultra", [
    ["output_image", usd(0.06), 1],
  ]),
  // FLUX.2 Pro charges $0.03 for the first processed megapixel and $0.015
  // for each additional input/output megapixel.
  ...usageGroup("image", "fal-ai/flux-2-pro", [
    ["processed_megapixel.first", usd(0.03), 1],
    ["processed_megapixel.additional", usd(0.015), 1],
  ]),
  ...usageGroup("image", "fal-ai/qwen-image", [
    ["output_megapixel", usd(0.02), 1],
  ]),
  // Qwen Image 3 is billed per image in two resolution tiers, split at
  // 2,250,000 output pixels.
  ...usageGroup("image", "alibaba/qwen-image-3/text-to-image", [
    ["output_image.1k", usd(0.04), 1],
    ["output_image.2k", usd(0.075), 1],
  ]),
  // Ideogram 4 bills output megapixels by rendering speed. The fractional
  // Turbo price is stored as 75 credits per 10 MP to preserve $0.0075/MP.
  ...usageGroup("image", "ideogram/v4", [
    ["output_megapixel.turbo", 75, 10],
    ["output_megapixel.balanced", usd(0.015), 1],
    ["output_megapixel.quality", usd(0.025), 1],
  ]),
  ...usageGroup("image", "fal-ai/bytedance/seedream/v4/text-to-image", [
    ["output_image", usd(0.03), 1],
  ]),
  // BytePlus Seedream 5 pricing, retrieved 2026-08-18 from:
  // https://docs.byteplus.com/en/docs/ModelArk/1544106
  // The service records the request's actual provider cost in micro-USD;
  // 1250 credits per USD applies the requested 25% markup once to the total.
  ...usageGroup("image", "dola-seedream-5-0-pro-260628", [
    ["provider_cost_usd_micros", 1250, 1_000_000],
  ]),
  ...usageGroup("image", "seedream-5-0-lite-260128", [
    ["provider_cost_usd_micros", 1250, 1_000_000],
  ]),
  ...usageGroup("image", "fal-ai/nano-banana-2", [
    ["output_image", usd(0.08), 1],
  ]),
  // Nano Banana 2 Lite is token billed at $37.50 per 1M output image tokens
  // and always returns 1K images (1024x1024 = 1120 tokens): $0.042 per image.
  ...usageGroup("image", "google/nano-banana-2-lite", [
    ["output_image", usd(0.042), 1],
  ]),
  // Background removal transform (fal cost is $0).
  ...usageGroup("image", "fal-ai/birefnet/v2", [["output_image", usd(0), 1]]),
  // Upscale/HD transform, billed per output megapixel.
  ...usageGroup("image", "fal-ai/clarity-upscaler", [
    ["output_megapixel", usd(0.03), 1],
  ]),

  // Video generation uses a 25% markup (20% gross margin): cost / 0.8.
  ...usageGroup("video", "dreamina-seedance-2-5-260628", [
    ["output_video_tokens.480p_720p.no_video", videoUsd(10.7), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", videoUsd(6.4), 1_000_000],
    ["output_video_tokens.1080p.no_video", videoUsd(11.7), 1_000_000],
    ["output_video_tokens.1080p.with_video", videoUsd(7), 1_000_000],
  ]),
  ...usageGroup("video", "dreamina-seedance-2-0-260128", [
    ["output_video_tokens.480p_720p.no_video", videoUsd(7), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", videoUsd(4.3), 1_000_000],
    ["output_video_tokens.1080p.no_video", videoUsd(7.7), 1_000_000],
    ["output_video_tokens.1080p.with_video", videoUsd(4.7), 1_000_000],
  ]),
  ...usageGroup("video", "dreamina-seedance-2-0-fast-260128", [
    ["output_video_tokens.480p_720p.no_video", videoUsd(5.6), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", videoUsd(3.3), 1_000_000],
  ]),
  ...usageGroup("video", "dreamina-seedance-2-0-mini-260615", [
    ["output_video_tokens.480p_720p.no_video", videoUsd(3.5), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", videoUsd(2.1), 1_000_000],
  ]),
  ...usageGroup("video", "seedance-1-5-pro-251215", [
    ["output_video_tokens.audio", videoUsd(2.4), 1_000_000],
    ["output_video_tokens.silent", videoUsd(1.2), 1_000_000],
  ]),
  ...usageGroup("video", "MiniMax-H3", [
    ["output_video_seconds.768p", videoUsd(0.08), 1],
    ["output_video_seconds.2k", videoUsd(0.13), 1],
    ["input_video_seconds.768p", videoUsd(0.08), 1],
    ["input_video_seconds.2k", videoUsd(0.13), 1],
    ["input_image.additional", videoUsd(0.04), 1],
  ]),
  ...usageGroup("video", "fal-ai/veo3.1/fast", [
    ["output_video_seconds.audio", videoUsd(0.15), 1],
    ["output_video_seconds.silent", videoUsd(0.1), 1],
    ["output_video_seconds.audio.4k", videoUsd(0.35), 1],
    ["output_video_seconds.silent.4k", videoUsd(0.3), 1],
  ]),
  ...usageGroup("video", "fal-ai/kling-video/v3/4k/text-to-video", [
    ["output_video_seconds.audio.4k", videoUsd(0.42), 1],
    ["output_video_seconds.silent.4k", videoUsd(0.42), 1],
  ]),
  // JoggAI Professional API cost: $399 / 800 credits, with one provider
  // credit consumed per started two minutes of talking-avatar output.
  // https://www.jogg.ai/api-pricing/
  ...usageGroup("video", "joggai-talking-avatar", [
    ["output_video_joggai_credits", videoUsd(399 / 800), 1],
  ]),
  // HeyGen self-serve API cost for a 720p/1080p Studio Avatar rendered with
  // the v3 Avatar III engine: $1 per output minute, billed by seconds.
  // https://developers.heygen.com/docs/pricing
  ...usageGroup("video", "heygen-avatar-iii", [
    ["output_video_seconds", videoUsd(1), 60],
  ]),

  // HeyGen Starfish TTS costs $0.000667 per second, approximately $0.04 per
  // generated minute. Intro Video uses only voices returned for this engine.
  // https://developers.heygen.com/docs/pricing
  ...usageGroup("audio", "heygen-starfish-tts", [
    ["output_audio_seconds", usd(0.04), 60],
  ]),

  // OpenAI GPT-4o mini TTS — https://platform.openai.com/docs/pricing
  // $0.015/minute raw provider cost = 15 credits/minute.
  ...usageGroup("audio", "gpt-4o-mini-tts", [
    ["output_audio_seconds", usd(0.015), 60],
  ]),
];

function getVendorApiKeyEnvVars(vendor: string): string[] {
  const envVar = `DEV_MODEL_${vendor.toUpperCase()}_KEY`;
  if (vendor === "anthropic") {
    return [envVar, "ANTHROPIC_API_KEY"];
  }
  if (vendor === "openai") {
    return [envVar, "OPENAI_API_KEY"];
  }
  return [envVar];
}

type OptionalEnvReader = (name: string) => string | undefined;
type LineWriter = (message: string) => void;

/**
 * Build built_in_model_keys entries from environment variables.
 * Vendors are derived from all built-in candidates so new providers are
 * automatically picked up.
 */
export function buildBuiltInModelKeys(
  readEnv: OptionalEnvReader = optionalEnv,
  logLine: LineWriter = writeLine,
): (typeof builtInModelKeys.$inferInsert)[] {
  const keys: (typeof builtInModelKeys.$inferInsert)[] = [];
  for (const vendor of getBuiltInModelRouteVendors()) {
    const envVars = getVendorApiKeyEnvVars(vendor);
    const apiKey = envVars
      .map((name) => {
        return readEnv(name);
      })
      .find((value): value is string => {
        return typeof value === "string" && value.length > 0;
      });
    if (!apiKey) {
      logLine(`Skipping ${vendor}: ${envVars.join(" or ")} is not configured`);
      continue;
    }
    keys.push({ vendor, apiKey, label: "dev-seed" });
  }
  return keys;
}

async function devSeed() {
  if (!optionalEnv("DATABASE_URL")) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const database = db();

  // --- usage_pricing (batch upsert) ---
  writeLine("Seeding usage_pricing");
  await database
    .insert(usagePricing)
    .values([...USAGE_PRICING])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: nowDate(),
      },
    });
  writeLine(`Seeded ${USAGE_PRICING.length} usage pricing entries`);

  // --- built_in_model_keys (transactional replace) ---
  writeLine("Seeding built_in_model_keys");
  const apiKeys = buildBuiltInModelKeys();
  await database.transaction(async (tx) => {
    await tx.delete(builtInModelKeys);
    if (apiKeys.length > 0) {
      await tx.insert(builtInModelKeys).values(apiKeys);
    }
  });
  for (const k of apiKeys) {
    writeLine(`Seeded built-in model key entry: ${k.vendor}`);
  }
  writeLine(`Seeded ${apiKeys.length} built-in model key entries`);

  // --- skills (published volumes + seed-skill metadata fallback) ---
  const seedSkillVolumes = getDevSeedSkillVolumes();
  writeLine("Seeding official skill volumes");
  const seededVolumeCount = await seedOfficialSkillVolumes(
    database,
    seedSkillVolumes,
  );
  writeLine(`Seeded ${seededVolumeCount} official skill volume entries`);

  const seededVolumeStorageNames = new Set(
    seedSkillVolumes.map((volume) => {
      return volume.storageName;
    }),
  );
  const fallbackSkillValues = buildSeedSkillValues(
    SEED_SKILLS.filter((name) => {
      const fullPath = resolveSkillRef(name).replace("https://github.com/", "");
      return !seededVolumeStorageNames.has(getSkillStorageName(fullPath));
    }),
  );
  if (fallbackSkillValues.length > 0) {
    const timestamp = nowDate();
    const fallbackStorageNames = fallbackSkillValues.map((skill) => {
      return getSkillStorageName(skill.fullPath);
    });
    let insertedCount = 0;
    await database.transaction(async (tx) => {
      const inserted = await tx
        .insert(skills)
        .values(fallbackSkillValues)
        .onConflictDoUpdate({
          target: skills.url,
          set: {
            name: sql`excluded.name`,
            fullPath: sql`excluded.full_path`,
            storageId: null,
            versionHash: null,
            commitSha: null,
            frontmatter: sql`excluded.frontmatter`,
            s3Key: null,
            size: 0,
            fileCount: 0,
            syncedAt: null,
            updatedAt: timestamp,
          },
        })
        .returning({ id: skills.id });
      insertedCount = inserted.length;

      await tx
        .delete(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            inArray(storages.name, fallbackStorageNames),
          ),
        );
    });
    writeLine(
      `Seeded ${insertedCount} metadata-only skills and cleared stale volumes`,
    );
  }

  // --- connector catalog (validated R2 snapshot + compatibility state) ---
  writeLine("Syncing connector catalog");
  const store = createStore();
  const signal = new AbortController().signal;
  const connectorCatalog = await store.set(syncConnectorCatalog$, signal);
  await store.set(reconcileConnectorCatalogCompatibility$, signal);
  if (!connectorCatalog.active) {
    throw new Error(
      "Connector catalog seed did not produce an active snapshot",
    );
  }
  writeLine(
    `Seeded connector catalog ${connectorCatalog.active.catalogVersion} (${connectorCatalog.outcome})`,
  );
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

async function runDevSeed(): Promise<void> {
  await onRejection(devSeed(), closeDbPool);
  await closeDbPool();
}

if (isMainModule()) {
  await runDevSeed();
}
