# chat-events-personal-instructions

## chat-events-personal-instructions-001

- Vitest: "captured My Okou execution guidance > keeps fixed identity and personal scope through dispatch"
- Mode: run
- Given: A signed-in workspace member can launch a Chat Run.
- When: The member sends a prompt asking the agent to work with their personal Instructions, then the Runner receives the dispatch.
- Then: The dispatched guidance identifies Okou as the user's personal AI assistant with its fixed tone and gives the commands to view and edit personal Instructions. It says changes apply to future work, private workflows take precedence over same-name workspace workflows, and account selection is saved for subsequent Runs in this Chat. It preserves authorization, permission-expiry, revocation and purchase-approval rules and identifies runtime child-task tools as execution tools.
