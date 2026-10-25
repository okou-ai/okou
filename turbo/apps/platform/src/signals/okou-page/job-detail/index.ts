import { command } from "ccstate";

import { agentName$, setAgentName$, resetActiveTab$ } from "./agent-name.ts";
import { discardAgentEdit$ } from "./instructions.ts";
import { resetSettingsForm$ } from "../settings/settings-tab.ts";

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Set active agent — sets the agent name and resets draft states. Async detail,
// instructions, connectors, and permissions re-evaluate through the computed
// dependency chain.
// ---------------------------------------------------------------------------

export const setActiveAgent$ = command(({ get, set }, agentName: string) => {
  if (get(agentName$) !== agentName) {
    set(resetSettingsForm$);
  }
  set(setAgentName$, agentName);
  set(resetActiveTab$);
  set(discardAgentEdit$);
});
