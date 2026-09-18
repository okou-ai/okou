import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type ResourceLoader,
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

/**
 * One immutable API-preparation resource view.
 *
 * Unlike DefaultResourceLoader, this loader has no package manager, filesystem
 * discovery, or reload work. It still supplies the public ResourceLoader seam
 * consumed by the official AgentSession prompt and extension runtime.
 */
export function createPiPreheatedResourceLoader(args: {
  readonly snapshot: PiPreheatedResourceSnapshot;
  readonly appendSystemPrompt: readonly string[];
  readonly systemPrompt: string;
}): ResourceLoader {
  const resources = preheatedResources(args.snapshot);
  const extensions: ReturnType<ResourceLoader["getExtensions"]> = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  const skills: ReturnType<ResourceLoader["getSkills"]> = {
    skills: resources.skills,
    diagnostics: [],
  };
  const prompts: ReturnType<ResourceLoader["getPrompts"]> = {
    prompts: [],
    diagnostics: [],
  };
  const themes: ReturnType<ResourceLoader["getThemes"]> = {
    themes: [],
    diagnostics: [],
  };
  const agentsFiles: ReturnType<ResourceLoader["getAgentsFiles"]> = {
    agentsFiles: resources.agentsFiles,
  };
  const appendSystemPrompt = [...args.appendSystemPrompt];

  return {
    getExtensions() {
      return extensions;
    },
    getSkills() {
      return skills;
    },
    getPrompts() {
      return prompts;
    },
    getThemes() {
      return themes;
    },
    getAgentsFiles() {
      return agentsFiles;
    },
    getSystemPrompt() {
      return args.systemPrompt;
    },
    getSystemPromptSource() {
      return undefined;
    },
    getAppendSystemPrompt() {
      return appendSystemPrompt;
    },
    getAppendSystemPromptSources() {
      return [];
    },
    extendResources(paths) {
      if (
        (paths.skillPaths?.length ?? 0) > 0 ||
        (paths.promptPaths?.length ?? 0) > 0 ||
        (paths.themePaths?.length ?? 0) > 0
      ) {
        throw new Error("Pi API resource snapshots cannot be extended");
      }
    },
    async reload() {
      // The admitted snapshot is already complete and immutable.
    },
  };
}
