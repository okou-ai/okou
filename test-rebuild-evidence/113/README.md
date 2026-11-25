# Batch 113 · Six remaining App scenarios

Opening head `ba94a6d69d155584c69fbdc3ded478fc62b069ae`. Reviewed main `7d5e1e2368cbb047f138882711115fe39e22551a`. Main brought in four Android files (#50633) and the Antigravity file-profile change (#50648). Its new preferences test adds one independent App row. The six IDs below are the complete opening inventory. First acceptances: 3. Deduplications, retirements and upstream transfers in this batch: 0. Open: 3. Batch 112 removed 68 through deduplication and separately completed nine first acceptances. The 68 independently owned upstream scenarios remain outside this denominator.

[Decision ledger](../../turbo/apps/platform/test-rebuild-batch-113.tsv) · [Remaining BDD](../../turbo/apps/platform/test-rebuild-pending.bdd.md) · [Source comparison](./comparison.json) · [Recorded observations](./observations.json)

## connector-directory-010

An unattended consent window survives dismissal of the connector directory. Router, real keyboard and native popup handle. Tab to Connect Gmail, Enter, wait for the provider and pending OAuth completion, then click the original Close button.

One popup and one authorization start. The directory disappeared. The very same native window remained open and still displayed the provider after dismissal. Native Escape agrees.

**Disposition:** open. Closure of the pending native popup on directory dismissal. Repeat after a change to directory dismissal or popup ownership. The registered window double is an adjacent control. Late callbacks are outside scope.

[Activating Gmail with Enter leaves a provider window that closes with the directory](../../turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#connector-directory-010)

## browser-response-deadlines-039

The visible member can regain control and create a usable tab in their assigned window. Withhold visible hello, verify disabled input, click Reconnect, and create one new tab through the original viewer.

The unavailable viewer rejected input. After explicit reconnect, one native about:blank target appeared in the same Chromium window. The member used the address form in that tab to open an editable fixture, then typed through the viewer. The new target alone received Input.insertText and its textarea contained Harbor; the original textarea stayed empty.

**Disposition:** first acceptance. Run the visible silent-hello registration and native receipt on changes to acquisition or tab creation. Some nearby create-tab runs reported that the new tab moved or navigated before it was ready. The successful sequence waited for the blank-tab presentation and used the public address form and rendered canvas. A retained socket packet is outside the acceptance criterion.

[browser-response-deadlines-039 A manual reconnect after a silent hello opens a writable tab in the member's window](../../turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-039)

## browser-response-deadlines-006

A returning member cannot type even though the replacement page is ready. Admit the original descriptor request, conceal the viewer, pass its deadline, reveal it and attempt input while the request stays held. Release and attempt a different character. Reverse the concealment/request order as a control.

Original ordering: neither page got x while the input was disabled. After release only replacement B got y. Concealing before requesting allowed B to receive x before release. The registered visible descriptor case also accepts input before release.

**Disposition:** open. Recovery with the admitted request still held after concealment and return. Repeat the admitted-before-concealment arm after a descriptor lifetime or visibility change. The inverse ordering, a banner and a discarded reply do not resolve the original condition.

[Replacement page receives typing when the pending descriptor expires and its original reply is deliver](../../turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-006)

## browser-response-deadlines-023

A late picture from the old chat could replace the new chat or send typing to the wrong page. Hold the original recovery paint, conceal the viewer, enter chat B through Router history, observe B’s descriptor while paused, resume and display B’s image. Deliver the distinguishable old image and type.

B’s canvas still displayed B’s raster after the old paint arrived. B stayed selected and only its target received the input.

**Disposition:** first acceptance. Run the registered cross-chat recovery representative. The raster widths distinguish fixture pictures. No particular resolution, ACK count or disposal event is required.

[browser-response-deadlines-023 Returning to another chat keeps its picture and sends typing to its own page after the former picture is released](../../turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#browser-response-deadlines-023)

## client-003

Losing one watched tab can leak a late child session or sever a usable sibling. Hold a real child attach reply on the original parent connection. Close that watched page with an independent Chromium observer. Deliver its target loss, then release the held response and type on the sibling through the original viewer.

The surviving peer received the late child reply and detached that child on the original parent. The same connection remained usable; the sibling’s native textarea received the viewer input.

**Disposition:** first acceptance. Run the native ownership registration against the production Router and extension. The raw private caller promise and its cancellation text are outside the active scenario. Root detach and closing the entire viewer are separate controls.

[client-003 Losing the watched tab releases its late child on the original parent while the sibling accepts typing](../../test-rebuild-evidence/113/browser-ownership.native.test.mjs) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#client-003)

## chat-scroll-017

Opening the keyboard while reading history can move the original message out of sight or lose the draft. Use the real chat transcript and editor in standalone Chromium with emulated touch and visual viewport. Wheel to a named older question, enter a multiline draft, open the keyboard once and read the same DOM text range against the visible bounds.

Both lines and editor focus survived. With a shrinking, stationary viewport the question remained visible. With the same shrink and a panned visual origin the original question was outside the readable rectangle.

**Disposition:** open. Preserving the history message when the visual origin advances. Repeat on a real mobile keyboard or after history-anchor/visual-viewport changes. The operating-system keyboard was emulated. No exact coordinate or cycle count is required.

[chat-scroll-016](../../turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx) · [Opening scenario](https://github.com/okou-ai/okou/blob/ba94a6d69d155584c69fbdc3ded478fc62b069ae/turbo/apps/platform/test-rebuild-pending.bdd.md#chat-scroll-017)
