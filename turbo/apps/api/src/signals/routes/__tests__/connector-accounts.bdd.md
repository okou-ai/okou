# connector-accounts

## connector-accounts-001

- Vitest: "connector account lifecycle routes > exposes canonical account resources without feature setup"
- Mode: run
- Given: An authenticated caller has no connector feature setup, and the requested account IDs do not exist.
- When: The caller reads an exact OpenAI account and GitHub account scope diff, lists connections with an invalid cursor, and posts an empty inspection to `/api/connector-accounts/inspect`.
- Then: Both exact reads return 404 with Connector account not found. The list returns 400 with Invalid connector account cursor. Inspection returns 200 with no results.

## connector-accounts-002

- Vitest: "connector account lifecycle routes > keeps OAuth setup and token markers separate through an exact non-default reconnect"
- Mode: run
- Given: An authenticated administrator has created an OAuth custom HTTP connector with a read scope, an OAuth token header template, and no configuration fields.
- When: The caller completes two OAuth account additions, tries to add a required Region field to the connector, reconnects the named second account by exact ID through OAuth, and attempts a manual values reconnect.
- Then: The first account is connected and default. The second is connected and non-default. Their configured and missing field lists are empty and the readbacks omit the OAuth client secret. Adding the field returns 400 with instructions to remove all fields and their template references, and leaves the account list intact. The OAuth reconnect preserves both IDs and the first account's default status. Manual values reconnect returns 400 directing the caller to authentication discovery.

## connector-accounts-003

- Vitest: "connector account lifecycle routes > keeps a stale saved default beside a reconnected healthy custom sibling"
- Mode: run
- Given: An authenticated owner has two accounts for a manual custom connector that requires an API key secret and a region variable. Both accounts originally supplied both fields.
- When: The owner reads the second account, increases the connector's storage version, reads the existing default, and reconnects the second account by exact ID with fresh values.
- Then: The initial second account is connected with both field keys configured. The default stays selected and reports reconnect-required with configuration_invalid, no configured keys, and both required fields missing. After reconnect, the list contains that stale default and the healthy second account at its original ID with both fields configured and nothing missing. Account readbacks omit the configuration values.

## connector-accounts-004

- Vitest: "connector account lifecycle routes > inspects exact account duplicates in request order after rename and deletion without leaking credentials"
- Mode: run
- Given: An authenticated owner has an API-token OpenAI account named Work.
- When: The owner posts to `/api/connector-accounts/inspect` with an unknown OpenAI ID, the owned OpenAI ID, the same ID for GitHub, and the owned OpenAI ID again. The owner repeats the inspection after renaming and then deleting the account.
- Then: Each inspection returns 200 in selection order. The first and third entries are unavailable. Initially the duplicate available entries report Work, API-token authentication, a connected state, no external identity or reconnect reason, and only the apiKey field name. Both reflect the rename. Deletion returns the exact ID and all entries then become unavailable.

## connector-accounts-005

- Vitest: "connector account lifecycle routes > accepts a dispatched Runner credential for account inspection"
- Mode: run
- Given: A dispatched Runner has a valid Run credential.
- When: The Runner posts an empty inspection to `/api/connector-accounts/inspect` with that credential.
- Then: The API returns 200 with an empty results array.

## connector-accounts-006

- Vitest: "connector account lifecycle routes > accepts one bounded inspection batch and rejects a larger one"
- Mode: run
- Given: An authenticated caller prepares repeated OpenAI selections for an unknown account.
- When: The caller posts 256 selections and then 257 selections to `/api/connector-accounts/inspect`.
- Then: The first request returns 200 with 256 results and the first entry unavailable. The second returns 400.

## connector-accounts-007

- Vitest: "connector account lifecycle routes > keeps default transitions exact and isolated across custom targets"
- Mode: run
- Given: An authenticated owner has two distinct custom connector definitions sharing an HTTP prefix. The first has Work as default plus Personal and Removed, and the second has its own default Other.
- When: The owner uses the exact account endpoints under `/api/connector-accounts` to try a mismatched default change, delete Removed, try making the deleted account default, search for Personal with a one-row limit, set Personal as default twice, and delete it.
- Then: Both invalid default changes return 404 with Connector account not found. Deleting Removed returns its ID, zero resolved selections, and no promoted default. Search still shows Work in the separate default field. Both valid default changes return Personal. Each list contains only its own accounts, exactly one default, and no secret values. Deleting Personal returns zero resolved selections and promotes Work, while the other connector keeps Other.

## connector-accounts-008

- Vitest: "connector account lifecycle routes > enriches the requested page and off-page default only when scope facts are requested"
- Mode: run
- Given: An authenticated owner has OpenAI accounts named Default and Sibling, with Default selected.
- When: The owner gets `/api/connector-accounts/connections` with search Sibling and limit one, once with and once without includeScopeMismatch.
- Then: Both requests return 200 with Sibling as the sole matching row and Default as the separate default projection. Both projections include scopeMismatch false when requested and omit it otherwise.

## connector-accounts-009

- Vitest: "connector account lifecycle routes > adds siblings and manages exact default and deletion lifecycle"
- Mode: run
- Given: An authenticated owner can add OpenAI API-token accounts.
- When: The owner adds and renames the first account to Work, reads its deletion impact, adds Personal, paginates one account at a time, tries an exact read under GitHub, and searches for a future renamed label. The owner renames Personal, sets it as default, reads both accounts and their deletion impact, then deletes Personal and repeats the reads.
- Then: The initial page contains default Work without a cursor and its impact reports zero selections and no sibling. Pagination returns two distinct IDs and default Work on each page. The wrong target returns 404. Search initially has no match and still reports Work. The renamed Personal account becomes default and is the sole search match without a next cursor. Both accounts report zero explicit selections and a sibling. Deletion returns Personal's ID, zero resolved selections, and promotes Work. Read and impact for the deleted ID return 404, and unfiltered and Work search pages report only default Work without a cursor. Work now has no sibling.

## connector-accounts-010

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across user boundaries for builtin accounts"
- Mode: run
- Given: An authenticated owner has a built-in OpenAI API-token account. A separate authenticated context is a second member in the same organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-011

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across organization boundaries for builtin accounts"
- Mode: run
- Given: An authenticated owner has a built-in OpenAI API-token account. A separate authenticated context is the same member acting in another organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-012

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across user boundaries for manual accounts"
- Mode: run
- Given: An authenticated owner has an account on a manual custom connector. A separate authenticated context is a second member in the same organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-013

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across organization boundaries for manual accounts"
- Mode: run
- Given: An authenticated owner has an account on a manual custom connector. A separate authenticated context is the same member acting in another organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-014

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across user boundaries for oauth accounts"
- Mode: run
- Given: An authenticated owner has an account on an OAuth custom connector. A separate authenticated context is a second member in the same organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-015

- Vitest: "connector account lifecycle routes > renames only exact owned accounts across organization boundaries for oauth accounts"
- Mode: run
- Given: An authenticated owner has an account on an OAuth custom connector. A separate authenticated context is the same member acting in another organization.
- When: The owner reads the account and deletion impact. The second context tries rename and deletion-impact for the known and random IDs. The owner tries a random ID and the owned ID with the wrong custom or GitHub target, then renames the owned account to Renamed and clears the name.
- Then: The original owned account is readable and its impact reports zero explicit selections and no sibling. All rejected rename and impact requests return the identical 404 NOT_FOUND body with Connector account not found. That leaves the owned readback intact. The valid rename and clear return 200 and exact reads reflect Renamed and then null.

## connector-accounts-016

- Vitest: "connector account lifecycle routes > keeps concurrent sibling creation to exactly one default"
- Mode: run
- Given: An authenticated owner has no existing OpenAI accounts and is adding two distinct account labels.
- When: The owner submits both OpenAI add grants concurrently and reads `/api/connector-accounts/connections` twice.
- Then: Both additions return 200. Both list responses contain exactly two accounts and exactly one default.

## connector-accounts-017

- Vitest: "connector account lifecycle routes > returns the default account outside the requested page"
- Mode: run
- Given: An authenticated owner has three no-auth accounts for a public MCP connector and has made an account outside the first two rows the default.
- When: The owner gets `/api/connector-accounts/connections` with limit one and includeScopeMismatch enabled.
- Then: The API returns 200 with the original first row, a cursor, and the exact off-page default account in a separate field.

## connector-accounts-018

- Vitest: "connector account lifecycle routes > more than one hundred accounts > paginates more than one hundred accounts"
- Mode: run
- Given: An authenticated owner has 101 no-auth accounts on a public MCP connector.
- When: The owner follows cursors from `/api/connector-accounts/connections` with a page limit of 23 until the listing ends.
- Then: Each page returns 200 and the collected account IDs are exactly the 101 created IDs.

## connector-accounts-019

- Vitest: "connector account lifecycle routes > more than one hundred accounts > searches display names across more than one hundred accounts"
- Mode: run
- Given: An authenticated owner has 101 no-auth accounts on a public MCP connector, one named Bulk 042.
- When: The owner gets `/api/connector-accounts/connections` with search Bulk 042 and limit 100.
- Then: The API returns 200 with exactly one connection named Bulk 042.

## connector-accounts-020

- Vitest: "connector account lifecycle routes > more than one hundred accounts > searches fallback names outside the first account page"
- Mode: run
- Given: An authenticated owner has 101 no-auth accounts on a public MCP connector. The target account is outside the first 23 rows and the owner has cleared its display name.
- When: The owner gets `/api/connector-accounts/connections` using the first eight characters of that account's ID as the search term.
- Then: The API returns 200 with the exact account and its null display name.

## connector-accounts-021

- Vitest: "connector account lifecycle routes > does not enumerate or mutate another member account"
- Mode: run
- Given: An authenticated member owns an OpenAI account. A second member is in the same organization and a separate context belongs to another organization.
- When: The second member searches `/api/connector-accounts/connections` by ID prefix and tries an exact read, inspection, and rename. The cross-organization caller also inspects the same ID.
- Then: The search returns 200 with no connections. The read and rename return 404. Both inspections return 200 with the selection unavailable. The unavailable item echoes the requested account ID and target.

## connector-accounts-022

- Vitest: "connector account lifecycle routes > projects no-auth custom HTTP accounts as connected without credential checks"
- Mode: run
- Given: An authenticated owner has defined a public custom HTTP connector that needs no authentication and has no configuration fields.
- When: The owner adds an account through the custom connector values endpoint with an empty values list. The owner lists the accounts and reads the new account by exact ID.
- Then: Adding returns 200. The sole account is the default and reports connected, auth method none, no reconnect reason, no missing required fields, and no configured field keys. The exact 200 account response equals the default projection.

## connector-accounts-023

- Vitest: "connector account lifecycle routes > projects no-auth custom MCP accounts as connected without credential checks"
- Mode: run
- Given: An authenticated owner has defined a public custom streamable HTTP MCP connector that needs no authentication and has no configuration fields.
- When: The owner adds an account through the custom connector values endpoint with an empty values list. The connector definition's storage version is subsequently increased. The owner lists the accounts and reads the new account by exact ID.
- Then: Adding returns 200. The sole account is the default and reports connected, auth method none, no reconnect reason, no missing required fields, and no configured field keys. The exact 200 account response equals the default projection.

## connector-accounts-024

- Vitest: "connector account lifecycle routes > supports exact lifecycle for custom HTTP accounts"
- Mode: run
- Given: An authenticated owner has a manual custom HTTP connector requiring a secret. The owner has added one unnamed account and a second account named Personal with different secrets.
- When: The owner lists and reads exact accounts, reads and lists connector definitions, inspects an exact account, and searches by the unnamed account's ID prefix. The owner renames Personal and makes it default, reads the projections and deletion impact, and then deletes each account.
- Then: The list initially has two accounts and one default. The exact detail and available inspection report a connected manual account with the configured secret field key and no missing fields. The fallback search includes the unnamed account. The rename is returned and the switched account list reports Personal as default. Definition detail and list retain the definition ID without exposing either secret before or after the switch. The impact reports zero selections and a sibling. Deleting Personal resolves zero selections and promotes the unnamed account. After deleting that remaining default, the list is empty.

## connector-accounts-025

- Vitest: "connector account lifecycle routes > supports exact lifecycle for custom MCP accounts"
- Mode: run
- Given: An authenticated owner has a manual custom streamable HTTP MCP connector requiring a secret. The owner has added one unnamed account and a second account named Personal with different secrets.
- When: The owner lists and reads exact accounts, reads and lists connector definitions, inspects an exact account, and searches by the unnamed account's ID prefix. The owner renames Personal and makes it default, reads the projections and deletion impact, and then deletes each account.
- Then: The list initially has two accounts and one default. The exact detail and available inspection report a connected manual account with the configured secret field key and no missing fields. The fallback search includes the unnamed account. The rename is returned and the switched account list reports Personal as default. Definition detail and list retain the definition ID without exposing either secret before or after the switch. The impact reports zero selections and a sibling. Deleting Personal resolves zero selections and promotes the unnamed account. After deleting that remaining default, the list is empty.
