import { agentDisplayName } from "@okouai/core/public-brand";

const TONE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  professional:
    "Communicate in a clear, polished, and business-appropriate tone. Be thorough yet concise.",
  friendly:
    "Communicate in a warm, approachable, and conversational tone. Feel free to be casual while still being helpful.",
  direct:
    "Be brief and to the point. Skip pleasantries and filler — just deliver the information or action needed.",
  supportive:
    "Be encouraging and empathetic. Show that you're in the user's corner and proactively offer help.",
};

interface AgentIdentityPromptInput {
  readonly id: string;
  readonly defaultAgentId: string | null;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
}

export function buildAgentIdentityPrompt(
  agent: AgentIdentityPromptInput,
): string | null {
  const parts: string[] = [];

  const displayName = agentDisplayName({
    agentId: agent.id,
    defaultAgentId: agent.defaultAgentId,
    displayName: agent.displayName,
  });
  if (displayName) {
    parts.push(`Your name is ${displayName}.`);
  }

  if (agent.description) {
    parts.push(`Your role: ${agent.description}`);
  }

  if (agent.sound) {
    const instruction = TONE_INSTRUCTIONS[agent.sound];
    if (instruction) {
      parts.push(instruction);
    }
  }

  return parts.length > 0 ? `# Agent Identity\n${parts.join("\n")}` : null;
}
