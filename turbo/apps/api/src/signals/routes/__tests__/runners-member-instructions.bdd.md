# runners-member-instructions

## runners-member-instructions-001

- Vitest: "Published member instructions in direct Runs > keeps each Run's published instruction bytes across later edits"
- Mode: run
- Given: A member saves instructions A and creates a Run. Before its execution is dispatched the member saves B containing a BOM, whitespace, CRLF and multilingual text.
- When: The Runner takes the first execution, the member saves C, and a later Run dispatches.
- Then: The first published bundle contains exactly A before and after the C update. The later bundle has a different digest and contains C. The original Run stays running.

## runners-member-instructions-002

- Vitest: "Published member instructions in direct Runs > dispatches an empty-file package when instructions are cleared before launch"
- Mode: run
- Given: The member saves and then clears their instructions before a new Run.
- When: The Runner takes that Run’s execution and reads its published instructions package.
- Then: The package contains exactly one zero-byte file, `instructions.md`.

## runners-member-instructions-003

- Vitest: "Published member instructions in direct Runs > reuses the sending member's instructions captured before attachment verification"
- Mode: run
- Given: A workspace member has saved personalized instructions and sends a message with a previously completed text attachment.
- When: The member’s instructions change while the API verifies the attachment, and the Runner takes the resulting execution.
- Then: The published instructions contain the bytes captured before attachment verification, preserving the sending member’s earlier text.
