# custom-connector-hostnames

## custom-connector-hostnames-001

- Vitest: "Custom connector hostname compatibility > rejects encoded joiner host xn--mgba3gch31f060k.example before creating a definition"
- Mode: run
- Given: An authenticated member prepares a manual HTTP connector with the encoded joiner hostname xn--mgba3gch31f060k.example in its HTTPS prefix.
- When: The member sends POST /api/custom-connectors.
- Then: The API returns HTTP 400 BAD_REQUEST mentioning hostname policy and the custom definition list remains empty.

## custom-connector-hostnames-002

- Vitest: "Custom connector hostname compatibility > rejects encoded joiner host xn--11b2ezcw70k.example before creating a definition"
- Mode: run
- Given: An authenticated member prepares a manual HTTP connector with the encoded joiner hostname xn--11b2ezcw70k.example in its HTTPS prefix.
- When: The member sends POST /api/custom-connectors.
- Then: The API returns HTTP 400 BAD_REQUEST mentioning hostname policy and the custom definition list remains empty.

## custom-connector-hostnames-003

- Vitest: "Custom connector hostname compatibility > preserves a usable definition when an encoded joiner update is rejected"
- Mode: run
- Given: An authenticated owner has a usable custom definition with a valid internationalized HTTPS prefix.
- When: The owner sends PUT /api/custom-connectors/:id to replace the prefix with the unsupported encoded joiner hostname, then reads the definition.
- Then: The update returns HTTP 400 BAD_REQUEST and the readback keeps the original prefix and display name.

## custom-connector-hostnames-004

- Vitest: "Custom connector hostname compatibility > rejects encoded joiner host variable xn--mgba3gch31f060k.example before saving an account"
- Mode: run
- Given: An authenticated member has a manual custom connector with required host template variable and plans to set encoded joiner hostname xn--mgba3gch31f060k.example.
- When: The member sends PUT /api/custom-connectors/:id/values and reads the custom connector accounts.
- Then: The write returns HTTP 400 BAD_REQUEST stating Value for variable host is not a valid custom connector hostname. The account list remains empty.

## custom-connector-hostnames-005

- Vitest: "Custom connector hostname compatibility > rejects encoded joiner host variable xn--11b2ezcw70k.example before saving an account"
- Mode: run
- Given: An authenticated member has a manual custom connector with required host template variable and plans to set encoded joiner hostname xn--11b2ezcw70k.example.
- When: The member sends PUT /api/custom-connectors/:id/values and reads the custom connector accounts.
- Then: The write returns HTTP 400 BAD_REQUEST stating Value for variable host is not a valid custom connector hostname. The account list remains empty.
