# user-templates

## user-templates-001

- Vitest: "user template owner routes > lists an empty catalog for a member with no templates"
- Mode: run
- Given: A signed-in member owns no user templates.
- When: The member lists user templates.
- Then: The API returns HTTP 200 and an empty array.

## user-templates-002

- Vitest: "user template owner routes > does not expose an unknown template through owner routes"
- Mode: run
- Given: A signed-in member provides an unknown well-formed template ID.
- When: The member reads, updates the title of, and deletes that ID.
- Then: Every request returns HTTP 404 with identical `NOT_FOUND` error and message `User template not found: <templateId>`.

## user-templates-003

- Vitest: "user template owner routes > resolves no assets for preview ids that match nothing"
- Mode: run
- Given: An authenticated member has a well-formed preview asset ID that matches no accessible template.
- When: The member requests preview URL resolution.
- Then: The API returns HTTP 200 with exactly `{ "assets": [] }`.
