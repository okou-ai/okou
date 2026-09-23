# Connector inspection JSON

Use `--json` to compose connector inspection with scripts and Agents:

```sh
okou connector search github --json
okou connector check --url https://api.github.com/repos/owner/repo --json
okou connector list --json
okou connector status github --json
okou connector custom list --json
okou connector custom status <selector> --json
```

An inspection result occupies all of stdout as one JSON value, without ANSI
formatting or appended guidance. Commands without `--json` keep their existing
human-readable output. Existing list/status JSON fields are preserved; new
identity fields are additive.

Selectors accept full slugs, custom UUIDs, and exact unique display names
within the command's supported connector types. Full identifiers take
precedence over names. Use `builtin:<slug-or-name>` or
`custom:<uuid-slug-or-name>` to disambiguate types; a remaining collision is an
error with explicit candidate identities. Custom UUIDs remain the stable
choice for automation. Selecting an alias preserves the canonical `target`
and the existing run-selected account in JSON.

## Identity and evidence

`target` preserves the stable identity: `{ kind: "builtin", connectorSlug }`
or `{ kind: "custom", customConnectorId }`. A connector's `connectorType` is
`builtin`, `custom-http`, or `custom-mcp`. Run inspection can retain a custom
target whose definition is no longer available: its `connectorType` is then
`null` and `definitionAvailable` is `false`. The target is never replaced with
a similarly named connector. Existing `kind` fields keep their original values.

Connection state, current Agent authorization, and run account availability are
different observations. A current grant does not prove that an account was
selected for an existing run. A reconnect-required account can still have
available metadata. Missing evidence is explicit (`null` or a discriminated
unavailable state), rather than being inferred from another account.

## Command contexts

| Command                        | Context and result                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`, `status` outside a run | `context: "current"`; current user/organization connector status and optional current Agent authorization. Existing connector fields remain available.                                                                                                         |
| `list`, `status` inside a run  | `context: "run"`; the existing run-account view, including its exact `connectionId`, account state, and metadata. Missing projection context remains `state: "unavailable"`.                                                                                   |
| `search`                       | Uses the same current/run distinction. `query` records the trimmed keyword and requested limit (`null` means no explicit limit); `total` counts all matches, `exactMatch` records the existing score threshold, and `connectors` retain rank order and scores. |
| `custom list`, `custom status` | Always `context: "current"`, including inside a run: these commands inspect organization definitions and optional current Agent grants. They do not report run admission.                                                                                      |
| `check`                        | `context` describes the CLI's current/run account view. `request` is the actual sanitized diagnostic request. The full server `diagnostic` separately reports its run scope, routing, and permission outcomes.                                                 |

Current discovery/status does not always have an exact account ID. It preserves
the metadata returned by that API and does not select an account to fill the
gap. Custom current results expose `connectionId` when their definition
response supplies it, otherwise `null`.

Run accounts retain the existing `available`, `metadata-unavailable`, and
`not-admitted` states. Search/check also retain `context-unavailable` with its
reason. A deleted account retains its exact ID. Search's `availableForRun` is
`null` when account context is unavailable; otherwise it follows the existing
account-availability column, including reconnect-required status. It is not an
assessment of a particular endpoint's permission policy. Search's `agent`
identifies the subject of current authorization inspection. Outside a run,
`--agent` selects that subject; inside a run, it must match the run's Agent.
This selector rule also applies to custom inventory despite its current context.

## Actions and diagnostics

Search's `actions` contain labels, exact URLs, and callback support. The usual
single-match and callback restrictions apply. Preserve returned action URLs,
including all query parameters.

Check emits the validated diagnostic without collapsing `deny`, `ask`,
`unavailable`, unknown endpoints, ambiguous targets, or missing run context.
The additional `connector`, `account`, `connection`, `authorization`, and
`environment` fields describe the corresponding available local/current
evidence. `account` is run-bound; `connection` is current-context data. Environment
entries contain only names and presence booleans, never values. URL userinfo is
rejected, and query strings/fragments are stripped before transport and output.

AWS URL checks may include a bounded `request.aws` selector object, supplied by
`--aws-service` with optional `--aws-action`, `--aws-target`, repeated
`--aws-query-param`, and repeated `--aws-header-present` CLI options. An action,
including a query `Action`, cannot be combined with a target. S3 header
selectors are limited to the allowlisted permission-selector names. These selectors classify the intended
operation only: they do not validate a SigV4 signature or send a request to
AWS. The raw URL query and fragment remain stripped. AWS rules that do not
match the explicit selectors remain unmatched and use the configured unknown-
endpoint policy. SigV4 credential, security-token, and signature query keys are
rejected. Other selector values are included in JSON and generated follow-up
commands, so never supply credentials or other secrets as selectors.

Check's `actions` contain commands, links, or guidance. Builtin permission
requests are offered only for denied/ask outcomes from a URL diagnostic.
Custom connectors retain their settings-based remediation; unknown custom
endpoints are not turned into builtin permission requests. Retry commands retain
the sanitized request selectors and JSON mode. Routing and permission results
describe intended state, not confirmation that the runner applied a later
update. Connector/account changes apply to future runs.

## Empty and error results

- Empty inventories and searches return empty arrays. Missing custom status
  returns `state: "unavailable"`, its requested target, and `connector: null`.
- A non-resolved check diagnostic remains a JSON result with the original
  outcome, an explanatory `message`, and a nonzero exit status. Missing custom
  status likewise exits nonzero. A resolved diagnosis that reports a denied
  permission keeps the existing successful diagnostic exit behavior; callers
  inspect its policy outcome.
- Computer Use retains its separate host/token guidance in a JSON result with
  `diagnostic.outcome: "not-a-connector"`.
- Argument validation, authentication, transport failures, and invalid API
  response contracts retain the existing stderr error boundary and nonzero exit.
  They do not fabricate an empty inventory or a successful JSON diagnosis.
