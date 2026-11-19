# Browser startup, address, and recovery rebuild

| File                       | Frozen rows | Selected and passing rows |
| -------------------------- | ----------: | ------------------------: |
| browser-discovery-startup  |          56 |                        28 |
| browser-response-deadlines |          55 |                        28 |
| browser-automatic-recovery |          77 |                        39 |
| browser-address-search     |          82 |                        41 |
| browser-viewer-interaction |         166 |                        83 |
| Total                      |         436 |                       219 |

The tests use the production Router with the existing local HTTP, CDP,
viewport, visibility, and recovery-clock fixtures. The selected rows exercise
initial discovery and scope changes, native and transport deadlines, recovery
without replay, address submission and paste handling, and the viewer's tab,
input, focus, and capture behavior.

For each selected frozen ID, the GWT checklist records the original conditions,
actions, and expected outcomes against the corresponding registration. The
rebuilt callbacks match the frozen callbacks after TypeScript AST printing,
including their assertions. Parameter tables contain only the selected inputs.
The execution ledger matches the 219 Vitest rows to the selection in both
directions. For address cases with line separators in their displayed Vitest
names, the ledger escapes those characters as `\r`, `\n`, and `\u2028`.

The local type check, targeted lint, and targeted Vitest runs passed. The five
BDD files were then removed. Main `d97fcb02` had no changes since the preceding
batch. The three `browser-session-page` cases 024, 025, and 034 retain their
BDD and earlier evidence.
