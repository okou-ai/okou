# Onboarding account, capabilities, and connection coverage

| File                          | Frozen rows | Selected and passing rows |
| ----------------------------- | ----------: | ------------------------: |
| onboarding-account-menu       |           3 |                         2 |
| onboarding-agentphone-tile    |           7 |                         4 |
| onboarding-capabilities       |          10 |                         5 |
| onboarding-chat-channels      |           9 |                         5 |
| onboarding-discord            |           4 |                         2 |
| onboarding-experience-connect |           4 |                         2 |
| onboarding-source-outcome     |           3 |                         2 |
| Total                         |          40 |                        22 |

The selected scenarios enter through the production Router and use existing
local fixtures. They cover keyboard settings entry and focus, iMessage code
availability and expiry, capabilities and draft continuity, channel connection
and revalidation, Discord authorization, subscription state, and responsive
source examples. The retained test bodies preserve the frozen actions and
assertions. Parameter tables register only selected input rows.

The GWT checklist records the original conditions, actions, and outcomes for
each registration. The execution ledger maps the actual expanded Vitest names
to each selected ID in both directions. Targeted Vitest, test TypeScript,
ESLint, and Oxlint passed before the corresponding BDD files were removed.
