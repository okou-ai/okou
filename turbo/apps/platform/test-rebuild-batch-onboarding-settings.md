# Onboarding callbacks and settings rebuild

| File                   | Frozen rows | Selected and passing rows |
| ---------------------- | ----------: | ------------------------: |
| integration-onboarding |           8 |                         4 |
| onboarding             |           5 |                         3 |
| preference-settings    |           8 |                         4 |
| settings-dialog        |           8 |                         4 |
| settings-tab           |          18 |                         9 |
| settings-model-loading |           3 |                         2 |
| Total                  |          50 |                        26 |

The selected tests open the production Router with local fixtures. They cover
onboarding redirects and interrupted OAuth return, preference and schedule
recovery, locale precedence and workspace settings, avatar editing, agent
profile changes, and workflow preservation when deleting an agent. Model
loading exercises the settings entry point while its data is pending.

The retained registration bodies preserve the frozen actions and assertions.
The GWT checklist records each scenario, and the execution ledger maps actual
expanded Vitest names to the selected IDs in both directions, including the
nested preference suite. Targeted Vitest, the test TypeScript project, ESLint,
and Oxlint passed before the corresponding BDD files were removed.
