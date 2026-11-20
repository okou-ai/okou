#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { count, gte, sql } from "drizzle-orm";
import { AUTO_RUN_KEY_VENDOR } from "@okouai/core/auto-run-model";
import { resolveSkillRef } from "@okouai/core/github-url";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import {
  contentBundleKey,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { builtInSkills } from "@okouai/db/schema/built-in-skill";
import { command, createStore } from "ccstate";

import { closeDbPool, db } from "../lib/db";
import { pgIntegerDecoder } from "../lib/db-structured-result";
import { env, optionalEnv } from "../lib/env";
import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import { putS3Object$ } from "../signals/external/s3";
import { immutableCatalogHash$ } from "../signals/services/connector-catalog-immutable.service";
import { syncConnectorCatalog$ } from "../signals/services/connector-catalog-sync.service";
import { seedPreviewConnectorCatalog$ } from "../signals/services/preview-connector-catalog.service";
import { publishDefaultPersonalInstructions$ } from "../signals/services/personal-instructions.service";
import { onRejection } from "../signals/utils";
import { DEV_SEED_SENTINEL_MANAGED_MODEL_KEY } from "./dev-seed-managed-model-key";
import devSeedSkillBundles from "./dev-seed-skill-bundles.json";

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Populate the development database with pricing, model keys, and skills.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Token prices use integer credits with a per-row token unit size.
 *
 * The managed OpenRouter Auto key is read from DEV_MODEL_OPENROUTER_KEY; the
 * fake sentinel key is seeded when it is not configured.
 */

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

type UsagePricingRow = readonly [
  category: string,
  unitPrice: number,
  unitSize: number,
];

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

// Official Standard token rates / 0.8, rounded per billing category.
const GPT_6_LUNA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", 125, 1_000_000],
  ["tokens.cache_read", 13, 1_000_000],
  ["tokens.cache_creation", 156, 1_000_000],
  ["tokens.output", 625, 1_000_000],
  ["tokens.input.long_context", 250, 1_000_000],
  ["tokens.cache_read.long_context", 25, 1_000_000],
  ["tokens.cache_creation.long_context", 313, 1_000_000],
  ["tokens.output.long_context", 938, 1_000_000],
  ["tokens.input.fast", 250, 1_000_000],
  ["tokens.cache_read.fast", 25, 1_000_000],
  ["tokens.cache_creation.fast", 313, 1_000_000],
  ["tokens.output.fast", 1250, 1_000_000],
  ["tokens.input.long_context.fast", 500, 1_000_000],
  ["tokens.cache_read.long_context.fast", 50, 1_000_000],
  ["tokens.cache_creation.long_context.fast", 625, 1_000_000],
  ["tokens.output.long_context.fast", 1875, 1_000_000],
];

const GPT_5_6_SOL_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(5), 1_000_000],
  ["tokens.cache_read", usd(0.5), 1_000_000],
  ["tokens.cache_creation", usd(6.25), 1_000_000],
  ["tokens.output", usd(30), 1_000_000],
];

const GPT_5_6_LUNA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(0.2), 1_000_000],
  ["tokens.cache_read", usd(0.02), 1_000_000],
  ["tokens.cache_creation", usd(0.25), 1_000_000],
  ["tokens.output", usd(1.2), 1_000_000],
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
  multiplier: number,
): readonly UsagePricingRow[] {
  return [
    ...rows,
    ...rows.map(([category, unitPrice, unitSize]) => {
      return [`${category}.fast`, unitPrice * multiplier, unitSize] as const;
    }),
  ];
}

const GPT_5_6_SOL_USAGE_PRICING = withFastPricing(
  withLongContextPricing(GPT_5_6_SOL_PRICING, 2, 1.5),
  2,
);

const GPT_5_6_LUNA_USAGE_PRICING = withFastPricing(
  withLongContextPricing(GPT_5_6_LUNA_PRICING, 2, 1.5),
  2,
);

function buildSeedSkillValues(
  names: readonly string[],
): (typeof builtInSkills.$inferInsert)[] {
  return names.map((name) => {
    const published = devSeedSkillBundles.find((skill) => {
      return skill.name === name;
    });
    if (!published) {
      throw new Error(`Development Seed Skill bundle is missing: ${name}`);
    }
    return {
      url: resolveSkillRef(name),
      versionHash: published.versionHash,
      contentBundle: published.contentBundle,
      contentBundleSourceVersionHash: published.versionHash,
      commitSha: published.commitSha,
    };
  });
}

export const USAGE_PRICING: readonly (typeof usagePricing.$inferInsert)[] = [
  // Model usage in the unified usage_event ledger.
  ...usageGroup("model", "claude-sonnet-4-6", [
    ["tokens.input", usd(3), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
    ["tokens.cache_read", usd(0.3), 1_000_000],
    ["tokens.cache_creation", usd(3.75), 1_000_000],
  ]),
  // Anthropic Sonnet 5.5 has the same token rates as Sonnet 5 (2026-09-28).
  ...usageGroup("model", "claude-sonnet-5-5", [
    ["tokens.input", usd(2), 1_000_000],
    ["tokens.output", usd(10), 1_000_000],
    ["tokens.cache_read", usd(0.2), 1_000_000],
    ["tokens.cache_creation", usd(2.5), 1_000_000],
  ]),
  ...usageGroup("model", "claude-sonnet-5", [
    ["tokens.input", usd(2), 1_000_000],
    ["tokens.output", usd(10), 1_000_000],
    ["tokens.cache_read", usd(0.2), 1_000_000],
    ["tokens.cache_creation", usd(2.5), 1_000_000],
  ]),
  // Anthropic pricing retrieved 2026-09-22 from:
  // https://platform.claude.com/docs/en/about-claude/pricing
  ...usageGroup("model", "claude-opus-5-5", [
    ["tokens.input", usd(4), 1_000_000],
    ["tokens.output", usd(20), 1_000_000],
    ["tokens.cache_read", usd(0.2), 1_000_000],
    ["tokens.cache_creation", usd(5), 1_000_000],
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
    withFastPricing(withLongContextPricing(GPT_6_ASTRA_PRICING, 2, 1.5), 2),
  ),
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  ...usageGroup(
    "model",
    "gpt-6.1-sol",
    withFastPricing(
      withLongContextPricing(
        [
          ["tokens.input", usd(2), 1_000_000],
          ["tokens.cache_read", usd(0.1), 1_000_000],
          ["tokens.cache_creation", usd(2.5), 1_000_000],
          ["tokens.output", usd(10), 1_000_000],
        ],
        2,
        1.5,
      ),
      2,
    ),
  ),
  // No official rate page is recorded for gpt-6-sol. These rows mirror the
  // production `usage_pricing` rows (the billing authority; read through
  // MaskDB on 2026-10-01, last updated 2026-09-22): Standard rates / 0.8 like
  // gpt-6-luna, with the GPT-6 long-context (x2 input family, x1.5 output)
  // and fast (x2) rule.
  ...usageGroup(
    "model",
    "gpt-6-sol",
    withFastPricing(
      withLongContextPricing(
        [
          ["tokens.input", 2500, 1_000_000],
          ["tokens.cache_read", 250, 1_000_000],
          ["tokens.cache_creation", 3125, 1_000_000],
          ["tokens.output", 12_500, 1_000_000],
        ],
        2,
        1.5,
      ),
      2,
    ),
  ),
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  ...usageGroup("model", "gpt-6-luna", GPT_6_LUNA_PRICING),
  // OpenAI API pricing retrieved 2026-07-31 from:
  // https://developers.openai.com/api/docs/pricing
  ...usageGroup("model", "gpt-5.6-sol", GPT_5_6_SOL_USAGE_PRICING),
  ...usageGroup("model", "gpt-5.6-luna", GPT_5_6_LUNA_USAGE_PRICING),
  // Development pricing is intentionally local seed data. Production pricing
  // is copied from the target database's current GPT rows by migration 1194.
  ...usageGroup("model", "okou-1.0", GPT_5_6_LUNA_USAGE_PRICING),
  // Synthetic test/preview rates, not production tariffs. Cover both runtime
  // presets and every standard/long-context/fast category without copying live data.
  ...["@preset/okou-1-0", "@preset/okou-1-0-dsf"].flatMap((provider) => {
    return usageGroup(
      "model",
      provider,
      withFastPricing(
        withLongContextPricing(
          [
            ["tokens.input", 1000, 1_000_000],
            ["tokens.output", 1000, 1_000_000],
            ["tokens.cache_read", 1000, 1_000_000],
            ["tokens.cache_creation", 1000, 1_000_000],
          ],
          1,
          1,
        ),
        1,
      ),
    );
  }),
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

  // OpenAI GPT Image 2.5 token pricing, in credits per million tokens.
  // https://developers.openai.com/api/docs/pricing
  ...usageGroup("image", "gpt-image-2.5-flare", [
    ["tokens.input.text", usd(5), 1_000_000],
    ["tokens.input.image", usd(8), 1_000_000],
    ["tokens.output.image", usd(30), 1_000_000],
  ]),
  ...usageGroup("image", "gpt-image-2.5-sunburst", [
    ["tokens.input.text", usd(5), 1_000_000],
    ["tokens.input.image", usd(8), 1_000_000],
    ["tokens.output.image", usd(30), 1_000_000],
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
  // Qwen Image is no longer selectable, but its row stays so already-recorded
  // usage keeps pricing.
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
  ...usageGroup("image", "fal-ai/nano-banana-2", [
    ["output_image", usd(0.08), 1],
  ]),
  // Nano Banana 2 Lite is token billed at $37.50 per 1M output image tokens
  // and always returns 1K images (1024x1024 = 1120 tokens): $0.042 per image.
  ...usageGroup("image", "google/nano-banana-2-lite", [
    ["output_image", usd(0.042), 1],
  ]),
];

type OptionalEnvReader = (name: string) => string | undefined;
type LineWriter = (message: string) => void;

/**
 * Build the managed OpenRouter built_in_model_keys row from the environment.
 * Without a configured key, seed the obvious fake sentinel so the managed
 * route exists locally; the provider rejects it like any invalid key.
 */
export function buildBuiltInModelKeys(
  readEnv: OptionalEnvReader = optionalEnv,
  logLine: LineWriter = writeLine,
): (typeof builtInModelKeys.$inferInsert)[] {
  const envVar = "DEV_MODEL_OPENROUTER_KEY";
  const apiKey = readEnv(envVar);
  if (!apiKey) {
    logLine(
      `Seeding the fake ${AUTO_RUN_KEY_VENDOR} sentinel key: ${envVar} is not configured`,
    );
    return [
      {
        vendor: AUTO_RUN_KEY_VENDOR,
        apiKey: DEV_SEED_SENTINEL_MANAGED_MODEL_KEY,
        label: "dev-seed sentinel",
      },
    ];
  }
  return [{ vendor: AUTO_RUN_KEY_VENDOR, apiKey, label: "dev-seed" }];
}

export function devSeedUsagePricing(environment: string | undefined) {
  if (environment !== "development" && environment !== "preview") {
    throw new Error(
      "Development pricing seed is restricted to development/preview",
    );
  }
  return USAGE_PRICING;
}

const seedPreparedSkills$ = command(
  async (
    { set },
    values: (typeof builtInSkills.$inferInsert)[],
    timestamp: Date,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    // Preview/development buckets do not inherit production's immutable objects.
    // Publish verified bytes before exposing their references in this environment.
    for (const skill of devSeedSkillBundles) {
      const archive = await readFile(
        new URL(
          `./dev-seed-skill-bundles/${skill.name}.tar.gz`,
          import.meta.url,
        ),
      );
      signal.throwIfAborted();
      readContentBundle(archive, skill.contentBundle);
      await set(
        putS3Object$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          key: contentBundleKey(skill.contentBundle.sha256),
          body: archive,
          contentType: "application/gzip",
        },
        signal,
      );
      signal.throwIfAborted();
    }
    const database = set(writeDb$);
    const upserted = await database
      .insert(builtInSkills)
      .values(values)
      .onConflictDoUpdate({
        target: builtInSkills.url,
        set: {
          versionHash: sql`excluded.version_hash`,
          contentBundle: sql`excluded.content_bundle`,
          contentBundleSourceVersionHash: sql`excluded.content_bundle_source_version_hash`,
          commitSha: sql`excluded.commit_sha`,
          updatedAt: timestamp,
        },
      })
      .returning({ url: builtInSkills.url });
    signal.throwIfAborted();
    return upserted.length;
  },
);

async function devSeed() {
  const pricing = devSeedUsagePricing(optionalEnv("ENV"));
  if (!optionalEnv("DATABASE_URL")) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const database = db();

  // --- usage_pricing (batch upsert) ---
  writeLine("Seeding usage_pricing");
  await database
    .insert(usagePricing)
    .values([...pricing])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: nowDate(),
      },
    });
  writeLine(`Seeded ${pricing.length} usage pricing entries`);

  // --- built_in_model_keys (atomic replace) ---
  writeLine("Seeding built_in_model_keys");
  const apiKeys = buildBuiltInModelKeys();
  if (apiKeys.length > 0) {
    const deletedKeys = database
      .$with("deleted_keys")
      .as(
        database
          .delete(builtInModelKeys)
          .returning({ deleted: sql`1`.mapWith(pgIntegerDecoder) }),
      );
    await database
      .with(deletedKeys)
      .insert(builtInModelKeys)
      .values(
        apiKeys.map((key) => {
          return {
            ...key,
            // Consume the complete deletion before checking insert uniqueness.
            // The aggregate also yields one key when the old pool is empty.
            apiKey: sql`(select ${sql.param(key.apiKey, builtInModelKeys.apiKey)}
              from ${deletedKeys} having ${gte(count(), sql`0`)})`,
          };
        }),
      );
  } else {
    await database.delete(builtInModelKeys);
  }
  for (const k of apiKeys) {
    writeLine(`Seeded built-in model key entry: ${k.vendor}`);
  }
  writeLine(`Seeded ${apiKeys.length} built-in model key entries`);

  const store = createStore();
  const signal = new AbortController().signal;
  {
    const insertedCount = await store.set(
      seedPreparedSkills$,
      buildSeedSkillValues(BUILT_IN_SKILLS),
      nowDate(),
      signal,
    );
    writeLine(`Seeded ${insertedCount} prepared Seed Skill bundles`);
  }
  // Preview/development buckets do not inherit production's default bundle.
  await store.set(publishDefaultPersonalInstructions$, signal);
  writeLine("Published default personal Instructions");

  // --- connector catalog (validated R2 publication -> pointer + entries) ---
  // The flag keeps its historical name because the CI preview workflow passes
  // it; it initializes the complete official catalog.
  if (process.argv.includes("--preview-onboarding-catalog")) {
    const seeded = await store.set(seedPreviewConnectorCatalog$, signal);
    writeLine(
      `Seeded ${seeded.connectorSlugs.length} preview connectors from ${seeded.catalogVersion}`,
    );
    return;
  }
  writeLine("Syncing connector catalog");
  const connectorCatalog = await store.set(syncConnectorCatalog$, signal);
  const catalogHash = await store.set(immutableCatalogHash$, signal);
  if (catalogHash === null) {
    throw new Error(
      `Connector catalog seed did not publish a catalog (${connectorCatalog.outcome}${connectorCatalog.failureCode === null ? "" : `: ${connectorCatalog.failureCode}`})`,
    );
  }
  writeLine(
    `Seeded connector catalog ${catalogHash} (${connectorCatalog.outcome})`,
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
  if (
    process.argv.includes("--preview-onboarding-catalog") &&
    optionalEnv("ENV") !== "preview"
  ) {
    throw new Error("Preview connector catalog seed is restricted to preview");
  }
  await onRejection(devSeed(), closeDbPool);
  await closeDbPool();
}

if (isMainModule()) {
  await runDevSeed();
}
