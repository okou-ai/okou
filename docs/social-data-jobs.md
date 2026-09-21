# Saved Social data jobs

Saved jobs add bounded public-data collection to `okou social`. The
`socialDataJobs` feature switch defaults to off. Commands without job controls
continue using their existing protocol.

```sh
okou social comments 'https://www.youtube.com/watch?v=VIDEO_ID' --limit 20 --dry-run --json
okou social search 'coffee shops' --platform tiktok --limit 20 --max-credits 100 --async --json
okou social jobs get JOB_ID --wait --json
okou social jobs list --json
okou social jobs cancel JOB_ID --json
```

`--dry-run`, `--max-credits`, `--async`, or `--request-id` select the saved-job
protocol. Quotes do not execute collection or create usage. `--request-id` is
an owner-scoped UUID; replay it only with identical inputs. A changed payload
returns an idempotency conflict. The CLI reports recovery instructions if a
submission response is lost. Interrupting the CLI leaves the admitted server
job running; cancellation is explicit.

Synchronous calls reuse existing JSON, CSV, and transcript export handling.
Saved jobs do not support streaming, checkpoints, or asynchronous file exports.
`jobs get --wait` waits for the billing receipt as well as the collection result.

## Supported collection

`okou social capabilities PLATFORM --json` includes a `jobs` section describing
the saved-job operations independently of the existing protocol.

| Platform  | Operations                                                            | Boundaries                                               |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Instagram | Profile/post/Reel inspection, profile posts/Reels, post comments      | Comments are limited to 50; no search or transcript jobs |
| TikTok    | Video/photo inspection, profile posts, search, comments               | One bounded comments batch; no transcript jobs           |
| YouTube   | Video inspection, channel videos/Shorts, search, comments, transcript | Transcript requires one video; optional language         |
| Facebook  | Public page inspection, public profile posts, search, comments        | One search query; full public URLs; no nested replies    |
| X         | Post inspection, profile posts, search, conversation comments         | Single target or query; no transcript jobs               |

The global result limit is 1,000. Platform and operation constraints can be
smaller. Unsupported options fail before execution. Paid add-ons, nested
replies, generated transcripts, and media downloads are excluded from this
protocol. Existing download commands remain available through their current
protocol. Responses expose normalized platform fields and public source URLs.

## Budget and recovery

Admission inspects the selected tool's current pricing and input schema. An
unknown price shape or an input without a reviewed result bound is rejected.
The current `usage_pricing` row supplies the tariff; admission saves that row's
units and the accepted credit ceiling on the job. Concurrent saved jobs for
the organization include their outstanding reservations in admission checks.
Reservations constrain this job protocol; they are not wallet deductions or
holds against unrelated services.

A valid successful result and confirmed USD cost are required for billing.
The actual receipt determines usage quantity, and the saved ceiling caps the
charge. Later pricing edits do not change an admitted job's tariff. Failed,
cancelled, or unrecoverable submissions are not charged. Known upstream run
IDs remain recoverable when a response or receipt is ambiguous; an ambiguous
start without a run ID is never submitted again.

The job's usage idempotency key survives retries. Credit deduction and the
durable job receipt commit in one transaction, so later source compaction
cannot turn an unfinished receipt into a repeated charge. Scoped account cleanup
deletes saved jobs before usage, and admission/settlement share account closure
locks to prevent deleted jobs from recreating charges.

Create schedules one background advance. Reads and the existing Social
reconciliation cron continue admitted jobs. Claims expire after an interrupted
worker; updates are fenced by the claim. Stop requests that have not been
acknowledged can be retried against the same upstream run.

## Usage presentation

Persisted events retain `kind=social`, the platform-specific source provider,
and `category=provider_cost_usd_micros`. Usage APIs keep those identities.

Presentation treats Social Search as one managed capability, the same way
Web Search covers its own upstream provider. The chat credit popover and the
Usage bars merge every `kind=social` row — `socialkit` and each `monid/...`
provider alike — into a single **Social Search** row, and place it in one
segment. No vendor or platform name is shown. The X connector keeps its own
row, because connector consumption is a different product surface from Social
Search. Model rows and incompatible source units stay separate. Runless CLI
charges are included in Usage records.

## Activation

Apply the generated migration before deploying the API. Provision
`OKOU_SOCIAL_MONID_API_KEY` and the platform-specific `usage_pricing` rows through
the operational configuration process. No production tariffs or credentials
are seeded by this change.

Keep the feature disabled until every serving API and settlement
worker has the new implementation. See the [deployment compatibility
boundary](deployment-compatibility.md#saved-social-data-jobs) before activation
or rollback. Public tool inspection informed the catalog; mocked integration
tests do not establish live paid-provider availability. A bounded live smoke
test is still required during activation.
