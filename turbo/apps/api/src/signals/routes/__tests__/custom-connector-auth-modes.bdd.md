# custom-connector-auth-modes

## custom-connector-auth-modes-001

- Vitest: "Custom connector authentication modes > publishes canonical Skill bundles for http connectors"
- Mode: run
- Given: An authenticated organization admin prepares a no-auth HTTP connector with Skill Markdown containing trailing whitespace and authored Unicode. Object storage accepts bundle publication.
- When: The admin creates the definition through POST /api/custom-connectors, reads it through GET /api/custom-connectors/:id, and repeats the identical definition as PUT /api/custom-connectors/:id after object storage becomes unavailable.
- Then: Creation returns HTTP 201 and detail returns HTTP 200 with the exact authored Markdown. Only one conditional archive creation reaches storage. Its content-addressed key matches its digest, and the archive contains the authored Skill. The identical update still returns HTTP 200 with the same Markdown.

## custom-connector-auth-modes-002

- Vitest: "Custom connector authentication modes > publishes canonical Skill bundles for mcp connectors"
- Mode: run
- Given: An authenticated organization admin prepares a no-auth MCP connector with Skill Markdown containing trailing whitespace and authored Unicode. Object storage accepts bundle publication.
- When: The admin creates the definition through POST /api/custom-connectors, reads it through GET /api/custom-connectors/:id, and repeats the identical definition as PUT /api/custom-connectors/:id after object storage becomes unavailable.
- Then: Creation returns HTTP 201 and detail returns HTTP 200 with the exact authored Markdown. Only one conditional archive creation reaches storage. Its content-addressed key matches its digest, and the archive contains the authored Skill. The identical update still returns HTTP 200 with the same Markdown.

## custom-connector-auth-modes-003

- Vitest: "Custom connector authentication modes > retains the current Skill after a failed bundle upload and allows a normal retry"
- Mode: run
- Given: An authenticated admin has a no-auth MCP definition with an original Skill. Object storage rejects upload of the revised bundle and later becomes available.
- When: The admin sends PUT /api/custom-connectors/:id for revised Markdown, reads the definition, retries that update and then clears the Skill with an explicit null.
- Then: The first update returns HTTP 500 and detail still contains the original Skill. The retry returns HTTP 200 and readback has the new Skill. Clearing returns HTTP 200 and detail reports null.

## custom-connector-auth-modes-004

- Vitest: "Custom connector authentication modes > rejects declared fields in http OAuth creation (required: true)"
- Mode: run
- Given: An authenticated admin prepares a HTTP OAuth connector with a member Region variable declared as required.
- When: The admin calls POST /api/custom-connectors and then lists the defined connectors.
- Then: Creation returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-005

- Vitest: "Custom connector authentication modes > rejects declared fields in http OAuth creation (required: false)"
- Mode: run
- Given: An authenticated admin prepares a HTTP OAuth connector with a member Region variable declared as optional.
- When: The admin calls POST /api/custom-connectors and then lists the defined connectors.
- Then: Creation returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-006

- Vitest: "Custom connector authentication modes > rejects declared fields in mcp OAuth creation (required: true)"
- Mode: run
- Given: An authenticated admin prepares a MCP OAuth connector with a member Region variable declared as required.
- When: The admin calls POST /api/custom-connectors and then lists the defined connectors.
- Then: Creation returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-007

- Vitest: "Custom connector authentication modes > rejects declared fields in mcp OAuth creation (required: false)"
- Mode: run
- Given: An authenticated admin prepares a MCP OAuth connector with a member Region variable declared as optional.
- When: The admin calls POST /api/custom-connectors and then lists the defined connectors.
- Then: Creation returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-008

- Vitest: "Custom connector authentication modes > preserves a http OAuth definition when explicit or inherited mode updates declare fields"
- Mode: run
- Given: An authenticated admin owns a HTTP OAuth connector without member fields.
- When: The admin tries PUT /api/custom-connectors/:id with an optional Region variable, once explicitly selecting OAuth and once inheriting the mode. The admin reads after each attempt and then updates the name without adding a field.
- Then: The field-bearing updates each return HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references and detail returns the unchanged original definition. The field-free update returns HTTP 200 with the same ID, the new name, no fields and the original storage version.

## custom-connector-auth-modes-009

- Vitest: "Custom connector authentication modes > preserves a mcp OAuth definition when explicit or inherited mode updates declare fields"
- Mode: run
- Given: An authenticated admin owns a MCP OAuth connector without member fields.
- When: The admin tries PUT /api/custom-connectors/:id with an optional Region variable, once explicitly selecting OAuth and once inheriting the mode. The admin reads after each attempt and then updates the name without adding a field.
- Then: The field-bearing updates each return HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references and detail returns the unchanged original definition. The field-free update returns HTTP 200 with the same ID, the new name, no fields and the original storage version.

## custom-connector-auth-modes-010

- Vitest: "Custom connector authentication modes > requires removing member fields when changing a http definition to OAuth"
- Mode: run
- Given: An authenticated admin owns a manual HTTP connector with a required region variable referenced by its Authorization template.
- When: The admin attempts PUT /api/custom-connectors/:id to OAuth while retaining the member variable, reads the definition and retries with an OAuth definition without member fields or their references.
- Then: The first update returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The original detail remains identical. The second returns HTTP 200 for the same ID in OAuth mode with no fields and storageVersion incremented by one.

## custom-connector-auth-modes-011

- Vitest: "Custom connector authentication modes > requires removing member fields when changing a mcp definition to OAuth"
- Mode: run
- Given: An authenticated admin owns a manual MCP connector with a required region variable referenced by its Authorization template.
- When: The admin attempts PUT /api/custom-connectors/:id to OAuth while retaining the member variable, reads the definition and retries with an OAuth definition without member fields or their references.
- Then: The first update returns HTTP 400 with the message that OAuth custom connectors cannot declare fields and must remove all fields and their template references. The original detail remains identical. The second returns HTTP 200 for the same ID in OAuth mode with no fields and storageVersion incremented by one.

## custom-connector-auth-modes-012

- Vitest: "Custom connector authentication modes > creates and reads a none connector without changing endpoint queries"
- Mode: run
- Given: An authenticated admin defines a streamable HTTP MCP connector using none authentication. Its endpoint query has repeated values, an empty value, percent-encoded input, a literal plus and a lowercase-encoded slash. Initial Skill is null.
- When: The admin creates through POST /api/custom-connectors, reads detail and list, then changes only the Skill through PUT /api/custom-connectors/:id and reads it again.
- Then: Creation returns HTTP 201 and reads and update return HTTP 200. The endpoint is identical byte for byte and the ID and none mode are preserved. The list matches initial detail. The update changes the Skill without incrementing the storage version and final detail matches the update. No OAuth configuration is present.

## custom-connector-auth-modes-013

- Vitest: "Custom connector authentication modes > creates and reads a manual connector without changing endpoint queries"
- Mode: run
- Given: An authenticated admin defines a streamable HTTP MCP connector using manual authentication. Its endpoint query has repeated values, an empty value, percent-encoded input, a literal plus and a lowercase-encoded slash. Initial Skill is null.
- When: The admin creates through POST /api/custom-connectors, reads detail and list, then changes only the Skill through PUT /api/custom-connectors/:id and reads it again.
- Then: Creation returns HTTP 201 and reads and update return HTTP 200. The endpoint is identical byte for byte and the ID and manual mode are preserved. The list matches initial detail. The update changes the Skill without incrementing the storage version and final detail matches the update. No OAuth configuration is present.

## custom-connector-auth-modes-014

- Vitest: "Custom connector authentication modes > creates and reads a oauth connector without changing endpoint queries"
- Mode: run
- Given: An authenticated admin defines a streamable HTTP MCP connector using oauth authentication. Its endpoint query has repeated values, an empty value, percent-encoded input, a literal plus and a lowercase-encoded slash. The OAuth definition contains a client secret and initial Skill.
- When: The admin creates through POST /api/custom-connectors, reads detail and list, then changes only the Skill through PUT /api/custom-connectors/:id and reads it again.
- Then: Creation returns HTTP 201 and reads and update return HTTP 200. The endpoint is identical byte for byte and the ID and oauth mode are preserved. The list matches initial detail. The update changes the Skill without incrementing the storage version and final detail matches the update. OAuth configuration preserves all public fields without exposing the client secret.

## custom-connector-auth-modes-015

- Vitest: "Custom connector authentication modes > creates and reads a automatic connector without changing endpoint queries"
- Mode: run
- Given: An authenticated admin defines a streamable HTTP MCP connector using automatic authentication. Its endpoint query has repeated values, an empty value, percent-encoded input, a literal plus and a lowercase-encoded slash. Initial Skill is null.
- When: The admin creates through POST /api/custom-connectors, reads detail and list, then changes only the Skill through PUT /api/custom-connectors/:id and reads it again.
- Then: Creation returns HTTP 201 and reads and update return HTTP 200. The endpoint is identical byte for byte and the ID and automatic mode are preserved. The list matches initial detail. The update changes the Skill without incrementing the storage version and final detail matches the update. No OAuth configuration is present.

## custom-connector-auth-modes-016

- Vitest: "Custom connector authentication modes > preserves host-only endpoints and query-only edits"
- Mode: run
- Given: An authenticated admin prepares a host-only MCP endpoint with a query and no explicit path.
- When: The admin calls POST /api/custom-connectors and then PUT /api/custom-connectors/:id to change only the query, including repeated tags, a valueless marker, encoded slash and literal plus.
- Then: Creation returns HTTP 201 with the exact host-only URL and generated hostname-derived slug. The update and read return HTTP 200 preserving the ID and slug with the exact updated query.

## custom-connector-auth-modes-017

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint http://mcp.example.test/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an insecure HTTP scheme.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-018

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://mcp.example.test:443:444/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing two port delimiters.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-019

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://mcp.example.test:65536/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an out-of-range port.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-020

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://127.0.0.1/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an IPv4 loopback host.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-021

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://[::1]/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an IPv6 loopback host.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-022

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://mcp.example.test/server?hl=en#fragment"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing a URL fragment.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-023

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://mcp.example.test/server?hl=en#"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an empty fragment marker.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-024

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://user:password@mcp.example.test/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing embedded user information.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-025

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://mcp.example.test/%2e%2e/admin?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing an encoded parent path segment.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-026

- Vitest: "Custom connector authentication modes > rejects unsafe MCP endpoint https://{{host}}.example.test/server?hl=en"
- Mode: run
- Given: An authenticated admin prepares a no-auth MCP connector with an endpoint containing a templated hostname.
- When: The admin submits POST /api/custom-connectors and lists the connector definitions.
- Then: Creation returns HTTP 400 BAD_REQUEST without echoing the submitted endpoint. The list returns HTTP 200 with no connector.

## custom-connector-auth-modes-027

- Vitest: "Custom connector authentication modes > keeps HTTP firewall prefixes query-free"
- Mode: run
- Given: An authenticated admin prepares a no-auth HTTP connector whose firewall prefix includes a query.
- When: The admin submits POST /api/custom-connectors.
- Then: The API returns HTTP 400 BAD_REQUEST.

## custom-connector-auth-modes-028

- Vitest: "Custom connector authentication modes > changes OAuth to none and back through public definition updates"
- Mode: run
- Given: An authenticated admin has created a streamable HTTP MCP connector in OAuth mode and chooses none as the next mode while keeping its endpoint.
- When: The admin calls PUT /api/custom-connectors/:id for none, switches to OAuth and reapplies OAuth, reading detail after each.
- Then: Every update and read returns HTTP 200 with the same ID and endpoint. Each read shows the requested mode. The none response omits OAuth configuration, and both OAuth responses restore the public configuration.

## custom-connector-auth-modes-029

- Vitest: "Custom connector authentication modes > changes OAuth to manual and back through public definition updates"
- Mode: run
- Given: An authenticated admin has created a streamable HTTP MCP connector in OAuth mode and chooses manual as the next mode while keeping its endpoint.
- When: The admin calls PUT /api/custom-connectors/:id for manual, switches to OAuth and reapplies OAuth, reading detail after each.
- Then: Every update and read returns HTTP 200 with the same ID and endpoint. Each read shows the requested mode. The manual response omits OAuth configuration, and both OAuth responses restore the public configuration.

## custom-connector-auth-modes-030

- Vitest: "Custom connector authentication modes > changes OAuth to oauth and back through public definition updates"
- Mode: run
- Given: An authenticated admin has created a streamable HTTP MCP connector in OAuth mode and chooses oauth as the next mode while keeping its endpoint.
- When: The admin calls PUT /api/custom-connectors/:id for oauth, switches to OAuth and reapplies OAuth, reading detail after each.
- Then: Every update and read returns HTTP 200 with the same ID and endpoint. Each read shows the requested mode. OAuth exposes its public OAuth configuration on every read.

## custom-connector-auth-modes-031

- Vitest: "Custom connector authentication modes > changes OAuth to automatic and back through public definition updates"
- Mode: run
- Given: An authenticated admin has created a streamable HTTP MCP connector in OAuth mode and chooses automatic as the next mode while keeping its endpoint.
- When: The admin calls PUT /api/custom-connectors/:id for automatic, switches to OAuth and reapplies OAuth, reading detail after each.
- Then: Every update and read returns HTTP 200 with the same ID and endpoint. Each read shows the requested mode. The automatic response omits OAuth configuration, and both OAuth responses restore the public configuration.

## custom-connector-auth-modes-032

- Vitest: "Custom connector authentication modes > removes an OAuth definition from public reads after deletion"
- Mode: run
- Given: An authenticated admin has created a streamable HTTP MCP connector in static OAuth mode.
- When: The admin sends DELETE /api/custom-connectors/:id, then GET /api/custom-connectors/:id and GET /api/custom-connectors.
- Then: Deletion returns HTTP 204. Detail returns HTTP 404 NOT_FOUND and list returns HTTP 200 with no definitions.
