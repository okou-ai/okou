# Model identity PR2: new writers and captured-runtime billing

This is release **2 of three**, following
[#38092](https://github.com/okou-ai/okou/pull/38092). Deployed API code selects
its writer behavior. There is no database switch, phase row, write-version
marker, normalization trigger, new feature switch or schema contraction.

## Writer ownership

- New member/default/reset and thread decisions persist nonempty `auto`, or an
  explicit personal model ID. Existing preference rows remain readable.
- Shared thread INSERT plans, integrations and workflow/automation creation and
  copy paths use the same canonical decision.
- Explicit null/`auto` intent means canonical Auto. An omitted send/PATCH field
  means no change, including an existing legacy nullable selection. Unrelated
  member updates do not overwrite selections.
- New thread creation events and newly resolved input annotations use the
  resolved selected identity. Consuming a captured PR1 decision preserves
  `okou-1.0`; SQL NULL for the entire input selection remains uncaptured.
- Unrelated event types do not acquire model fields. Failed/unresolved lifecycle
  records may remain incomplete.
- New effort-preference copies exclude Auto/legacy/preset keys while preserving
  explicit personal effort. Saved historical settings are not mass-normalized.
  Auto still rejects effort and Fast; public explicit `okou-1.0` stays rejected.

Runless inputs are selection decisions, not executable jobs. The existing
admission owner resolves execution once when creating the Run. After capture,
later org changes cannot replace the runtime, exact account/key or dialect.
Captured PR1 inputs are not relabeled as PR2 inputs when consumed.

## Execution and billing ownership

The existing launch owner captures runtime provider/model, the exact managed key
or personal account, credentials, dialect, transport, capabilities and billing
classification in Run metadata and its execution snapshot. Queued executable
snapshots, active jobs and late producers retain those captured values.

Canonical Auto usage identity comes from the captured runtime preset, never an
upstream response's model name, selected `auto`, the old catalog ID or today's
org default. The authenticated Runner boundary pins model observations to the
Run's immutable runtime identity. Incomplete canonical capture fails closed;
final preparation cannot fabricate a route from the current catalog.

New canonical Auto captures the inclusive long-context billing boundary of
**100001 total input tokens**. Retained legacy `okou-1.0` captures keep
**272001**. Already serialized execution configurations are not rewritten.
This classification change does not change runtime model capabilities or
OpenRouter transport. Luna fallback does not change a captured classification.

Personal subscription model usage remains outside platform model billing.
Tool/image/connector observations keep their existing owners and identities.
Pi memory Stage 1/Phase 2's fixed Luna maintenance binding remains independent
of foreground Auto. Historical usage and settled amounts are not converted.
PR1's repeated literal `'auto'` SQL grouping and result decoders are unchanged.

## Mixed-version matrix

| Producer / consumer                           | Contract                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 API -> PR2 API                            | Nullable member/thread preferences and captured legacy selections remain legal. No constraint is added before PR1 writers retire.                                                |
| PR2 API -> PR1 API                            | PR1 readers accept canonical selections, captured configurations and runtime-key observations. Execution creation and classification must also be validated across this overlap. |
| PR2 API -> pre-PR1 API/runtime                | Unsupported after canonical records are emitted; exclude these versions from serving and supported rollback before activation.                                                   |
| Supported clients -> PR1/PR2 API              | Nullable/explicit Auto intent, the legacy Auto catalog and nullable Auto choice remain compatible. Omission preserves personal selections.                                       |
| Captured job -> installed CLI/Pi              | Verify a PR1-capable installed execution path; Runner generation capability alone does not prove the CLI/Pi package in use.                                                      |
| Mixed native history -> supported API/runtime | Both Auto spellings remain the same family. Harness, genuinely different families and null boundaries remain distinct. Actual native/R2 restoration needs acceptance evidence.   |

Keep the legacy catalog/replacement lineage, nullable choice protocol and retained
configuration/history readers through the supported Web, Desktop, CLI and iOS
response window. A Web floor cannot close the CLI/iOS gate.

## Deployment evidence and remaining acceptance

Production release [run 37865772815](https://github.com/okou-ai/okou/actions/runs/37865772815)
was observed completed successfully during implementation, including API, App
Worker, CLI publication and x86_64 Runner promotion. Its rootfs verification
reported CLI 9.380.0 and installed manifest/entrypoint; the downloaded canonical
package reported Pi runtime 1.47.0 and contained the canonical Auto reader.

Those release/build/package facts do not establish every serving instance,
supported rollback target, installed consumer, fresh job package selection or
native-history/R2 restoration. Internal iOS TestFlight availability is not
proof that all supported installations upgraded; Desktop promotion was skipped.

Before promoting the writer, verify:

1. PR1-capable serving API/App, drained pre-PR1 instances and supported rollback.
   Database changes do not roll back with code; rollback below PR1 is unsupported
   after canonical records are emitted.
2. Fresh jobs' actual canonical package selection and installed CLI/Pi/rootfs,
   plus supported client readers rather than only the Web floor.
3. Both mixed native-history directions, same-family continuation and actual R2
   restore, through an authorized nonproduction lifecycle.
4. Successful canonical execution, runtime-key reporting, boundary behavior,
   immutable capture across org/account/key changes and old-job late reporting.

New Pi OpenRouter launches permanently use generation-5 Chat Completions after
#38096. Captured older Responses configurations retain their readers and their
captured dialect remains authoritative. No transport switch is restored.

## Verification boundary

Public writer/preference cases cover creation, explicit Auto, personal omission
and effort preservation, and unavailable execution. Core compatibility cases
cover both selected identities and the new/legacy boundary matrix. Pi protocol
and CLI Commander tests cover the retained captured configuration and client
intent contracts. Static checks are not deployed acceptance.

The existing native routing suite has unresolved claim/device-completion and
Auto launch failures, also observed on the original base; it is not green.
Its actual execution boundary and the deployed history/installed-consumer
acceptance above remain open. Do not replace those outcomes with private
business-state setup, mocks of internal services, sleeps or weakened assertions.

## Release 3 remains separate

[#38114](https://github.com/okou-ai/okou/issues/38114) owns justified historical
conversion, constraints, catalog retirement and compatibility removal after
verified producer, queue, installed-runtime, history and late-report drains.
This PR performs none of those. Elapsed time alone is not a removal condition.
