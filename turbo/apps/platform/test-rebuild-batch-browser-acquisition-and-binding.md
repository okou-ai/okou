# Browser acquisition, binding, and frame budgets

Main `d3772d88` was a release-only update with no Platform test additions.

| File                       | Frozen rows | Verified selected rows |
| -------------------------- | ----------: | ---------------------: |
| Browser viewer acquisition |           9 |                      5 |
| Browser viewer binding     |           6 |                      3 |
| Browser frame budgets      |           4 |                      2 |

- Acquisition checks Start with and without a correlated notice while
  follow-up reads are held, and tests whether an invalidated Start's ID still
  suppresses a later refresh. Reconnect uses a terminal protocol disconnect
  followed by the real Reconnect control. The replacement uses a different
  page session and can send input even though explicit opening is unavailable.
  A new grant likewise acquires its own native session after revocation.
- Binding keeps input disabled during a deferred native read. It verifies
  the replacement window excludes its sibling and that a new tab targets
  the replacement window. Two expanded rows change connection mode while
  socket opening and native attachment are pending, respectively.
- Frame budgets exercise a 48 MiB first encoded image and explicit recovery
  from a transport message that exceeds the envelope limit. The local CDP
  fixture supplies frames and errors without contacting external services.

All ten runtime rows match their selected IDs in both directions. The three
corresponding BDD files are removed. Standalone browser page `024`, `025`,
and `034` remain open under the previous evidence. The next related file is
`browser-frame-window`, with four selected rows.
