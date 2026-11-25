# chat-events-auto-route

## chat-events-auto-route-001

- Vitest: "Auto native routing > claims the OpenRouter preset for a completed initial run and its successor"
- Mode: run
- Given: A signed-in workspace owner has paid capacity, an available Runner, and access to the built-in Auto route through OpenRouter.
- When: The owner sends an explicit Auto prompt to start a thread, allows the Sandbox Pi Run to complete, then sends a second prompt to the same thread without selecting a model. The Runner receives and completes the successor Run.
- Then: Both Runner dispatches specify Pi, the OpenRouter API, and preset `@preset/okou-1-0` for the model and usage attribution. The successor gets a new Run ID and the same thread ID. Both Runs read back as completed with model `auto`, a built-in OpenRouter Codex source and organization credential scope, and both completion callbacks record the same native session ID.
