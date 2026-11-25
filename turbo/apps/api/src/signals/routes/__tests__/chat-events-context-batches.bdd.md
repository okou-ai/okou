# chat-events-context-batches

## chat-events-context-batches-001

- Vitest: "shared context statement projections through normal sends > preserves providers rowsets in first and continuation sends"
- Mode: run
- Given: An entitled workspace member selects personal Claude Fable 5.1 and has a personal Codex OAuth credential installed as well, without agent-specific connector or workflow entries.
- When: The member sends an initial prompt and a continuation, and the Runner claims both.
- Then: Both dispatches attribute model usage to Claude Fable 5.1, include the Claude Code OAuth provider firewall with allow for its unknown policy and empty explicit allow, deny and ask lists, and emit the credential placeholder. The connector target list is empty and the skills bundle contains the built-in skills.

## chat-events-context-batches-002

- Vitest: "shared context statement projections through normal sends > preserves all rowsets in first and continuation sends"
- Mode: run
- Given: An entitled workspace member selects personal Claude Fable 5.1 and has a Codex OAuth credential installed too. The member connects Slack with an unknown-permission deny rule, configures a custom connector with a secret and a region, and publishes a workflow.
- When: The member sends an initial prompt, reconnects the custom account with a new region, and sends a continuation to the same thread.
- Then: Both Runner dispatches preserve the chosen model usage attribution, Claude Code OAuth firewall and credential placeholder with its allow policy, the Slack and custom connector targets, Slack's unknown-permission deny policy, and a workflow skill bundle containing the published content. Authorized request decoration resolves the custom header and applies the appropriate initial or updated region on each Run.
