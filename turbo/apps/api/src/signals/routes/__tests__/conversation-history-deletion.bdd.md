# conversation-history-deletion

## conversation-history-deletion-001

- Vitest: "preserves completed Run history and callback replay after Clerk user deletion"
- Mode: run
- Given: A Pro member completed an assigned Claude Code Run with native-only session history. Before deletion the owner can read status completed, and the sandbox retains the original completion credential.
- When: Clerk delivers its verified user deletion event. After deletion processing the sandbox replays the original Run completion.
- Then: The deletion webhook and completion replay both return HTTP 200.

## conversation-history-deletion-002

- Vitest: "preserves completed Run history and callback replay after Clerk organization deletion"
- Mode: run
- Given: A Pro member completed an assigned Claude Code Run with native-only session history. Before deletion the owner can read status completed, and the sandbox retains the original completion credential.
- When: Clerk delivers its verified organization deletion event. After deletion processing the sandbox replays the original Run completion.
- Then: The deletion webhook and completion replay both return HTTP 200.
