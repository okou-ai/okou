import { describe, expect, it } from "vitest";

import { DEV_SEED_SENTINEL_MANAGED_MODEL_KEY } from "../dev-seed-managed-model-key";
import rawDevSeedSkillVolumes from "../dev-seed-skill-volumes.json";
import {
  buildBuiltInModelKeys,
  devSeedUsagePricing,
  getMetadataOnlySeedSkillNames,
  USAGE_PRICING,
} from "../dev-seed";

function readEnvFrom(
  values: Readonly<Record<string, string | undefined>>,
): (name: string) => string | undefined {
  return (name) => {
    return values[name];
  };
}

function buildVendorKeys(
  vendor: string,
  values: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof buildBuiltInModelKeys> {
  return buildBuiltInModelKeys(readEnvFrom(values), () => {
    // Suppress the seed progress log in builder assertions.
  }).filter((key) => {
    return key.vendor === vendor;
  });
}

describe("official skill volume seeds", () => {
  it("uses the current registry repository without renaming stored objects", () => {
    for (const volume of rawDevSeedSkillVolumes) {
      expect(volume.url).toMatch(
        /^https:\/\/github\.com\/okou-ai\/okou-skills\/tree\/main\//,
      );
      expect(volume.fullPath).toMatch(/^okou-ai\/okou-skills\/tree\/main\//);
      expect(volume.s3Key).toContain("agent-skills@vm0-ai/vm0-skills/");
      expect(volume.s3Prefix).toContain("agent-skills@vm0-ai/vm0-skills/");
      expect(volume.storageName).toContain("agent-skills@vm0-ai/vm0-skills/");
      expect(volume.message).toMatch(/^Synced from vm0-ai\/vm0-skills@/);
    }
  });

  it("keeps published historical Storage bindings out of metadata fallback", () => {
    expect(
      getMetadataOnlySeedSkillNames(
        [
          "computer-use",
          "gen",
          "office-files",
          "ppt-avatar-video",
          "workflow-setup",
        ],
        rawDevSeedSkillVolumes,
      ),
    ).toStrictEqual(["office-files", "ppt-avatar-video", "workflow-setup"]);
  });
});

describe("buildBuiltInModelKeys", () => {
  it("seeds the fake sentinel key when no OpenRouter key is configured", () => {
    expect(buildVendorKeys("openrouter", {})).toStrictEqual([
      {
        apiKey: DEV_SEED_SENTINEL_MANAGED_MODEL_KEY,
        label: "dev-seed sentinel",
        vendor: "openrouter",
      },
    ]);
  });

  it("builds the OpenRouter built-in model key row", () => {
    const openRouterKeys = buildVendorKeys("openrouter", {
      DEV_MODEL_OPENROUTER_KEY: "dev-openrouter-key",
    });

    expect(openRouterKeys).toStrictEqual([
      {
        apiKey: "dev-openrouter-key",
        label: "dev-seed",
        vendor: "openrouter",
      },
    ]);
  });
});

describe("usage pricing", () => {
  it.each(["development", "preview"])(
    "provides synthetic Auto runtime rates in %s only",
    (environment) => {
      const rows = devSeedUsagePricing(environment);
      for (const provider of ["@preset/okou-1-0", "@preset/okou-1-0-dsf"]) {
        const categories = [
          "tokens.input",
          "tokens.output",
          "tokens.cache_read",
          "tokens.cache_creation",
        ];
        expect(
          rows.filter((row) => {
            return row.kind === "model" && row.provider === provider;
          }),
        ).toStrictEqual(
          [
            ...categories,
            ...categories.map((category) => {
              return `${category}.long_context`;
            }),
          ].map((category) => {
            return {
              kind: "model",
              provider,
              category,
              unitPrice: 1000,
              unitSize: 1_000_000,
            };
          }),
        );
      }
    },
  );

  it.each(["production", "test", undefined])(
    "rejects development seed for environment %s",
    (environment) => {
      expect(() => {
        return devSeedUsagePricing(environment);
      }).toThrow("restricted to development/preview");
    },
  );

  it("seeds the Claude Opus 5.5 public token schedule", () => {
    expect(
      USAGE_PRICING.filter((row) => {
        return row.kind === "model" && row.provider === "claude-opus-5-5";
      }).map((row) => {
        return [row.category, row.unitPrice, row.unitSize];
      }),
    ).toStrictEqual([
      ["tokens.input", 4000, 1_000_000],
      ["tokens.output", 20_000, 1_000_000],
      ["tokens.cache_read", 200, 1_000_000],
      ["tokens.cache_creation", 5000, 1_000_000],
    ]);
  });

  it.each([["okou-1.0", "gpt-5.6-luna"]] as const)(
    "seeds %s from the local %s schedule",
    (okouModel, sourceModel) => {
      const comparableRows = (provider: string) => {
        return USAGE_PRICING.filter((row) => {
          return row.kind === "model" && row.provider === provider;
        }).map((row) => {
          return {
            category: row.category,
            unitPrice: row.unitPrice,
            unitSize: row.unitSize,
          };
        });
      };

      expect(comparableRows(okouModel)).toStrictEqual(
        comparableRows(sourceModel),
      );
      expect(comparableRows(okouModel)).toHaveLength(16);
    },
  );
});
