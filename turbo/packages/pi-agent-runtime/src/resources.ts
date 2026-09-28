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

function preheatedResources(snapshot: PiPreheatedResourceSnapshot) {
  return {
    agentsFiles: snapshot.agentsFiles.map((file) => {
      return { path: file.path, content: file.content };
    }),
    skills: snapshot.skills.map(officialSkill),
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
  const resources = preheatedResources(args.snapshot);
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: [...args.appendSystemPrompt],
    agentsFilesOverride() {
      return { agentsFiles: resources.agentsFiles };
    },
    skillsOverride() {
      return { skills: resources.skills, diagnostics: [] };
    },
  };
}
