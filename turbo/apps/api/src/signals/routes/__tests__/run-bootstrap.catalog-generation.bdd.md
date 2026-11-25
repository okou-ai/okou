# run-bootstrap.catalog-generation

## run-bootstrap.catalog-generation-001

- Vitest: "Run connector selection through normal user changes > omits a connected but unselected connector from a real Runner execution"
- Mode: run
- Given: An onboarded member on an active plan uses a personal subscription model, has a registered Runner group, and has connected X, but has turned off X as a default connector for chats.
- When: The member sends a chat message that launches a Run, and the Runner reads the Run's execution input.
- Then: The execution has no `X_TOKEN` in its environment or secret connector map, no built-in `x` firewall entry, no `x` billable firewall, and no `x` network policy.

## run-bootstrap.catalog-generation-002

- Vitest: "Run connector selection through normal user changes > uses current native connector selections during preparation and keeps the delivered Run configuration"
- Mode: run
- Given: An onboarded member on an active plan has connected OpenAI and a `runtime` connector with API keys and X; X and runtime are off by default and a chat input is queued behind a busy Run. After queuing, the member turns OpenAI off and runtime on.
- When: The queued input launches its Run and the Runner reads the execution input; the member then turns OpenAI on and runtime off, cancels the Run, and sends a new message in the same conversation.
- Then: The launched Run uses the selections current at preparation: `RUNTIME_API_KEY` comes from the runtime connection and there is no `OPENAI_TOKEN`. Later selection changes do not alter the delivered execution, which still has `RUNTIME_API_KEY`. The next Run has `OPENAI_TOKEN` from the OpenAI connection and no `RUNTIME_API_KEY`.
