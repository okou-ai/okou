import { computed, type Computed } from "ccstate";
import { resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";

export function createSystemSkillsContext(
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
  seedSkills$: AgentRunContextSignals["seedSkills$"],
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [disabledPaidTools, published] = await Promise.all([
      get(disabledPaidTools$),
      get(seedSkills$),
    ]);
    // The external gen skill unconditionally teaches managed image execution.
    // Other generation types retain their CLI and Agent Tools guidance.
    const skills = SEED_SKILLS.filter((name) => {
      return name !== "gen" || !disabledPaidTools.includes("image-generation");
    });
    const byUrl = new Map(
      published.map((skill) => {
        return [skill.url, skill];
      }),
    );
    const skillVolumes = skills.flatMap((skillName): readonly SkillVolume[] => {
      // Only a usable bundle matters: a newer source version that is still
      // being rebuilt does not block the run, which keeps this pointer.
      const contentBundle = byUrl.get(
        resolveSkillRef(skillName),
      )?.contentBundle;
      if (!contentBundle) {
        throw new Error(`Seed Skill bundle is not prepared: ${skillName}`);
      }
      return [
        {
          skillName,
          source: "system_skill",
          contentBundle: contentBundleSchema.parse(contentBundle),
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
