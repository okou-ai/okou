# connector-check

## connector-check-001

- Vitest: "POST /api/connectors/diagnostics/check > requires organization auth and both agent capabilities"
- Mode: run
- Given: A Reap account is configured for an owned Run. The client can exercise a missing session, an organization-less session, and Run credentials with only one or both diagnostic capabilities.
- When: Each credential is used with POST /api/connectors/diagnostics/check to check a Reap GET /users request.
- Then: Missing authentication or organization returns HTTP 401 UNAUTHORIZED. Missing connector:read or agent-run:read returns HTTP 403 FORBIDDEN identifying the required capability. With both permissions the HTTP 200 resolves Reap for the configured Run with read allowed on the allow-list.

## connector-check-002

- Vitest: "POST /api/connectors/diagnostics/check > returns sanitized unsafe-input outcomes"
- Mode: run
- Given: An authenticated workspace member submits malformed diagnostic inputs covering a disallowed method, malformed URL forms, and unsafe path syntax.
- When: The caller sends POST /api/connectors/diagnostics/check for each input.
- Then: Each HTTP 200 returns only a sanitized unsafe-input outcome with invalid-method for TRACE, invalid-url for missing scheme, user information, malformed or noncanonical host and path separators or whitespace, and unsafe-path for a disallowed path.

## connector-check-003

- Vitest: "POST /api/connectors/diagnostics/check > retains encoded API prefixes during global catalog selection"
- Mode: run
- Given: An authenticated member has a Reap manual account with an encoded API prefix.
- When: The member submits a URL with the normalized form of the prefix to POST /api/connectors/diagnostics/check without an explicit connector.
- Then: HTTP 200 returns exactly unsafe-input with reason unsafe-path.

## connector-check-004

- Vitest: "POST /api/connectors/diagnostics/check > returns canonical identities for both URL request forms"
- Mode: run
- Given: An authenticated workspace member has a recognized GitHub endpoint and can select it by legacy slug or typed built-in target.
- When: The member calls POST /api/connectors/diagnostics/check for the same GET request in both URL forms.
- Then: Both HTTP 200 responses resolve to the same canonical built-in GitHub target.

## connector-check-005

- Vitest: "POST /api/connectors/diagnostics/check > returns an unknown endpoint for AWS without selectors and matches explicit SigV4 selectors"
- Mode: run
- Given: An authenticated workspace member diagnoses a known AWS STS host outside a Run and compares absent, known, unknown and incompatible selector combinations.
- When: The member calls POST /api/connectors/diagnostics/check without SigV4 selectors, with the explicit identity action, with an unknown action and with the session-token alias on an action that uses only an access key pair.
- Then: Each diagnostic returns HTTP 200. Missing selectors resolve AWS with unknown-endpoint and an insufficient-context header. The explicit identity action matches sts:get-caller-identity with the three AWS environment names. An unknown action has unknown-endpoint without the insufficient header. The incompatible alias reports environment-not-used and lists the access key ID and secret key. Matched and unknown policy are unavailable outside a Run.

## connector-check-006

- Vitest: "POST /api/connectors/diagnostics/check > marks an AWS action with an omitted required query as incomplete"
- Mode: run
- Given: An authenticated member diagnoses the versioned AWS STS federation action outside a Run.
- When: The member calls POST /api/connectors/diagnostics/check with the required version omitted, with the catalog version and with a different version.
- Then: The omitted version reports unknown-endpoint and insufficient context. The matching version finds sts:get-federation-token-versioned with no insufficient-context header. The contradictory version returns the same unknown-endpoint body as omission but no insufficient-context header.

## connector-check-007

- Vitest: "POST /api/connectors/diagnostics/check > prefers the canonical AWS permission over a denied alias"
- Mode: run
- Given: A caller has valid authentication for a Run with connected AWS and both allow and deny permission names applied to the canonical action and alias, respectively.
- When: The caller submits the known caller-identity action to POST /api/connectors/diagnostics/check.
- Then: HTTP 200 resolves AWS and matches canonical sts:get-caller-identity with allow and allow-list basis.

## connector-check-008

- Vitest: "POST /api/connectors/diagnostics/check > keeps incomplete AWS checks on the unknown policy"
- Mode: run
- Given: A caller has valid authentication for a Run with connected AWS and custom permission grants.
- When: The caller uses POST /api/connectors/diagnostics/check for STS without selectors and with an explicit unknown action.
- Then: Both HTTP 200 bodies resolve AWS with identical unknown-endpoint policy. Only the request lacking selectors receives the insufficient-context header.

## connector-check-009

- Vitest: "POST /api/connectors/diagnostics/check > supports a real PAT and resolves hidden server-authored metadata without private refs"
- Mode: run
- Given: An authenticated workspace owner has a PAT issued through CLI device flow and diagnostics for a public Slack endpoint and an explicitly identified hidden catalog connector.
- When: The owner uses POST /api/connectors/diagnostics/check with the PAT, a Slack URL carrying a query and fragment, and the hidden OAuth connector's endpoint.
- Then: Slack resolves as available and network-boundary authorized with method POST, base and relative path, matched chat:write and unavailable policy outside a Run. The serialized body omits query and fragment input. The hidden connector resolves with visibility unavailable and its expected relative path while omitting private routing references and variable names.

## connector-check-010

- Vitest: "POST /api/connectors/diagnostics/check > resolves environment aliases, ambiguity, and URL selectors deterministically"
- Mode: run
- Given: An authenticated member uses catalog diagnostics for aliases and URLs that may overlap, belong to different connectors or be unmatched.
- When: The caller uses POST /api/connectors/diagnostics/check for GH_TOKEN and an unknown alias, GitHub with explicit alias or unrelated selector, Nintendo's shared endpoint with and without selections, an unknown slug and a deceptive host sharing GitHub's text prefix.
- Then: The known alias resolves GitHub with not-scoped run and unavailable policy, and the unknown alias reports unknown-environment. GitHub URL restricts the alias list to GH_TOKEN, selects the canonical connector despite connector-mismatch or environment-not-owned on unrelated selectors, and the deceptive host has no-match at catalog scope. Nintendo without selection returns the two expected candidates. Explicit parental-controls target resolves or reports environment-not-used with its account-token alias as appropriate. The unknown slug reports unknown-connector.

## connector-check-011

- Vitest: "POST /api/connectors/diagnostics/check > resolves opaque dynamic bases from the current owner account"
- Mode: run
- Given: The authenticated owner initially has no Reap account and can connect and switch between two manual accounts with distinct base URLs. Another user in the workspace and the same user in another workspace have no account.
- When: Callers diagnose GET /users through POST /api/connectors/diagnostics/check before connection and after connection and default switches.
- Then: Initially Reap reports unresolved-dynamic-base. The owner resolves the current default's exact base and /users outside a Run, restoring the original result after switching back. Other identities still get unresolved-dynamic-base. The response reveals neither credentials nor the private base-variable name.

## connector-check-012

- Vitest: "POST /api/connectors/diagnostics/check > keeps stored credential snapshots isolated across user boundaries through reconnect and deletion"
- Mode: run
- Given: Two authenticated caller contexts differ by user within the same organization. Both begin without Reap accounts and add separate API keys and base URLs.
- When: Each calls POST /api/connectors/diagnostics/check before and after saving accounts, tests the other context's URL, and repeats after the first owner reconnects the same ID with a new key and base and both accounts are later deleted.
- Then: The initial and post-deletion responses report unresolved dynamic base. Each saved default resolves only its owner's URL and foreign URLs report catalog no-match. Reconnect keeps the same ID, changes only that owner's matched base and leaves the foreign result identical. Public results omit secrets, account IDs, private variables and storage metadata. Both account lists end empty.

## connector-check-013

- Vitest: "POST /api/connectors/diagnostics/check > keeps stored credential snapshots isolated across organization boundaries through reconnect and deletion"
- Mode: run
- Given: Two authenticated caller contexts differ by organization for the same user. Both begin without Reap accounts and add separate API keys and base URLs.
- When: Each calls POST /api/connectors/diagnostics/check before and after saving accounts, tests the other context's URL, and repeats after the first owner reconnects the same ID with a new key and base and both accounts are later deleted.
- Then: The initial and post-deletion responses report unresolved dynamic base. Each saved default resolves only its owner's URL and foreign URLs report catalog no-match. Reconnect keeps the same ID, changes only that owner's matched base and leaves the foreign result identical. Public results omit secrets, account IDs, private variables and storage metadata. Both account lists end empty.

## connector-check-014

- Vitest: "POST /api/connectors/diagnostics/check > refreshes an active Run after shared permission and account authority change"
- Mode: run
- Given: An authenticated Chat owner has an active Run with a manually connected Reap account. The owner adds a shared deny grant for read, reconnects the admitted account with a changed host and switches the default to a new separate account.
- When: The active Run checks GET /users via POST /api/connectors/diagnostics/check against the original and current URLs before and after the account updates.
- Then: The original check resolves the original configured base and read deny. After the changes the old URL gives no-match at Run scope, the current default's URL resolves with its exact configured base and the read denial remains.

## connector-check-015

- Vitest: "POST /api/connectors/diagnostics/check > uses current permission expiry for an admitted builtin connector"
- Mode: run
- Given: An authenticated owner has an active Run with an admitted OAuth Cloudflare account and a one-hour allow for the DNS firewall write permission.
- When: The caller uses POST /api/connectors/diagnostics/check for the DNS firewall rules POST with a Run token before and at the grant deadline.
- Then: Both HTTP 200 responses resolve Cloudflare and dns-firewall.write. Before the deadline the matched permission is allow from the allow-list. At expiry it is deny from the deny-list.

## connector-check-016

- Vitest: "POST /api/connectors/diagnostics/check > keeps active Run registration preflight isolated across user boundaries"
- Mode: run
- Given: An owner has an active Run and an authenticated foreign context differs by user within the same organization. Both credentials have connector:read and agent-run:read.
- When: Both contexts call POST /api/connectors/diagnostics/check with the owner's Run ID for an unmatched URL and the GitHub alias, and the foreign context repeats with an unknown Run ID.
- Then: Owner requests return HTTP 200 with no-match at run scope for the URL and a resolved GH_TOKEN with GitHub not configured and null policy for the environment request. The foreign Run and unknown Run both return the identical HTTP 404 NOT_FOUND Agent run not found. Owner results remain identical after the denied calls.

## connector-check-017

- Vitest: "POST /api/connectors/diagnostics/check > keeps active Run registration preflight isolated across organization boundaries"
- Mode: run
- Given: An owner has an active Run and an authenticated foreign context differs by organization for the same user. Both credentials have connector:read and agent-run:read.
- When: Both contexts call POST /api/connectors/diagnostics/check with the owner's Run ID for an unmatched URL and the GitHub alias, and the foreign context repeats with an unknown Run ID.
- Then: Owner requests return HTTP 200 with no-match at run scope for the URL and a resolved GH_TOKEN with GitHub not configured and null policy for the environment request. The foreign Run and unknown Run both return the identical HTTP 404 NOT_FOUND Agent run not found. Owner results remain identical after the denied calls.

## connector-check-018

- Vitest: "POST /api/connectors/diagnostics/check > rejects connector diagnostics from another owner of the same organization"
- Mode: run
- Given: An authenticated owner has a connected Reap account and active Run. Another admin in the same organization has a different user identity.
- When: The other admin uses POST /api/connectors/diagnostics/check targeting the owner's Run with both diagnostic capabilities.
- Then: The API returns HTTP 404 NOT_FOUND with message Agent run not found.

## connector-check-019

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > returns unsafe input when a configured prefix exceeds analysis capacity"
- Mode: run
- Given: An authenticated Chat owner has an admitted custom HTTP account with a configured encoded API prefix that exceeds the analyzer's capacity.
- When: The Run uses POST /api/connectors/diagnostics/check for a GET request on the same authority and selects that exact custom connector.
- Then: HTTP 200 returns only unsafe-input and reason unsafe-path.

## connector-check-020

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > requires an explicit identity for shared custom prefixes and retains deletion isolation"
- Mode: run
- Given: An authenticated member admits two custom connectors with the same configured HTTP prefix, distinct IDs and separate account credentials into an active Run.
- When: The Run calls POST /api/connectors/diagnostics/check with custom inclusion and no explicit target, selects each definition in turn, then checks both after the member deletes the first.
- Then: The untargeted diagnostic is ambiguous. Each explicitly selected ID initially resolves without exposing credentials. After deletion the first explicitly targeted result is target-unavailable and the second still resolves.

## connector-check-021

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > keeps legacy run requests builtin-only despite an admitted custom overlap"
- Mode: run
- Given: An active Run has both a built-in Reap account and an admitted custom connector covering the same URL.
- When: The Run uses the legacy URL-only request to POST /api/connectors/diagnostics/check without opting in to custom connectors.
- Then: HTTP 200 resolves the built-in Reap target and does not disclose the custom connector ID.

## connector-check-022

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > redacts explicit custom diagnostics and reflects permission changes and selection precedence"
- Mode: run
- Given: An authenticated owner has an active Run with both a built-in Reap account and an admitted custom connector with Slack-based permission rules covering the same URL.
- When: The Run calls POST /api/connectors/diagnostics/check with the explicit custom target. The owner patches its chat:write grant to allow and the built-in write grant to deny. The Run repeats the explicit request and enables custom matching for the shared URL.
- Then: The explicit response names the exact custom target and base and marks it configured, available and network-boundary authorized, with a matched chat:write deny. It omits account credentials, IDs and private routing and header data. Subsequent checks report the updated allow, including the shared URL request with custom matching enabled.

## connector-check-023

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > refreshes the Chat account host after reconnection and definition changes"
- Mode: run
- Given: An active Run has an admitted custom HTTP account with a dynamic host variable. The owner reconnects the exact account with a new host and updates the definition path from v1 to v2 and its display name.
- When: The Run uses POST /api/connectors/diagnostics/check with the explicit custom target for the old and new hosts under v2.
- Then: HTTP 200 gives no-match at Run scope for the old host and resolves the new host and path, configured active base and updated connector label.

## connector-check-024

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > rejects an explicit custom connector created after the run was admitted"
- Mode: run
- Given: An authenticated owner creates a custom connector after an earlier Run has already been admitted.
- When: The existing Run uses POST /api/connectors/diagnostics/check with the new exact custom target.
- Then: HTTP 200 returns target-unavailable with the requested ID and reason not-admitted.

## connector-check-025

- Vitest: "POST /api/connectors/diagnostics/check > run-admitted custom connector diagnostics > reports an admitted custom connector as unavailable after deletion"
- Mode: run
- Given: An authenticated owner has a custom connector admitted to an active Run. The owner updates its prefix then deletes it.
- When: The Run calls POST /api/connectors/diagnostics/check with that exact custom target and the updated URL.
- Then: HTTP 200 returns target-unavailable with the requested ID and reason connector-unavailable.

## connector-check-026

- Vitest: "POST /api/connectors/diagnostics/check > reads a real registration and rejects diagnostics after normal Run cancellation"
- Mode: run
- Given: An authenticated Chat owner starts a normal live Run with its execution-provided Okou token and no configured GitHub account.
- When: The caller uses POST /api/connectors/diagnostics/check in environment mode for GH_TOKEN, then the owner cancels and completes the Run and the caller uses the original token again.
- Then: The live HTTP 200 response resolves the GitHub alias with available catalog visibility, network-boundary authorization, Run status not-configured and null permission. After normal cancellation the same request returns HTTP 404 NOT_FOUND Agent run not found.
