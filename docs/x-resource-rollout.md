# X resource rollout evidence

[#35156](https://github.com/vm0-ai/okou/issues/35156) qualifies the producer and
consumer against shared examples. [#34615](https://github.com/vm0-ai/okou/issues/34615)
remains responsible for deployed verification and separately authorized
deduplication rollout. [#35197](https://github.com/vm0-ai/okou/issues/35197) replaces
date-based activation with the standard `xResourceDeduplication` feature switch.
The protocol cleanup removes the claim capability and fixed activation date;
it preserves the feature switch. Neither code change enables the production
switch, and repository qualification alone is not production acceptance.
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
| Complete responses, stream failures and UTC midnight              | `test_x_resource_observations.py`, `test_x_resource_stream_failures.py`                   |
| Batch limits, retry identity, saturation and expiry               | `test_x_resource_usage_transport.py`                                                      |
| Atomic global billing, concurrent uploads and lifecycle admission | `webhooks-x-resource-usage.test.ts` and adjacent `webhooks-x-resource-*` lifecycle suites |
| Two-date cleanup, batch bound and writer exclusion                | `cron-cleanup-x-resource-reads.test.ts`                                                   |

Record the tested commit, exact commands and results in the PR. A passing CI
run proves only the checks and commit that it actually executed.

The switch tests cover both states, transitions and source replay. Disabled
observations record their resource IDs and reach the usage ledger at positive
quantity Q; enabled observations use N + R against the same shared records.
Zero quantities are discarded without source receipts. Persisted positive
sources retain their amount when replayed after a switch change; discarded zero
observations are evaluated again under the current switch.
Resource production, validation, lifecycle admission and two-date cleanup remain
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

All serving and supported rollback APIs must preserve the
settlement, compaction and Run-deletion lock order described in the ingestion
contract. This is a deployment compatibility floor, independent of the switch.

The cleanup removes the entire claim/registry capability, its fixed activation
date and the producer's count-only X read path. New Runners always produce v1
for X reads. The API's generic count-event contract remains unchanged, including
X counts, other connectors, model and image usage.

The preceding switch-based API already accepts the unconditional producer's
uploads. During the standard API-before-Runner release, an old Runner receiving
a cleaned-up claim without its capability emits ordinary count events. The
existing ingestion path accepts and bills those events at their full quantity;
already-claimed Runs with the capability continue reporting resources. This
preserves base billing, but count-only reads cannot populate resource history or
receive deduplication even if the switch is enabled.

Full deduplication coverage requires old Runner processes, Runs, streams and
retained uploads to finish draining. Where uninterrupted deduplication is needed,
deploy the unconditional Runner against the preceding API first and verify that
drain before the API cutover. A merge or successful ordinary promotion does not
establish this stronger coverage guarantee or authorize a production operation.

The preceding switch-based API remains a compatible rollback target. A Runner
rollback may reduce resource coverage while generic count billing still works;
older date-gated APIs with the setting unset reject v1 uploads. Switching
deduplication off does not repair an incompatible API.

## Deduplication rollout and observation

The unconditional producer no longer captures an X capability at claim time.
Confirm the drain of previous date-gated or absent-capability Runs and their
in-flight requests, streams and retained uploads before claiming full coverage;
checking binary versions alone is insufficient to claim complete resource
coverage. Record immutable artifact identities and actual drain outcomes.

The standard `xResourceDeduplication` switch defaults to disabled and is enabled
for staff organizations. It resolves the authenticated Run owner's
organization/user context once per batch. Existing user overrides within the
authenticated organization can explicitly enable or disable deduplication; there
is no future UTC activation date to configure. Resource
records collected while disabled are already available for the same-day switch
to N + R billing. Resource identity is global even when switch rollout is scoped.
Disabling the switch charges Q for newly accepted observations while continuing
all other processing. Neither direction changes persisted positive amounts under
a source UUID. A previously discarded zero observation can be billed at Q when
retried after the switch is disabled.

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
