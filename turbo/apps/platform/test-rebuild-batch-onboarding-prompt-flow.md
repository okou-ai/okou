# Onboarding prompt, skills, and first-run flow

| File                               | Frozen rows | Selected and passing rows |
| ---------------------------------- | ----------: | ------------------------: |
| onboarding-prompt-connectors       |           6 |                         3 |
| onboarding-prompt-output-formats   |          56 |                        28 |
| onboarding-skill-import            |          12 |                         6 |
| onboarding-sources-first-flow      |          34 |                        17 |
| onboarding-sources-first-telemetry |           5 |                         3 |
| onboarding-start                   |           5 |                         3 |
| Total                              |         118 |                        60 |

The selected tests open the production Router with local fixtures. They verify
recommended connections and OAuth return, output-format defaults and explicit
response contracts, skill import and draft isolation, first-request continuity,
and analytics without prompt disclosure. The onboarding-start tests exercise
marketing event delivery and recovery without blocking the onboarding page.

The selected registration bodies retain their frozen actions and assertions.
Each GWT checklist entry points to its registration. The execution ledger maps
the selected IDs to the actual expanded Vitest rows in both directions.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before the BDD files
were removed.
