# Pi runtime architecture

This is the whole-system responsibility and compatibility map for
[#33519](https://github.com/vm0-ai/vm0/issues/33519). It describes execution and
memory boundaries consolidated by A–D, without defining a new harness,
route policy, wire format, or release gate. The linked source owns executable
behavior; the detailed contracts below own their respective implementation and
rollout rules.

> **API-first retired.** The API no longer executes Pi model turns. Every Pi
> run, including the first turn of a new thread, executes in the Sandbox. The
> Sandbox CLI starts a fresh session on a first turn or opens the session the
> Runner restored from `resumeSession`; no handoff manifest or startup record
> exists any more. The API-first executor, compaction preflight, usage observer,
> runtime ownership modes and continuation-only tracing have been removed.
> Dated rollout receipts below remain historical evidence.

## Authorities and dependencies

- [Pinned SDK integration](../turbo/patches/pi-pending-tools.md): Pi **0.87.1**,
  pending tools, cancellation, next-response preparation, and session fixtures.
- [Bash spool contract](../turbo/packages/pi-agent-runtime/bash-spool-backpressure.md):
  actual local-tool consumers, backpressure, interruption, and verification.
- [Deployment compatibility](./deployment-compatibility.md): independently
  deployed API/Runner/Sandbox, commit-addressed CLI, history, and memory readers.
- [Preparation timing](./pi-preparation-timing.md): bounded Sandbox session
  initialization observations, launch transaction/activation boundaries, and
  transport correlation.
- [Memory/citation provenance](../turbo/packages/pi-agent-runtime/src/memory-recall-upstream.md)
  and [delimiter boundary](./citation-delimiter-literals.md): canonical parser,
  derived text, historical reads, and upstream attribution.

```mermaid
flowchart TD
    Launch[API admission and captured launch] --> First[Sandbox launch with captured history]
    Launch --> Platform[Runner and Guest preheat]
    First --> Platform
    Platform --> CLI[CLI validates launch and opens official RPC]
    CLI --> Session[Foreground SDK session]
    Session --> Model[Shared model bootstrap and stream adapters]
    Session -->|native settlement| Platform
    Platform -->|events and checkpoint| Durable[API terminal and checkpoint effects]
    Durable --> Extract[Stage 1 settled-session extraction]
    Extract --> Jobs[API Phase 2 jobs and leases]
    Jobs --> Maintenance[Restricted sandbox consolidation]
    Maintenance --> Model
    Maintenance -->|validated mount and private marker| Durable
    Durable --> Recall[Frozen memory selection and read projection]
    Recall --> Session
```

Arrows describe calls or transfer of validated data, not shared cancellation or
accounting ownership. Pure route/policy/projection modules never import API
services or a command accessor.

| Responsibility                      | Source and dependency boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission and captured identity     | [pi-sandbox-config.ts](../turbo/apps/api/src/signals/services/pi-sandbox-config.ts), [agent-run-create.service.ts](../turbo/apps/api/src/signals/services/agent-run-create.service.ts), fence eligible sources and capture `piModelConfig`; every start uses the complete legacy launch. Authorization, queue-first input, account, credit, catalog and original API-clock owners are shared.                                                                                                                                                                                                                                                                                                |
| Route normalization and credentials | [execution-route.ts](../turbo/packages/pi-agent-runtime/src/execution-route.ts) normalizes supported carriers into the in-process `PiExecutionRoute`; [credential.ts](../turbo/packages/pi-agent-runtime/src/credential.ts) snapshots it before asynchronous materialization. The original wire remains authoritative for claim capability and telemetry. Credential references are captured; secrets are materialized only at the API or firewall execution edge.                                                                                                                                                                                                                           |
| SDK model boundary                  | [session-model.ts](../turbo/packages/pi-agent-runtime/src/session-model.ts) owns explicit resource-registry initialization, registered model description, and fixed `ModelRuntime` bootstrap. [model.ts](../turbo/packages/pi-agent-runtime/src/model.ts) owns catalog/transport adaptation and request guards.                                                                                                                                                                                                                                                                                                                                                                              |
| Session shells                      | [session-runtime.ts](../turbo/packages/pi-agent-runtime/src/session-runtime.ts) owns foreground settings, resources, tools, harness prompt, and captured run effort precedence. [phase2-memory.ts](../turbo/packages/pi-agent-runtime/src/phase2-memory.ts) owns the separate restricted session, caller/model arbitration, validation, and cleanup.                                                                                                                                                                                                                                                                                                                                         |
| API history inspection and export   | [session-memory.ts](../turbo/packages/pi-agent-runtime/src/session-memory.ts) adapts byte-backed history through official parsing, context and public-export helpers. It does not execute a provider turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sandbox execution                   | The [CLI loop](../turbo/apps/cli/src/lib/pi-agent-loop.ts) reads the captured launch, opens fresh or restored history and enters [rpc.ts](../turbo/packages/pi-agent-runtime/src/rpc.ts). [Guest Pi RPC](../crates/guest-agent/src/cli/pi_rpc.rs) owns transport and public settlement projection; the SDK owns tools and native input queues.                                                                                                                                                                                                                                                                                                                                               |
| Memory work and publication         | [Stage 1 worker](../turbo/apps/api/src/signals/services/pi-memory-stage1-worker.service.ts) owns extraction claims; [Phase 2 worker](../turbo/apps/api/src/signals/services/pi-memory-phase2-worker.service.ts) and [jobs](../turbo/apps/api/src/signals/services/pi-memory-phase2-job.service.ts) own durable leases. [Local filesystem boundary](../turbo/packages/pi-agent-runtime/src/phase2-memory-filesystem.ts) prepares/applies validated bytes; ordinary checkpoint publication owns durable Storage changes. [Maintenance completion](../turbo/apps/api/src/signals/services/pi-memory-phase2-maintenance.service.ts) observes the exact run/checkpoint, not a new Storage writer. |
| Public projection and accounting    | Guest projects public content/usage. [Stage 1 usage](../turbo/apps/api/src/signals/services/pi-memory-stage1-usage.service.ts), and Runner/proxy ingestion retain their separate request owners. Public token counters are not the billing journal.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Product model selection, SDK catalog identity, upstream request model,
credential/account owner, and billing owner are distinct.
The captured route carries that meaning through API and Sandbox; adapters do not
reselect a provider or infer a different account from a model name. Explicit
headers, firewall placeholders, subscription account binding, and
dialect-specific tier policy remain at their existing trust boundaries.

## Retired stable-context projection

The Pi stable-context projection (an owner-bound, generation-fenced cache of
the stable prompt and resource snapshot) never had a production reader and has
been removed. Run launch builds the stable prompt directly from the canonical
composers on every claim. Migration `1343_retire_pi_stable_context` dropped its
heads, artifacts, artifact resources and the Pi resource snapshot table.

Only the reserve-before-IO publication fence survives, in
[`storage-publication-fence.service.ts`](../turbo/apps/api/src/signals/services/storage-publication-fence.service.ts),
on the renamed `storage_publication_generations` and
`storage_publication_tokens` tables. Agent instructions and Workflow volume
writers reserve a generation and key/token before preparing an archive, so an
older, slower preparation cannot publish its Storage HEAD over a newer
reservation. See
[deployment compatibility](deployment-compatibility.md#pi-stable-context-tables-retired-2026-10-07).

## Launch through settlement

1. The API freezes the admitted route, source, session, resources and CLI artifact.
   Every Pi provider request runs in the Sandbox. Ordinary Runner capacity and
   the existing run/session transaction own admission.
2. Runner restores the selected native session when `resumeSession` exists.
   Otherwise the CLI creates empty canonical history. The CLI validates the
   captured launch and installed runtime contract before opening official RPC.
3. The SDK owns model requests, tools, compaction/retry, steering and follow-up
   queues, and awaited extension settlement. Guest owns stdin, cancellation ACK
   deadlines and process termination/reaping. Cooperative cancellation cannot
   undo external tool effects.
4. Guest/Runner deliver public events, proxy usage and the ordinary checkpoint.
   API terminal guards arbitrate completion and memory publication. Neither a
   callback nor a usage receipt creates a second terminal authority.

The former API provider-attempt/H1/recovery state machine is retired. Historical
sessions remain readable through the native session and export contracts; they
are not replayed by an API executor.

## Model failure diagnostics

The owned OpenAI Responses and Codex Responses fetch boundaries record the
last transport attempt's observed HTTP status, attempt count and optional
allowlisted failure reason. A bounded non-success body is classified before the
SDK rewrites it; successful response bodies keep their native streaming path.
Failed native assistant messages carry this evidence in `okou_model_request`.
Both stream iteration and `result()` expose the same diagnostic; sandbox usage
is recorded by the Runner proxy.

Request rejection and response-body read failure also retain optional
`transportFailure` before the SDK reduces the exception to display text. It
contains the observed `request` or `response_body` phase, whether the model caller's
signal was already aborted, and allowlisted exception names and direct/nested
Node or Undici codes. Causal inspection stops after four nested errors. It never
includes messages, stack traces, URLs, headers, bodies, addresses or raw causes.
Signal state reports the model caller, not an SDK-created timeout signal, and
does not establish user cancellation. SDK-owned timeouts that do not reject a
fetch/body read retain their existing timeout diagnostics. A bare `terminated`
result still cannot establish the original cause.

The response observer uses one demand-driven reader, forwards original bytes
and errors, propagates cancellation, and releases its reader on termination.
Evidence resets on every fetch attempt and is published only on a failed
assistant message; success and abort retain their existing lifecycle. Runner
terminal logs carry the same reduced evidence.
Semantic errors and non-fetch transports can legitimately omit it. Older Guest
readers ignore the additive field and current readers accept its absence; no
public reason token or database migration changes. Verify both the deployed CLI
and Runner artifact before attributing production diagnostics to this change,
then observe the exact failure signature in a bounded window. Historical errors
cannot be retrospectively diagnosed from the new fields.

Guest projects this evidence into the failed terminal result and optional
`FailureDiagnostic.modelRequest`. A failed retry records the attempt number and
limit from its native `auto_retry_start` event. A scheduled sleep does not count
as a completed retry. Native retry completion, successful assistant output and
settlement clear pending retry state; queued input and compaction do not inherit
an earlier retry budget. Aborted messages and tool results cannot supply model
HTTP evidence. Historical messages without this diagnostic remain supported.

Structured provider codes precede recognized terminal text and HTTP status.
At owned Guest terminal sources, a diagnosed provider refusal also precedes
native Codex credential-keyword heuristics: an opaque policy link containing
`invalid_api_key` does not change the cause. Actual structured credential codes
retain priority, and stderr keeps its existing native rules rather than gaining
refusal inference.
The original body distinguishes ordinary HTTP 429 rate limits from provider
account balance failures (`provider_insufficient_credits`) and subscription
usage limits (`usage_limit`), even when the SDK renders all three as a usage
limit. Platform credit admission retains `insufficient_credits`. Provider
billing classification requires an observed response, a typed provider event,
or a native API error prefix; bare billing JSON in terminal text is insufficient.
Public balance messages use the existing provider ownership contract, keeping
built-in provider billing details private.
HTTP 529 means overload; other 5xx statuses mean provider server failure.
Known streaming error text can classify an overload after HTTP 200. Unknown
formats remain unclassified, and bare HTTP 401/403 does not establish a specific
credential error. Shared fixtures keep these rules aligned with Codex and
Claude Code terminal classification; framework-specific states retain their
native classifiers.

Guest uses the allowlisted reason from the selected terminal
message before its display text. The Guest's public result carries it separately
from `modelRequest`, whose shape is unchanged. Older Guests ignore the additive
runtime field; newer Guests still accept messages without it. The open reason
token contract accepts additive API/Runner taxonomy entries without a database
migration.

A diagnosed `safety_policy_refusal` vetoes native assistant and summary retries
before generic text matching, even when the preserved provider link contains
HTTP-looking digits. It also stays out of automatic overflow/threshold compaction:
context-looking link text must not trigger summarization or replay. The
[pinned patch contract](../turbo/patches/pi-pending-tools.md#provider-declared-queue-expiry)
owns these narrow SDK guards; genuine context-overflow recovery is unchanged,
and no answer/tool/stderr classifier is added. Only the matching patched CLI
gains those guards. A newer Guest can classify an older CLI's terminal text,
but cannot undo retries or recovery the old SDK already performed.

A settled final Pi `length` response follows Pi's completed outcome: partial
assistant text stays in its event and becomes the public result, without a
synthetic `output_token_limit` failure. An empty answer remains empty; completion
does not assert that an answer is complete. Pi owns bounded truncated-response
recovery and refuses to execute truncated tool arguments before settlement.
Native tools and subsequent responses remain owned by the same sandbox session.
Existing API/Runner completion contracts already accept this success result, so
old and new consumers need no schema migration. Older Guests retain their former
length-failure behavior until upgraded; historical run statuses are not rewritten.
Retry budgets, cancellation, Runner logging rules and user-owned-provider
warning suppression are unchanged.

GPT 5.6 Luna and GPT 6 Luna have a product effort ceiling of `xhigh`. Migration
1317 removes `max` from their catalog routes and changes a `max` or omitted route
default to `xhigh`, including subscription routes. Both the composer choices and
API validation read that catalog; there is no separate frontend denylist. An
unavailable stored `max` preference resolves to the new route default without
rewriting the preference or a historical run. Already captured runs retain their
launch effort. Old clients that explicitly submit `max` receive the existing
unsupported-effort response and must refresh; rollback to an earlier application
does not restore the removed database catalog choice.

The exact failed-provider sentence "We were unable to start processing your
request within the 900-second timeout limit. Please try again later." is
`provider_queue_timeout`. Recognized SDK error envelopes and code prefixes are
accepted; generic timeouts, other durations and quoted successful output are
not. This reason refines generic server/overload evidence, while explicit
credential, billing, usage and context reasons keep precedence. Actual HTTP
status is retained, including a failed stream delivered with HTTP 200.

The pinned pi-ai patch vetoes further transport, native assistant and summary
retries for this result, including an upstream retry hint. Completed tools, failed history,
cancellation and independently accepted input retain native ownership. This
does not shorten the first provider wait or introduce a total run timer.
Presentation stays a generic failed run without a replay or model-switch action;
built-in completion warnings remain visible. See the
[patch contract](../turbo/patches/pi-pending-tools.md#provider-declared-queue-expiry)
for removal criteria.

## Shared bootstrap, distinct session policies

`createPiModelRuntime` receives the **already-resolved model**, captured stream
configuration, and caller-selected credentials/signal. It fixes
`allowModelNetwork: false`, `modelsPath: null`, and `refreshOnCreate: false`, then
registers that model. This disables model catalog networking/file discovery and
startup refresh; it does not disable the intended inference request or change
SDK registration's existing local refresh behavior.

| Entry                                     | Credential and cancellation policy                                                                             | Session policy                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed resource construction               | Explicit in-memory credentials and trusted settings.                                                           | Frozen resources feed the shared session constructor for the canonical prompt/tool digest; no API provider execution or separate session owner.                                                   |
| Other foreground Sandbox without snapshot | Omit explicit credentials, preserving the SDK's existing default store.                                        | File-backed production history, normal discovery, and captured run effort precedence.                                                                                                             |
| Restricted Phase 2                        | Explicit in-memory credentials; the exact input signal goes to ModelRuntime and `services.modelRuntimeSignal`. | In-memory session at fixed private cwd, restricted tools, no discovered extensions/skills/prompts/themes/context files, disabled retry/compaction, fixed reasoning, exact system-prompt equality. |

### Session construction digest

The shared session constructor supplies fixed frozen-resource profiles for the
committed prompt/tool digest. Frozen profiles disable extension, skill, prompt,
theme and context-file discovery and use trusted in-memory settings. The same
constructor serves sandbox sessions; there is no API-only preparation entry.
The former API-first construction benchmark and measurement script are retired.
Its earlier measurements are historical and do not establish current latency.

Model lookup and error classification stay with each caller. Phase 2 applies
[#33567](https://github.com/vm0-ai/vm0/issues/33567)'s existing maintenance-only
catalog correction **once**, then passes the same corrected model to registration
and session construction. Bootstrap never resolves it again. Foreground catalog
resolution remains unchanged.

Both callers explicitly initialize the shared session-resource registry at the
start of their existing shell, before their previous asynchronous preparation.
Its register/unregister pair ensures eager disposal works under Vite SSR; it
does not establish another resource lifetime. Service/session creation,
disposal, tools, settings, and resource loaders remain local to their owners.

The package's [root](../turbo/packages/pi-agent-runtime/src/index.ts) and
[/api](../turbo/packages/pi-agent-runtime/src/api.ts) expose Okou structural
types. [/node](../turbo/packages/pi-agent-runtime/src/node.ts) is the native
SDK/CLI boundary. The [public declaration checker](../turbo/packages/pi-agent-runtime/scripts/check-public-declarations.mjs)
walks the root and `/api` declaration closures and their resolved TypeScript
dependencies, rejecting upstream SDK leakage; `/node` is deliberately excluded.
Clean declarations do not mean the API implementation has no SDK dependency.
The internal bootstrap is not added to any public entry point.

API byte-backed history and Sandbox's official `SessionManager` have different
storage owners. The former uses exported parsing/migration/context helpers
without asking an SDK file loader to rewrite the source; the latter owns native
file persistence. `rpc.ts` synchronously validates UTF-8, structure, and identity
before `SessionManager.open` can migrate a file, then validates loaded entries
before traversal. A universal session factory would hide these distinctions.

## Extraction, consolidation, and reading

Stage 1 operates asynchronously on settled-session history. The API worker
authenticates/decompresses the source, excludes active or ineligible sources,
projects/redacts/truncates within its existing bounds, runs
[stage1-memory.ts](../turbo/packages/pi-agent-runtime/src/stage1-memory.ts), and
commits a candidate under its claim fence. Its work unit and usage owner are
separate from a foreground response and a Phase 2 storage consolidation.

Both stages use the platform-managed OpenRouter Chat Completions preset
`@preset/memory`, recorded under the private `okou-memory` identity. They never
select a member's Codex account. Cache breakpoints follow Auto's Anthropic-style
OpenRouter compatibility; `x-session-id` is `MEMORY-${userId}-${orgId}` for both
stages and all attempts. The preset owns reasoning, output ceilings and sampling:
only model, messages, tools (Phase 2), stream and stream usage options are sent.
Stage 1 retains local evidence budgets and JSON output validation without sending
a response-format override. Private metadata uses Auto's local model budgets;
the operator must configure a preset that supports those input/tool contracts.
An admitted attempt keeps its credential snapshot and existing errors/retries;
historical maintenance snapshots still drain unchanged. See
[deployment compatibility](deployment-compatibility.md#free-memory-preset-routing-2026-10-09).

The Phase 2 API worker claims a storage revision/base/selection and dispatches a
private maintenance run. It renews the **real database lease** against the
maintenance run/token. The local engine has no fabricated user/org identity,
heartbeat callback, lease scheduler, or database publication authority. It
snapshots owned bytes, stages a private workspace, executes the restricted SDK
session, validates outputs, awaits cancellation/settlement and cleanup, and
returns prepared bytes. There is no same-process Base64 transport roundtrip.

The mounted boundary authenticates the exact base and selection, rechecks path,
symlink, collision, immutable-file, size/hash and final identity constraints, and
applies only a validated result. CLI writes the private validation marker only
after that succeeds. Ordinary terminal artifact publication validates the marker
and ownership fences; [checkpoint receipts](../turbo/apps/api/src/signals/services/pi-memory-phase2-checkpoint.service.ts)
are recorded inside that commit transaction. Completion observes the exact
checkpoint/lineage/receipt; callback delivery alone proves none of these effects.

Recall freezes a Storage version and source identity per run. Shared
[memory-recall.ts](../turbo/packages/pi-agent-runtime/src/memory-recall.ts) and
[memory-recall-node.ts](../turbo/packages/pi-agent-runtime/src/memory-recall-node.ts)
authenticate the full source, then inject the bounded excerpt. Stored-summary
size and injected-summary token budget are distinct; their authoritative
reader/producer contract is in deployment compatibility. Memory tools retain
the frozen epoch and explicit ad-hoc-note request boundary. Local note staging
is not a durable checkpoint.

New preset memory is free: it neither checks nor consumes organization credits,
allowance windows or personal subscription quotas. Stage 1 retains token/cost
observations but creates no charge events; new Phase 2 contexts have no billable
firewalls or model pricing identity. Runtime Phase 2 usage remains evidence.
Stage 1's legacy usage writer and Runner/proxy accounting remain intact for
previously captured paid attempts; no historical prices or charges are rewritten. [Phase 2 usage binding](../turbo/apps/api/src/signals/services/pi-memory-phase2-usage.service.ts)
survives the existing execution/finalization drain for late proxy usage, including
failed/revoked attempts. The shared [model usage thresholds](../turbo/packages/api-contracts/src/contracts/model-price-tiers.ts)
and their [Python generation](../turbo/packages/api-contracts/src/python-bindings/generate.ts)
remain authoritative for API and [proxy classification](../crates/runner/mitm-addon/src/usage/providers/model_provider.py).
Existing pricing owners remain unchanged; public event fixtures do not replace billing classification,
raw usage, or compacted rollup reconciliation.

## Retained compatibility and retirement evidence

Versions below name different dimensions. A higher model generation does not
retire an older launch, resource, manifest, session, or persisted reader.

| Surface and actual consumers                                                                                                                                                                                                                              | Why retained                                                                                                                                                                                                           | Decisive gate and authority                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model carriers Gen1–Gen3 and Gen5: [runners.ts](../turbo/packages/api-contracts/src/contracts/runners.ts), route normalizer, [claim capability](../turbo/apps/api/src/signals/services/pi-model-config-claim-capability.ts), CLI and Runner readers       | Gen1 remains the canonical field-absent public Responses carrier. Gen2/3 dialect/tier are active contracts; Gen4 native was removed; Gen5 is the OpenRouter Chat Completions route that new OpenRouter launches write. | [#33966](https://github.com/vm0-ai/vm0/issues/33966) removes only the optional Gen1 wire `api` after the [September 14 readiness acceptance](https://github.com/vm0-ai/vm0/issues/31085#issuecomment-5660026283). Strict TypeScript readers reject the key; generated Rust DTOs no longer represent or retain it. Gen1, the active Codex dialect and SDK `Model.api` remain supported. |
| Launch snapshot V3, Pi launch config V2, private payload V1, maintenance input V1; API creation, Runner serialization and CLI parsing                                                                                                                     | Run identity and private inputs have their own strict schemas and captured lifetimes.                                                                                                                                  | Audit each writer/reader and all supported old/new pairs before changing its shape; [deployment compatibility](./deployment-compatibility.md) governs release, queue, process and rollback evidence. D changes none.                                                                                                                                                                   |
| Resource snapshots V1/V2; [runners.ts](../turbo/packages/api-contracts/src/contracts/runners.ts) schema, [resources.ts](../turbo/packages/pi-agent-runtime/src/resources.ts), shared session construction                                                 | V2 adds frozen recall; both snapshots still describe admitted immutable resources. B derives runtime types from these contracts.                                                                                       | Retire only with proof all captured contexts and supported readers/rollback paths use the replacement; schema numbering or absent sampled traffic is insufficient.                                                                                                                                                                                                                     |
| Retired API-first handoff and producer contracts                                                                                                                                                                                                          | Removed in Release 7; no current runtime reader.                                                                                                                                                                       | Historical rollout receipts and the explicit Release 7 rollback floor remain in [deployment compatibility](./deployment-compatibility.md).                                                                                                                                                                                                                                             |
| Commit-addressed CLI and queued/active contexts; API context writer, Runner launcher, CLI package                                                                                                                                                         | A current Runner can launch an older package frozen when a context was created. Semantic package version alone is not an artifact floor.                                                                               | Maximum queue plus claimed execution/finalization lifetime, complete old-context drain and supported external-caller audit, separately from Runner/Sandbox and rollback-target retirement. No blanket elapsed-time gate.                                                                                                                                                               |
| Session v3; byte-backed API adapter, SDK file reader, checkpoint/Stage 1/export readers                                                                                                                                                                   | Branches, compaction and pending tools must retain native meaning and source identity.                                                                                                                                 | [0.84.1/0.85.1 session fixtures](../turbo/packages/pi-agent-runtime/src/session-version-compatibility.test.ts) prove representative compatibility, not fleet drain or historical replay. Any replacement needs supported-reader and retained-history evidence, not just a newer SDK.                                                                                                   |
| Old-Guest raw citation bridge in [pi-memory-citation-events.ts](../turbo/apps/api/src/signals/services/pi-memory-citation-events.ts), called by [agent-webhook-events.service.ts](../turbo/apps/api/src/signals/services/agent-webhook-events.service.ts) | Older Guest events can need raw-envelope projection before structured provenance persistence.                                                                                                                          | [#31964](https://github.com/vm0-ai/vm0/issues/31964) alone owns bridge removal: successful #31959 API/Runner release, pre-release process drain through the two-hour budget plus bounded finalization, and sanitized structured output from retained rollback Runners.                                                                                                                 |
| Historical citation/text defenses and private provenance; API chat/Snapshot/search/callback reads, browser cache, raw-history export derivatives, [user-export.service.ts](../turbo/apps/api/src/signals/services/user-export.service.ts)                 | Immutable historical rows/blobs remain supported reads. User export still reads `piMemoryPublicationProvenance`; source JSONL is not rewritten.                                                                        | These are separate from the rollout-only old-Guest bridge. #31964 does not authorize removal. A later explicit historical-data/export contract would be required; [provenance note](../turbo/packages/pi-agent-runtime/src/memory-recall-upstream.md) and delimiter contract remain authoritative.                                                                                     |

At D's source review on 2026-09-12, #31085 and #31964 were OPEN with their
respective removal gates unresolved. That is historical evidence. The later
[#31085 readiness receipt](https://github.com/vm0-ai/vm0/issues/31085#issuecomment-5660026283)
and [#33966 dispatch ledger](https://github.com/vm0-ai/vm0/issues/33966#issuecomment-5660179289)
authorize the separate wire-field retirement; parent closure still requires
independent acceptance, release and production verification. #31964 remains
separately owned.

Creation snapshots retain only the bounded Pi generation classification. The
field-only `piModelConfigLegacyApi` classifier is retired. Historical Axiom
snapshots remain non-executable evidence: the existing unknown-record reader in
[run-context-snapshot.service.ts](../turbo/apps/api/src/signals/services/run-context-snapshot.service.ts)
continues projecting them into the public context response without exposing
internal classifications. Missing old observations remain unobserved. Retired
API-first outcome rows are historical records, not a current telemetry producer.

### Pinned patch inventory

[pnpm-workspace.yaml](../turbo/pnpm-workspace.yaml) pins the three actual 0.87.1
patches. The SDK version, dependency lock, and patch hashes were unchanged by D;
the later model-admission upgrade rebased all three patches onto 0.87.1.

| Patch / actual consumer                                                                                                                                           | Retained behavior and replacement evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [pi-agent-core](../turbo/patches/@earendil-works__pi-agent-core@0.87.1.patch): native loop/Agent reached through `rpc.ts` and `AgentSession.continuePendingTools` | Unresolved suffix execution without transcript replay; native ownership before ACK; joined tools/events, queue admission and cancellation reconciliation through sole settlement. Replace only with an upstream public API proving these same real-session/RPC contracts. The [SDK note](../turbo/patches/pi-pending-tools.md) owns the exact semantics.                                                                                                                                                                             |
| [pi-coding-agent](../turbo/patches/@earendil-works__pi-coding-agent@0.87.1.patch): AgentSession continuation and pre-response preparation                         | Await settlement extensions once while busy, flush native custom messages, retain `lastCompletedTurn`, and propagate cancellation through next-response compaction/auth/retry/preparation. Keep matching JS/declarations and cancellation/session fixtures until a pinned upstream replacement passes them. No new state machine or replay journal.                                                                                                                                                                                  |
| Same coding-agent patch: official local Bash tool, `OutputAccumulator`, shared child-process helper                                                               | Pace both pipes through spool drain and final flush; preserve caller timeout, abort, process cleanup, byte order, and complete-file success. `core/exec.js` still calls the helper without drain options; `AgentSession.executeBash` uses the independent executor. These supported callers justify optional helper arguments, not a claim that every executor is paced. Retirement requires the [real child/file spool regressions](../turbo/packages/pi-agent-runtime/bash-spool-backpressure.md) against an upstream replacement. |
| Same coding-agent patch: Photon import, image resizing, packed CLI worker/fallback                                                                                | Normalize the CJS default import while preserving worker and fallback behavior. [CLI bundling](../turbo/apps/cli/tsup.config.ts) ships the image worker and WASM. Removal requires verified upstream interop plus actual packed CLI image/worker/fallback execution; a source-only import check is insufficient.                                                                                                                                                                                                                     |
| [pi-ai](../turbo/patches/@earendil-works__pi-ai@0.87.1.patch): Codex Responses via `model.ts`                                                                     | Explicit selected `accountId` wins over JWT extraction. Current Okou binding remains mandatory; the upstream JWT fallback still serves SDK callers such as summarization auth paths that omit this additive option. Its comment names [#31373](https://github.com/vm0-ai/vm0/issues/31373): remove only after every supported caller supplies explicit identity and the recorded Runner/Sandbox drain passes. Closure of a delivery issue alone is not that caller proof.                                                            |

A bounded upstream follow-up is to provide supported unresolved-tool continuation
with native awaited settlement/cancellation and explicit provider/account
configuration matching these fixtures. No upstream issue or SDK release is a
prerequisite for this internal bootstrap consolidation.

## Historical disposition of the A–D recommendations

| Recommendation from #33519                                                    | Disposition and evidence                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove simulated Phase 2 orchestration                                        | **A delivered**, [#33521 / #33547](https://github.com/vm0-ai/vm0/pull/33547): local consolidation replaced fake identity/always-true heartbeat/observer machinery; unused API heartbeat export removed. Real database lease, checkpoint and cancellation owners remain.                                                                           |
| Remove local transport and redundant byte copies                              | **A delivered**: owned local bytes replace the Base64 roundtrip; synchronous input/prepared snapshotting and mounted revalidation preserve trust boundaries. No OOM cause or historical recovery claim.                                                                                                                                           |
| Canonicalize frozen route meaning and invalid combinations                    | **B delivered**, [#33556 / #33558](https://github.com/vm0-ai/vm0/pull/33558): `PiExecutionRoute`, discriminated dialect/auth types, one edge materializer, native placeholder construction, and route-based metadata/accounting inputs. Wire-generation branches remain for real claims and compatibility readers.                                |
| Share registry initialization and model registration description              | **A delivered**, with B's typed stream integration: `initializePiSessionResourceRegistry` and `registeredModelConfig` already lived in `session-model.ts`. D reuses them; they are not new D work.                                                                                                                                                |
| Share selection digest and resource contracts                                 | **A delivered** `phase2-memory-selection.ts`, consumed by API jobs/worker and local filesystem. **B delivered** `api-types.ts` aliases derived from existing resource/recall contracts. No duplicate encoder or schema is introduced by D.                                                                                                        |
| Separate API-first decisions from effects                                     | **C delivered**, [#33570 / #33580](https://github.com/vm0-ai/vm0/pull/33580): pure history/H1/recovery/terminal policy plus guarded effects. Preparation and effects intentionally remain adjacent because they share authenticated H0/launch identity; registration and lifecycle lock keep their own responsibilities.                          |
| Consolidate cross-language public events and billing policy where appropriate | **C delivered** fixed [public-event fixtures](../fixtures/pi-public-events.json) through real API/runtime/Guest producers; shared citation fixtures remain. API attempts and proxy accounting intentionally remain independent, with existing generated price/threshold contracts. Sharing public counters never creates a second billing writer. |
| Remove remaining identical SDK setup                                          | **D delivered**, [#33581](https://github.com/vm0-ai/vm0/issues/33581): one internal fixed ModelRuntime bootstrap takes the caller's resolved model and explicit credential/signal choice. Foreground and restricted session shells stay separate for the policies above.                                                                          |
| Document SDK adapters, compatibility readers, patches and ownership           | **D delivered** by this indexed overview and linked detailed authorities. Byte-backed API history, official file/RPC adapters, native pending-tool/cancellation patches, and historical exports are intentionally retained with actual consumers and gates above.                                                                                 |
| Avoid duplicate ownership and unbounded follow-ups                            | **Externally owned**: #31085, #31964, #33351/#33560, #33069, #32963, #33567 and model-aware effort work. D preserves their current code and does not claim context/summary/concurrency, recovery, OOM, admission or rollout completion.                                                                                                           |

A/B/C have independent controller acceptance recorded on the parent:
[A](https://github.com/vm0-ai/vm0/issues/33519#issuecomment-5636139079),
[B](https://github.com/vm0-ai/vm0/issues/33519#issuecomment-5638163894),
[C](https://github.com/vm0-ai/vm0/issues/33519#issuecomment-5640227662).
Those are dated code/verification records. D9, full EPIC acceptance, exact
authorized release inclusion and production verification remain the controller's
separate work; this document does not certify them. D introduces no migration,
backfill, historical replay, production rewrite, or new waiting gate between
code-only slices.

## Verification boundary

Use the real runtime session/model/Phase 2 tests, externally controlled provider
requests, temporary files, native RPC/cancellation tests, and session compatibility
fixtures. Retired API-only executor, preparation, projection, preflight and usage
observation tests are removed with their producers. Shared provider policies,
transport errors, sandbox tools and cancellation remain covered at their native
entry points.
Existing Phase 2 tests observe restricted tools/prompt,
abort/cleanup, and the corrected context's serialized output ceiling; they must
continue to catch re-resolution to the stale catalog. Foreground tests preserve
captured route/headers/account/tier and run effort. CLI loop and
API/Guest event consumers cover the neighboring edges.

Run affected formatting, types, lint, Knip, build/public declarations and required
CI. A bundle change also requires the actual packed CLI/Photon path. Keep one
local Vitest process at a time and bounded logs; use the repository's
[testing guidance](./testing.md). Record exact revisions and actual execution in
the PR, distinguishing unselected/skipped/environment-limited checks and older
fixture evidence from current-head passes. None of these local/CI checks is
production release or fleet-drain evidence.

## Model-aware foreground effort

Chat stores effort preferences per model in `model_settings`. At run admission,
normal sends, queued inputs, and workflow launches resolve the preference against
the selected runtime and concrete provider. An unsupported route choice falls
back to the route's `model_routes.default_effort` without rewriting the
preference. Claude's `extra` product label maps to Pi's `xhigh` level.

The effective preference is captured in `agent_runs.reasoning_effort` and applied
to the existing `piModelConfig.thinkingLevel` field before the execution context
is persisted. The Sandbox consumes the captured configuration.
When starting a new run from prior JSONL, the Sandbox appends a thinking
change if the captured level differs. Historical entries remain intact, and the
run keeps its captured level. Launches without a configured level
retain the SDK session/default behavior. Memory learning and consolidation keep
their own model binding.

`GET /api/run-models` lists Auto and the caller's connected personal
subscription models for the picker; server admission resolves the route again
when the run starts. This advisory response does not reserve a route. New API launch contexts select the corresponding
commit-addressed CLI containing the runtime change; queued execution contexts retain
the CLI and configuration they captured. API rollback does not rewrite stored effort
or history; this staff-only feature requires the updated API and CLI to honor changed
effort on resume.
The existing Pi model-config generations and Runner/Guest schemas are unchanged.
`Effort` gates reasoning effort and Fast, and `ModelPickerFlyout` gates the model
picker's layout. Pi admission follows the route policy and runtime capability.
