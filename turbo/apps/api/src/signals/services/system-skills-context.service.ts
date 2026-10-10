import { computed, type Computed } from "ccstate";
import { parseGitHubTreeUrl, resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getSkillStorageName } from "@okouai/core/storage-names";
import type { SystemSkillStorageResolution } from "../context/system-skill-storage-resolution";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";

export function createSystemSkillsContext(
  storageResolution$: Computed<SystemSkillStorageResolution>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed((get): Promise<RunPromptAndSkills> => {
    const storageResolution = get(storageResolution$);
    const skillVolumes = [...new Set(SEED_SKILLS)].flatMap(
      (skillName): readonly SkillVolume[] => {
        const parsed = parseGitHubTreeUrl(resolveSkillRef(skillName));
        return parsed
          ? [
              {
                name:
                  storageResolution[skillName] ??
                  getSkillStorageName(parsed.fullPath),
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
