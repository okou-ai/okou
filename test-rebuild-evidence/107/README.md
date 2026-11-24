# App batch 107

All 20 assigned cases were open at the handoff. Of 121 frozen cases, seven received first complete original acceptance and one was closed with a sourced revision. The remaining 113 cases include all six product decisions. The 68 independent upstream scenarios remain separate. Restorations, whole-case retirements and substitutions were zero. [Set reconciliation](reconciliation.json) · [Original GWT and per-ID ledger](../../turbo/apps/platform/test-rebuild-batch-107.tsv) · [Active cases](../../turbo/apps/platform/test-rebuild-pending.bdd.md) · [Verification](checks.md)

## realtime-019

A queued automation made cancellation recovery visible. In the same mounted thread, the open connector menu and automation panel showed Cedar account and Cedar schedule while the two publications were withheld. The detail publication alone returned the changed detail and connector overview, displayed the cancellation recovery status and Maple account, and left Cedar schedule visible. The automation publication then replaced Cedar schedule with Maple schedule. Replay both publications with the queue strip, menu and panel already mounted. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-019)

## realtime-020

The startup thread detail returned HTTP 500. The same open panel still changed Cedar schedule to Maple schedule after the later automation notification. The external HTTP failure has no identified receipt from the original subscription caller. Observe the caller of the subscription initialization receiving its original error while the same open automation panel subsequently changes. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-020)

## realtime-011

A genuine payload publication was followed by Delivered survey 17 on the open thread. The external provider then recorded both a resumed connection and a discontinuous reconnect. These receipts do not identify two completed initializations of that particular payload subscriber with runOnSubscribe omitted. Use a mounted payload consumer with a unique visible value produced only by its initialization on both sides of the continuity gap. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-011)

## realtime-005

Two independent Chromium Routers used the local identity service. The provider invoked the production auth callback, the realtime-token HTTP receiver returned 500, and the provider received its failure. Loading another window did not surface distinct setup, pending subscription and later subscription rejections with that failure. Identify each caller at a supported consumer of the failed token exchange, including a later subscription after terminal failure. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-005)

## realtime-006

With an organization attach held at the HTTP boundary, the presentation shelf opened and the provider received the suspended transition. Chromium confirmed closing the subscriber window before the attach gate was released. The gate then returned 503. Neither the waiting subscriber’s cancellation reason nor its topic removal was acknowledged independently. Keep the provider observer alive beyond the cancellation and identify the subscriber-specific rejection and removal before releasing attach. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-006)

## realtime-010

The external attach was outstanding while the shelf was open. The provider delivered a terminal failed-channel transition with the connection-failed reason, followed by a failed connection and the attach failure. There was no observable acknowledgement from the background subscriber’s error callback or removal of its exact subscription. Use a background subscriber whose failure callback changes a visible value and whose subscription removal can be identified at the same provider. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#realtime-010)

## message-port-014

Two already-open Chromium template shelves subscribed to the same user topic. Both windows displayed the new card before the resume control began. That resume produced no page catalog read. The continuity gap produced one read in A and one in B. Only B read the second, empty catalog after A closed and B lost the card. The provider did not record the final topic unsubscribe after B closed. Obtain an independent final topic-removal receipt after B disconnects, while retaining this per-window continuity control. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#message-port-014)

## message-port-038

Two independent already-open shelves shared an outstanding organization attach. The local receiver released it with 503. After closing both windows, a newly registered window reacquired presentationTemplatesChanged on the same organization channel. Publishing on that topic delivered to one handler and put Harbor exhibit on the new shelf. Neither of the two original callers surfaced its rejected attach result. Observe both original subscription rejections and identify removal of the failed topic before reacquiring it. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#message-port-038)

## message-port-032

Upstream #49839 made the agent map optional for the staged rollout and #49868 removed it from the indicators contract. The current sidebar began with Side survey unread, then cleared it after the receiver returned empty threads and unread timestamps. A new, unpublished turn staged at the API stayed absent on the subsequent offline visit. In the positive control a separate message publication warmed three rows from cursor 48 and the offline page showed Delivered survey 17. This is acceptance of the revised thread-only contract. Replay both indicator and message-publication arms. The retired agent field is recorded under the original stable ID. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#message-port-032) · [Staged migration](https://github.com/okou-ai/okou/pull/49839) · [Final contract](https://github.com/okou-ai/okou/pull/49868)

## browser-response-deadlines-007

Startup hello was pending when the document became hidden. The first transport retired after 30,001 ms. After revealing the viewer, the original page session received fresh text on the replacement with exactly two connections. Releasing the old hello did not read its message data on the retired socket. Obtain distinguishable late delivery to the original startup peer, or a final decision about the retired peer. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-007)

## browser-response-deadlines-009

The very first descriptor stayed outstanding as a minute elapsed. The changed binding acquired the replacement page. The page consumed the uniquely named old response body after recovery. The original HTTP request had not been aborted. Fresh input reached the replacement session on the single connection and the original tab was absent. Run the registered Router case with the deferred first response. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-009)

## browser-response-deadlines-011

The initial descriptor brought up the shared viewer. Separate-image worker attachment and hello each consumed 21 seconds. The window proof used 17,999 ms plus 1,001 ms. At the end of the cumulative 61 seconds recovery used the single available replacement descriptor. Its distinct endpoint received the text; an early or repeated recovery read would have returned HTTP 503. No alert appeared. Run the phased Router case with its one-use recovery endpoint. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-011)

## browser-response-deadlines-022

After visible disconnect, recovery had requested its first image. Navigating to a different chat produced a distinct endpoint and page session. After 61 seconds the old image was released with a unique frame number. The new peer received the text, but no frame acknowledgement identified that old image. Obtain an independent acknowledgement for the identified old frame after visible navigation, or source its final disposal. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-022)

## browser-response-deadlines-023

Recovery was painting when the document became hidden. The history transition occurred while hidden, then the document became visible before releasing the unique old frame. The replacement peer accepted input. The old capture had no matching frame acknowledgement. Observe late frame handling across the hidden chat transition while independently verifying the selected replacement session. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-023)

## browser-response-deadlines-039

After 31 seconds without hello the unavailable screen disabled input. Explicit Reconnect restored the original page. After attempting delivery of the old reply, New tab created exactly one blank target in the original window, and it received the typed text. The original socket did not read the late hello. Distinguish actual delivery of the stale hello from sending to a closed socket while reproducing the same single-tab result. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-039)

## browser-response-deadlines-043

The native window read after tab attachment expired after 31 seconds. During Reconnecting both input and New tab were disabled. The original address recovered on the same connection. The WebSocket message data for the exact late read was consumed, and fresh text reached the original target. Run the registered late-read Router test on the unchanged binding. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-043)

## browser-response-deadlines-053

The user switched chats while the original native window read was outstanding. The replacement address was usable on a different endpoint through the old deadline. Text reached the new page with no recorded report. The original peer did not read the late response body. Observe consumption or final sourced cancellation of that exact outstanding old read after the chat transition. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-053)

## browser-viewer-interaction-148

The selected target was destroyed while its membership read was held. The failed reply’s message data was consumed. Only the scoped survivor was selected and enabled; neither the original nor the foreign tab appeared. Submitting survivor.example/ready changed the survivor URL and preserved the foreign target URL. Run the registered membership-destruction test with the foreign control. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-viewer-interaction-148)

## browser-viewer-interaction-155

In two separate Router runs the original target was destroyed before selecting Other or after its confirmation reply. The original membership failure produced a held CDP target inventory. Other was selected before delivery of that identified successful inventory. Its message data was consumed. After destruction the original tab was absent, Other kept its address and received fresh input. Replay both destruction orders around the same successful target inventory. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-viewer-interaction-155)

## browser-viewer-interaction-158

The original target remained alive after its membership failure and throughout selection of Other. The target inventory was held with a distinct CDP failure. The user selected Other, the viewer read the identified failed response, and only then was the original target destroyed. Other remained enabled at its original address and received the next text. Run the failed-inventory case with destruction strictly after the reply. [Handoff GWT](https://github.com/okou-ai/okou/blob/1699ffa1134c9072908c78a015b6593ee3e6853d/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-viewer-interaction-158)
