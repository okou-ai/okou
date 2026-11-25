# presentation-templates

## presentation-templates-001

- Vitest: "presentation template owner routes > lists the owner collection"
- Mode: run
- Given: An authenticated member has an empty personal presentation template collection.
- When: The member requests `GET /api/presentation-templates`.
- Then: The API returns HTTP 200 with an empty array.
