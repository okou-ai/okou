# Browser authorization, navigation, and CDP rebuild

| File                       | Frozen rows | Selected and passing rows |
| -------------------------- | ----------: | ------------------------: |
| browser-authorization-page |           6 |                         3 |
| browser-authorization-card |           8 |                         4 |
| chat-browser-shutdown      |           5 |                         3 |
| chat-navigation-browser    |          36 |                        18 |
| Browser CDP client         |          13 |                         7 |
| Total                      |          68 |                        35 |

The page tests retain the selected frozen test bodies and enter through the
production Router with local fixtures. The CDP client tests enter through
its production connection and exercise a local socket fixture to verify
response deadlines, connection ownership, and attachment cleanup. The selected
IDs match the Vitest expansion in both directions for all five files. The
GWT checklist and execution ledger link each original scenario to its verified
registration.

## Chat capability browser actions

All 13 previously ledgered rows ran and passed again. They are counted in the
existing execution ledger. The existing runtime titles for 002 and 003 differ
from the frozen titles, and the ledger retains the explicit ID mapping.

Case 001 is partially verified. The active session and initial screenshot are
provided through the local browser fixture, and the rendered card exposes
Cloud browser, Live, the expected accessible name, and the thumbnail. Its second
Then still requires rendered-browser evidence for a 1 px top border, transitions
for background color, border color, and transform, and a 16 px status line
height. The local Router test does not load the generated stylesheet. Production
component declarations show the intended utilities, which do not establish
computed output. The BDD remains in place and this file is excluded from the
five file completions.

Main `d97fcb02` had no changes since the previous batch. The separate
`browser-session-page` cases 024, 025, and 034 remain documented.
