# Browser automatic recovery

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-automatic-recovery.test.tsx](browser-automatic-recovery.test.tsx).

## browser-automatic-recovery-001

Original test `A successful image attempt 1 stays pending through same-binding revalidation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L324).

- **Given** The selected tab is recovering after a failed image frame, with one image attempt already made.
- **When** A frame succeeds and the browser session is revalidated without changing its binding.
- **Then** Recovery remains pending during revalidation, then the viewer becomes ready and accepts input. A later frame failure recovers without an extra connection or error report.

## browser-automatic-recovery-002

Original test `A successful image attempt 3 stays pending through same-binding revalidation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L324).

- **Given** The selected tab is recovering after a failed image frame, with three image attempts made.
- **When** A frame succeeds and the browser session is revalidated without changing its binding.
- **Then** Recovery remains pending during revalidation, then the viewer becomes ready and accepts input. A later frame failure recovers without an extra connection or error report.

## browser-automatic-recovery-003

Original test `A successful image attempt retains the original deadline during revalidation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L361).

- **Given** The selected tab is recovering after three failed image attempts, and a successful frame arrives near the original recovery deadline while session revalidation is pending.
- **When** The original 180-second deadline passes before revalidation completes.
- **Then** Recovery is reported exhausted and the input remains disabled. Revalidation can restore the viewer and input, but does not clear the single exhaustion report or start another connection.

## browser-automatic-recovery-004

Original test `A successful image attempt preserves a current terminal descriptor error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L393).

- **Given** The selected tab is recovering after a successful image frame, and revalidation receives a terminal 409 conflict because the assigned window was lost.
- **When** The user reconnects after the unavailable-view state appears.
- **Then** The terminal descriptor error and one final protocol recovery report are preserved in order. Reconnect restores the viewer without adding reports.

## browser-automatic-recovery-005

Original test `Confirmed suspension after a successful image attempt leaves no pending viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L430).

- **Given** The selected tab is recovering after a successful image frame, and revalidation confirms the browser is suspended with no viewer.
- **When** The descriptor update completes.
- **Then** The Start browser button appears, the input is disabled, and the reconnecting status is removed.

## browser-automatic-recovery-006

Original test `A same-window endpoint replacement preserves recovery attempt 1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L441).

- **Given** The selected tab is recovering after one failed image attempt.
- **When** A successful image frame coincides with a same-window endpoint replacement and the replacement viewer initializes.
- **Then** The new endpoint is used while recovery remains pending; a succeeding frame restores the viewer and input without an additional connection or error report.

## browser-automatic-recovery-007

Original test `A same-window endpoint replacement preserves recovery attempt 3`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L441).

- **Given** The selected tab is recovering after three failed image attempts.
- **When** A successful image frame coincides with a same-window endpoint replacement and the replacement viewer initializes.
- **Then** The new endpoint is used while recovery remains pending; a succeeding frame restores the viewer and input without an additional connection or error report.

## browser-automatic-recovery-008

Original test `A same-window endpoint replacement keeps the original recovery deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L483).

- **Given** Three failed image attempts have consumed 65 seconds, and the last attempt begins with one second remaining in the original recovery deadline.
- **When** The endpoint is replaced in the same window, the deadline expires, and the replacement frame fails.
- **Then** Recovery is exhausted and no further automatic attempt starts, even after four seconds. Manual reconnect restores input on the replacement endpoint without adding a report.

## browser-automatic-recovery-009

Original test `A removed selected tab hands off to a scoped successor without a final recovery error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L538).

- **Given** The selected tab is removed while its viewer is healthy, and another tab exists in the same scoped window.
- **When** The selected target is destroyed.
- **Then** The viewer hands off to the other tab, whose address is shown and accepts input. No recovery report or error log is produced.

## browser-automatic-recovery-010

Original test `A moved selected tab hands off to a scoped successor without a final recovery error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L538).

- **Given** The selected tab is healthy, another tab exists in the same scoped window, and the selected tab is moved to a different window.
- **When** The selected target moves out of scope.
- **Then** The viewer hands off to the other tab, whose address is shown and accepts input. No recovery report or error log is produced.

## browser-automatic-recovery-011

Original test `Selected-target loss from a healthy viewer waits for complete empty inventory before offering a new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L583).

- **Given** A healthy viewer has a selected tab and a sibling whose membership inventory is still pending.
- **When** The selected tab and another known tab are destroyed before inventory completes.
- **Then** The input and New tab control remain disabled, and no-tabs-open is not shown until the inventory is complete. Then New tab is enabled and creates a blank tab in the selected window without a recovery report.

## browser-automatic-recovery-012

Original test `Selected-target loss from a recovering viewer waits for complete empty inventory before offering a new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L583).

- **Given** A recovering viewer has a selected tab and a sibling whose membership inventory is still pending.
- **When** The selected tab and another known tab are destroyed before inventory completes.
- **Then** The input and New tab control remain disabled, and no-tabs-open is not shown until the inventory is complete. Then New tab is enabled and creates a blank tab in the selected window without a recovery report.

## browser-automatic-recovery-013

Original test `Closing a target after exhausted image recovery preserves its original report (pending inventory: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L642).

- **Given** Image recovery has been exhausted and reported, with no pending tab inventory.
- **When** The remaining tabs are closed and the user creates a new tab after the empty state appears.
- **Then** The no-tabs-open state appears, the new blank tab becomes ready, and the original exhaustion report remains unchanged.

## browser-automatic-recovery-014

Original test `Closing a target after exhausted image recovery preserves its original report (pending inventory: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L642).

- **Given** Image recovery has been exhausted and reported, and a new sibling tab has been created while its membership inventory is pending.
- **When** The remaining tabs are closed, inventory completes, and the user creates a new tab.
- **Then** The connecting state appears until inventory completes, then no-tabs-open appears and the new blank tab becomes ready. The original exhaustion report remains unchanged.

## browser-automatic-recovery-015

Original test `Manual selection from recovering image recovery does not revive the retired failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L708).

- **Given** Image recovery is still recovering and has not yet produced a report.
- **When** The user selects another tab while its initialization and frame are pending.
- **Then** The input remains disabled until the other tab is ready; the recovering status disappears, the new tab accepts input, and no retired failure is reported.

## browser-automatic-recovery-016

Original test `Manual selection from exhausted image recovery does not revive the retired failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L708).

- **Given** Image recovery has been exhausted and reported once.
- **When** The user selects another tab while its initialization and frame are pending.
- **Then** The other tab becomes ready and accepts input, with the original exhaustion report unchanged and no retired failure revived.

## browser-automatic-recovery-017

Original test `A new successor failure is reported after superseding an exhausted image failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L755).

- **Given** Image recovery has been exhausted and its failure reported once.
- **When** The user selects another tab whose initialization fails with an unsupported Page.enable capability error, then reconnects.
- **Then** A new terminal recovery report and the corresponding promise error are recorded for the successor failure, while the original report remains. Reconnect restores the selected tab without further reports.

## browser-automatic-recovery-018

Original test `Recovery waits for a pending descriptor and selection without reporting its remembered failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L795).

- **Given** Image recovery is pending, and a session descriptor revalidation is held while tab initialization is also pending.
- **When** The descriptor and initialization complete after time advances during recovery.
- **Then** The input stays disabled until the tab is ready, then recovery status clears. Only one descriptor read and one connection are used, and no failure is reported.

## browser-automatic-recovery-019

Original test `Retained input readmission completes recovery after toolbar interaction`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L844).

- **Given** Image recovery is pending, and a session update readmits the retained selected tab while another tab is added in the background.
- **When** The user edits the address and opens then dismisses browser settings before the retained tab is readmitted.
- **Then** The draft remains visible during recovery and is retained when the viewer becomes ready. The selected tab accepts input, and a later image failure recovers without extra connections or reports.

## browser-automatic-recovery-020

Original test `A removed image-recovery target preserves an independent pending creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L932).

- **Given** Image recovery is underway while creation of a new tab is pending.
- **When** The selected recovery target is removed and tab creation completes.
- **Then** The newly created blank tab in the selected window becomes ready and accepts input. No recovery report is produced.

## browser-automatic-recovery-021

Original test `A moved image-recovery target preserves an independent pending creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L932).

- **Given** Image recovery is underway while creation of a new tab is pending.
- **When** The selected recovery target moves to another window and tab creation completes.
- **Then** The newly created blank tab in the selected window becomes ready and accepts input. No recovery report is produced.

## browser-automatic-recovery-022

Original test `An explicit selection supersedes pending creation during image recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L970).

- **Given** Image recovery is underway while creation of a new tab is pending.
- **When** The user explicitly selects another tab before creation completes.
- **Then** The explicit selection remains active and accepts input; completion of the pending creation does not change it. A later New tab action creates a second blank tab, with no recovery report.

## browser-automatic-recovery-023

Original test `Manual retry of a retired failure permits a later independent automatic recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1002).

- **Given** Image recovery has been exhausted and reported, and the user closes another tab.
- **When** The user retries the live image and then a later image frame fails automatically.
- **Then** The viewer recovers and becomes ready. The original report remains unchanged, with no new report.

## browser-automatic-recovery-024

Original test `A failed successor reports its own terminal initialization error after target loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1031).

- **Given** The selected tab is moved out of scope, and its successor fails initialization with an unsupported Page.enable capability error.
- **When** The user reconnects from the unavailable-view state.
- **Then** One terminal recovery report identifies the successor's capability failure, and all reports concern that initialization error. Reconnect restores the successor without additional reports.

## browser-automatic-recovery-025

Original test `The refined panel shows a non-blocking recovery status without a reclaim footer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1073).

- **Given** The refined browser panel is displaying a live image when an image frame fails.
- **When** Automatic recovery begins and a later frame succeeds.
- **Then** A non-blocking reconnecting status appears while the live image remains visible; no unavailable-view message or reclaim footer appears, and recovery clears when the viewer is ready.

## browser-automatic-recovery-026

Original test `Local address editing survives recovery (binding replaced=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1093).

- **Given** The address field contains a locally edited draft with the caret after its second character, and the browser connection drops.
- **When** The user edits the draft during recovery and the binding remains unchanged when recovery succeeds.
- **Then** The field retains focus, value, and caret position. Submitting navigates the selected tab to the normalized address; Escape restores the sibling tab's address.

## browser-automatic-recovery-027

Original test `Local address editing survives recovery (binding replaced=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1093).

- **Given** The address field contains a locally edited draft with the caret after its second character, and the browser connection drops.
- **When** The user edits the draft during recovery and the binding is replaced before recovery succeeds.
- **Then** The field retains focus, value, and caret position. Submitting does not navigate either tab; Escape restores the sibling tab's address.

## browser-automatic-recovery-028

Original test `A clean address selection survives binding replacement and releases on blur`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1141).

- **Given** The address field shows the selected tab's URL, with the caret after its second character, when the browser connection drops.
- **When** The binding is replaced during recovery, then the user blurs the address field and selects a different address.
- **Then** The original address and caret survive recovery until blur; blur updates the displayed address to the sibling tab. Submitting the new address navigates that sibling, not the original tab.

## browser-automatic-recovery-029

Original test `A submitted address can start a fresh selection after connection recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1171).

- **Given** The user submits an address and its navigation is pending when the browser connection drops.
- **When** The viewer recovers, then the user places the caret in the submitted address and a duplicate-tab event arrives.
- **Then** The submitted address and caret position remain unchanged through the event and its completion.

## browser-automatic-recovery-030

Original test `Interacting with a recovered submission cannot transfer it to an automatic successor (type=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1207).

- **Given** An address submission is pending when the connection drops, recovery restores the viewer, and the selected tab is then moved out of scope.
- **When** The user focuses the address field and presses Enter without typing.
- **Then** The successor tab remains selected and its address is not changed by the old submission.

## browser-automatic-recovery-031

Original test `Interacting with a recovered submission cannot transfer it to an automatic successor (type=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1207).

- **Given** An address submission is pending when the connection drops, recovery restores the viewer, and the selected tab is then moved out of scope.
- **When** The user edits the recovered address by adding a character and presses Enter.
- **Then** The edited address remains in the field, and the successor tab's URL is not changed by the old submission.

## browser-automatic-recovery-032

Original test `An address first edited during recovery stays bound to the restored tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1245).

- **Given** The browser connection drops before the user has edited the address field.
- **When** During recovery, the user edits and submits an address before tab membership completes.
- **Then** After the restored tab is ready, the address remains selected and a subsequent submission navigates that restored tab to the normalized address.

## browser-automatic-recovery-033

Original test `Automatic connection recovery survives transient descriptors and restores the selected scoped tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1272).

- **Given** The user has selected a scoped sibling tab when the browser connection drops.
- **When** Automatic recovery encounters two transient descriptor failures, then receives a successful descriptor.
- **Then** The selected sibling tab is restored and accepts input; the out-of-scope sibling is not shown. No error log or recovery report is produced.

## browser-automatic-recovery-034

Original test `shared recovery keeps the presented picture through failed attempts and replaces it only with a fresh frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1329).

- **Given** The shared image connection is showing a live picture when the browser connection drops.
- **When** Three descriptor reads occur, the first two fail transiently, and a fresh frame arrives after recovery.
- **Then** The reconnecting status and existing picture remain through failed attempts without clearing or repainting; no unavailable-view or alert appears. The fresh frame replaces the picture once, and no failure message appears.

## browser-automatic-recovery-035

Original test `split recovery keeps the presented picture through failed attempts and replaces it only with a fresh frame`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1329).

- **Given** The separate image connection is showing a live picture when the browser connection drops.
- **When** Three descriptor reads occur, the first two fail transiently, and a fresh frame arrives after recovery.
- **Then** The reconnecting status and existing picture remain through failed attempts without clearing or repainting; no unavailable-view or alert appears. The fresh frame replaces the picture once, and no failure message appears.

## browser-automatic-recovery-036

Original test `shared connection recovery preserves pixels and rejects a late decode from its retired frame generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1424).

- **Given** The viewer is ready and an image decode is in progress when the shared connection drops.
- **When** Automatic recovery reconnects the browser, then the old image decode completes.
- **Then** The existing picture is not cleared, the late image is closed without being painted, and the reconnecting notice ends.

## browser-automatic-recovery-037

Original test `split connection recovery preserves pixels and rejects a late decode from its retired frame generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1424).

- **Given** The viewer is ready in split-connection mode and an image decode is in progress when the connection drops.
- **When** Automatic recovery reconnects the browser, then the old image decode completes.
- **Then** The existing picture is not cleared, the late image is closed without being painted, and the reconnecting notice ends.

## browser-automatic-recovery-038

Original test `A different selected target clears the previous picture while its first frame is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1470).

- **Given** The original browser tab is selected and its picture is visible.
- **When** The user selects another tab before its first frame arrives.
- **Then** The previous picture is cleared, the canvas is hidden, and browser input stays disabled until the new tab is ready.

## browser-automatic-recovery-039

Original test `Definitive authorization loss during attempt clears the picture and ends the reconnecting notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1488).

- **Given** A picture is visible while automatic recovery is trying to reconnect.
- **When** The recovery attempt receives HTTP 403 authorization denial.
- **Then** The picture is cleared, the reconnecting notice ends, input stays disabled, and recovery stops as terminal without a second retry.

## browser-automatic-recovery-040

Original test `Definitive authorization loss during pacing clears the picture and ends the reconnecting notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1488).

- **Given** A picture is visible while automatic recovery is waiting between attempts.
- **When** A session-change notification causes a recovery request that receives HTTP 403 authorization denial.
- **Then** The picture is cleared, the reconnecting notice ends, input stays disabled, and recovery stops as terminal without another retry.

## browser-automatic-recovery-041

Original test `Automatic shared image recovery retains healthy control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1542).

- **Given** The viewer is ready with a healthy control connection in shared-connection mode.
- **When** An image failure triggers automatic recovery.
- **Then** The existing picture remains, recovery restores readiness, and subsequent text input works on the existing connection without errors or reports.

## browser-automatic-recovery-042

Original test `Automatic split image recovery retains healthy control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1542).

- **Given** The viewer is ready with a healthy control connection in split-connection mode.
- **When** An image failure triggers automatic recovery.
- **Then** The existing picture remains, recovery restores readiness, and subsequent text input works on the existing connection without errors or reports.

## browser-automatic-recovery-043

Original test `Exhausted automatic recovery stops after three attempts and permits a fresh manual operation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1577).

- **Given** The viewer is ready, but browser recovery requests keep failing with HTTP 500.
- **When** Automatic recovery makes three attempts, then the user waits and manually reconnects after the service becomes available.
- **Then** Automatic recovery stops with the final error and an enabled Reconnect button; the manual action succeeds with a fourth request.

## browser-automatic-recovery-044

Original test `HTTP 403 is terminal until an explicit recovery action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1643).

- **Given** Initial browser loading receives HTTP 403 and the viewer shows that it is unavailable.
- **When** The user waits, then explicitly chooses Reconnect after authorization becomes available.
- **Then** The denial does not retry automatically; the explicit action makes a new request and succeeds.

## browser-automatic-recovery-045

Original test `HTTP 409 is terminal until an explicit recovery action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1643).

- **Given** Initial browser loading receives HTTP 409 and the viewer shows that it is unavailable.
- **When** The user waits, then explicitly chooses Reconnect after the conflict is resolved.
- **Then** The conflict does not retry automatically; the explicit action makes a new request and succeeds.

## browser-automatic-recovery-046

Original test `The episode ceiling ends a stalled descriptor and late work cannot start another budget`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1688).

- **Given** A browser navigation request is still pending when the connection fails and recovery begins.
- **When** Recovery reaches its 180-second episode ceiling while a descriptor request is stalled, then the request is released and the user manually reconnects.
- **Then** Recovery ends with an error and reports the exhausted episode; late work does not start another automatic budget, and manual reconnection succeeds without changing the pending navigation outcome.

## browser-automatic-recovery-047

Original test `Missing initial paint recovers automatically and rejects the retired first image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1760).

- **Given** The initial browser viewer has not received its first frame for 31 seconds.
- **When** Automatic recovery runs and the original delayed frame arrives afterward.
- **Then** The viewer becomes ready, the retired initial image does not displace it, and new text input works.

## browser-automatic-recovery-048

Original test `The episode ceiling shows its final error while the last native bootstrap is still pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1784).

- **Given** Automatic recovery is on its third native bootstrap, which remains pending.
- **When** The 180-second episode ceiling is reached, then the user manually reconnects before releasing the old bootstrap.
- **Then** The final timeout error is shown while the old bootstrap is pending; manual recovery succeeds, removes the error, and the late bootstrap does not create another report.

## browser-automatic-recovery-049

Original test `A split image socket is replaced without replacing its healthy control socket`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1826).

- **Given** The viewer is ready with separate image and control connections, and text input works on the control connection.
- **When** The image connection drops and automatic recovery runs.
- **Then** A new image connection is created while the control connection remains in use for subsequent text input; no error report is produced.

## browser-automatic-recovery-050

Original test `The final split image failure retains its original connection observations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1864).

- **Given** The viewer is ready in split-connection mode and the image connection drops.
- **When** Automatic recovery reaches its episode ceiling, then the user retries the live image.
- **Then** The final report retains the original image-connection close details, including code 1006 and an unclean close, and the manual retry restores readiness.

## browser-automatic-recovery-051

Original test `Manual recovery serializes its transient failures with automatic policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1904).

- **Given** Initial browser loading fails with HTTP 403 and the viewer offers manual reconnect.
- **When** The user reconnects while the service changes from a transient HTTP 500 failure to success.
- **Then** The manual failure is serialized with recovery policy; the reconnect button is disabled during the transient failure and readiness returns after the next attempt.

## browser-automatic-recovery-052

Original test `Pausing cancels recovery pacing and resuming recovers the current owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1949).

- **Given** The viewer is recovering after its connection drops.
- **When** The user hides the page, waits 61 seconds, and then makes it visible again.
- **Then** Recovery pacing is canceled while hidden; resuming reconnects the current browser, and text input works without reports or errors.

## browser-automatic-recovery-053

Original test `Selecting another tab cancels held automatic image recovery and old pixels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1980).

- **Given** Automatic image recovery is holding a replacement frame for the selected original tab.
- **When** The user selects another tab and the held old frame is released later.
- **Then** The new tab becomes ready and later input goes to that tab; the old recovery does not replace the selection.

## browser-automatic-recovery-054

Original test `A binding replacement cancels a held automatic bootstrap`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2009).

- **Given** Automatic recovery is holding a browser bootstrap for the current binding.
- **When** The binding is replaced and the new tab becomes ready before the old bootstrap is released.
- **Then** The old bootstrap does not clear the new picture or disrupt the new selection, which continues to accept input.

## browser-automatic-recovery-055

Original test `A chat replacement cancels a held automatic bootstrap`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2009).

- **Given** Automatic recovery is holding a browser bootstrap for the current chat.
- **When** The user navigates to a different chat and its new tab becomes ready before the old bootstrap is released.
- **Then** The old bootstrap does not clear the new picture or disrupt the new selection, which continues to accept input.

## browser-automatic-recovery-056

Original test `Unmounting during recovery clears the retained surface and cancels further attempts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2064).

- **Given** The viewer is recovering after a connection drop while retaining its picture.
- **When** The user leaves the browser viewer before another attempt begins.
- **Then** The picture and reconnecting notice are cleared, the viewer is removed, and no further attempts or reports occur.

## browser-automatic-recovery-057

Original test `Automatic recovery never replays uncertain input after connection loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A text input action has been sent but its completion is uncertain.
- **When** The browser connection drops and automatic recovery restores readiness.
- **Then** The uncertain text input is not replayed; a later fresh input is accepted, and no errors or reports occur.

## browser-automatic-recovery-058

Original test `Automatic recovery never replays uncertain input after worker loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A text input action has been sent but its completion is uncertain.
- **When** The native worker is replaced and automatic recovery restores readiness.
- **Then** The uncertain text input is not replayed; a later fresh input is accepted, and no errors or reports occur.

## browser-automatic-recovery-059

Original test `Automatic recovery never replays uncertain navigation after connection loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A navigation action to next.example has been sent but its completion is uncertain.
- **When** The browser connection drops and automatic recovery restores readiness.
- **Then** The navigation is not replayed; the address remains at next.example, and a later fresh input is accepted without errors or reports.

## browser-automatic-recovery-060

Original test `Automatic recovery never replays uncertain navigation after worker loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A navigation action to next.example has been sent but its completion is uncertain.
- **When** The native worker is replaced and automatic recovery restores readiness.
- **Then** The navigation is not replayed; the address remains at next.example, and a later fresh input is accepted without errors or reports.

## browser-automatic-recovery-061

Original test `Automatic recovery never replays uncertain creation after connection loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A new-tab creation action has been sent but its completion is uncertain.
- **When** The browser connection drops and automatic recovery restores readiness.
- **Then** The creation action is not replayed, so only one created tab exists; a later fresh input is accepted without errors or reports.

## browser-automatic-recovery-062

Original test `Automatic recovery never replays uncertain creation after worker loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2098).

- **Given** A new-tab creation action has been sent but its completion is uncertain.
- **When** The native worker is replaced and automatic recovery restores readiness.
- **Then** The creation action is not replayed, so only one created tab exists; a later fresh input is accepted without errors or reports.

## browser-automatic-recovery-063

Original test `Unsupported capability loss is terminal rather than an automatic retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2162).

- **Given** Initial browser setup encounters an unsupported Page.enable capability.
- **When** The viewer handles the capability failure, then the user waits and explicitly reconnects.
- **Then** Automatic recovery stops as terminal and offers Reconnect; the explicit action succeeds.

## browser-automatic-recovery-064

Original test `A reclaimed window cannot recover by using the sibling window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2185).

- **Given** The browser's assigned window is reclaimed while a sibling window exists.
- **When** The user later opens a browser session assigned to the sibling window.
- **Then** Recovery does not use the sibling window for the reclaimed assignment; the new session connects to the sibling with its own single target.

## browser-automatic-recovery-065

Original test `A healthy static viewer survives a failed HTTP heartbeat without reconnecting`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2224).

- **Given** The static browser viewer is healthy and its HTTP lease heartbeat fails once with HTTP 503.
- **When** The user waits 61 seconds and enters text.
- **Then** The viewer remains connected and accepts the text without opening another connection.

## browser-automatic-recovery-066

Original test `A transient native read recovers the selected tab on the existing control connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2267).

- **Given** The user has selected the Other tab and the browser control connection is healthy.
- **When** A native tab event triggers a transient read failure, followed by automatic recovery.
- **Then** The selected tab becomes ready again, text input works on its page, and recovery uses the existing control connection.

## browser-automatic-recovery-067

Original test `A transient network descriptor failure permits the next recovery attempt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2295).

- **Given** The browser is ready and its connection drops.
- **When** The first recovery descriptor request fails at the network level and a later request succeeds.
- **Then** Recovery continues after the transient network failure and restores readiness on the next attempt.

## browser-automatic-recovery-068

Original test `A transient http-503 descriptor failure permits the next recovery attempt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2295).

- **Given** The browser is ready and its connection drops.
- **When** The first recovery descriptor request fails with HTTP 503 and a later request succeeds.
- **Then** Recovery continues after the transient service failure and restores readiness on the next attempt.

## browser-automatic-recovery-069

Original test `Native worker replacement recovers without leaving the assigned window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2349).

- **Given** The user has selected the Other tab in the assigned browser window.
- **When** The native worker is replaced and automatic recovery runs.
- **Then** The selected tab becomes ready again, text input works there, and the sibling window is not shown as a tab.

## browser-automatic-recovery-070

Original test `Rejected navigation remains local and does not trigger resource replay`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2374).

- **Given** The browser is healthy and a navigation to unreachable.example is rejected by name resolution.
- **When** The user submits that navigation and later enters text.
- **Then** The failure remains local to the rejected navigation: it is not replayed, the browser stays connected, later text input works, and one navigation fault is reported.

## browser-automatic-recovery-071

Original test `Repeated missing retry images recover locally within the original budget`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2443).

- **Given** The remote browser is ready and a frame is missing.
- **When** Two image retry attempts also receive no image, then 4 seconds pass.
- **Then** The browser recovers without opening another connection, the canvas is not cleared, and text entered afterward reaches the remote browser.

## browser-automatic-recovery-072

Original test `Exhausted local image recovery permits a new manual image retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2468).

- **Given** The remote browser is ready and a frame is missing.
- **When** All three local image recovery attempts fail and the user selects Retry live image.
- **Then** A retry button is enabled after recovery is exhausted, with one exhaustion report. The browser becomes ready again without another connection, accepts subsequent text, and does not report a second exhaustion.

## browser-automatic-recovery-073

Original test `Automatic recovery accepts an authoritative empty window without creating a tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2500).

- **Given** The connected browser loses its two existing targets and disconnects.
- **When** Automatic recovery runs with the authoritative window empty.
- **Then** The app shows “No tabs open” and enables New tab; it does not create a tab or show the sibling window’s tab.

## browser-automatic-recovery-074

Original test `Remote tab activation replaces the target restored by pending automatic recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2522).

- **Given** The browser is ready on the original page and automatic recovery is pending after a missing frame.
- **When** A remote event selects the Other tab, then the browser disconnects and recovers.
- **Then** Other remains selected, the address becomes https://other.example, and text entered afterward is sent through that tab’s remote session.

## browser-automatic-recovery-075

Original test `Control loss during shared image retry continues the same recovery budget`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2578).

- **Given** The browser is ready in shared connection mode and an image retry is in progress when control is lost.
- **When** Automatic recovery continues for the shared connection.
- **Then** The same recovery budget continues, the browser becomes ready, and subsequent text reaches the remote browser.

## browser-automatic-recovery-076

Original test `Control loss during split image retry continues the same recovery budget`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2578).

- **Given** The browser is ready in separate image connection mode and an image retry is in progress when control is lost.
- **When** Automatic recovery continues for the separate image connection.
- **Then** The same recovery budget continues, the browser becomes ready, and subsequent text reaches the remote browser.

## browser-automatic-recovery-077

Original test `Control loss after image retry leaves only two connection attempts before exhaustion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2600).

- **Given** The browser loses control during image retry, and subsequent browser-session requests return service-unavailable errors.
- **When** Two recovery attempts occur at 2-second and then 4-second intervals; after exhaustion and a 61-second wait, the user selects Reconnect when the service is available.
- **Then** Recovery exhausts after exactly two requests and enables Reconnect. Selecting it starts a third request and restores the ready browser.
