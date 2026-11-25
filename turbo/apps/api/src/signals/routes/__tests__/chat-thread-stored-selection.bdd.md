# chat-thread-stored-selection

## chat-thread-stored-selection-001

- Vitest: "public selection of a retired model for webhook automation > normalizes an explicit thread selection and runs its webhook automation on the successor"
- Mode: run
- Given: An authenticated Team workspace member has an active Runner, a workflow with a thread-bound signed webhook automation, and access to Claude Fable 5.1 as the successor to the retired Claude Fable 5 alias.
- When: The member explicitly selects the retired model on the automation's thread and sends a valid signed JSON webhook to start it.
- Then: The webhook returns HTTP 200 with success true and duplicate false, and its input launches a Run using `claude-fable-5-1`. Thread metadata reports the same canonical model, and the thread event feed records exactly one matching model-selection update.
