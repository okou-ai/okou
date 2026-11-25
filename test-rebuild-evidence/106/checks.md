# Batch 106 verification

## Main synchronization

The opening head already contained main at `dc8a902b0c14fe21497527ffc84dcf8ec6c13a0d`. The first sync at `eefa0dc937fb1e6385fcabf7121b811a85f3fd5a` incorporated four upstream commits through `e939477354a7b8df087557431089566bf9b1a682`. Its App paths and frozen register had no changes. The changed Discord relay and connection-health suites ran against their locally built worker bundle. Both suites passed all 28 tests. [Sync](https://github.com/okou-ai/okou/commit/eefa0dc937fb1e6385fcabf7121b811a85f3fd5a)

The second sync incorporated main through `a0ae29c897aa14624e8a2b2ab6660bc60d1358c6`. Four test paths conflicted. None contained a selected case. [Sync](https://github.com/okou-ai/okou/commit/b950036f31773860f86896c5b6d24b7b493d8987)

| Affected suite | Resolution and observable regression |
|---|---|
| Workspace timezone startup | The rebuilt Workflows suite now exercises the upstream preference-read failure. The 500 stops startup and exposes the server error. The existing first-visit timezone and saved-timezone cases stay in that suite. [#50260](https://github.com/okou-ai/okou/pull/50260) |
| Hosted-site sharing | Website visibility changes retain the owner's current preview. The rebuilt suite opens from private and public access, checks the selected new audience and live preview, then copies the permanent URL. The grouped share dialog remains operable even when a later preview request would return 500. This revises the historical 026/027 controls. [#50449](https://github.com/okou-ai/okou/pull/50449) |
| Presentation output | The server preference governs eligible structured and untagged messages. Kept the upstream queued draft, fresh preference read, failure, feedback, Chart and eligibility controls. The template case with the feature disabled also verifies its exact submitted text, selected template and 8–12 slide default. The old in-composer format picker was removed upstream. [#50260](https://github.com/okou-ai/okou/pull/50260) |
| Billing feedback | Upstream replaced the in-app questionnaire and checkout survey with PostHog feedback. The five historical rows in the former billing-survey suite refer to the earlier product. The replacement suite exercises checkout, targeting, feedback and funnel behavior. [#50412](https://github.com/okou-ai/okou/pull/50412) |

These synchronization changes belong to previously settled regressions outside the 20-case allocation. The 106 frozen-register diff contains exactly the IDs in the reconciliation file. [Set comparison](reconciliation.json)

A final clean sync at `0766690382fabd08130e3edc48e12b50d08e20b2` incorporated main `8e9c65481965d0a8b696f386301d0a7ce6c6e58e`. It brought iOS and Android visual updates and release metadata. The only web App paths were its version and changelog.

## Protected behavior

Search 001 still exercises the settled number at the workspace search boundary. The historical retirement of 002 remains in the first-pass ledger. The shared debounce implementation, including cancellation and the zero test delay, is identical to the opening head. The single voice-note player still resumes its current clip, then advances to the next clip. Its implementation and attachment regression are also identical to the opening head. [Search decision](https://github.com/okou-ai/okou/commit/090b0c51baf3d980b040220352cec1ae57d634bd) · [Attachment suite](../../turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx)

## Original-text comparison

The independent trials were compared against the frozen suite, the two pre-withdrawal states, main and the surrounding tests and helpers. The original 409 scenario expected two telemetry entries. The concealed descriptor scenario needed recovery before delivery of the stale response. The Shift scenario required a newly captured image with the original key-up still outstanding. Those distinctions are retained in the pending register. The native experiments use the Router and external identity, provider and HTTP receivers. The viewer suites use the registered Router fixture, monotonic clock and external CDP peer. [Source fingerprints and matches](comparison.json) · [External observations](native.json) · [Viewer controls](viewer.json)
