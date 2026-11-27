import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";

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
  readonly phoneUseContext?: string;
  readonly suggestionFeedback?: string;
  readonly connectors?: string;
  readonly codexImageUpload?: string;
  readonly builtInImageModel?: string;
  readonly restrictedExplicitContent?: string;
}

export interface UserPromptVariables {
  readonly message?: string;
}

export interface NamedSkillBundle {
  readonly name: string;
  readonly contentBundle: ContentBundle;
}

export interface RunPrompt {
  readonly systemPromptVariables: SystemPromptVariables;
  readonly userPromptVariables: UserPromptVariables;
}

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

export function mergeRunPrompt(parts: readonly RunPrompt[]): RunPrompt {
  const systemPromptVariables: SystemPromptVariables = {};
  const userPromptVariables: UserPromptVariables = {};
  for (const part of parts) {
    mergePromptVariables(systemPromptVariables, part.systemPromptVariables);
    mergePromptVariables(userPromptVariables, part.userPromptVariables);
  }
  return { systemPromptVariables, userPromptVariables };
}

interface RenderedRunPrompts {
  readonly userPrompt: string;
  readonly systemPrompt: string;
}

/** Render the complete prompt contributions in their stable injection order. */
export function renderRunPrompts(part: RunPrompt): RenderedRunPrompts {
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
      variables.phoneUseContext,
      variables.suggestionFeedback,
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
