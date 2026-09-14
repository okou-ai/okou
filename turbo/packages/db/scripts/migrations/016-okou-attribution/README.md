# Canonical Okou attribution metadata

Operation 016 implements the historical campaign/ad-group metadata migration in
[#33059](https://github.com/vm0-ai/vm0/issues/33059). It adds equal canonical
aliases without deleting old keys or changing a first touch, click, timestamp,
conversion destination, transaction ID, or delivery receipt. It never submits
conversions or replays a Stripe webhook. This is separate from the withdrawn
Clerk-to-database authority migration (#33452 / #33543).

## Inventory and boundaries

| Source               | Complete inventory at the cutoff                                                                                                                                                         | Action                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Clerk                | Every reachable user, including inactive, banned, staff, organic, and users without an organization; `signup_attribution`, acquisition delivery history, and an existing privacy receipt | Add `okou_campaign_id` / `okou_ad_group_id` to existing first-touch and nested delivery attribution records |
| Stripe               | All customers, subscriptions (`status=all`), checkout sessions, and invoices created before the cutoff                                                                                   | Add canonical aliases in writable object metadata and `gdm_*` invoice snapshots                             |
| Application database | All pre-cutoff organizations and every `acquisition_*` value                                                                                                                             | Read-only comparison; these columns are already brand-neutral                                               |

Provider-owned immutable invoice/subscription-detail copies, deleted provider
objects, historical analytics events, browser cookies/session storage, and
previously published URLs are historical records. Do not reconstruct their
values from another user, organization, later checkout, or campaign name. Their
legacy readers remain supported. The census covers reachable records; compare
deleted/unavailable identities with retained operational records and explicitly
account for them in the completion evidence. Operation 011 is a historical
organization backfill tied to its original schema; do not run or rewrite it.

`vm0_source`, `vm0_experiment`, and `vm0_variant` are deliberately outside this
campaign/ad-group rewrite. Their targets and strict-reader rollout conditions
are recorded in [the attribution inventory](../../../../../../docs/google-ads-browser-routing.md#remaining-field-inventory).
No provider-side standard field (`gclid`, `gbraid`, `wbraid`, UTM, GA client ID)
needs a branding rename.

## Preparation and compatibility

1. Deploy both the main application and marketing account mappings, and verify
   the deployed versions. New application requests and Clerk first touches use
   canonical campaign/ad-group keys; Stripe and reporting keep equal legacy
   aliases for existing consumers.
2. Verify API serving and rollback targets contain the alias-aware reader from
   `a222108b4eccfdab77fa3f6f3c08fa6ea2bdfac7` (#33149). The existing enforced
   `669d0befc9a181e44e3f1f9e39093efddabcc0f8` rollback floor contains that reader.
   This operation changes no rollback setting. Both versions accept either
   campaign/ad-group spelling and equal aliases. Marketing serving and any
   selected rollback runtime must retain its #676 reader
   (`5877e98af09ac8ae4b6596615ffead32ab5f60e8`); this is a documented operator
   prerequisite because its manual release workflow has no enforced floor.
3. Use the intended environment's `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, and
   `DATABASE_URL`. The database connection should have read-only access to
   `org_metadata`. Clerk is bound to its instance ID/environment type; Stripe
   to its account ID/live or test mode; the DB report records host/port/database
   without credentials. Never publish report contents or secrets in issue logs.
4. Before applying, quiesce attribution metadata writers and drain in-flight
   work: API signup/checkout metadata writes, marketing acquisition cron and
   Stripe webhook metadata writes, manual corrections, and old rollback
   writers. Preserve incoming webhooks for delivery afterward. Neither Clerk
   nor Stripe provides compare-and-set for these metadata patches; a pre-read
   alone cannot protect concurrent corrections. `--writers-quiesced` is the
   operator's assertion of this operational gate, not a lock acquired by the
   script. The script itself disables or changes no service.

## Dry run

Run from `turbo/packages/db`, with Node 24 and the repository dependencies. Store
artifacts in a restricted directory outside Git. Choose one cutoff in **Unix
seconds** for all three sources, and retain it through each plan's apply and
verification.
Users/objects created after it are outside this historical census and must be
covered by verification of the deployed canonical writers.

```bash
umask 077
mkdir -p /restricted/attribution-33059
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --source clerk --cutoff <unix-seconds> --output /restricted/attribution-33059/clerk.json
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --source stripe --cutoff <same-unix-seconds> --output /restricted/attribution-33059/stripe.json
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --source database --cutoff <same-unix-seconds> --output /restricted/attribution-33059/database.json
```

Dry run is the default. Each source is scanned twice at the same cutoff; the
complete ID set and metadata must match, not merely the row count. Clerk uses
100-user ordered list pages containing metadata, without per-user reads during
inventory. Stripe uses resource cursors and includes cancelled subscriptions.
Database pages run in a read-only repeatable-read transaction. An unstable
source or duplicate ID fails instead of publishing a partial census.

The report is created exclusively with mode `0600`. It retains exact source
values, including malformed or conflicting evidence. The adjacent
`.exceptions.json` identifies records that need investigation. Stdout contains
only aggregate counts and the inventory digest. Conflicts produce a nonzero
CLI exit status and block apply; never clear one by picking an arbitrary alias.
Take a new full inventory after an authorized correction.

Requests are sequential and spaced 500 ms apart by default (`--interval-ms`).
Only read requests retry HTTP 429/5xx, at most three times, honoring Retry-After
and bounded backoff. A Retry-After exceeding one minute stops for later resume.
Requests have a 30-second timeout; SIGINT/SIGTERM abort owned operations.

## Apply and resume

Review the census, exceptions, source identity, deployment coverage and drained
writers before applying. Use the exact `identity` from the corresponding plan;
the command re-reads that identity before any mutation.

```bash
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --migrate --plan /restricted/attribution-33059/clerk.json \
  --identity '<instance-id>:<environment-type>' --writers-quiesced --limit 100 --offset 0
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --migrate --plan /restricted/attribution-33059/stripe.json \
  --identity '<account-id>:live' --writers-quiesced --limit 100 --offset 0
```

`--offset` addresses the immutable reviewed inventory, never a live provider
page. After each successful batch use the returned `nextOffset`. The maximum
batch is 1,000 records. On interruption, repeat the same offset: a fresh read
recognizes already-applied values and makes no duplicate write. A failed or
uncertain mutation is never automatically retried. Stripe also receives a
deterministic idempotency key. The private `.journal.jsonl` records intent and
verified readback; an unverified intent requires readback, not blind replay.

Every mutation compares the current source against the reviewed record,
patches **only absent equal canonical keys**, then requires exact readback of
all inventoried metadata. Existing first-touch and receipt fields must remain
byte-equivalent as JSON values. Conflicts, invalid IDs, Stripe's 50-key limit,
source drift, deletion, or a readback mismatch stop the batch. Database apply
is intentionally rejected because its attribution fields need no rewrite.

## Reconciliation and completion evidence

```bash
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --verify --plan /restricted/attribution-33059/clerk.json
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --verify --plan /restricted/attribution-33059/stripe.json
pnpm exec tsx scripts/migrations/016-okou-attribution/backfill.ts \
  --verify --plan /restricted/attribution-33059/database.json
```

Verify repeats the full stable census at the original cutoff, checks exact ID
coverage and expected metadata, and requires zero remaining candidates or
exceptions. A batch's `batchComplete` is **not** this reconciliation result.
Only `complete: true` is success; incomplete verification exits nonzero. The
comparison preserves campaign/ad-group IDs, click IDs, original timestamps,
every delivery state and receipt, and the unchanged organization attribution.
It never substitutes counts for field equivalence.

After verification, resume the recorded writers, drain queued webhook work, and
run a fresh stable dry run at a later cutoff to catch late-created or late-written
legacy metadata. Repeat bounded apply/verify if that census has candidates.
Verify signup-to-checkout account selection for both Ads accounts and that no
historical conversion was replayed. Record only aggregate counts, stable
digests, source/version/cutoff coverage, exceptions, and rerun results in #33059.
Merging the PR or producing the tool is not proof of production backfill.

## Rollback

Before metadata apply, code can roll back to any allowed alias-aware API. After
apply, keep the additive canonical keys and all old keys: both supported readers
produce the same first-touch/account decision. A repeat apply is a no-op.
Do not bulk restore old snapshots, delete aliases, or replay conversions as a
rollback; those actions can overwrite newer provider changes or duplicate events.
For a reconciliation failure, keep writers quiesced, inspect the private before
image and journal, and repair only verified differences. Keep the brand-neutral
database values intact. Older legacy-only readers are excluded by the existing
rollback floor; this operation does not relax that floor.
