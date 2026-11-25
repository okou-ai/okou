# dev-seed

## dev-seed-001

- Vitest: "buildBuiltInModelKeys > seeds the fake sentinel openrouter key when no OpenRouter key is configured"
- Mode: run
- Intent: review
- Given: The development seed script runs with no `DEV_MODEL_OPENROUTER_KEY` configured (vendor row `openrouter`).
- When: The seed builds its built-in managed model key rows and the `openrouter` rows are selected.
- Then: Exactly one row is built: `{ apiKey: <dev-seed sentinel managed model key>, label: "dev-seed sentinel", vendor: "openrouter" }`.

## dev-seed-002

- Vitest: "buildBuiltInModelKeys > seeds the fake sentinel openrouter-proactive key when no OpenRouter key is configured"
- Mode: run
- Intent: review
- Given: The development seed script runs with no `DEV_MODEL_OPENROUTER_KEY` configured (vendor row `openrouter-proactive`).
- When: The seed builds its built-in managed model key rows and the `openrouter-proactive` rows are selected.
- Then: Exactly one row is built: `{ apiKey: <dev-seed sentinel managed model key>, label: "dev-seed sentinel", vendor: "openrouter-proactive" }`.

## dev-seed-003

- Vitest: "buildBuiltInModelKeys > builds the openrouter key row from the development OpenRouter key"
- Mode: run
- Intent: review
- Given: The development seed script runs with `DEV_MODEL_OPENROUTER_KEY` set to `dev-openrouter-key` (vendor row `openrouter`).
- When: The seed builds its built-in managed model key rows and the `openrouter` rows are selected.
- Then: Exactly one row is built: `{ apiKey: "dev-openrouter-key", label: "dev-seed", vendor: "openrouter" }`.

## dev-seed-004

- Vitest: "buildBuiltInModelKeys > builds the openrouter-proactive key row from the development OpenRouter key"
- Mode: run
- Intent: review
- Given: The development seed script runs with `DEV_MODEL_OPENROUTER_KEY` set to `dev-openrouter-key` (vendor row `openrouter-proactive`).
- When: The seed builds its built-in managed model key rows and the `openrouter-proactive` rows are selected.
- Then: Exactly one row is built: `{ apiKey: "dev-openrouter-key", label: "dev-seed", vendor: "openrouter-proactive" }`.

## dev-seed-005

- Vitest: "usage pricing > provides synthetic Auto runtime rates in development only"
- Mode: run
- Intent: review
- Given: The development seed computes usage pricing for environment `development`.
- When: The model pricing rows for providers `@preset/okou-1-0` and `@preset/okou-1-0-dsf` are selected.
- Then: Each provider has exactly 16 `model` rows in order: `tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_creation`, then the same four with `.long_context`, `.fast` and `.long_context.fast` suffixes, each with `unitPrice` 1000 and `unitSize` 1,000,000.

## dev-seed-006

- Vitest: "usage pricing > provides synthetic Auto runtime rates in preview only"
- Mode: run
- Intent: review
- Given: The development seed computes usage pricing for environment `preview`.
- When: The model pricing rows for providers `@preset/okou-1-0` and `@preset/okou-1-0-dsf` are selected.
- Then: Each provider has exactly 16 `model` rows in order: `tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_creation`, then the same four with `.long_context`, `.fast` and `.long_context.fast` suffixes, each with `unitPrice` 1000 and `unitSize` 1,000,000.

## dev-seed-007

- Vitest: "usage pricing > rejects development seed for environment production"
- Mode: run
- Intent: review
- Given: The development seed is asked for usage pricing in environment `production`.
- When: The seed computes its usage pricing rows.
- Then: It throws an error containing "restricted to development/preview".

## dev-seed-008

- Vitest: "usage pricing > rejects development seed for environment test"
- Mode: run
- Intent: review
- Given: The development seed is asked for usage pricing in environment `test`.
- When: The seed computes its usage pricing rows.
- Then: It throws an error containing "restricted to development/preview".

## dev-seed-009

- Vitest: "usage pricing > rejects development seed for environment undefined"
- Mode: run
- Intent: review
- Given: The development seed is asked for usage pricing with no environment (row `undefined`).
- When: The seed computes its usage pricing rows.
- Then: It throws an error containing "restricted to development/preview".

## dev-seed-010

- Vitest: "usage pricing > seeds the complete gpt-image-2.5-flare image token schedule for preview"
- Mode: run
- Intent: review
- Given: The development seed computes usage pricing for `preview` (provider row `gpt-image-2.5-flare`).
- When: The `image` pricing rows for `gpt-image-2.5-flare` are selected.
- Then: The rows are exactly, in order: `tokens.input.text` 5000, `tokens.input.image` 8000 and `tokens.output.image` 30,000, each per 1,000,000 units.

## dev-seed-011

- Vitest: "usage pricing > seeds the complete gpt-image-2.5-sunburst image token schedule for preview"
- Mode: run
- Intent: review
- Given: The development seed computes usage pricing for `preview` (provider row `gpt-image-2.5-sunburst`).
- When: The `image` pricing rows for `gpt-image-2.5-sunburst` are selected.
- Then: The rows are exactly, in order: `tokens.input.text` 5000, `tokens.input.image` 8000 and `tokens.output.image` 30,000, each per 1,000,000 units.

## dev-seed-012

- Vitest: "usage pricing > seeds the Claude Opus 5.5 public token schedule"
- Mode: run
- Intent: review
- Given: The seed's static usage pricing table is loaded.
- When: The `model` rows for provider `claude-opus-5-5` are selected.
- Then: The rows are exactly, in order: `tokens.input` 4000, `tokens.output` 20,000, `tokens.cache_read` 200 and `tokens.cache_creation` 5000, each per 1,000,000 units.

## dev-seed-013

- Vitest: "usage pricing > seeds okou-1.0 from the local gpt-5.6-luna schedule"
- Mode: run
- Intent: review
- Given: The seed's static usage pricing table is loaded (row `okou-1.0` sourced from `gpt-5.6-luna`).
- When: The `model` rows for `okou-1.0` and `gpt-5.6-luna` are compared by category, unit price and unit size.
- Then: The `okou-1.0` rows equal the `gpt-5.6-luna` rows in order, and there are exactly 16 of them.
