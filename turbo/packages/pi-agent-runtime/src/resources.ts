import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import type {
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
} from "./api-types";

function officialSkill(skill: PiPreheatedSkill): Skill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: "preheated",
      scope: skill.scope,
      baseDir: skill.baseDir,
    }),
    disableModelInvocation: skill.disableModelInvocation,
  };
}

/**
 * Feed a durable discovery snapshot through Pi's official resource loader.
 * Neither override reads the local filesystem; skill bodies remain available
 * only to sandbox tools at their canonical paths.
 */
export function piPreheatedResourceLoaderOptions(args: {
  readonly snapshot: PiPreheatedResourceSnapshot;
  readonly appendSystemPrompt: readonly string[];
  readonly systemPrompt: string;
}) {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: [...args.appendSystemPrompt],
    agentsFilesOverride() {
      return {
        agentsFiles: args.snapshot.agentsFiles.map((file) => {
          return { path: file.path, content: file.content };
        }),
      };
    },
    skillsOverride() {
      return {
        skills: args.snapshot.skills.map(officialSkill),
        diagnostics: [],
      };
    },
  };
}
