# Pi native provider consumer preparation

This records the reader/runtime/accounting preparation release for [#32803](https://github.com/vm0-ai/vm0/issues/32803), part of [#32795](https://github.com/vm0-ai/vm0/issues/32795). That preparation release did not admit a new production route or emit native model configs; the later writer is described under Shared route activation below. The controller owns independent acceptance, authorized publication and the subsequent activation child.

Release 7 retires the API-first foreground consumer, usage writer and handoff
mentioned in this dated preparation/activation ledger. Current foreground Pi
requests and usage belong to Sandbox/Runner; Stage 1 maintenance retains its
separate API worker. The receipts below describe the original rollout, not a
requirement to retain an API-first reader.

Current foreground routes are Auto (`okou-1.0` through the built-in
`openrouter-codex` Responses provider) and connected personal subscriptions.
Personal Claude subscriptions run in their vendor harness and are never admitted
to Pi; a personal Codex subscription may use Pi. None of these routes selects
the native Messages or Bedrock dialects described below; the generation 4
readers remain for already captured contexts.

## Two independent version axes

`PiModelConfig` generation 4 adds native Messages/SSE and Bedrock Converse/AWS event-stream readers. Generations 1, 2 and 3 keep their vocabulary, producers and behavior. Launch snapshot V3, Pi JSONL, memory admission, canonical owned-thread identity and source fencing are unchanged. An unknown model generation is left unclaimed; it is never coerced into a supported dialect.

| Consumer                                  | Prepared behavior                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API contract and stored execution context | Strict native protocol, logical catalog, exact endpoint, selected credential bundle, ownership and one-attempt policy     |
| Runner claim API                          | Requires generation 4 advertisement plus the exact native egress context; missing/older capability leaves the job pending |
| Runner environment                        | Generated DTO plus strict refinements; only selected opaque native credential markers enter the guest                     |
| CLI and shared Pi runtime                 | Materialize the same route; API resolves explicit credentials, sandbox supplies markers                                   |
| API-first and sandbox AgentSession        | Reuse native adapters, tools, history, thinking signatures, images, compaction and cancellation                           |
| API-first billing                         | Read all five active Claude logical models using the existing immutable usage identities and canonical prices             |

Normal producers remain in `pi-sandbox-config.ts` and their existing launch paths. The chat caller, internal connector queue callback and workflow launch all retain `shouldUsePiExecution` and the current shared selection behavior. No availability/alias, cohort, default, entitlement or feature switch changes are included.

## Native transport and credentials

The Messages reader accepts only the exact endpoints, credential headers and resource paths enumerated in [`pi-native.ts`](../turbo/packages/api-contracts/src/contracts/pi-native.ts). The adapter constructs thinking/output behavior from the trusted catalog and sends the captured upstream identifier only at the payload boundary. Official Claude OAuth/subscription credentials are rejected. No ambient Anthropic authentication is inherited.

Bedrock uses the pinned pi-ai adapter with a narrow typed `clientConfig` patch. The real AWS client receives the frozen region/endpoint, explicit bearer or SigV4 credentials, `maxAttempts: 1`, an owned request handler, and the caller cancellation signal. The client is destroyed on completion. Credentials are copied before passing to the SDK, which annotates credential objects. The shared agent loop is not copied.

The sandbox SigV4 client signs with fake markers; existing MITM `auth.awsSigv4` resolves and re-signs with real access key, secret and optional session token outside the guest. Bearer stays bearer. The compiled native firewall fixes one inference URL and the public-destination policy. API transport rejects redirects and validates the actual DNS addresses used by direct sockets; Runner enforces destination validation for proxied requests. Credential values are never embedded in the model contract.

## Accounting ownership

Native `input`, `output`, `cacheRead` and `cacheWrite` are disjoint provider quantities. The optional one-hour cache-create count remains a subset of cache creation and is never added again. Short cache retention preserves existing pricing; this change does not add TTL price categories or rewrite historical usage.

Foreground Sandbox provider calls use the proxy usage writer. Idempotent response/category identities are unchanged, including retries and late cancellation observations. Native user-owned credentials bypass Built-in model-token charges even if an obsolete billable marker is present. This does not waive tool, infrastructure or maintenance charges. Phase 2 keeps the #32626 proxy-only accounting path and its existing maintenance model/key owner; foreground native usage does not enter that path.

## Publication and activation gates

Follow [deployment compatibility](deployment-compatibility.md). Merge is not publication or native-route acceptance. Before the later activation child writes generation 4, independently verify all of these:

1. The preparation API is live and older API readers have drained. Retained API rollback targets must understand generation 4 and native Built-in usage before writers activate.
2. The selected Runner artifacts advertise generation 4 and pass strict native environment and existing MITM auth validation. Old Runners may remain but cannot claim generation 4 work.
3. Every CLI artifact that can be pinned in a new generation 4 sandbox reads this contract. A capable Runner paired with an old pinned CLI is not sufficient.
4. Existing generations, queued/stored contexts, API-first handoff, shared memory and Phase 2 billing remain healthy. Existing claimed guests retain the documented two-hour runtime plus bounded finalization window.
5. Activation connects shared policy/mapping/admission/writers only in the subsequent controller-owned issue. Rollback after activation must not select an API, Runner/CLI combination or retained artifact that cannot read already-written native contexts. Stop new native writers before any incompatible rollback and inventory queued/claimed work first.

There is no migration/backfill and no new permanent compatibility fallback. Existing Gen1/#31085 and #32783 compatibility debt remains under its existing owners and removal gates.

## Shared route activation (#33348)

The subsequent [activation child](https://github.com/vm0-ai/vm0/issues/33348)
connects the shared writer to the prepared consumers above. Preparation was
accepted at `31133fc7ba5eeecbc1c8a0cda32f16f1ff2b4602`; the controller's
[read-only publication receipt](https://github.com/vm0-ai/vm0/issues/32803#issuecomment-5627813459)
records compatible serving API, CLI and Runner releases and retained rollback
code. That receipt releases the implementation dependency. It is not a native
route live pass or permission for this child to publish.

Canonical owned-thread admission follows the route policy and runtime capability.
The same policy selection and launch writer serve direct chat, connector
callbacks, delegated inputs and Automation turns. Threadless/private maintenance,
test/replay and retired Goal admission remain outside foreground activation.
Provider `framework` values still describe the protocol family; they are not
rewritten to `pi`.

Every newly written generation 4 context requires a canonical `https://static.okou.io`, commit-addressed
CLI package from its API writer commit (`/okou-cli/<GIT_COMMIT_SHA>/package.tgz`).
The PR preview API checkout is explicitly aligned with the CLI head SHA; merge
groups and main keep their event SHA. Release promotion verifies the CLI artifact
at its release target before selecting it.
This narrowly rejects mismatched or mutable pins; it adds no deployment system
or compatibility fallback. Old/missing Runner capability remains unclaimed by
the existing reader. Already captured contexts keep their package and generation.

API-first native calls retain the API usage writer; subsequent sandbox calls use
the proxy writer. Foreground model tokens on user-owned credentials are not Built-in charges. Tools,
infrastructure and shared Stage 1/Phase 2 maintenance keep their existing pricing,
credential ownership and proxy-only Phase 2 accounting. No memory learner or
session format is copied.

This child ended at protected merge; the controller owns independent acceptance
and a separately authorized release and production verification.
