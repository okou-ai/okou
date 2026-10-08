# max-signal-owner-lines

The chat pick and claim-context modules each own a complete declarative signal
graph. Counting every nested callback against the outer factory's 128-line
limit would require splitting the graph into signal-injecting factories, which
conflicts with the approved ownership boundary.

These two modules use `api/max-signal-owner-lines` instead of Oxlint's aggregate
`max-lines-per-function` check. The replacement still limits every operational
callback and ordinary function to 128 non-comment, non-blank lines.

Only the explicitly configured, top-level `createPickObjects` and
`createThreadClaimRunObjects` declarations can qualify as graph owners. A qualifying
owner contains only `const` declarations and a final object return. Its
initializers contain ordinary values or constructors imported from `ccstate`;
eager business calls, control flow, mutable declarations, and lookalike
constructors do not qualify. Each `computed` and `command` callback is checked
independently. Calls hidden in a `state(...)` initializer also disqualify the
owner.

This is a local replacement of the counting boundary, not permission to make
business callbacks larger or to skip cancellation, query, or command rules.
