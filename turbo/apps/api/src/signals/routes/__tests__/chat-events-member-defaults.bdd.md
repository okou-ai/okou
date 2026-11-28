# chat-events-member-defaults

## chat-events-member-defaults-001

- Vitest: "new chat event member defaults > uses empty model settings and enables cloud browser without a saved member preference"
- Mode: run
- Given: A newly registered member in a paid workspace has personal Claude Fable 5.1 access but no saved model or Web preferences.
- When: The member reads their preferences, sends a prompt and reads the new thread's metadata.
- Then: The preference read returns HTTP 200 with no update timestamp. New thread metadata has empty model settings and cloud browser enabled.

## chat-events-member-defaults-002

- Vitest: "new chat event member defaults > captures saved model settings and cloud browser (true), retaining them on continuation"
- Mode: run
- Given: An entitled member has saved Claude Fable 5.1 high effort and enables cloud browser by default.
- When: The member sends a first prompt, then saves low effort and disables the default browser. They continue the original thread and start a new thread.
- Then: The first thread and its continuation read back high effort and cloud browser true. The newly created thread reads back low effort and cloud browser false.

## chat-events-member-defaults-003

- Vitest: "new chat event member defaults > captures saved model settings and cloud browser (false), retaining them on continuation"
- Mode: run
- Given: An entitled member has saved Claude Fable 5.1 high effort and disables cloud browser by default.
- When: The member sends a first prompt, then saves low effort and enables the default browser. They continue the original thread and start a new thread.
- Then: The first thread and its continuation read back high effort and cloud browser false. The new thread reads back low effort and cloud browser true.
