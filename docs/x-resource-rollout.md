# X resource rollout evidence

[#35156](https://github.com/vm0-ai/okou/issues/35156) qualifies the producer and
consumer against shared examples. [#34615](https://github.com/vm0-ai/okou/issues/34615)
remains responsible for deployed verification and separately authorized
deduplication rollout. [#35197](https://github.com/vm0-ai/okou/issues/35197) replaces
date-based activation with the standard `xResourceDeduplication` feature switch.
That change does not enable the production switch, and this document records no
production acceptance.
The [ingestion contract](./x-resource-observations.md) remains authoritative:
one upstream billing account, global daily resource identity, today and yesterday
in UTC, and ordinary net usage without a user-visible deduplication status.

## Repeatable repository qualification

The shared [fixture](../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/x-resource-observations.json)
contains upstream responses and literal expected webhook payloads. The
[Python test](../crates/runner/mitm-addon/tests/test_x_resource_contract.py)
drives registry admission, request/response hooks, parsing, buffering and HTTP
serialization, with external authentication/delivery and observation time
controlled by the test. It compares the complete payloads, including source
UUIDs, counts, exact IDs, timestamps and remainder. Repeated terminal hooks must
not produce another delivery.

The [TypeScript contract test](../turbo/packages/api-contracts/src/contracts/__tests__/x-resource-producer.test.ts)
parses those same payloads without changing their contents. The
[API integration test](../turbo/apps/api/src/signals/routes/__tests__/webhooks-x-resource-producer-contract.test.ts)
uses the payloads through the usage webhook and verifies resulting usage through
public endpoints against real PostgreSQL. Its isolated identity and clock mapping
covers source replay, a new operation in another organization, remainder charging,
post/user namespaces, next-day charging and expired replay.

Together these tests detect disagreement between both sides of the wire
contract. They do not launch a deployed Rust/Python/API chain or contact X, and
do not establish fleet, account, delivery, performance or rollout readiness.
The Crates shared-input selector runs the existing addon checks for fixture-only
changes. The fixture is also an explicit API test input in Turbo, so changing it
invalidates cached API test results without invalidating production builds.

Use the pinned [addon environment](./testing/mitm-addon-testing.md#environment-setup).
From the repository root, with workspace dependencies installed and
`DATABASE_URL` pointing to a migrated, disposable local PostgreSQL database:

```bash
uv run --project crates/runner/mitm-addon --no-sync python -m pytest \
  crates/runner/mitm-addon/tests/test_x_resource_contract.py -q
pnpm --dir turbo --filter @okouai/api-contracts test \
  src/contracts/__tests__/x-resource-producer.test.ts
pnpm --dir turbo --filter api test \
  src/signals/routes/__tests__/webhooks-x-resource-producer-contract.test.ts
```

Keep the existing resource suites in the qualification record as well:

| Boundary                                                          | Existing coverage                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claim-time capability                                             | `runner-x-resource-capability.test.ts`, `test_x_resource_capability.py`                   |
| Complete responses, stream failures and UTC midnight              | `test_x_resource_observations.py`, `test_x_resource_stream_failures.py`                   |
| Batch limits, retry identity, saturation and expiry               | `test_x_resource_usage_transport.py`                                                      |
| Atomic global billing, concurrent uploads and lifecycle admission | `webhooks-x-resource-usage.test.ts` and adjacent `webhooks-x-resource-*` lifecycle suites |
| Two-date cleanup, batch bound and writer exclusion                | `cron-cleanup-x-resource-reads.test.ts`                                                   |

Record the tested commit, exact commands and results in the PR. A passing CI
run proves only the checks and commit that it actually executed.

The switch tests cover both states, transitions and source replay. Disabled
observations still reach the usage ledger at quantity Q and record their resource
IDs; enabled observations use N + R against the same shared records. A source
accepted in either state retains its amount when replayed after a switch change.
Claim capability, validation, lifecycle admission and two-date cleanup remain
active in both states.

## Deployment and rollback compatibility

Record dated evidence in #34615 for the serving API deployment, every serving
or draining Runner artifact/process, and the selected supported rollback API
and Runner artifacts. Use immutable commits and deployed artifact identities;
a merged PR, release label or successful promotion does not prove old processes
have finished. Confirm that all platform-funded X traffic uses the one billing
account without recording credentials.

The relevant implementation boundaries are backend ingestion/admission
[#34844](https://github.com/vm0-ai/okou/pull/34844), merged as
`d4a7d5f6a0fde270eb47fceb94c1d92e26a6072b`, and the resource producer
[#35108](https://github.com/vm0-ai/okou/pull/35108), merged as
`96047fc9cc3ec7e50779708e01ffbb8b28789af0`. Check the actual selected Runner
release commit separately from the API commit. The annotation cleanup in #35147
is not a billing compatibility boundary. The current
[rollback resolver](../.github/scripts/resolve-production-rollback-target.sh)
does not enforce an X-specific boundary, so its success alone cannot qualify a
target. This qualification adds no rollback policy.

Deploy API support for unconditional v1 ingestion and admission before relying on
new producer claims. All serving and supported rollback APIs must preserve the
settlement, compaction and Run-deletion lock order described in the ingestion
contract. This is a deployment compatibility floor, independent of the switch.
The updated API always advertises
`xResourceBilling: { protocol: "x-resource-v1", startDate: "1970-01-01" }`.
Deployed Runner parsers require the date field, so the API retains a fixed
compatibility value without a configured date or API cutoff.

Deploying the change starts resource collection, reporting and recording on new
capable Runs even while deduplication is disabled. Verify the actual rollback
artifact's v1 ingestion behavior: an older API with its original date setting
unset rejects v1 uploads and omits capability from new claims. Turning the
deduplication switch off does not repair that incompatibility. Retain a compatible
API for already admitted v1 uploads.

## Deduplication rollout and observation

Capability is captured when a Run is claimed. A current Runner can still host a
Run claimed before this API deployment, with no capability for its entire lifetime.
An older Runner ignores the advertised field. Confirm the drain of both kinds
of Runs and their in-flight requests, streams and retained uploads; checking
binary versions alone is insufficient to claim complete resource coverage.
Previously queued Runs resolve capability at claim time. Record deployment
propagation and any remaining absent-capability claims.

The standard `xResourceDeduplication` switch defaults to disabled, with no staff
whitelist, and resolves the authenticated Run owner's organization/user context
once per batch. When authorized, use existing user overrides within the
authenticated organization to
enable deduplication; there is no future UTC activation date to configure. Resource
records collected while disabled are already available for the same-day switch
to N + R billing. Resource identity is global even when switch rollout is scoped.
Disabling the switch charges Q for newly accepted observations while continuing
all other processing. Neither direction changes amounts already accepted under
a source UUID.

Use actual process/Run completion and delivery outcomes. Promotion's soft-drain
acknowledgement is not completion. Proxy quiescence means no outstanding work;
it is not an all-delivered receipt. Inspect permanent failures, exhausted retries,
flush failures and shutdown losses, and resolve their billing impact. Execution,
flush and retry limits do not replace this evidence or guarantee durable delivery.

Measure representative request sizes, resource counts, upload backlog/latency,
database contention and clock alignment. Cleanup deletes at most 1,000 rows per
minute: 1.44 million rows per day is a nominal upper bound if every scheduled
call succeeds, not measured capacity. Compare actual expired-row volume and
backlog with observed cleanup throughput. Delayed cleanup retains extra rows but
must never extend the today/yesterday admission window.

Switch rollback does not require changing producer protocol or clearing resource
records. Never replay expired observations on a new date or downgrade a rejected
v1 upload to a count-only event. Record operational verification and recovery
decisions in #34615; passing the shared fixture does not enable the production
switch or close that issue.
