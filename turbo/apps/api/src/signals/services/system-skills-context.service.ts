import { computed, type Computed } from "ccstate";
import { logger } from "../../lib/log";
import { resolveSkillRef } from "@okouai/core/github-url";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { SeedSkillVolume } from "./run-prompt-and-skills";

const log = logger("api:system-skills");

export function createSystemSkillVolumes(
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
  seedSkills$: AgentRunContextSignals["seedSkills$"],
) {
  return computed(async (get) => {
    const [disabledPaidTools, published] = await Promise.all([
      get(disabledPaidTools$),
      get(seedSkills$),
    ]);
    // The external gen skill unconditionally teaches managed image execution.
    // Other generation types retain their CLI and Agent Tools guidance.
    const skills = BUILT_IN_SKILLS.filter((name) => {
      return name !== "gen" || !disabledPaidTools.includes("image-generation");
    });
    const byUrl = new Map(
      published.map((skill) => {
        return [skill.url, skill];
      }),
    );
    return skills.flatMap((skillName): readonly SeedSkillVolume[] => {
      // Only a usable bundle matters; the run keeps this pointer whatever the
      // catalog's source version is when the Runner starts.
      const bundle = contentBundleSchema.safeParse(
        byUrl.get(resolveSkillRef(skillName))?.contentBundle,
      );
      if (!bundle.success) {
        log.warn("Seed Skill bundle is unavailable", { skillName });
        return [];
      }
      return [
        {
          skillName,
          source: "system_skill",
          contentBundle: bundle.data,
        },
      ];
    });
  });
}
