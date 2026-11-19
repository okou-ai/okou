# App rebuild sample and first verified files

The sample uses the Email updates switch in the real Preference route
and the selected scenario `email-subscription-settings-002`. A typed
HTTP fixture withholds the first save and returns 500. The UI disables
the switch for that request, retains the previous unchecked value when
it fails, and enables another attempt. The second user click saves the
preference and the real reload paints the checked state. The other
selected email case asserts delivery unavailability while the saved
preference remains checked.

## Testing review

- The production Router opens the real entry, with initial state supplied
  by typed API responses and no direct writes to app state.
- The test clicks the visible switch. It waits for observable transitions
  and does not drive the app from a polling callback.
- Failed and successful saves share one external HTTP contract. A
  case-owned deferred response exposes the pending state without sleeps.
  The retry changes the response to the next read so the assertion
  depends on a committed preference.
- The error currently presents as the control returning to its prior
  value and becoming available again. The scenario does not require
  error copy or an alert that the product does not render.

Ethan review points remain on the [testing pattern](test-rebuild-pattern.md):
does this preferences retry establish the desired template before using it in
the automation card, and should the hosted-site boundary retain one explicit
invalid return destination? The latter is outside the current five selected
cases for that file. The first batch continued with reversible independent work.

## Verification and accounting

| File                        | Frozen executions | Vitest registrations and passes |
| --------------------------- | ----------------: | ------------------------------: |
| Email subscription settings |                 3 |                               2 |
| Email unsubscribe           |                 3 |                               3 |
| Hosted-site access          |                10 |                               5 |
| Banking connect return      |                 2 |                               1 |
| Onboarding invite redirect  |                 2 |                               1 |
| Total                       |                20 |                              12 |

[Collected execution map](test-rebuild-rebuilt-executions.tsv) ties the
12 registrations to their retained frozen IDs. Vitest 5.1.0 collected
these counts with `vitest list --json`. The four-file run passed 11
tests, then a separate one-file onboarding run passed its test. The
email unsubscribe implementation was already on the Draft and was
revalidated in the batch. Each completed file's adjacent temporary BDD
was retired. Original frozen behavior and selection remain recoverable
through the baseline and the selection commit.

The verified files remove eight frozen executions locally. This count
does not extrapolate to the remaining suite. Reconcile the pending
upstream identity and entry-point questions before rebuilding the
affected connector files. For the next batch, start with the standalone
permission approval entry and its explicit continuation outcomes, then
the hosted artifact and shared-thread entry points.
