# connector-catalog

## connector-catalog-001

- Vitest: "GET /api/connector-catalog > returns 401 when not authenticated"
- Mode: run
- Given: The caller sends the request without authentication.
- When: The caller sends GET /api/connector-catalog.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-catalog-002

- Vitest: "GET /api/connector-catalog > returns 401 when the session has no organization"
- Mode: run
- Given: The caller is authenticated with no organization selected.
- When: The caller sends GET /api/connector-catalog.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-catalog-003

- Vitest: "GET /api/connector-catalog > returns public catalog metadata including posthog auth methods"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog and looks up the posthog entry.
- Then: The list returns HTTP 200 with public catalog data and no private metadata. The posthog entry contains method ID oauth, grant kind auth-code and supportsRefresh true.

## connector-catalog-004

- Vitest: "GET /api/connector-catalog > returns public catalog metadata including calendly auth methods"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog and looks up the calendly entry.
- Then: The list returns HTTP 200 with public catalog data and no private metadata. The calendly entry contains method ID oauth, grant kind auth-code and supportsRefresh true.

## connector-catalog-005

- Vitest: "GET /api/connector-catalog > returns public catalog metadata including monday-mcp auth methods"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog and looks up the monday-mcp entry.
- Then: The list returns HTTP 200 with public catalog data and no private metadata. The monday-mcp entry contains method ID automatic, grant kind automatic and supportsRefresh false.

## connector-catalog-006

- Vitest: "GET /api/connector-catalog > returns public catalog metadata including plaud-mcp auth methods"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog and looks up the plaud-mcp entry.
- Then: The list returns HTTP 200 with public catalog data and no private metadata. The plaud-mcp entry contains method ID automatic, grant kind automatic and supportsRefresh false.

## connector-catalog-007

- Vitest: "GET /api/connector-catalog > returns compact public connector metadata"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog.
- Then: HTTP 200 returns a nonempty catalog without private fields. OpenAI has label OpenAI, text generation, the llm tag and only its api-token API Key method with manual grant and no refresh. Its permission summary reports zero permissions and no categories or policy overrides.

## connector-catalog-008

- Vitest: "GET /api/connector-catalog > returns shared public icon descriptors across catalog views"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog, GET /api/connector-catalog/status and GET /api/connector-catalog/openai.
- Then: All return HTTP 200. OpenAI's public SVG icon has dark-mode inversion and the descriptor is identical in all three views. Slack's list icon uses its own SVG, no dark-mode inversion and scale 2.

## connector-catalog-009

- Vitest: "GET /api/connector-catalog > accepts an Okou run token carrying connector:read"
- Mode: run
- Given: A workspace admin has a credential for a normally dispatched run containing connector:read.
- When: The caller sends GET /api/connector-catalog with that Run token.
- Then: The API returns HTTP 200 with a nonempty connector list.

## connector-catalog-010

- Vitest: "GET /api/connector-catalog > returns 401 for catalog status when not authenticated"
- Mode: run
- Given: The caller sends the request without authentication.
- When: The caller sends GET /api/connector-catalog/status.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-catalog-011

- Vitest: "GET /api/connector-catalog > returns 401 for catalog status when the session has no organization"
- Mode: run
- Given: The caller is authenticated with no organization selected.
- When: The caller sends GET /api/connector-catalog/status.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-catalog-012

- Vitest: "GET /api/connector-catalog > returns bounded featured connectors and searches only slug or label"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/discovery with no filters, then with GITHUB as a keyword, then with a keyword found only in a description.
- Then: All return HTTP 200. Browse returns a nonempty public subset of at most 100 entries and a total at least as large. Every GITHUB result matches github case-insensitively in slug or label. The description-only search returns no entries.

## connector-catalog-013

- Vitest: "GET /api/connector-catalog > orders discovery by rank and gives every category its own slice"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/discovery with no category or keyword.
- Then: HTTP 200 provides each represented category's first slice of at most 12 entries and category totals at least as large as their slices. Each category is ordered by nondecreasing popularity rank with unranked entries last. The list excludes the five internal connectors checked by the suite.

## connector-catalog-014

- Vitest: "GET /api/connector-catalog > answers a named category with the whole category"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller browses GET /api/connector-catalog/discovery and then requests the category with the largest advertised total.
- Then: Both return HTTP 200. The scoped list contains exactly that total, only entries in the chosen category and nondecreasing popularity rank.

## connector-catalog-015

- Vitest: "GET /api/connector-catalog > returns public catalog status without private connector fields"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller reads GET /api/connector-catalog/status.
- Then: HTTP 200 returns no private fields. OpenAI has no single auth-code shortcut or connect notice and has the single non-refreshing api-token method with required password field apiKey labeled API Key, placeholder sk-... and no start options. Neon shows only api-token.

## connector-catalog-016

- Vitest: "GET /api/connector-catalog > returns 401 for one-click connectors when not authenticated"
- Mode: run
- Given: The caller sends the request without authentication.
- When: The caller sends GET /api/connector-catalog/one-click.
- Then: The API returns HTTP 401 UNAUTHORIZED.

## connector-catalog-017

- Vitest: "GET /api/connector-catalog > lists one-click connectors with connection status and without per-connector detail"
- Mode: run
- Given: An authenticated owner has completed GitHub OAuth on the published catalog.
- When: The owner sends GET /api/connector-catalog/one-click and GET /api/connector-catalog/status.
- Then: Both return HTTP 200 without private metadata from the one-click projection. The one-click slugs exactly match the status entries with at least one eligible grant kind. Its GitHub brief has the corresponding public name, description, icon, optional rank and auth methods, sole auth-code method oauth and null connect notice.

## connector-catalog-018

- Vitest: "GET /api/connector-catalog > returns connected manual grant status from public API-created state"
- Mode: run
- Given: An authenticated member has created a manual OpenAI connection using the public grant API.
- When: The member reads GET /api/connector-catalog/status and lists OpenAI accounts.
- Then: The public status returns HTTP 200 and includes openai without private metadata. The saved account readback matches its exact ID, api-token method, null external username and email, and null reconnect reason.

## connector-catalog-019

- Vitest: "GET /api/connector-catalog > returns connected auth-code status without exposing stored scopes"
- Mode: run
- Given: An authenticated member completes the GitHub auth-code OAuth flow.
- When: The member reads GET /api/connector-catalog/status and lists GitHub accounts.
- Then: The public status returns HTTP 200 with GitHub and single auth-code method oauth without leaking private metadata or stored scopes. The account readback has oauth method and the provider username.

## connector-catalog-020

- Vitest: "GET /api/connector-catalog > reports a normal empty provider grant without exposing scope storage"
- Mode: run
- Given: An authenticated member completes GitHub OAuth with a provider token response containing an empty scope string.
- When: The member reads GET /api/connector-catalog/status and lists GitHub accounts.
- Then: The callback reports success and public status returns HTTP 200 with github and no private metadata or scope storage. The account has auth method oauth and no reconnect reason.

## connector-catalog-021

- Vitest: "GET /api/connector-catalog > returns reconnect-required status for expired non-refreshable connectors"
- Mode: run
- Given: An authenticated member has successfully completed live Stripe CLI device authorization. The account was connected and has a non-refreshable credential with a known future expiration.
- When: One millisecond after expiry the owner sends GET /api/connector-catalog/status and reads the exact Stripe account.
- Then: Status returns HTTP 200 with Stripe public metadata and no private fields. The exact saved account reports auth method cli and reconnect reason credential_expired, while preserving the original token expiry timestamp.

## connector-catalog-022

- Vitest: "GET /api/connector-catalog > returns connector detail without leaking manual field storage names"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/openai.
- Then: HTTP 200 contains public metadata with the api-token field apiKey, labeled API Key, required, password-typed and with placeholder sk-.... Its private storage names are absent.

## connector-catalog-023

- Vitest: "GET /api/connector-catalog > returns exact connector metadata with the current connection status"
- Mode: run
- Given: An authenticated member already connected OpenAI using the manual grant API.
- When: The member sends GET /api/connector-catalog/openai.
- Then: The API returns HTTP 200 with slug openai and no private fields.

## connector-catalog-024

- Vitest: "GET /api/connector-catalog > omits auth text and placeholders derived from private names"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/parallel.
- Then: HTTP 200 omits descriptions and placeholders derived from private names. Its api-token method has null description and one required password field with public ID apiKey, label API Key and null placeholder.

## connector-catalog-025

- Vitest: "GET /api/connector-catalog > returns every visible connector detail without private metadata"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller lists GET /api/connector-catalog, then fetches the exact detail for every visible slug.
- Then: The catalog is nonempty, and every detail returns HTTP 200 with no private metadata.

## connector-catalog-026

- Vitest: "GET /api/connector-catalog > returns 404 for hidden connector catalog slugs"
- Mode: run
- Given: An authenticated member does not have the feature that exposes the test OAuth device connector.
- When: The member sends GET /api/connector-catalog/test-oauth-device.
- Then: The API returns HTTP 404 with message Connector catalog item not found.

## connector-catalog-027

- Vitest: "GET /api/connector-catalog > returns semantic public ids for device-auth start options"
- Mode: run
- Given: The test OAuth device connector feature is enabled for the authenticated member.
- When: The caller sends GET /api/connector-catalog/test-oauth-device.
- Then: HTTP 200 exposes only public data. Its method IDs are oauth and api in order. The API method's required select option has public ID environment and label Mode, defaults to test and offers test/Test and live/Live.

## connector-catalog-028

- Vitest: "GET /api/connector-catalog > returns the Neon API key method in connector detail"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/neon.
- Then: The request returns HTTP 200 and the method IDs are exactly api-token. Private fields are absent.

## connector-catalog-029

- Vitest: "GET /api/connector-catalog > shows Mercury OAuth without the API token method hidden from new connections"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/mercury.
- Then: The request returns HTTP 200 and the method IDs are exactly oauth, omitting the hidden API-token method.

## connector-catalog-030

- Vitest: "GET /api/connector-catalog > shows Stripe OAuth alongside the API token and CLI methods"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller sends GET /api/connector-catalog/stripe.
- Then: The request returns HTTP 200 and the method IDs are exactly oauth, api-token and cli in order.

## connector-catalog-031

- Vitest: "GET /api/connector-catalog > returns public permission detail from accepted firewall metadata"
- Mode: run
- Given: The caller is authenticated as a member of an organization with access to the published catalog.
- When: The caller requests GET /api/connector-catalog/notion/permissions and GET /api/connector-catalog/notion.
- Then: Both return HTTP 200. Permission detail identifies notion and matches the catalog icon. The positive permission count equals the list length. The first permission exposes no private firewall rules and the response has no private metadata.
