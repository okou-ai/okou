# tokens

## tokens-001

- Vitest: "auth tokens > isolates expiring host firewall authority from Guest identities"
- Mode: run
- Intent: review
- Given: A host firewall token is issued for a user, run and workspace, and a second firewall-prefixed token carries the same claims but expired a minute ago.
- When: Each token is verified as a firewall token, and the valid one is also verified as a sandbox token and as an Okou run token.
- Then: The valid token verifies as a firewall token with exactly the user, workspace, run and scope `firewall`, and is rejected (null) as a sandbox or Okou token; the verified firewall and sandbox identity types are not interchangeable. The expired firewall token is rejected.

## tokens-002

- Vitest: "auth tokens > verifies PAT CLI tokens"
- Mode: run
- Intent: review
- Given: A personal access token is signed with scope `cli`, a user, workspace and token ID, and expires in 60 seconds.
- When: The token is checked as a PAT and verified as a CLI token.
- Then: It is recognized as a PAT and verifies to exactly the user ID, workspace ID and token ID.

## tokens-003

- Vitest: "auth tokens > verifies sandbox and okou tokens behind the sandbox prefix"
- Mode: run
- Intent: review
- Given: Two sandbox-prefixed tokens are valid for 60 seconds: one with scope `sandbox` and one with scope `okou` carrying capability `file:write`.
- When: The sandbox token is checked and verified as a sandbox token and as an Okou token, and the okou token is verified as an Okou token.
- Then: The sandbox token is recognized as a sandbox token, verifies to exactly scope `sandbox` with its user, workspace and run, and is rejected as an Okou token. The okou token verifies to exactly its user, workspace, run and `["file:write"]`.

## tokens-004

- Vitest: "auth tokens > generates a run token with the okou scope behind the sandbox prefix"
- Mode: run
- Intent: review
- Given: Default feature switches apply to a user, run and workspace.
- When: A run token is issued.
- Then: The token starts with `vm0_sandbox_`, its payload has scope `okou`, and it verifies with the user, run and workspace and capabilities including `notify:write`, `data-search:read` and `whatsapp:file:write`.

## tokens-005

- Vitest: "auth tokens > limits Suggestions capabilities to personal execution (personal: true)"
- Mode: run
- Intent: review
- Given: A run token is issued with personal execution enabled (`personalExecution: true`).
- When: The token is verified.
- Then: Its capabilities include both `suggestion:read` and `suggestion:write`.

## tokens-006

- Vitest: "auth tokens > limits Suggestions capabilities to personal execution (personal: false)"
- Mode: run
- Intent: review
- Given: A run token is issued with personal execution disabled (`personalExecution: false`).
- When: The token is verified.
- Then: Its capabilities include neither `suggestion:read` nor `suggestion:write`.

## tokens-007

- Vitest: "auth tokens > generates one Okou-scoped run token with the complete run claims"
- Mode: run
- Intent: review
- Given: The Banking feature switch is on, and the run is granted a computer-use host, cloud browser access and a custom connector-to-source mapping.
- When: A run token is issued, its payload decoded and the token verified.
- Then: The payload has scope `okou`, the user, run and workspace, the host ID, `cloudBrowserEnabled: true`, the connector mapping, capabilities including `banking:read`, `browser:read`, `browser:write` and `computer-use:write`, and an expiry exactly two hours after issue. Verification returns the same identity, host ID, browser flag and connector mapping.

## tokens-008

- Vitest: "auth tokens > ignores unknown run capabilities while preserving known capabilities"
- Mode: run
- Intent: review
- Given: A valid okou-scoped sandbox token lists capabilities `file:read`, an unknown `future:read`, and `file:write`.
- When: The token is verified as an Okou token.
- Then: It verifies to exactly the user, workspace, run and capabilities `["file:read", "file:write"]`, dropping the unknown one.

## tokens-009

- Vitest: "auth tokens > rejects expired tokens and mismatched scopes"
- Mode: run
- Intent: review
- Given: A CLI PAT expired 60 seconds ago, and a valid sandbox-prefixed token has scope `compose-job` with a user and job ID.
- When: The expired PAT is verified as a CLI token, and the compose-job token is verified as sandbox, Okou and compose-job tokens.
- Then: The expired PAT and the compose-job token as sandbox or Okou token are rejected (null); as a compose-job token it verifies to exactly the user ID and job ID.

## tokens-010

- Vitest: "auth tokens > includes chat thread and connector account capabilities in okou-scoped tokens"
- Mode: run
- Intent: review
- Given: Default feature switches apply.
- When: A run token is issued and verified.
- Then: Its capabilities include `chat-thread:read`, `chat-thread:write` and `connector-account:switch`.

## tokens-011

- Vitest: "auth tokens > includes chat event read and write capabilities in okou-scoped tokens"
- Mode: run
- Intent: review
- Given: Default feature switches apply.
- When: A run token is issued, decoded and verified.
- Then: Both the decoded payload and the verified capabilities include `chat-event:read` and `chat-event:write`.

## tokens-012

- Vitest: "auth tokens > gates banking capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the Banking feature switch off and once with it on.
- When: Both tokens are verified.
- Then: The disabled token lacks `banking:read` and the enabled token includes it.

## tokens-013

- Vitest: "auth tokens > gates larkIntegration capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the Lark Integration feature switch off and once with it on.
- When: Both tokens are verified.
- Then: The disabled token lacks `lark:write` and the enabled token includes it.

## tokens-014

- Vitest: "auth tokens > gates larkOfficialBot capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the Lark Official Bot feature switch off and once with it on (row checking `lark:write`).
- When: Both tokens are verified.
- Then: The disabled token lacks `lark:write` and the enabled token includes it.

## tokens-015

- Vitest: "auth tokens > gates larkOfficialBot capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the Lark Official Bot feature switch off and once with it on (row checking `lark:read`).
- When: Both tokens are verified.
- Then: The disabled token lacks `lark:read` and the enabled token includes it.

## tokens-016

- Vitest: "auth tokens > gates wechatIntegration capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the WeChat Integration feature switch off and once with it on (row checking `wechat:read`).
- When: Both tokens are verified.
- Then: The disabled token lacks `wechat:read` and the enabled token includes it.

## tokens-017

- Vitest: "auth tokens > gates wechatIntegration capability behind its feature switch"
- Mode: run
- Intent: review
- Given: Run tokens are issued once with the WeChat Integration feature switch off and once with it on (row checking `wechat:write`).
- When: Both tokens are verified.
- Then: The disabled token lacks `wechat:write` and the enabled token includes it.

## tokens-018

- Vitest: "auth tokens > grants artifact:read by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `artifact:read`).
- When: A run token is issued and verified.
- Then: Its capabilities include `artifact:read`.

## tokens-019

- Vitest: "auth tokens > grants artifact:write by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `artifact:write`).
- When: A run token is issued and verified.
- Then: Its capabilities include `artifact:write`.

## tokens-020

- Vitest: "auth tokens > grants discord:read by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `discord:read`).
- When: A run token is issued and verified.
- Then: Its capabilities include `discord:read`.

## tokens-021

- Vitest: "auth tokens > grants discord:write by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `discord:write`).
- When: A run token is issued and verified.
- Then: Its capabilities include `discord:write`.

## tokens-022

- Vitest: "auth tokens > grants vnc:read by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `vnc:read`).
- When: A run token is issued and verified.
- Then: Its capabilities include `vnc:read`.

## tokens-023

- Vitest: "auth tokens > grants vnc:write by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `vnc:write`).
- When: A run token is issued and verified.
- Then: Its capabilities include `vnc:write`.

## tokens-024

- Vitest: "auth tokens > grants subscription:read by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `subscription:read`).
- When: A run token is issued and verified.
- Then: Its capabilities include `subscription:read`.

## tokens-025

- Vitest: "auth tokens > grants subscription:switch by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply (row `subscription:switch`).
- When: A run token is issued and verified.
- Then: Its capabilities include `subscription:switch`.

## tokens-026

- Vitest: "auth tokens > grants current-run usage by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply.
- When: A run token is issued and verified.
- Then: Its capabilities include `run-usage:read`.

## tokens-027

- Vitest: "auth tokens > includes Slack read and write capabilities in okou-scoped tokens"
- Mode: run
- Intent: review
- Given: Default feature switches apply.
- When: A run token is issued and verified.
- Then: Its capabilities include `slack:read` and `slack:write`.

## tokens-028

- Vitest: "auth tokens > grants custom connector writes by default"
- Mode: run
- Intent: review
- Given: Default feature switches apply.
- When: A run token is issued and verified.
- Then: Its capabilities include `connector:write`.

## tokens-029

- Vitest: "auth tokens > gates browser capabilities on thread access"
- Mode: run
- Intent: review
- Given: One run token is issued with default options and another with cloud browser access enabled.
- When: Both tokens are verified.
- Then: The default token includes neither `browser:read` nor `browser:write`; the enabled token has `cloudBrowserEnabled: true` and includes both.

## tokens-030

- Vitest: "auth tokens > gates computer-use capability on an explicit host grant"
- Mode: run
- Intent: review
- Given: One run token is issued with default options and another with an explicit computer-use host ID.
- When: Both tokens are verified.
- Then: The default token lacks `computer-use:write` and has no host ID; the scoped token carries the host ID and includes `computer-use:write`.
