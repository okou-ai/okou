# model-catalog-authority

## model-catalog-authority-001

- Vitest: "fixed Auto catalog authority > exposes canonical Auto without a provider chooser"
- Mode: run
- Given: An ordinary authenticated workspace member can read the model catalog.
- When: The member requests the catalog.
- Then: The API returns HTTP 200 with `private, no-store`, system default Auto, Auto first in the models list and exactly one enabled built-in route.

## model-catalog-authority-002

- Vitest: "fixed Auto catalog authority > projects shared Fast usage and Pi capability for independently shipped clients"
- Mode: run
- Given: An authenticated member can read shared model capabilities.
- When: The member reads the model catalog.
- Then: HTTP 200 exposes Sol’s Fast ChatGPT usage multiplier of 2.5, marks Sol’s Codex OAuth route Pi-capable and marks all Claude Code OAuth routes as not Pi-capable.
