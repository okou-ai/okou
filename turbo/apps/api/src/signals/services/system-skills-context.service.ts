import { computed, type Computed } from "ccstate";
import { resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import { skills as skillCatalog } from "@okouai/db/schema/skill";
import { inArray } from "drizzle-orm";
import { db$ } from "../external/db";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";

export function createSystemSkillsContext(
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const disabledPaidTools = await get(disabledPaidTools$);
    // The external gen skill unconditionally teaches managed image execution.
    // Other generation types retain their CLI and Agent Tools guidance.
    const skills = SEED_SKILLS.filter((name) => {
      return name !== "gen" || !disabledPaidTools.includes("image-generation");
    });
    const published = await get(db$)
      .select({
        url: skillCatalog.url,
        versionHash: skillCatalog.versionHash,
        contentBundle: skillCatalog.contentBundle,
        contentBundleSourceVersionHash:
          skillCatalog.contentBundleSourceVersionHash,
      })
      .from(skillCatalog)
      .where(inArray(skillCatalog.url, skills.map(resolveSkillRef)));
    const byUrl = new Map(
      published.map((skill) => {
        return [skill.url, skill];
      }),
    );
    const skillVolumes = skills.flatMap((skillName): readonly SkillVolume[] => {
      const skill = byUrl.get(resolveSkillRef(skillName));
      // An absent global cache entry has no registered skill to install.
      if (!skill) {
        return [];
      }
      if (
        skill.versionHash === null ||
        skill.contentBundle === null ||
        skill.contentBundleSourceVersionHash !== skill.versionHash
      ) {
        throw new Error(`Seed Skill bundle is not prepared: ${skillName}`);
      }
      return [
        {
          skillName,
          source: "system_skill",
          contentBundle: contentBundleSchema.parse(skill.contentBundle),
        },
      ];
    });
    return {
      systemPromptVariables: {},
      userPromptVariables: {},
      skillVolumes,
    };
  });
}
