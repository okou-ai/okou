export interface SystemPromptVariables {
  readonly agentIdentity?: string;
  readonly executionLimit?: string;
  readonly tools?: string;
  readonly userIdentity?: string;
  readonly channelUserIdentity?: string;
  readonly integrationContext?: string;
  readonly continuationContext?: string;
  readonly generationTemplatePrompt?: string;
  readonly computerUseContext?: string;
  readonly connectors?: string;
  readonly codexImageUpload?: string;
  readonly builtInImageModel?: string;
  readonly restrictedExplicitContent?: string;
}

export interface UserPromptVariables {
  readonly message?: string;
}

type SkillVolumeSource =
  | "system_skill"
  | "connector_skill"
  | "custom_connector_skill"
  | "official_workflow"
  | "workflow_skill"
  // Template guidance packages keep their existing storage provenance.
  | "request_additional_volume";

interface SkillVolumeStorage {
  readonly name: string;
  readonly version?: string;
  readonly system?: boolean;
  readonly expectedStorageId?: string;
}

export type SkillVolume = SkillVolumeStorage &
  (
    | {
        readonly source: Exclude<
          SkillVolumeSource,
          "request_additional_volume"
        >;
        readonly skillName: string;
      }
    | {
        readonly source: "request_additional_volume";
        readonly mountPath: string;
      }
  );

/** Prompt text and skill or template guidance packages for one run. */
export interface RunPromptAndSkills {
  readonly systemPromptVariables: SystemPromptVariables;
  readonly userPromptVariables: UserPromptVariables;
  readonly skillVolumes: readonly SkillVolume[];
}

const VOLUME_SOURCE_ORDER = {
  custom_connector_skill: 0,
  system_skill: 1,
  connector_skill: 2,
  official_workflow: 3,
  workflow_skill: 3,
  request_additional_volume: 4,
} as const satisfies Readonly<Record<SkillVolumeSource, number>>;

function mergePromptVariables<T extends object>(target: T, source: T): void {
  for (const key in source) {
    if (Object.hasOwn(source, key)) {
      const value = source[key];
      if (value === undefined) {
        continue;
      }
      if (target[key] !== undefined) {
        throw new Error(`Multiple run parts supply prompt variable: ${key}`);
      }
      target[key] = value;
    }
  }
}

export function mergeRunPromptAndSkills(
  parts: readonly RunPromptAndSkills[],
): RunPromptAndSkills {
  const systemPromptVariables: SystemPromptVariables = {};
  const userPromptVariables: UserPromptVariables = {};
  const skillVolumes: SkillVolume[] = [];
  for (const part of parts) {
    mergePromptVariables(systemPromptVariables, part.systemPromptVariables);
    mergePromptVariables(userPromptVariables, part.userPromptVariables);
    skillVolumes.push(...part.skillVolumes);
  }
  return {
    systemPromptVariables,
    userPromptVariables,
    // Preserve mount precedence while keeping each source's captured order.
    skillVolumes: skillVolumes.sort((left, right) => {
      return (
        VOLUME_SOURCE_ORDER[left.source] - VOLUME_SOURCE_ORDER[right.source]
      );
    }),
  };
}

interface ResolvedSkillVolume extends SkillVolumeStorage {
  readonly mountPath: string;
}

/** Bind runtime skill paths at run assembly; template paths are already fixed. */
export function resolveRunSkillVolumes(
  volumes: readonly SkillVolume[],
  skillsRoot?: string,
): {
  readonly skillVolumes: readonly ResolvedSkillVolume[];
  readonly skillVolumeSources: readonly SkillVolumeSource[];
} {
  const skillVolumes: ResolvedSkillVolume[] = [];
  const skillVolumeSources: SkillVolumeSource[] = [];
  for (const volume of volumes) {
    if (volume.source === "request_additional_volume") {
      const { source, ...fixedVolume } = volume;
      skillVolumes.push(fixedVolume);
      skillVolumeSources.push(source);
    } else {
      if (skillsRoot === undefined) {
        throw new Error("Runtime skills require a mount root at run assembly");
      }
      const { source, skillName, ...storage } = volume;
      skillVolumes.push({
        ...storage,
        mountPath: `${skillsRoot}/${skillName}`,
      });
      skillVolumeSources.push(source);
    }
  }
  return { skillVolumes, skillVolumeSources };
}

interface RenderedRunPrompts {
  readonly userPrompt: string;
  readonly systemPrompt: string;
}

/** Render the complete prompt contributions in their stable injection order. */
export function renderRunPrompts(part: RunPromptAndSkills): RenderedRunPrompts {
  const variables = part.systemPromptVariables;
  return {
    userPrompt: part.userPromptVariables.message ?? "",
    systemPrompt: [
      variables.agentIdentity,
      variables.executionLimit,
      variables.tools,
      [variables.userIdentity, variables.channelUserIdentity]
        .filter(Boolean)
        .join("\n"),
      variables.integrationContext,
      variables.continuationContext,
      variables.generationTemplatePrompt,
      variables.computerUseContext,
      variables.connectors,
      variables.codexImageUpload,
      variables.builtInImageModel,
      // Keep the product policy last, after all caller and integration text.
      variables.restrictedExplicitContent,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
