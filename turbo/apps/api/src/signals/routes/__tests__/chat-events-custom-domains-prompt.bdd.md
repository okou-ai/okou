# chat-events-custom-domains-prompt

## chat-events-custom-domains-prompt-001

- Vitest: "custom-domain CLI guidance in the dispatched system prompt > includes custom-domain instructions only when the feature is enabled: false"
- Mode: run
- Given: An authenticated workspace member has the custom-domain feature disabled.
- When: The member sends a Chat prompt about connecting a custom domain and a Runner receives it.
- Then: The Runner's system instructions omit the custom-domain CLI guidance.

## chat-events-custom-domains-prompt-002

- Vitest: "custom-domain CLI guidance in the dispatched system prompt > includes custom-domain instructions only when the feature is enabled: true"
- Mode: run
- Given: An authenticated workspace member has the custom-domain feature enabled.
- When: The member sends a Chat prompt about connecting a custom domain and a Runner receives it.
- Then: Runner guidance includes custom-domain help, add and verify commands, the entitlement requirement, possible additional certificate TXT records, readiness before domain selection, no polling or guessing of DNS targets, and preserving connected domains and site visibility.
