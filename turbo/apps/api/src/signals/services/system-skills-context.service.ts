import { computed, type Computed } from "ccstate";
import { parseGitHubTreeUrl, resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getSkillStorageName } from "@okouai/core/storage-names";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";

export function createSystemSkillsContext(): Computed<
  Promise<RunPromptAndSkills>
> {
  return computed((): Promise<RunPromptAndSkills> => {
    const skillVolumes = [...new Set(SEED_SKILLS)].flatMap(
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
    return Promise.resolve({
      systemPromptVariables: {},
      userPromptVariables: {},
      skillVolumes,
    });
  });
}
