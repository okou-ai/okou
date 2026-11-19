# App rebuild snapshot delivery and preview boundaries

Main remained at `4bf10b89`. This round has no upstream test increment.
None of the five completed paths intersects the 72 mapping reviews
recorded in the upstream ledger. Previously recorded upstream additions
remain outside the frozen comparison.

| File                                  | Frozen executions | Registered and passed |
| ------------------------------------- | ----------------: | --------------------: |
| Shared conversation snapshot viewer   |                 4 |                     2 |
| Private shared conversation artifacts |                 3 |                     2 |
| Shared conversation diagrams          |                 1 |                     1 |
| Shared artifact fullscreen            |                 6 |                     3 |
| Chat JSON preview                     |                 3 |                     2 |
| This round                            |                17 |                    10 |
| All verified files so far             |                90 |                    51 |

The [execution ledger](test-rebuild-rebuilt-executions.tsv) records the
retained stable IDs and exact Vitest runtime registrations. All five
files passed focused Vitest and Oxlint before their adjacent BDD files
were removed. The cumulative verified reduction is 39 frozen executions
across 20 files. The final 30% gate uses the complete suite's actual
registered count.

## Observed coverage

- Anonymous snapshot sharing copies the complete stable reference. A
  later download uses newly authorized bytes and the original filename
  while the preview remains on the same fragment. The HTML snapshot
  preserves its slide fragment, restricted sandbox and origin referrer
  policy. The browser downloads through the authorized URL when the
  publication listing returns 403.
- Inside a signed-out shared conversation, the image, slides and video
  resolve to temporary preview URLs. File links and copied message text
  retain stable references. A denied reference displays unavailable
  previews without exposing those addresses as image or iframe sources.
- The shared diagram expands through the conversation's own action and
  downloads the locally rendered SVG. Native and fallback fullscreen
  retain their close controls, restore header focus, and keep a nested
  diagram independent of the surrounding document's fullscreen state.
- A private chat JSON attachment preserves the original spelling of a
  large integer. An incomplete byte-range response preserves the received
  text and disables the tree even when the prefix parses as JSON.

Next, continue with shared artifact routes and shared conversation
actions. The [first batch](test-rebuild-batch-one.md) still records
Ethan's review questions for the automation retry template and an invalid
hosted return address.
