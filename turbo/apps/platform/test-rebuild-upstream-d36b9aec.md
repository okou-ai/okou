# Workflow tests on main d36b9aecf2b0

Compared with 4b72b660f827, one Platform test path changed. The other
changes in the comparison are runner scripts and API tests. Resolve the
modify/delete conflict by retaining this inventory and the frozen BDD
while clearing the incoming legacy test body.

| Frozen scenario IDs             | Incoming outcome                                                                                                                                               | Accounting                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| workflows-page-001 through -003 | Missing Automations detail redirects to Workflows with a toast and a remaining workflow link. Incoming coverage omits the Instructions and Info route entries. | Keep route-specific guarantees under review. The previous source decision for -003 stays recorded.                                      |
| workflows-page-007 and -008     | Open a hidden Official Workflow; the redirect shows the normal workflow list, including Ops Playbook and excluding the Official Workflow.                      | One incoming execution. Compare the two original list fixtures before credit.                                                           |
| workflows-page-012 and -023     | Open a deep-linked Gmail automation; the current encoding, focus, match summaries and schedule-only Next indicator are visible.                                | Summary moved into the deep-link case. Check that a normal non-deep-linked load still has a retained outcome where needed.              |
| workflows-page-028 and -029     | After entering a Gmail label, a provider 400 preserves the form and shows the provider failure. The original special 403 input was dropped from the matrix.    | Check the label-correction scenario workflows-page-027 before consolidating.                                                            |
| workflows-page-043              | Eligible user creates a webhook, sees its URL and secret, and can copy the available values. Incoming checks use scoped named fields and clipboard evidence.   | Retain webhook creation and output. Cross-check any field interaction that upstream removed against the remaining existing-secret flow. |
| workflows-page-058 and -059     | The file picker now exercises Enter and Space in one test. It closes and returns focus after activation.                                                       | Track one incoming execution and verify that the original per-key route, selection and aria assertions are covered before credit.       |
| workflows-page-068 and -069     | Standalone workspace browse and open rows were removed.                                                                                                        | Find retained workflow list and open route donors before credit.                                                                        |

The eight-row upstream decrease is a change to the incoming suite. The
confirmed frozen deduction remains unchanged by this reconciliation.
The two previously inventoried upstream additions remain separate.

[Incoming source](https://github.com/okou-ai/okou/blob/d36b9aecf2b0792b08b9f29b9f42b9eede169fd1/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx)
