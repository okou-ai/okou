# For you updates in a678cec8

Compared `edb4d615` with [a678cec8 (#49200)](https://github.com/okou-ai/okou/pull/49200).
The product changes are integrated and `agent-suggestions` is rebuilt as
`agent-suggestions.test.tsx` (send and custom-direction paths) and
`agent-suggestions-deck.test.tsx` (feed, feedback and deck paths). The
frozen baseline is unchanged.

The [scenario ledger](test-rebuild-upstream-a678cec8-scenarios.tsv) records
each registration change. Five selected frozen IDs (-019, -020, -021, -022
and -037) map to the current in-card editor registrations and are counted
once under their frozen IDs. The eaae30ac additions they superseded add no
upstream executions. The removed eaae30ac addition 1143-01 is retired with
its registration.

Of the three new registrations, the per-file high-value rule selects two:
replying in a related chat without touching its saved draft (1244-01) and
sending standalone text after removing the quote (1032-01). Returning from
the related-chat choice to a new chat (1312-01) is not selected. Its new-chat
send is covered by the current paths of -019, -022 and -037. The temporary
scenario text was removed after verification.
