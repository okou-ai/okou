# Batch 104 frozen-case review

The [opening register](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md) contained 142 unique cases across 46 frozen owners. All 20 selected IDs were active. One original GWT received its first complete acceptance. Two Discord cases closed with sourced corrections. The remaining 139 cases still span 46 owners and include the six product decisions. The separate 68 upstream scenarios, earlier acceptances and regressions contribute zero to the batch selection.

Chromium used the production Router and SharedWorker, a loopback HTTP receiver, local membership and conversation fixtures, and physical layout. Positions in the receipts are CSS pixels. Event IDs and text identify the same reference across samples. History pages in this conversation were mounted locally from delivered events. The pre-layout sample is a capture-phase scroll observation before the older DOM page appears. It does not imply an outstanding historical-events HTTP request.

The owning suites exercise the production Router against supported browser and service boundaries. The rejected-request control ran after leaving the Discord callback. The supplementary voice trials used the normal 5000 ms registration budget. A timed-out trial is recorded only as an attempt.

| Distinct cases handled | First complete original | Restored | Sourced revisions | Entirely retired | Net decrease | Remaining |
| ---------------------: | ----------------------: | -------: | ----------------: | ---------------: | -----------: | --------: |
|                     20 |                       1 |        0 |                 2 |                0 |            3 |       139 |

## chat-scroll-024

Started from sixteen completed turns with question 6 unmounted. On a wheel event at scrollTop 4036, event …0038, “Turn 13, observation 3.” was at 448.75 px. When the older local page mounted and layout settled at 4680, the same text was still at 448.75 px. Question 6 was offscreen until another wheel reached 2336. With shorter earlier turns and a 1600 px browser height, a single wheel made question 6 visible, but question 9 moved from 1031 to 1019 px. A separate 51 px wheel moved the same control text from 84.25 to 135.25 px.

The same delivery must show question 6 in the viewport while the pre-delivery event and text retain their screen coordinate. Recheck a change to native anchor compensation or page measurement. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-024)

## chat-scroll-025

Drove near, away, then near again with trusted wheels. Question 6 mounted, unmounted, and mounted again. Question 4 stayed absent. The reference retained its position across each local layout. Repeating with the next wheel issued at the observed scroll event also produced two mounts.

Look for a change to page retention or a continuous gesture with a single independently observed mount and the same pre-delivery text position. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-025)

## chat-scroll-023

Delivered two completed turns through separate catch-up responses. The locator showed 17 then 18 turns. At both arrivals the original text was at 263.25 px. The replies were mounted at 1507.75 and 1789.25 px, below the transcript bottom at 609 px. Both were readable after scrolling to the tail.

A layout or presentation change must make both arriving replies visible in the viewport while preserving the history anchor. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-023)

## chat-scroll-020

Scrolled the Markdown image into view to start an actual SVG request, then read a lower message while the receiver held the response. The image was above the anchor. After releasing the 240 × 75 SVG and awaiting browser decode, the thumbnail was still 198 × 178 px and the reference was still at 351.25 px.

Exercise a supported late-loading media presentation that actually increases document height by 75 px. [#48209](https://github.com/okou-ai/okou/pull/48209)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-020)

## chat-scroll-008

At physical offset 275, delivered a diagram reply while Automations covered the transcript. The seventeenth marker arrived. The external image receiver had zero arrivals both before and after closing the panel. The same question returned at 296 px. Scrolling to the diagram then started the held image request.

Revisit when rendering can start actual image preparation for the incoming reply while the transcript is hidden. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-008)

## chat-scroll-006

At 930 px width the side conversation remained accessible under Automations. Alt-click opened the empty side conversation through the sidebar query, kept the primary route and exposed capability discovery. Primary text stayed at 385.25 px through reveal, the incoming reply and a real image decode. The reserved thumbnail stayed 198 × 178 px.

Repeat behind a primary image whose rendered height genuinely grows. The 760 px layout did not expose the side-conversation link while covered. [#48209](https://github.com/okou-ai/okou/pull/48209)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-006)

## chat-scroll-007

Scrolled from the tail to physical offset 275 in a 760 px browser. Question 2, event …0004, was at 296 px. With Automations open the transcript height was zero and the seventeenth completed turn arrived. Closing returned the same text to 296 px at offset 275. A separate routed registration verifies offset and text position with the new reply already present before close.

Complete. This GWT has no adjustment-count clause. The previously registered generic hidden-reply journey remains covered. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-007)

## chat-scroll-001

At 760 px the history text returned to 263.25 px and offset 4687. Browser animation frames observed 4687 → 0 while hidden and 0 → 4687 on reveal. The scrollTop, scroll, scrollTo and scrollBy observers registered zero application writes during reveal. Two same-frame control scrolls of +22 and −22 were both recorded.

Browser visibility restoration and an explicit physical adjustment are distinguishable here. A receiver for compositor changes inside one frame, or an upstream statement defining the count, could resolve the frozen “exactly one.” [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-001)

## chat-scroll-005

Repeated the narrow reveal after the same worker delivered turn 17 behind Automations. The marker was present before close. Offset 4687 and text position 263.25 px returned. Explicit scroll writes during reveal were zero, with one sampled transition and a two-write positive control.

The single physical adjustment remains unproved. Preserve the separate completed-reply observation. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-005)

## chat-scroll-017

Focused a two-line draft and ran three shrink/restore cycles in Chromium. Desktop layout resizing retained the reference. A PWA installation and launch succeeded, but the observed target reported standalone=false and no independent keyboard pan. Separately, a routed standalone VisualViewport fixture with distinct resize and pan inputs moved the text from 65 to −265 px.

Use a standalone target that reports its display mode and a real nonzero visualViewport.offsetTop during keyboard use. Keep the existing tail regression separate. [#50032](https://github.com/okou-ai/okou/pull/50032)

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-017)

## chat-scroll-018

From a completed conversation at the tail, clicked Add, Research and Remove Research. Transcript heights were 561 → 201 → 561 px. Distance to the bottom stayed zero, the route stayed put, and the composer stayed empty.

The measured reduction was 360 px. Revisit an actual 120 px tray layout or an upstream decision superseding that dimension.

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-018)

## chat-scroll-019

Delivered a terminal run.cancelled row and opened Research from history with an empty composer. The same text stayed at 249.25 px and scrollTop at 4701 through opening and removal. Heights were 561 → 201 → 561 px, with the route unchanged.

The measured reduction was 360 px. A stopped conversation with a 120 px reduction, or a documented replacement for that contract, would settle this case.

[Measurements](./scroll.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-019)

## chat-capability-voice-recording-004

Registered an independent 128-segment recovery trial at the ordinary 5000 ms suite limit. It supplied microphone PCM and received four transcriptions before timeout. It did not reach the restored editor or 128 polish groups in that registration. The previous long-run proof and short registered recovery control remain distinct.

A representative saved 128-segment draft must be obtainable at a supported boundary within the normal suite run. [#38082](https://github.com/okou-ai/okou/pull/38082)

[Measurements](./voice.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-capability-voice-recording-004)

## chat-capability-voice-recording-005

The separate 129-segment trial supplied its own microphone capture. It reached four transcription responses before the ordinary 5000 ms limit, before recovery and the expected 65 polish items. The prior full-size supplemental recovery remains historical evidence.

A regular registration must exercise the 129-to-65 boundary and detect any retranscription or lost final singleton. [#38082](https://github.com/okou-ai/okou/pull/38082)

[Measurements](./voice.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-capability-voice-recording-005)

## voice-draft-audio-010

Sent an empty microphone frame through the real recording page. Stop remained absent. A single positive sample enabled Stop. The WAV suite now registers that contrast. No finished zero-sample recording was produced through these controls.

Find a supported device termination that completes an empty draft and permits a request for the next segment. [#31983](https://github.com/okou-ai/okou/pull/31983) [#32059](https://github.com/okou-ai/okou/pull/32059)

[Measurements](./voice.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#voice-draft-audio-010)

## voice-draft-audio-013

Recorded exactly 60 seconds, navigated away after the fourth live WAV, and reopened the draft. The four live uploads ended at 15, 28, 41 and 54 seconds. Use recording was available without Resume. Its uploads covered 39–54 and 52–60 seconds. The continuous 73-second control has a different non-final 52–67 second window.

A supported resume of a retained 60-second checkpoint must emit a non-final 58–73 second WAV. The initial fourth response raced navigation and was requested again on recovery. [#32059](https://github.com/okou-ai/okou/pull/32059) [#38082](https://github.com/okou-ai/okou/pull/38082)

[Measurements](./voice.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#voice-draft-audio-013)

## integrations-discord-016

Loaded the connected callback with an unverified member. Chromium showed Connect to Discord at /settings/discord?status=connected, enabled Connect, and exposed neither the provider detail nor Open Discord. The independent HTTP receiver observed only a status GET between navigation and departure. It recorded a rejected completion POST sent afterwards as a positive control. Upstream explicitly expects Connect for this indicator and unverified status.

Closed against the sourced correction. The frozen “no Connect” clause receives no original-GWT acceptance. [#39693](https://github.com/okou-ai/okou/pull/39693)

[Measurements](./discord.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#integrations-discord-016)

## integrations-discord-037

Started disconnected, held the change-triggered status request, left for Chat and returned before release. The description remained with no buttons. Delivery exposed Connected and enabled More options. In a separate control where refresh started only on return, the card retained enabled Connect until delivery. Both chronologies have a regular registration.

The upstream cache promise covers refresh starting on return. A change or a product ruling on refresh already pending before departure could close the original. [#39684](https://github.com/okou-ai/okou/pull/39684)

[Measurements](./discord.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#integrations-discord-037)

## integrations-discord-038

Started connected, held refresh before leaving Works and returned while pending. The card showed its description without Connected or actions. The response restored Connected and enabled More options. Starting refresh only on return preserved the cached Connected state. Both initial states and both chronologies were exercised.

Look for a decision or implementation that preserves a connected card across departure with a status request already pending. [#39684](https://github.com/okou-ai/okou/pull/39684)

[Measurements](./discord.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#integrations-discord-038)

## integrations-discord-040

A connected member received HTTP 403 on status refresh. The global notice said “Discord access denied”. The Discord card kept its description with zero actions and no stale Connected status. After leaving for Chat and returning with access restored, Connected and More options returned. The upstream change asserts the notice at page scope and the description and actions at card scope.

Closed against the sourced correction to the error surface. No first acceptance of the frozen card-scoped claim. [#39684](https://github.com/okou-ai/okou/pull/39684)

[Measurements](./discord.json) · [Frozen GWT](https://github.com/okou-ai/okou/blob/339969f0ac36eb6a793a469527a780ce784c4d2d/turbo/apps/platform/test-rebuild-pending.bdd.md#integrations-discord-040)

## Registration and source comparison

After writing the routed and native journeys, the review traced the four frozen suites at `b0a10287edf4242383c28e39c6f7675053febb32` through their page, geometry, sidebar, chat event, authentication and Discord fixtures. The historical scroll helper synthesized page heights and scroll writes. Its visibility assertion on the two incoming answers did not require viewport intersection. The archived 128/129 trials wrote internal draft metadata and the archived WAV rows called the segment function directly. The new probes use the recording UI, microphone frames and actual WAV payloads. The archived Discord tests start the return refresh after departure, expect Connect for the unverified connected marker and observe the denial at page scope. Production changes and matching scopes are linked per ID.

The search 001 registration, the retirement of search 002, the cancellable debounce and the attachment suites were carried through the main synchronization. Only the three complete dispositions above remove an active anchor. The [per-ID ledger](../../turbo/apps/platform/test-rebuild-batch-104.tsv) retains all 20 original Given/When/Then clauses.
