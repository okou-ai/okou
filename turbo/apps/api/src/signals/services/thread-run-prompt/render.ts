import type {
  CommonPromptVariables,
  IntegrationPromptVariables,
  ThreadPrompt,
} from "./types";

export function renderThreadPrompt(
  common: CommonPromptVariables,
  integration: IntegrationPromptVariables,
): ThreadPrompt {
  const { integrationContext, channelUserIdentity } =
    integration.systemPromptVariables;
  return {
    userPrompt: integration.userPromptVariables.message,
    systemPrompt: [
      [common.userIdentity, channelUserIdentity].filter(Boolean).join("\n"),
      integrationContext,
      common.priorContext,
      common.incompleteContext,
      common.generationTemplatePrompt,
      common.computerUseContext,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
