import type { AnyPgColumn } from "drizzle-orm/pg-core";

interface AgentRunReferences {
  readonly agentRunId: AnyPgColumn;
  readonly agentSessionId: AnyPgColumn;
}

let references: AgentRunReferences | undefined;

export function registerAgentRunReferences(
  registeredReferences: AgentRunReferences,
): void {
  if (
    references &&
    (references.agentRunId !== registeredReferences.agentRunId ||
      references.agentSessionId !== registeredReferences.agentSessionId)
  ) {
    throw new Error("Agent-run schema references were registered twice");
  }
  references = registeredReferences;
}

function resolveAgentRunReferences(): AgentRunReferences {
  if (!references) {
    throw new Error(
      "Agent-run schema references were resolved before schema initialization",
    );
  }
  return references;
}

export function resolveAgentSessionId(): AnyPgColumn {
  return resolveAgentRunReferences().agentSessionId;
}
