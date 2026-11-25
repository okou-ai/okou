# registry-resources-download

## registry-resources-download-001

- Vitest: "registry resource download > keeps non-presentation resources off the current-template route"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin requests `GET /api/registry/presentation-templates/download?id=image-style:vm0-illustration`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND`.

## registry-resources-download-002

- Vitest: "registry resource download > reports an unpublished native PPTX package without substituting HTML"
- Mode: run
- Given: A signed-in workspace admin; the native PPTX template `template:pptx-schoolhouse-runbook` has no published current archive.
- When: The admin requests `GET /api/registry/presentation-templates/download?id=template:pptx-schoolhouse-runbook`.
- Then: The request returns HTTP 404 with exactly `{ error: { code: "NOT_FOUND", message: "Current archive for \"template:pptx-schoolhouse-runbook\" was not found" } }`, without substituting an HTML template.

## registry-resources-download-003

- Vitest: "registry resource download > rejects an unpublished presentation registry digest through the route"
- Mode: run
- Given: A signed-in workspace admin; the given SHA-256 digest for `template:html-ppt-schoolhouse-runbook` was never published.
- When: The admin requests `GET /api/registry/resources/download` with that ID and `expectedSha256`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND`.

## registry-resources-download-004

- Vitest: "registry resource download > rejects a reverse-template digest that was never published"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin requests `GET /api/registry/resources/download?id=skill:presentation-reverse-template` with an all-zero `expectedSha256`.
- Then: The request returns HTTP 404 with exactly `{ error: { code: "NOT_FOUND", message: "Registry resource \"skill:presentation-reverse-template\" is not private-pullable" } }`.

## registry-resources-download-005

- Vitest: "registry resource download > rejects registry resources that are not in the private archive allowlist"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin requests `GET /api/registry/resources/download?id=template:dashboard` with an all-zero `expectedSha256`.
- Then: The request returns HTTP 404 with error code `NOT_FOUND`.
