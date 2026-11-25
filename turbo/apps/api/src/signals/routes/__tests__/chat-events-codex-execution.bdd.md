# chat-events-codex-execution

## chat-events-codex-execution-001

- Vitest: "Codex execution switch > routes native Codex for gpt-6.1-sol with tier undefined when KMS decryption is unavailable"
- Mode: run
- Given: A member has native Codex enabled and a connected personal GPT-6.1 Sol account. KMS decryption is unavailable.
- When: The member sends a Chat prompt for standard GPT-6.1 Sol with high reasoning effort and the Runner claims it.
- Then: The dispatch uses native Codex with the requested model and effort, connected account ID and matching access-token source. It has no Pi configuration, native Pi session, fast tier or billable firewalls.

## chat-events-codex-execution-002

- Vitest: "Codex execution switch > routes native Codex for gpt-6.1-sol with tier fast when KMS decryption is unavailable"
- Mode: run
- Given: A member has native Codex enabled and a connected personal GPT-6.1 Sol account. KMS decryption is unavailable.
- When: The member sends a Chat prompt for fast GPT-6.1 Sol with high reasoning effort and the Runner claims it.
- Then: The dispatch uses native Codex with the model, fast tier and high effort, and exposes the account ID and corresponding credential source. No Pi configuration, launch or session options or billable firewalls are present.

## chat-events-codex-execution-003

- Vitest: "Codex execution switch > routes native Codex for gpt-6-luna with tier undefined when KMS decryption is unavailable"
- Mode: run
- Given: A member has native Codex enabled and a connected personal GPT-6 Luna account. KMS decryption is unavailable.
- When: The member sends a Chat prompt for standard GPT-6 Luna with high reasoning effort and the Runner claims it.
- Then: The dispatch uses native Codex with the model and effort, and identifies the connected account and credential source. It sets no fast tier, Pi model or launch configuration, Pi session or billable firewalls.

## chat-events-codex-execution-004

- Vitest: "Codex execution switch > routes native Codex for gpt-6-luna with tier fast when KMS decryption is unavailable"
- Mode: run
- Given: A member has native Codex enabled and a connected personal GPT-6 Luna account. KMS decryption is unavailable.
- When: The member sends a Chat prompt for fast GPT-6 Luna with high reasoning effort and the Runner claims it.
- Then: The dispatch uses native Codex on that account with the selected model, high effort and fast tier and corresponding credential source. The dispatch has no Pi configuration, Pi launch, Pi session or billable firewalls.

## chat-events-codex-execution-005

- Vitest: "Codex execution switch > uses the switch when an event-triggered workflow launches a subscription chat"
- Mode: run
- Given: A Team member has a personal Luna subscription, native Codex enabled and a selected thread.
- When: An event-triggered workflow starts a Run on the thread.
- Then: The Runner receives a native Codex dispatch for Luna and the member's personal account, with no Pi launch config or billable firewalls.

## chat-events-codex-execution-006

- Vitest: "Codex execution switch > leaves Claude subscriptions on Claude Code"
- Mode: run
- Given: A member has an official personal Claude Fable 5.1 subscription and native Codex enabled.
- When: The member sends a Chat prompt selecting Fable.
- Then: The Runner receives Claude Code with Fable configured as the Anthropic model and no Pi model configuration.

## chat-events-codex-execution-007

- Vitest: "Codex execution switch > rotates native sessions and preserves visible context when switching both ways"
- Mode: run
- Given: A member with a personal Luna route starts on Pi and can toggle native Codex.
- When: The first Run dispatches on Pi, native Codex is enabled before it completes, and the member starts and completes the next turn on Codex. The member disables native Codex again and continues on Pi.
- Then: The first claim uses Pi, the second uses Codex and the third uses Pi. The Codex dispatch does not inject the prior Pi answer and supplies Chat recovery guidance; it can complete and read back completed. The final Pi dispatch does not inject the Codex answer.
