# Main test inventory through 596e8ca5

Compared main `c6085455` and `b964f017`. Only `596e8ca5` (#49268, retire
agent connector execution grants) changes Platform tests. It removes the
agent custom connector and user permission grant contracts, the agent grant
mock handlers and the agent fields on connector start requests. The
`UserPermissionGrantExpiresIn` and batch item types move to
`validators/user-permission-grants`, and grant fixtures use
`ConnectorPermissionFixture`.

The [scenario ledger](test-rebuild-upstream-596e8ca5-scenarios.tsv) lists
75 changed registrations in 26 Platform test files. 73 have modified bodies
with unchanged titles. One unselected scenario is renamed:
`chat-capability-connectors-015`, "Preserve an existing custom connector
permission during reconnection", becomes "Continue after connecting a custom
connector with permission metadata" because its existing grant premise is
retired. It stays unselected, so the range adds no upstream case.

## Rebuilt cases updated by the sync

The merge keeps each rebuilt case and applies the upstream intent. Cases drop
mocks of retired endpoints, negative checks on agent grants and agent request
fields, and the agent authorization fixture options. The current
registration lines are in the execution ledger.

| Change                                                                      | Rebuilt IDs                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent grant update or read mocks and their empty-grant checks removed       | `chat-capability-connectors-004`, `005`, `008`, `009`, `011`; `connectors-custom-001`, `022`; `custom-default-reconnect-010`; `directed-connect-page-004`, `008`, `009`; `directed-authorize-page-006`; `upstream-eaae30ac-directed-connect-page-924-01` |
| Agent ID and authorization fields no longer sent when starting a connection | `chat-composer-connectors-008`, `016`; `directed-connect-page-012`, `014`                                                                                                                                                                                |
| Agent authorization fixture options removed                                 | `chat-composer-connectors-001`, `006`, `011`; `chat-composer-connector-accounts-006`, `007`, `008`; `chat-composer-connector-status-001`, `006`; `chat-navigation-artifact-drive-008`, `009`, `010`                                                      |
| Grant fixtures typed as `ConnectorPermissionFixture`                        | `chat-capability-permissions-004`, `005`, `006`; chat batch and Markdown permission batch fixtures                                                                                                                                                       |
| Thread creation no longer sends connector selections                        | `chat-composer-ssh-009`, `014`; `prompt-link-005`                                                                                                                                                                                                        |
| Realtime connector changes use the `connector:changed` topic                | `realtime-005`                                                                                                                                                                                                                                           |
| The service client fixture reads an agent instead of its retired connectors | `fetch-002`, `003`, restored from the current `main` bodies                                                                                                                                                                                              |

## Retired premises

Twenty Given or Then items describe agent connector grants that #49268
removed: agent authorization of a connector, an empty grant after connection,
an absent authorization update, or an agent that stays unauthorized. Their
checklist rows are marked `covered-with-retired-premise`, and a note names
the retired phrase. The remaining outcomes of those items are still asserted.

## Verification

After the merge, Platform production and test TypeScript pass. The 76 test
files that changed upstream or use a changed shared helper pass with one
worker, 498 of 498 rows. ESLint and both Oxlint configurations pass on the
resolved files. The execution ledgers were re-anchored to the moved
registrations. Thirty older rows with stale lines were also corrected by
matching their recorded Vitest names.
