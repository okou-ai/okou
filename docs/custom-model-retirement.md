# Custom model configuration retirement

## Product contract

Chat has two credential sources, not two organization modes:

- **Auto:** the platform route is `okou-1.0` through `openrouter-codex` to
  `@preset/okou-1-0`. It uses platform billing. Model policy rows and a global
  default-model lookup do not select that route.
- **Personal subscription:** the member chooses models offered by their own
  connected ChatGPT/Codex or Claude subscription. Ownership, account capture,
  reconnect state, supported efforts and service tiers remain enforced. Claude
  subscriptions continue using the vendor harness; retirement does not relax
  their prohibition on Pi execution.

Organization policy management, mode switching, workspace API-key providers,
custom model gateways, platform multi-model selection and their comparison
prices are retired. This does not retire image-model settings, general SaaS
connectors, actual usage pricing or historical billing/model attribution.

Personal-subscription model metadata remains in the shared catalog tables.
Keeping those tables is not permission to offer their legacy platform/BYOK
routes: active selection and admission accept only Auto or a caller-owned
subscription. Catalog additions must not reopen a retired credential source.

## Database contraction

The generated migration drops only:

- `org_model_policies`;
- `model_provider_surfaces`;
- `model_provider_connections`;
- `org_metadata.model_mode` and its constraint.

It has no data backfill, credit change, subscription change, credential deletion
or automation rewrite. Drops are ordered by dependencies without `CASCADE`.
Personal provider/account tables, subscription catalog metadata, usage pricing,
member preferences, workflows and automations remain.

The migration regression validator verifies contraction with connected retired
rows present while comparing the retained rows before and after. It is part of
`test:migration-consistency`. Historical migrations and numbered external-data
migration scripts are permanent records, not runtime dependencies to delete.

## Merge preconditions and verification boundaries

The user owns production conversion of the remaining Custom organizations
before merge. This PR does not perform that conversion or certify it from a
previous database snapshot. Recheck that there are no Custom organizations and
no organization-owned BYOK/gateway credentials requiring cleanup before merge.
Deletion of organization configuration cannot be reversed by changing a mode.

The user explicitly requested one atomic PR without old API/client deployment
compatibility. Deploy the changed API, clients and schema as that breaking
contract; there is no old policy endpoint or old-client shim. Historical usage
must still settle with its captured model/pricing identity. Do not confuse this
release choice with permission to remove historical billing or to drop an active
execution's credential before it has finished.

Existing supported personal-subscription selections remain selections. A stale
Custom-only selection must not grant access to an obsolete provider; selection
resolution normalizes an unsupported stored choice to Auto. Explicit attempts to
configure retired organization providers are rejected instead of stored and
silently ignored. Valid subscription credentials are never replaced with a
platform credential to conceal a reconnect or ownership failure.

## Internal memory maintenance

Pi memory maintenance retains its existing effective OpenRouter transport to
`deepseek/deepseek-v4.1-flash`, with the same DeepSeek usage/pricing identity.
Its fixed binding, key/cooldown resolution and actual served-route pricing
snapshot are separate from chat admission. The maintenance binding neither adds
a chat choice nor restores organization policies, gateways, direct API-key
connections or general vendor fallback. Personal Codex maintenance credentials
retain their ownership and reconnect safeguards.

## Validation boundary (2026-10-05)

The unified PR includes the complete former #37758 cleanup, the resolved main
integration, and generator-produced migrations 1323–1325. The physical cleanup
remains deletion-only. A separate, narrow data migration preserves the native
subscription launch defaults previously supplied by retired mirror routes; it
never changes explicit defaults, disabled/future routes, or member preferences.
Luna retains its independent xhigh ceiling.

Verified locally:

- Full migration replay, consecutive reset consistency and schema equivalence.
- Cleanup guards, rollback, retained data and SQL/journal retry idempotence.
- Personal subscription default efforts, explicit-default and disabled-route preservation.
- Normal repository commit hooks, including workspace types and Rust formatting/docs.
- API test type shards, plus focused ownership, effort, admission, queue, memory handoff,
  runtime cooldown, provider invalidation, CLI authentication and integration regressions.
- Platform provider settings and main's last-read marker regressions.
- Official translation extraction and resource checking for all 12 locales.

These results are not deployed acceptance. The stable pushed HEAD still requires
current-revision review and required PR/merge-group CI. iOS validation requires
its CI toolchain. Real subscription sign-in and deployed runner, independent
memory and settlement verification have not been performed. No production SQL,
deployment approval or protection bypass is authorized by local validation.

## Required acceptance scenarios

- An unconnected member sees only Auto; it starts the fixed OpenRouter preset.
- A connected member can select their own subscription model, including its
  valid effort/service tier; a different member cannot borrow that account.
- Disconnect/reconnect handling preserves executable selections or explicitly
  returns the preference to Auto when its source disappears.
- A catalog row for another platform model, direct API key or gateway cannot
  create a selectable or executable platform route.
- Scheduled workflows still execute; valid personal selections stay personal,
  stale organization-only selections resolve to Auto.
- Auto pricing, usage events, historical display, credits, paid subscriptions,
  image settings and unrelated connectors remain intact.
- Public API, Platform, CLI, edge preload, runner/E2E fixtures and migration
  schema snapshots agree with the retired contract.
