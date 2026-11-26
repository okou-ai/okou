# org-openrouter-preset

## org-openrouter-preset-001

- Vitest: "lets a Debug administrator persist each allowed preset for the organization"
- Mode: run
- Given: A signed-in workspace admin has enabled the Okou Debug feature switch via `POST /api/feature-switches`; another admin of the same workspace and an admin of a different workspace also enable Debug.
- When: The admin reads `GET /api/org/openrouter-preset`, then for each allowed preset (`@preset/okou-1-0`, `@preset/okou-1-0-dsf`, `@preset/okou-experimental`) saves it via `PUT /api/org/openrouter-preset` and reads it back; the other two admins then read the preset.
- Then: The initial preset is `null`, and each saved preset reads back as saved. The same-workspace admin sees `@preset/okou-experimental`, and the other workspace's admin sees `null`.

## org-openrouter-preset-002

- Vitest: "lets a Debug administrator clear the preset for the organization and select it again"
- Mode: run
- Given: A Debug-enabled workspace admin has saved `@preset/okou-experimental`, and another Debug-enabled admin belongs to the same workspace.
- When: The first admin clears the preset with `PUT /api/org/openrouter-preset` `{ openrouterPreset: null }`; the second admin reads it, saves `@preset/okou-1-0`, and reads it again.
- Then: The clear returns `null`, the second admin reads `null`, and after saving reads `@preset/okou-1-0`.

## org-openrouter-preset-003

- Vitest: "denies reads and writes for role org:member with Debug true"
- Mode: run
- Given: A Debug-enabled admin has saved `@preset/okou-1-0`; an `org:member` of the same workspace has Debug enabled.
- When: The member reads `GET /api/org/openrouter-preset` and tries to save `@preset/okou-experimental` and `null`; then a Debug-enabled admin reads the preset.
- Then: The member's read and both writes return HTTP 403, and the admin still reads `@preset/okou-1-0`.

## org-openrouter-preset-004

- Vitest: "denies reads and writes for role org:admin with Debug false"
- Mode: run
- Given: A Debug-enabled admin has saved `@preset/okou-1-0`; another `org:admin` of the same workspace has Debug disabled.
- When: The second admin reads `GET /api/org/openrouter-preset` and tries to save `@preset/okou-experimental` and `null`; then a Debug-enabled admin reads the preset.
- Then: The read and both writes return HTTP 403, and the Debug-enabled admin still reads `@preset/okou-1-0`.

## org-openrouter-preset-005

- Vitest: "rejects unlisted presets and caller-selected organizations without changing the saved value"
- Mode: run
- Given: A Debug-enabled workspace admin has saved `@preset/okou-1-0`.
- When: The admin sends `PUT /api/org/openrouter-preset` with `@preset/not-allowed`, with `@preset/okou-experimental` plus `orgId: "org_another"`, and with `null` plus `orgId: "org_another"`, then reads the preset.
- Then: All three writes return HTTP 400, and the preset still reads `@preset/okou-1-0`.

## org-openrouter-preset-006

- Vitest: "requires authentication for both reads and writes"
- Mode: run
- Given: An unauthenticated caller, and a signed-in user without an active organization.
- When: Each calls `GET` and `PUT /api/org/openrouter-preset`.
- Then: All four requests return HTTP 401.
