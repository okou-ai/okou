import { computed, type Computed } from "ccstate";
import { parseGitHubTreeUrl, resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getSkillStorageName } from "@okouai/core/storage-names";
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
    const skillVolumes = [...new Set(skills)].flatMap(
      (skillName): readonly SkillVolume[] => {
        const parsed = parseGitHubTreeUrl(resolveSkillRef(skillName));
        return parsed
          ? [
              {
                name: getSkillStorageName(parsed.fullPath),
                skillName: parsed.skillName,
                system: true,
                source: "system_skill",
              },
            ]
          : [];
      },
    );
    return {
      systemPromptVariables: {},
      userPromptVariables: {},
      skillVolumes,
    };
  });
}
