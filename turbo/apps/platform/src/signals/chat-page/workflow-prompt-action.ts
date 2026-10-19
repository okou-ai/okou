export const CREATE_WORKFLOW_WITH_CHAT_PROMPT =
  "Help me create a workflow for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

export const CREATE_AUTOMATION_CHAT_PROMPT =
  "Help me create a workflow automation for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

/** The automation request with how often it should run already given. */
export function scheduledAutomationChatPrompt(cadence: string): string {
  return `Help me create a workflow automation for this agent that runs ${cadence}. Use the workflow-setup skill, then ask me for the desired outcome and action before creating the workflow and automation.`;
}
