# Batch 103 frozen-case review

The [starting register](https://github.com/okou-ai/okou/blob/f9fa72a98b827c489a8bab18cd1781aba91d1a24/turbo/apps/platform/test-rebuild-pending.bdd.md) had 143 cases across 47 owners. One case closed after a sourced revision. The remaining 142 cases span 46 owners and include the six pending product decisions. There were zero first complete acceptances of an original scenario, historical restorations or whole-case retirements. The 68 upstream scenarios have their own register. [Case ledger](../../turbo/apps/platform/test-rebuild-batch-103.tsv) · [Active cases](../../turbo/apps/platform/test-rebuild-pending.bdd.md) · [Upstream register](../../turbo/apps/platform/test-rebuild-upstream-pending.bdd.md)

## agent-suggestions-021

The original custom-direction dialog became an inline form in [#49016](https://github.com/okou-ai/okou/pull/49016). The full composer and its compact title followed in [#49200](https://github.com/okou-ai/okou/pull/49200) and [#49618](https://github.com/okou-ai/okou/pull/49618). The page test used an authenticated member and a newly published card. A provider update changed the background after the member opened the editor. The timeline below follows the same card and both attempts of one retry.

| Observation | Failed send | Member retries after the provider restores the background |
| --- | --- | --- |
| Event API and authenticated chat history | HTTP 409. The event was absent. | HTTP 201. The event was present. |
| Chat / client event identity | `f4464b23-2172-8284-aeea-24d928df0183` / `c9c7638a-bfed-856b-bd29-a8f223386723` | Both matched the failed attempt and the persisted event. |
| Background / follow-up | “Survey launch depends on the tide” / “Confirm the harbor depth with Mara.” | Both matched the authenticated event readback. |
| Page and card | “This suggestion background has changed.” The card and typed note remained, with Send enabled. | The editor and card disappeared. The page showed “Sent to a new chat” and “All caught up” on `/for-you`. |
| Feed management readback | Active card, no feedback. | Consumed with a `custom_sent` record keyed to the same event. |

After acceptance, the controller submitted the ordinary consume request for that card. It received 409 and the card's curation record was identical before and after. The receipt therefore cannot distinguish the absence of an ordinary request from a rejected one. This clause remains open. The observations use the product App and local product API backed by PostgreSQL. Clerk and the external agent runtime are fixture boundaries. [Paired page, history and feed receipts](./suggestion-retry.json)

## agent-suggestions-015

The same member had two published cards. Disconnecting its last personal provider returned 204. The model API still returned available organization-backed Auto. Sending the first card returned 201 and authenticated event history contained its input. The second card became first. In a separate control the App received the literal model response `{ "models": [] }` for those cards. It displayed “The selected model is not available”. Opening the first, second and first position again confirmed their original order. [Page and API receipts](./suggestion-models.json)

The built-in Auto entry predates the empty-response App regression. The latter deliberately supplies an empty model list. The production catalog and the defensive App behavior are both supported by their sources. A member-facing route to zero available models is still missing. [Auto rollout](https://github.com/okou-ai/okou/pull/37746) · [Model ID](https://github.com/okou-ai/okou/pull/38389) · [Original defensive regression](https://github.com/okou-ai/okou/pull/45456)

## agent-suggestions-004

The homepage prefetch and For you still share the scoped feed resource. Batch 100 already compared cold entry with a prior feed read followed by a held refresh. No distinct entry capable of rendering the prior card during the pending interval was identified. The earlier observation and the frozen ID are carried forward. [Earlier case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv)

## chat-metadata-003

The archived test kept the returning metadata promise pending when checking for an absent chat region. The missing-thread view gives a confirmed miss a region labelled “Chat thread”. The legacy Agents destination has been replaced by Workflows. These sources establish the revised observations at the pending and settled boundaries. [Original regression](https://github.com/okou-ai/okou/pull/38731) · [Missing-thread view](https://github.com/okou-ai/okou/pull/26014) · [Agent navigation](https://github.com/okou-ai/okou/pull/49556) · [Retained destination](https://github.com/okou-ai/okou/pull/49838)

A member opened a new chat with a known title, left for Workflows and received the abandoned 200 there. Workflows kept its title. The same member then deleted the disposable chat through the local product API (204). On returning, the page had no chat region or old title while its fresh lookup was pending. Decoding the real 404 with the canonical list held left the region absent. Delivering the same member’s authenticated, empty canonical thread snapshot mounted the named “Chat thread not found” region. The old title and composer stayed absent. The permanent routed suite also compares releasing and withholding the abandoned response. [Member, thread and delivery boundaries](./metadata.json)

## composer-custom-template-recommendations-009

The contextual Image shelf still accepts WEBP for reusable-style analysis. The product import scenario used the file input. The newer removal of the standalone gallery preserved contextual imports. The existing paired App journeys exercise actual clipboard paste and a file selection. Pasting attaches the PDF to the composer, while the input filters the PDF. The frozen paste clause remains open. [Original import](https://github.com/okou-ai/okou/pull/39648) · [Contextual recommendations](https://github.com/okou-ai/okou/pull/50365)

## chat-conversation-locator-002

The native Chromium page loaded a conversation with exactly eight turns. At both 1280 × 720 and 1280 × 960, it showed eight markers and the first question started unmounted. Selecting the first marker brought the original question into view, with landing feedback attached to its own event. After layout settled the scroll position was zero. The event anchor was 60 px below the scroll viewport's top edge and the question text began 74 px below it at both heights. Selecting the fourth marker instead moved the scroll position and attached feedback to the fourth event. The exact top-edge clause remains open. [Viewport and message measurements](./locator.json)

## Review boundaries

The original registrations, related suggestion attribution and navigation tests, and their model, feed and route fixtures were checked against the newly authored journeys. Discord callback case 007 retains the archived 200/400 replay from batch 102. It received no new acceptance. [Discord receipts](../102/discord.json)

## Synchronizing the contextual template shelves

[Production change #50365](https://github.com/okou-ai/okou/pull/50365) removed the standalone picker, its URL and tab navigation, the Templates flyout, gallery-wide search, and opening an attached reference for replacement. The [historical entry ledger](./template-entry-changes.tsv) tracks 58 previously resolved IDs whose entry or assertion was affected. Each links to its archived frozen wording. These rows contribute zero to the reduction of the 143 starting cases.

The retained page paths exercise slash Create, category switching, published recommendations appearing and disappearing while the shelf stays open, built-in choices while personal templates are pending, portable chat references, document and deck viewers, visibility, title editing, and scoped file imports. The Image clipboard and file-input controls remain separate under the pending case above. A shared deck opens with its owner's attribution; the editing controls appear for the owner. Empty titles, rejected and retried renames, and two IME Enter sequences have direct detail-page coverage.
