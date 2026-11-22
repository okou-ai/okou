# Platform test rebuild checkpoint continuation

## Batch 71 evidence

The opening head was `4178756cbae8fe773bd18f183da9d1a49b5ba219` and the synchronized main was `03233f4ebe14b7ea240948a4a081e1469df2b149`. The original checkpoint links here. [Earlier batches](test-rebuild-rework-checkpoint.md)

The 30 passing registrations below consist of 23 nominees and seven browser-viewer-interaction substitutes. Prior session cases 002 and 003 passed as regressions. The three files keep their complete BDD. Historical first acceptances rose from 1,340 to 1,370/2,681 and current full coverage from 1,323 to 1,353/2,681. Within the withdrawal cohort the counts are 420 historical and 413 current of 506. Outside it, 950 historical and 940 current of 2,175. The 252 closed files cover 868 selections including five retirements. Current coverage in 233 open files rose from 460 to 490 of 1,813 selections.

[30-row GWT crosswalk](https://app.okou.ai/artifacts/s86dk9lnfp.tsv) · [Mutation diffs and boundary-probe receipts](https://app.okou.ai/artifacts/nvu91603l5.md)

### Design and verification

The suites enter the production Router through setupPage, including the native viewer fixture. Tests operate toolbar controls, tab selection, address entry, menu dismissal and browser history. Local HTTP, CDP, geometry, permission events and streaming frames model external boundaries. Permission scenarios use a projected chat snapshot and message-port SharedWorker transport. For 055 the local browser history contains the previously visited other chat and the current viewer before Back. The old request’s abort signal, new lease owner, selected tab and actual address establish the transition.

The 30 targeted rows passed and the three entire files passed 32/32. Shuffling 13 affected files (seed 71043) passed 112/112, including 82 existing rows. Three TypeScript projects, applicable ESLint, oxlint, type-aware oxlint and formatting were checked. The change adds two executed files and 30 rows to the 326/1,355 opening baseline. The synchronized main includes Android #49856 and the #49899 release versions and changelogs. Neither adds a Platform execution row. See the PR description for the per-shard readback and independent gates. The original 86 withdrawal dispositions, 17 later evidence losses and 68 upstream selections keep their owners. Browser-address-search-004, keyboard-shortcut-hints-003, the fourteen batch 69 gaps, link-navigation-005, chat-activity-summary-002 and billing-survey-004 retain their earlier evidence.

[AGENTS.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/AGENTS.md) · [docs/testing.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/docs/testing.md) · [docs/app/app-testing.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/docs/app/app-testing.md) · [docs/app/platform-ccstate.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/docs/app/platform-ccstate.md) · [docs/app/signals/settle.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/docs/app/signals/settle.md) · [docs/chat.md](https://github.com/okou-ai/okou/blob/4178756cbae8fe773bd18f183da9d1a49b5ba219/docs/chat.md)

### Failure controls

| ID                             | Temporary production change                                                     | Failure observed                                                                     | Restored result |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------- |
| browser-display-regression-001 | Subtract ten pixels from the measured canvas width.                             | The fitted native window measured 890×600 at the 900×600 assertion.                  | Passed          |
| browser-session-page-007       | Apply quality during slider movement.                                           | The CDP capture diverged from 70 while the draft showed 25 and the pointer was held. | Passed          |
| browser-session-page-008       | Commit the quality draft when the submenu closes on Escape.                     | The reopened text field showed 25 where 70 was required.                             | Passed          |
| browser-session-page-050       | Ignore primary window ID when classifying lease replies from the same instance. | The address stayed on example.com where the window-1 URL was required.               | Passed          |

### Post-authoring comparison

The scan compared four normalized consecutive lines across 1,901 historical TypeScript blobs and 820 paths, including both pre-withdrawal trees, rename history, the frozen tree, the opening branch, main, mocks and helpers. The six cross-file sequences were imports. The previously accepted session rows and existing CDP fixture account for the bulk of exact matches. In the new scenario bodies the four-line preset table repeats the three label/value pairs required by 006. The CDP fixture adds a target-specific filter over delivered input, with no test flow or assertions.

Each row below links the individual frozen registration and rewritten source. Inspection of the corresponding old bodies and helpers found shared fixtures, menu vocabulary and required action sequences. The new admission cases hold a target-specific membership proof and inspect the actual selected remote page. Stream quality tests read the current capture and visible draft separately. The lease cases preserve distinct ownership using request signals, distinct tab titles and concrete readbacks. The two external response shapes assumed by old 024/025 have become one acquisition, and an installed pending handler alone cannot prove either Given.

[before-zero-page-rename](https://github.com/okou-ai/okou/commit/8924f63dade934b3caa6d5629013447a6c70fc3c) · [after-zero-page-rename](https://github.com/okou-ai/okou/commit/0f0ded9b208cbeb41998c04f43db70ac1cf11d22) · [freeze](https://github.com/okou-ai/okou/commit/b0a10287edf4242383c28e39c6f7675053febb32) · [before-first-withdrawal](https://github.com/okou-ai/okou/commit/5310dbb9ba6bd8b95507bc7293f6da3ed8aa004b) · [restored](https://github.com/okou-ai/okou/commit/b666cd050364ef31821b71fee4e14802a9e8476b) · [before-second-withdrawal](https://github.com/okou-ai/okou/commit/a445586e0483bb7e2440e60200a8deed30aa3df9) · [opening](https://github.com/okou-ai/okou/commit/4178756cbae8fe773bd18f183da9d1a49b5ba219) · [upstream](https://github.com/okou-ai/okou/commit/03233f4ebe14b7ea240948a4a081e1469df2b149)

### Open nominees

- [browser-session-page-010](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-010). The production acquisition returns a suspended browser and null viewer for idle reclamation. That response showed Browser not live and Start browser. An active/null response also failed to show the required unavailable text. The separate historic connection read returning BROWSER_NOT_LIVE has no matching current service path.
- [browser-session-page-014](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-014). The 900×600 viewer and held replacement GET were observed. Input became disabled while the previous live canvas remained visible. Resizing at that point cannot establish a measurement taken while concealed; the original concealment prerequisite remains open.
- [browser-session-page-024](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-024). An initial native session GET denied with the authorization code displayed the correct permission panel. At that visible outcome the deferred lease arrival was still unset. A handler prepared to wait is insufficient evidence of a pending request.
- [browser-session-page-025](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-025). The native GET returns session and connection together. The initial denial produced the permission panel with no lease arrival. The probe cannot isolate an initial connection denial with a concurrent lease.
- [browser-session-page-034](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-034). Same-window reload completed its acquisition and restored usable input while the old renewal was held. At that point the new lease had not arrived. Waiting for it with the older lease unresolved also timed out. Releasing first changes the required order.
- [browser-session-page-035](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-035). The new grant reached its lease while the old HTTP handler still waited. The original request signal was already aborted by that transition. A later denial cannot establish independence from a still-live old lease.
- [browser-session-page-036](src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-036). The permission change disabled input during the held grant revalidation. The original lease request signal was already aborted before a late denial could be delivered to the viewer.

## First acceptances in batch 71

### browser-display-regression-001

[Open GWT](src/views/browser-session/__tests__/browser-display-regression.bdd.md#L6) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L143) · [Passing test](src/views/browser-session/__tests__/browser-display-regression.test.tsx#L47)

- Given The remote browser's primary window is minimized and a foreign window is fullscreen.
- When The viewer opens.
- Then The primary window is restored to normal, fitted to the 900-by-600 panel, and its input is enabled without an alert. The foreign window remains fullscreen, and only the primary window receives a restore request.
- Observed With primary 12 minimized and sibling 77 fullscreen, opening the Router restores and fits 12 to 900×600 with enabled input and no alert. Every observed window-restore command targets 12 and the sibling stays fullscreen.
- Write-after-GWT comparison. Distinct native window IDs and initial states expose an accidental cross-window restoration, even if input appears ready.
- Vitest `browser-display-regression-001 Opening restores and fits only the assigned minimized window`.

### browser-display-regression-004

[Open GWT](src/views/browser-session/__tests__/browser-display-regression.bdd.md#L30) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L179) · [Passing test](src/views/browser-session/__tests__/browser-display-regression.test.tsx#L75)

- Given The viewer is calibrated to 900 by 600 and has received a frame. The primary window is then maximized at 1280 by 720.
- When The user selects “Fit window to panel” while the next native frame is held.
- Then The window becomes normal and the viewport stays at 1280 by 720 until a fresh frame arrives. While that frame is pending, the fit option is disabled; after release, the viewport becomes 900 by 600, input is enabled, and no alert appears.
- Observed The acknowledged 900×600 frame precedes maximization. After Fit restores the window, the held next frame leaves the native viewport at 1280×720 and Fit disabled. Releasing it yields 900×600, enabled input and no alert.
- Write-after-GWT comparison. The first calibration frame is acknowledged. The later held target frame separates a completed native restore from a still-disabled fit action.
- Vitest `browser-display-regression-004 Fit waits for a replacement frame before changing the viewport`.

### browser-display-regression-005

[Open GWT](src/views/browser-session/__tests__/browser-display-regression.bdd.md#L38) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L216) · [Passing test](src/views/browser-session/__tests__/browser-display-regression.test.tsx#L101)

- Given The primary window is maximized and automatic restoration fails while preparing native capture.
- When After the failure, the user minimizes the window and selects “Fit window to panel.”
- Then The first failure is shown as an operation error. The later explicit fit restores the window to normal, sets the viewport to 900 by 600, enables input, and clears the alert.
- Observed The first native restore is rejected and the visible operation alert appears. After minimizing, the user explicitly fits the viewport. The window becomes normal at 900×600 with enabled input and the alert clears.
- Write-after-GWT comparison. The initial CDP restore is rejected at its native boundary. The explicit second fit follows the visible operation error.
- Vitest `browser-display-regression-005 An explicit fit recovers from capture preparation failure`.

### browser-display-regression-006

[Open GWT](src/views/browser-session/__tests__/browser-display-regression.bdd.md#L46) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-display-regression.test.tsx#L242) · [Passing test](src/views/browser-session/__tests__/browser-display-regression.test.tsx#L113)

- Given The viewer is calibrated at 900 by 600 and has received a frame. The primary window is maximized at 1280 by 720, and its pending calibration frame is held.
- When The user selects “Fit window to panel,” then a resize invalidates the held frame and the window is minimized before the pending native observation completes.
- Then The window is restored to normal and fitted to 900 by 600, input is enabled, and no alert appears.
- Observed Fit starts from a painted, calibrated 900×600 viewport. A pending native window observation spans an actual frame-resized event and minimization. When that observation finishes the window returns to normal at 900×600 with enabled input, visible image and no alert.
- Write-after-GWT comparison. The pending native window observation straddles the frame resize and minimization. The fitted result is read after that observation completes.
- Vitest `browser-display-regression-006 A resize supersedes the held calibration of a minimized window`.

### browser-session-page-004

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L30) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L346) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L136)

- Given An active browser has image quality applied at 70.
- When The user clears the quality field, types 100, and presses Enter after ending composition; then types 0 and blurs the field.
- Then Typing alone does not change applied quality. Enter applies 100, and blur applies 0. Enter and Escape during composition do not apply or dismiss the edit; the quality menu remains open.
- Observed Clearing shows an empty field. Typed 100 remains a draft through composing Enter and Escape with the menu visible and remote capture at 70. Enter after composition changes capture to 100. Typing 0 leaves it at 100 until blur applies 0.
- Write-after-GWT comparison. The shared quality submenu is the entry point. Capture settings are read before submission, after IME keys, and after each distinct commit.
- Vitest `browser-session-page-004 Enter after composition and blur apply the typed endpoints`.

### browser-session-page-006

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L46) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L419) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L158)

- Given An active browser has the image-quality menu open with Balanced selected at 70.
- When The user selects Data saver, Sharper, and Balanced, adjusts the slider to its endpoints with End and Home, then edits the field and presses Escape twice.
- Then The presets apply 40, 90, and 70 respectively. End applies 100 and Home applies 0 while the slider keeps focus. The first Escape closes the menu without applying the draft and focuses the Image quality menu item; the second returns focus to Browser settings.
- Observed Balanced starts checked. The three menu choices produce remote capture quality 40, 90 and 70. End and Home produce 100 and 0 with focus on the slider. Escape discards 51, keeps capture at 0 and focuses Image quality. The next Escape focuses Browser settings.
- Write-after-GWT comparison. The four-line match consists of the mandated preset values. The test independently exercises both endpoint keys and reads focus after each dismissal.
- Vitest `browser-session-page-006 Presets and slider endpoints preserve Escape focus`.

### browser-session-page-007

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L54) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L474) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L661)

- Given An active browser has applied image quality 70, and the user has drafted 85 in the numeric field.
- When The user drags the quality slider to 25 and then 60, releasing at 60.
- Then The field follows the drag while applied quality remains 70 until release; after release, quality 60 is applied.
- Observed Starting with 85 drafted and 70 applied, pointer positions 25 and 60 change the text while the remote capture remains at 70. The release at 60 changes the capture to 60.
- Write-after-GWT comparison. Pointer coordinates come from the local control bounds. The initial text edit, live draft and committed CDP capture are checked independently.
- Vitest `browser-session-page-007 The numeric draft follows a drag before remote capture applies it on release`.

### browser-session-page-008

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L62) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L523) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L673)

- Given An active browser has applied quality 70 and its quality slider is being dragged to 25.
- When The user presses Escape while pointer-move and pointer-up events to 90 are queued during menu dismissal, then reopens the quality menu.
- Then The menu closes without applying the queued drag; reopening shows 70, and the Image quality menu item is not disabled.
- Observed The open slider shows 25 while capture is 70. Escape and trailing pointer events at 90 share one interaction batch. Reopening the enabled quality option shows 70 in both the text field and remote capture.
- Write-after-GWT comparison. Dismissal and the trailing movement and release are dispatched in the same React interaction. Reopening reads the resulting value.
- Vitest `browser-session-page-008 Escape dismisses before queued pointer events can apply a quality change`.

### browser-session-page-009

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L70) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L567) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L195)

- Given An active browser has applied quality 70, and the user has drafted 85 in the quality field.
- When The user selects Sharper, switches the image format to PNG, then switches it to JPEG.
- Then Sharper applies 90 instead of the draft 85. PNG is applied and Lossless is disabled; switching to JPEG applies JPEG at quality 90, and reopening the format menu shows JPEG selected.
- Observed Sharper replaces 85 with 90 in the field and stream. PNG starts lossless capture and disables the Lossless option. Switching to JPEG starts capture at 90 and the reopened format menu checks JPEG.
- Write-after-GWT comparison. The pending draft is checked on the live field and the final format checked through a freshly opened radio menu.
- Vitest `browser-session-page-009 The Sharper preset survives a PNG round trip`.

### browser-session-page-016

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L126) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L781) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L593)

- Given A null-URL browser viewer is streaming through a browser runtime, and text input to the old page is pending.
- When The browser session replaces the runtime identity, the replacement viewer loads, and the user types fresh text.
- Then The fresh text reaches the replacement page, not the old connection; the address shows the replacement page URL.
- Observed A key acknowledgement is held on the original null-URL runtime. The service replaces the runtime and window, the Address changes to the replacement URL, and the fresh q is received on the new target only. Attribution uses the CDP attachment that actually received the input.
- Write-after-GWT comparison. The receipt is matched to its actual CDP target using a transport-only lookup. The capture and input sessions can have different IDs.
- Vitest `browser-session-page-016 Input on a replacement runtime reaches its own tab`.

### browser-session-page-017

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L134) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L873) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L248)

- Given A healthy viewer is open in window 0 with a provider URL.
- When The browser session is revalidated and its replacement connection is loading, then the user attempts stale input; after it completes, the user types fresh input.
- Then Stale input is not sent while input is disabled. Fresh input is sent to the current page, and no alert appears.
- Observed Window 0 with a provider URL first streams Example. During the held acquisition, the remote input is disabled. None of the letters in stale reaches Example. After release the current target receives z and the viewer has no alert.
- Write-after-GWT comparison. The input fence is exercised on the mounted control with a non-null provider URL and checked against the recipient of fresh and stale text.
- Vitest `browser-session-page-017 Window zero fences input while its replacement loads`.

### browser-session-page-018

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L142) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L873) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L249)

- Given A healthy viewer is open in window 0 without a provider URL.
- When The browser session is revalidated and its replacement connection is loading, then the user attempts stale input; after it completes, the user types fresh input.
- Then Stale input is not sent while input is disabled. Fresh input is sent to the current page, and no alert appears.
- Observed Window 0 with a null provider URL first streams Example. The input is disabled during the held acquisition. After release the current target receives z, none of the attempted stale text, and the viewer has no alert.
- Write-after-GWT comparison. The same specified action is separately executed with a null provider URL and the original window-0 assignment.
- Vitest `browser-session-page-018 Window zero fences input while its replacement loads`.

### browser-session-page-022

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L174) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1039) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L297)

- Given A stopped browser page has an initial address field containing text entered during composition before the browser is restarted.
- When The user restarts the browser, enters “annual report,” and presses Enter.
- Then The Search Google button is enabled, and the address becomes the Google search URL for “annual report.”
- Observed The stopped address receives a composition draft. Clicking Start browser returns enabled remote input. Entering annual report enables Search Google. Enter produces the exact Google URL in the field and selected remote page.
- Write-after-GWT comparison. The stopped form receives composition input before restart. The final search is verified on both the visible address and the remote target.
- Vitest `browser-session-page-022 A restarted viewer searches after an unfinished composition`.

### browser-session-page-023

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L182) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1127) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L700)

- Given A browser viewer has an earlier blocked address hint, and chat authorization is renewed while another membership check is pending.
- When The user submits a new address during the renewed viewer session, then the pending check completes.
- Then The earlier blocked hint is cleared on renewal; the new address is blocked while the check is pending, the page remains at example.com, and the hint disappears when the check completes.
- Observed The first pending membership check produces a readiness hint. Renewal clears it while a fresh proof is held. Entering a different destination raises a new hint, with the remote tab still at example.com. Releasing the fresh proof clears that hint and leaves the tab there.
- Write-after-GWT comparison. The held external proofs distinguish the old hint, the new refused submission and the removal following the new proof.
- Vitest `browser-session-page-023 A new permission grant clears an earlier blocked address before membership settles`.

### browser-session-page-028

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L222) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1344) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L235)

- Given A healthy viewer is open while its lease renewal is pending.
- When The renewal is denied for missing authorization.
- Then The authorization message appears and the remote input and live browser view are removed, without showing “Browser not live.”
- Observed The real mounted lease arrived with a live request and streaming input. Its 403 response replaces the image and remote input with the permission message in the page, without a native disconnect.
- Write-after-GWT comparison. The received HTTP request establishes a live, pending lease before the 403. The UI outcome is verified without emitting a CDP disconnect.
- Vitest `browser-session-page-028 Lease denial removes the still-connected native view`.

### browser-session-page-032

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L254) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1445) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L328)

- Given An active browser is denied because chat authorization is disabled.
- When Chat authorization is restored, then disabled again.
- Then The active viewer streams after restoration. Revoking authorization again removes remote input and shows the authorization placeholder, not “Browser not live.”
- Observed A denied session shows the permission message. A persisted chat permission event restores the native stream. The next revocation removes input and restores the authorization message without exposing the paused state.
- Write-after-GWT comparison. The saved thread permissions arrive through the page’s message-port transport, with two different authorized states served by the backend.
- Vitest `browser-session-page-032 Service permission restored then revoked removes the active viewer`.

### browser-session-page-037

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L294) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1632) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L440)

- Given A healthy shared browser viewer is open with cached browser permission, and its initial lease renewal is pending.
- When The renewal is denied, then permission is disabled and re-enabled in a batch.
- Then The viewer becomes usable again and the authorization-denied message is cleared.
- Observed The cached thread grants permission, and the open viewer streams while its lease waits. Completing the denial displays the permission panel. The paired revoke and grant events restore the stream and clear the denial.
- Write-after-GWT comparison. The local initial projection models a cached grant. A completed 403 must actually show the warning before the event batch restores streaming.
- Vitest `browser-session-page-037 A batched grant change clears a completed lease denial`.

### browser-session-page-038

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L302) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1667) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L488)

- Given A healthy shared browser viewer is open and a lease renewal fails with a temporary 503 outage.
- When A later renewal confirms that the browser has expired and the session is suspended.
- Then The page shows “Browser not live” and an enabled “Start browser” button; the authorization-denied message is absent.
- Observed An initial 503 is followed by the recovery lease. Its 409 triggers a fresh acquisition showing a suspended browser. Browser not live and enabled Start browser appear without an authorization warning.
- Write-after-GWT comparison. The recovery response uses 409 and a distinct suspended acquisition. It has a separate expanded title from the 404 case.
- Vitest `browser-session-page-038 Expiry confirmed after a transient renewal exposes Start browser`.

### browser-session-page-039

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L310) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L525)

- Given A mounted browser panel is usable and its lease renewal receives a transient HTTP 502 failure.
- When The panel recovers and renews its lease again.
- Then The failure is recorded as HTTP 502, address editing remains usable, and the viewer is streaming.
- Observed After a 502 the next lease arrives and the external log has the failed thread and status 502. Typing x appends to the address while the live picture remains visible and remote input enabled.
- Write-after-GWT comparison. The local logging boundary and arrival of the next lease are paired with editing and the still-visible native stream.
- Vitest `browser-session-page-039 A gateway failure is reported and the next lease leaves the viewer editable`.

### browser-session-page-045

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L358) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1826) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L489)

- Given A healthy shared browser viewer is open and a lease renewal fails with a temporary capacity error.
- When The recovery renewal confirms the browser is expired with status 404.
- Then The page shows “Browser not live” and an enabled “Start browser” button; one heartbeat failure is recorded.
- Observed A recoverable capacity failure is followed by a new lease. Its 404 and the subsequent suspended acquisition show Browser not live and an enabled Start browser. The external log records the single heartbeat failure for this thread.
- Write-after-GWT comparison. The 404 expiry is delivered only after the failed lease round. The suspended UI and recorded failure are both checked.
- Vitest `browser-session-page-045 Expiry confirmed after a transient renewal exposes Start browser`.

### browser-session-page-050

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L398) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1960) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L542)

- Given A browser viewer is open with its native window at primary window 0 and a lease renewal is pending.
- When The renewal responds with status 200 after the browser's window changes to primary window 1.
- Then The tab list changes to “Other chat,” the viewer remains streaming, and another renewal starts.
- Observed The initial selected tab is First chat in window 0. The 200 lease naming window 1 replaces it with selected Other chat at its distinct URL. The old tab disappears, the view streams, and a subsequent lease arrives.
- Write-after-GWT comparison. Distinct tab titles and URLs distinguish primary windows. Ignoring just the changed window ID was caught by this row.
- Vitest `browser-session-page-050 The renewed window supplies its own tab and subsequent lease`.

### browser-session-page-053

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L422) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L2015) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L732)

- Given A browser viewer has suffered a transient lease failure and a replacement browser connection is being loaded.
- When A late renewal reports the original session after the replacement has a different instance ID.
- Then The replacement viewer becomes usable, a subsequent renewal starts, and address editing remains usable at https://example.comx; one heartbeat failure is recorded.
- Observed After a recorded 503 the older renewal is held alive. During replacement, input is disabled. After the stale original instance replies, a subsequent lease arrives and the replacement tab remains selected, without the old tab. The address accepts x and exactly one failure is recorded.
- Write-after-GWT comparison. The original HTTP request remains alive through replacement. A subsequent renewal and the selected replacement tab fence the stale result.
- Vitest `browser-session-page-053 Late instance renewal cannot replace the new instance after a service outage`.

### browser-session-page-055

[Open GWT](src/views/browser-session/__tests__/browser-session-page.bdd.md#L438) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L2110) · [Passing test](src/views/browser-session/__tests__/browser-session-page.test.tsx#L798)

- Given A browser viewer is open and a transient lease failure has occurred; its renewal for the current chat is pending.
- When The user navigates to a different chat.
- Then The old renewal is cancelled, renewals are requested only for the old chat and then the new chat, the viewer remains streaming, and the tab list shows “Other chat.”
- Observed Browser Back through a prepared history pair navigates the mounted Router to a different chat. A failed first lease and outstanding old renewal precede navigation. Its request is aborted; the new chat streams Other chat. The lease-owner sequence contains only the old and new thread IDs in that order.
- Write-after-GWT comparison. The browser Back event reaches the production Router. The request signal and the ordered sequence of distinct thread owners provide cancellation and routing evidence.
- Vitest `browser-session-page-055 Old lease is cancelled when the user returns to the other chat viewer`.

### browser-viewer-interaction-002

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L14) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L159) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L80)

- Given The user has typed draft.example/path and placed the caret after its second character while the page is at https://example.com.
- When The selected page's membership refreshes; while it is pending, the user types x and submits, then releases the refresh and submits again.
- Then The draft and caret remain intact during the refresh, and the first submission does not navigate. After the refresh, the second submission normalizes the draft to http://drxaft.example/path and navigates there.
- Observed Caret position 2 survives the held proof. Typing x moves it to 3. Enter retains focus and draft while the remote page stays at example.com. After proof and a second Enter, field and selected page reach http://drxaft.example/path.
- Write-after-GWT comparison. The hold is target-specific. A real Enter and a mutation of the focused draft distinguish refused and successful submissions.
- Vitest `browser-viewer-interaction-002 The pending proof preserves the draft and insertion point`.

### browser-viewer-interaction-003

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L22) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L195) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L92)

- Given The user has entered native-admission.example/path while the browser is connected to https://example.com.
- When The page's membership refresh is held pending and the user submits the address.
- Then The app explains, “The browser is not ready. Try again shortly.” The address stays focused with its text intact, and the page does not navigate, even after the refresh completes. A later submission navigates to http://native-admission.example/path.
- Observed The held proof causes the exact not-ready message. Native-admission draft and focus persist; the remote page is unchanged before and after release. The next Enter reaches the full normalized URL on the selected tab.
- Write-after-GWT comparison. The readiness message follows ordinary Enter. Focus and remote URL are checked on both sides of the external reply.
- Vitest `browser-viewer-interaction-003 Deferred membership explains a refused navigation until the next submission`.

### browser-viewer-interaction-015

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L118) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L526) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L139)

- Given Window 0 contains the Example page and window 1 contains the Other page.
- When The user closes the last tab in window 0.
- Then A usable blank tab at about:blank is selected in window 0, and the Other page remains unchanged in window 1. The user can navigate the blank tab to https://continued.example.com/ready.
- Observed Closing Example leaves an enabled, selected about:blank replacement in window 0. Other remains unchanged in window 1. After submission only the replacement reaches https://continued.example.com/ready.
- Write-after-GWT comparison. Two explicit target fixtures separate the surviving foreign tab from the new local blank page and its subsequent navigation.
- Vitest `browser-viewer-interaction-015 Closing the only local tab creates a navigable blank replacement`.

### browser-viewer-interaction-021

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L166) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L672) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L185)

- Given A blank tab exists alongside the Example page, and the blank tab's first image is delayed.
- When The user selects the blank tab and waits for its first image, then releases the image and navigates to https://new.example.com/page.
- Then The blank presentation covers the previous page before the image arrives, and browser input stays disabled until the image is ready. The blank presentation clears after navigation, and the new address is shown.
- Observed Selecting the held blank tab shows the blank-page guidance with input disabled before paint. Releasing its frame enables input. Navigating to the requested URL clears the guidance and updates the field and selected remote tab.
- Write-after-GWT comparison. The first image is held by the blank target’s ID. The blank guidance and its disappearance are checked through the page.
- Vitest `browser-viewer-interaction-021 The blank tab covers Example before its first image`.

### browser-viewer-interaction-028

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L222) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L881) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L200)

- Given Other is available in a multi-tab viewer, and its first image has not arrived.
- When The user selects Other while its first image is delayed.
- Then Other becomes selected, but browser input and the New tab button remain disabled until the image arrives. The address stays enabled; after the image arrives, it shows https://other.example.com and browser input and New tab become enabled.
- Observed Selecting Other immediately marks it selected while the held frame keeps remote input and New tab disabled. Address remains enabled. Frame release displays https://other.example.com with both controls enabled.
- Write-after-GWT comparison. The first-frame boundary is attached to Other. Address, New tab and remote input each have their own readiness assertion.
- Vitest `browser-viewer-interaction-028 Other is selected before its first frame enables browser actions`.

### browser-viewer-interaction-031

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L246) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L971) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L100)

- Given The viewer uses fallback frame decoding, and the current page is https://example.com.
- When The user enters example.test/path and submits it.
- Then Navigation succeeds, the address normalizes to http://example.test/path, and the other page remains at https://other.example.com.
- Observed With native Base64 decoding unavailable, a real address submission reaches http://example.test/path in the field and primary remote tab. The second target retains its original URL and window.
- Write-after-GWT comparison. The local native Base64 boundary is disabled. Both destinations are read after the normal address-bar submission.
- Vitest `browser-viewer-interaction-031 Fallback frame decoding preserves navigation and the sibling page`.

### browser-viewer-interaction-038

[Open GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L302) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1126) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L120)

- Given The Example page is selected in the viewer.
- When Another page moves into the same browser window while its membership check is pending, then the check completes.
- Then The input is temporarily disabled, Example remains selected, and afterwards the input is enabled, Other is unselected, and the address remains https://example.com.
- Observed Moving Other into the selected tab’s window starts a held membership check and disables input. Example stays selected. After release, Other appears unselected, remote input is enabled and Address remains at https://example.com.
- Write-after-GWT comparison. The proof is held on the original target while Other changes windows. The two tab-selection states are checked after the fence.
- Vitest `browser-viewer-interaction-038 A tab admitted from a different window leaves Example selected`.

## Batch 72 evidence

Opening branch `978e7afc8158cc54e4d9b4781b47790a53e4bfd9`; synchronized main `944a81c4133e743e33621d016d52025c4a8dff21`. The domain and viewer files retain their complete frozen BDD. 29 nominees and substitute browser-viewer-interaction-048 earned first acceptance. Viewer 002/003/015/021/028/031/038 passed as whole-file regressions. Historical 1,370 → 1,400/2,681; current 1,353 → 1,383/2,681. The 233 open files now hold 520 covered selections out of 1,813. Closed files remain 252. Withdrawal cohort 420 historical and 413 current out of 506. Outside it 980 historical and 970 current out of 2,175. Original withdrawal dispositions (86), historical losses (17) and independent upstream selections (68) retain their owners.

[Full GWT/expanded-row crosswalk](https://app.okou.ai/artifacts/8pk1flcx37.tsv) · [Restored mutation diffs, failed assertions and gap probes](https://app.okou.ai/artifacts/tdblqkx1cm.md)

### Batch 72 verification

Real Router, user actions, native browser geometry, history, MSW and local CDP. The page uses its normal worker bootstrap and page/worker lifetimes. Source guidance: [repository guidelines](../../../AGENTS.md), [testing](../../../docs/testing.md), [App testing](../../../docs/app/app-testing.md), [async ownership](../../../docs/app/platform-ccstate.md), [geometry events](../../../docs/app/resize-observer.md). The two-stage remote-close fixture holds the effect itself; a held receipt elsewhere can mean the native effect has already occurred. The address busy state acknowledges navigation handling. Window-close diagnostics are checked at the real Sentry boundary. The active number of sockets in 011 verifies closure. Neither measurement substitutes for an application request count.

Post-sync targeted 30/30; whole files 37/37; shuffle seed 72043: 170 passing rows across 20 files, including 140 existing rows. Platform production, test and build-config types; applicable ESLint; oxlint and type-aware oxlint; changed-file formatting and repository size checks passed. The Android workspace toolbar (#49853) and retired DB connector mirror (#49802) touched no Platform source or Vitest registration. Revalidation included both here; no imported App execution is counted.

### Batch 72 historical comparison

After authorship, normalized four-line windows from the changed portions of the tests and external fixture were compared across 1,793 unique historical blobs and 757 paths. The search included test files, renamed paths and helper/fixture files. 12 windows matched. The matches comprise shared imports/Router setup, the release–visible failure–wait sequence, and existing CDP native receipt-key classification extracted from the socket callback so it can also hold a specific target attachment. The failure helper identifies the actual created target, moves it to a distinct window and waits for the restored original recipient. No earlier scenario body was placed in a helper. The CDP fixture adds an external document-navigation entry and an independent control over the arrival and completion of a close for a particular target.

[before-zero-page-rename](https://github.com/okou-ai/okou/tree/8924f63dade934b3caa6d5629013447a6c70fc3c) · [after-zero-page-rename](https://github.com/okou-ai/okou/tree/0f0ded9b208cbeb41998c04f43db70ac1cf11d22) · [freeze](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32) · [before-first-withdrawal](https://github.com/okou-ai/okou/tree/5310dbb9ba6bd8b95507bc7293f6da3ed8aa004b) · [restored](https://github.com/okou-ai/okou/tree/b666cd050364ef31821b71fee4e14802a9e8476b) · [before-second-withdrawal](https://github.com/okou-ai/okou/tree/a445586e0483bb7e2440e60200a8deed30aa3df9) · [opening](https://github.com/okou-ai/okou/tree/978e7afc8158cc54e4d9b4781b47790a53e4bfd9) · [upstream](https://github.com/okou-ai/okou/tree/944a81c4133e743e33621d016d52025c4a8dff21)

### Batch 72 evidence gaps

- **browser-viewer-interaction-010.** With the creation receipt held, the identified target moved to window 42. The action-failed message appeared and Example regained usable input. Submitting retained.example/path kept the focused draft and left Example at https://example.com. After leaving the field (probed by Tab and separately by clicking remote input), replacing it with after-failure.example/path and pressing Enter did not navigate Example to http://after-failure.example/path. The frozen implementation also reset the refocused editor with Escape, an additional prerequisite absent from 010. The distinct Escape contract is covered by 011.
- Browser-session-page 010/014/024/025/034/035/036 retain their batch 71 probes. Chat-activity-summary-002 retains its late-response completion gap. The earlier address, shortcut, double-tab and billing gaps remain under their original IDs.

### browser-domain-initialization-001

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L6) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L133) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L67)

- Given The viewer is connecting its Inspector and Page domains, with the Inspector response arriving first.
- When The Inspector response arrives while the Page response is still pending, then the Page response arrives.
- Then Input stays disabled until both responses arrive, then becomes enabled. The user can enter text that reaches the remote browser.
- Observed Both external domain requests reach the browser. After Inspector replies, the disabled control cannot send x. Only after Page replies can p reach Report; neither Other nor the foreign tab receives it.
- Write-after-GWT review: freeze L133, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L133. The largest same-registration token similarity was 0.175. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-001 Input waits for Page after Inspector succeeds`.

### browser-domain-initialization-003

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L22) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L150) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L77)

- Given The Inspector domain enable request fails while the Page response is held pending.
- When The Inspector failure arrives, followed by the late Page response.
- Then The browser view is unavailable, the original page attachment is retired, input remains disabled, and no input is sent.
- Observed The held Inspector failure produces the unavailable message and retires the actual original attachment at the remote boundary. A late Page reply followed by a typing attempt leaves input disabled and the browser input stream empty.
- Write-after-GWT review: freeze L150, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L150. The largest same-registration token similarity was 0.448. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-003 Inspector failure retires the attachment before the late Page reply`.

### browser-domain-initialization-005

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L38) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L173) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L107)

- Given The initial tab is selected while the Inspector domain enable request is pending.
- When The user selects the “Other” tab before that request responds.
- Then The “Other” tab remains selected and usable after the late response; the original attachment is retired, the successor remains attached, and entered text reaches the remote browser.
- Observed Clicking Other while Inspector is pending retires the original attachment. Other remains selected with its own live attachment, and only Other receives s after the late Inspector reply.
- Write-after-GWT review: freeze L173, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L173. The largest same-registration token similarity was 0.256. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-005 Selecting Other retires the pending attachment and routes text to Other`.

### browser-domain-initialization-007

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L54) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L192) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L118)

- Given The first owned tab is selected while Inspector enable is pending, and another owned tab survives.
- When The first target is destroyed before the pending response arrives.
- Then The surviving owned tab is selected and usable after the late response. The destroyed tab is absent and entered text reaches the remote browser.
- Observed Destroying the original target while Inspector is pending selects the surviving owned Other. After the late reply, s reaches only Other on the still-attached successor, and Report is absent.
- Write-after-GWT review: freeze L192, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L192. The largest same-registration token similarity was 0.216. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-007 Destroying Report during setup leaves Other selected and usable`.

### browser-domain-initialization-009

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L70) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L212) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L125)

- Given Inspector enable is pending for a viewer with two owned tabs and a sibling tab in another window.
- When The owned window is removed, then the pending response arrives.
- Then The viewer reports “Browser disconnected”; input stays disabled, the sibling tab is not exposed, and no input is sent.
- Observed An owned-window removal event produces Browser disconnected. Delivering the outstanding Inspector reply and attempting text input leaves input disabled, the foreign tab absent and the external input stream empty.
- Write-after-GWT review: freeze L212, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L212. The largest same-registration token similarity was 0.288. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-009 Window removal blocks input and isolates the sibling after a late enable`.

### browser-domain-initialization-011

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L86) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L233) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L137)

- Given Inspector enable is pending while the viewer is mounted.
- When The viewer is unmounted before the response arrives.
- Then All connections close despite the late response, and no remote-browser input remains in the document.
- Observed Browser Back leaves the viewer through the real Router. At the home route all browser sockets have closed and the remote input has unmounted. Delivery of the old reply to that closed boundary leaves both conditions intact.
- Write-after-GWT review: freeze L233, before-first-withdrawal original registration absent, before-second-withdrawal absent, upstream L233. The largest same-registration token similarity was 0.331. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-011 Leaving the viewer closes its transport before a late Inspector reply`.

### browser-domain-initialization-013

[Nominee GWT](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L102) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L251) · [Passing registration](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L153)

- Given Inspector enable is pending in the current connection mode.
- When The user switches to “Separate image connection” before the response arrives.
- Then The new session remains attached after the old response arrives, input is usable, and entered text reaches the remote browser.
- Observed Switching to Separate image connection during Inspector enable produces a distinct active attachment. The old reply leaves that successor attached and usable, and z reaches the correct remote target.
- Write-after-GWT review: freeze L251, before-first-withdrawal L238, before-second-withdrawal absent, upstream L251. The largest same-registration token similarity was 0.376. Cross-file sequences and helper matches are described above.
- Vitest `browser-domain-initialization-013 A transport change retains its new session after the old enable replies`.

### browser-viewer-interaction-005

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L38) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L271) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L296)

- Given The user has replaced the address with discarded.example/path.
- When The user presses Escape, then the document navigates to https://background.example/ while the address remains focused.
- Then Escape restores and selects the full original address, https://example.com. The document update does not replace it while focused; after the user blurs the field, it shows https://background.example/.
- Observed Escape selects offsets 0 through 19 of the restored URL. The selected tab displays the background hostname while Address still has focus and the old value. Clicking the remote input reveals the background URL.
- Write-after-GWT review: freeze L271, before-first-withdrawal L200, before-second-withdrawal absent, upstream L271. The largest same-registration token similarity was 0.420. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-005 Escape selects the restored address through a background navigation`.

### browser-viewer-interaction-008

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L62) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L322) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L313)

- Given A new-tab creation is pending, and the user has focused the blank address editor without changing its text.
- When The creation fails after the new target moves to another window.
- Then The existing page is restored without navigation, while the blank address remains focused. The browser input is usable, and the user can subsequently navigate to http://after-failure.example/path.
- Observed The native creation receipt is held. Clicking the empty editor preserves focus and empty text through the actual failure alert and restoration of usable Example. A subsequent edit reaches the main target at http://after-failure.example/path.
- Write-after-GWT review: freeze L322, before-first-withdrawal L251, before-second-withdrawal absent, upstream L322. The largest same-registration token similarity was 0.132. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-008 The focused empty editor survives a moved creation`.

### browser-viewer-interaction-011

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L86) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L385) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L324)

- Given A new-tab creation is pending from a page at https://example.com.
- When The user enters retained.example/path, the creation fails after its target moves to another window, and the user submits the retained draft.
- Then The draft remains focused and visible, and the restored page stays at https://example.com. Escape restores the page address; a subsequent chosen.example/path submission navigates to http://chosen.example/path.
- Observed The retained draft is submitted after the moved-target failure alert. It stays focused and Example keeps its initial URL. Escape restores the original value and the replacement submission reaches main at http://chosen.example/path.
- Write-after-GWT review: freeze L385, before-first-withdrawal L316, before-second-withdrawal absent, upstream L385. The largest same-registration token similarity was 0.336. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-011 Escape from a failed creation lets the user address Example again`.

### browser-viewer-interaction-012

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L94) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L419) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L342)

- Given The window has no open tabs, and a new-tab creation is pending.
- When The user enters failed-intent.example/path, the creation fails, and a different tab arrives in the window.
- Then The arriving https://other.example.com tab is selected, but the failed draft remains visible and cannot navigate that tab. Escape restores the arriving tab's address.
- Observed No tabs open precedes the failed creation. The failure alert completes before the Other target enters. It becomes selected and usable while its external URL survives the refused submission. Escape shows the URL of Other.
- Write-after-GWT review: freeze L419, before-first-withdrawal L350, before-second-withdrawal absent, upstream L419. The largest same-registration token similarity was 0.388. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-012 A failed draft cannot navigate the first subsequently admitted tab`.

### browser-viewer-interaction-013

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L102) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L453) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L370)

- Given A viewer is open with an existing page in window 0 and a new-tab creation can be delayed.
- When The user creates a tab, enters draft.example/path and submits before creation is ready, waits for the blank tab's first image, then closes that tab.
- Then The new tab stays blank at about:blank in window 0; early submission reports that the browser is not ready and does not discard the draft. Once ready, the draft remains visible. Closing the blank tab selects the existing Example tab, and no created target remains.
- Observed In window 0 the not-ready message appears before the held create receipt is delivered. After the held first image is released, the draft is intact, the same target is blank in window 0, and closing it restores Example and the original two-target inventory.
- Write-after-GWT review: freeze L453, before-first-withdrawal L384, before-second-withdrawal absent, upstream L453. The largest same-registration token similarity was 0.262. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-013 An early address stays with the new blank in window 0`.

### browser-viewer-interaction-014

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L110) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L453) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L370)

- Given A viewer is open with an existing page in window 1 and a new-tab creation can be delayed.
- When The user creates a tab, enters draft.example/path and submits before creation is ready, waits for the blank tab's first image, then closes that tab.
- Then The new tab stays blank at about:blank in window 1; early submission reports that the browser is not ready and does not discard the draft. Once ready, the draft remains visible. Closing the blank tab selects the existing Other tab, and no created target remains.
- Observed In window 1, Other is the original page. The early submit displays the readiness notice, the draft survives its blank target’s first image, and closing it restores Other. The remote inventory contains neither an extra target nor a changed Example.
- Write-after-GWT review: freeze L453, before-first-withdrawal L384, before-second-withdrawal absent, upstream L453. The largest same-registration token similarity was 0.262. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-014 An early address stays with the new blank in window 1`.

### browser-viewer-interaction-017

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L134) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L569) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L597)

- Given The Example page is the established tab in window 0, and a separate new-tab creation is pending.
- When The user closes Example, then closes the confirmed blank replacement before the pending creation finishes.
- Then The confirmed replacement keeps the window usable without relying on the pending creation. When that creation completes, its target is removed, leaving one usable blank tab with an empty address.
- Observed The independent creation receipt remains held while Example closes. The confirmed replacement is identified by its actual target ID and closed by its own control. Releasing the older receipt removes that specific target and leaves a single local usable blank.
- Write-after-GWT review: freeze L569, before-first-withdrawal L500, before-second-withdrawal absent, upstream L569. The largest same-registration token similarity was 0.246. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-017 Closing two established tabs never adopts the abandoned creation`.

### browser-viewer-interaction-018

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L142) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L604) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L402)

- Given Example is the last tab in its window.
- When The user closes it while navigation preparing its blank replacement is pending.
- Then Example remains open and its close control is disabled until replacement preparation completes. Afterwards, one selected blank tab remains and browser input is enabled.
- Observed While the replacement navigation receipt is withheld, the original remote target is still present and Close Example is disabled. Completion leaves the sibling and exactly one selected, usable local blank.
- Write-after-GWT review: freeze L604, before-first-withdrawal L535, before-second-withdrawal absent, upstream L604. The largest same-registration token similarity was 0.521. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-018 The last page stays open until its replacement navigation finishes`.

### browser-viewer-interaction-019

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L150) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L623) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L640)

- Given Example and Other are both in window 0.
- When The user starts closing both tabs before either remote close completes.
- Then The window retains exactly one blank tab at about:blank. Once the closes finish, that tab is selected and browser input is enabled.
- Observed Both targeted close requests arrive before either remote effect occurs. Both original targets and a prepared blank coexist. Completing the closes in reverse order leaves only the usable selected blank in window 0.
- Write-after-GWT review: freeze L623, before-first-withdrawal L554, before-second-withdrawal absent, upstream L623. The largest same-registration token similarity was 0.360. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-019 Concurrent closes leave one usable blank in the original window`.

### browser-viewer-interaction-022

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L174) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L709) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L417)

- Given A new-tab creation is pending while the Example page is selected.
- When The user selects Other, edits its address to later-choice.example/draft, and then the creation completes.
- Then Other stays selected; the delayed creation does not restore the blank presentation or replace the user's focused draft. No unavailable-browser presentation appears.
- Observed Choosing Other and editing its address precedes release of the old creation. Actual removal of that specific remote target establishes cleanup. Selection, focus and draft still belong to Other without an unavailable message.
- Write-after-GWT review: freeze L709, before-first-withdrawal L618, before-second-withdrawal absent, upstream L709. The largest same-registration token similarity was 0.309. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-022 Selecting Other during creation preserves its focused draft`.

### browser-viewer-interaction-023

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L182) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L747) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L437)

- Given A new-tab creation is pending and the user opens and dismisses Browser settings.
- When The creation completes and the new tab's first image arrives.
- Then The new tab becomes selected and browser controls become enabled, but Browser settings retains focus rather than focus moving to the address field.
- Observed The user opens and dismisses settings while creation is pending. The settings control retains focus after the created target’s first image, selected blank, enabled remote input and enabled New tab action.
- Write-after-GWT review: freeze L747, before-first-withdrawal L656, before-second-withdrawal absent, upstream L747. The largest same-registration token similarity was 0.430. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-023 Dismissing settings keeps its focus when the first new-tab frame arrives`.

### browser-viewer-interaction-026

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L206) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L838) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L456)

- Given A new-tab creation is pending, and the user has not interacted with the automatically focused blank address.
- When The creation completes and the new tab's document navigates first to https://first.example/ and then https://second.example/.
- Then Each navigation updates the focused address to the latest URL, including https://second.example/. After the user leaves the field, it still shows the latest URL.
- Observed The automatically focused address is untouched. Two real document notifications on the created target change its selected tab title. Address tracks each URL while focused and retains the second after focus leaves.
- Write-after-GWT review: freeze L838, before-first-withdrawal L688, before-second-withdrawal absent, upstream L838. The largest same-registration token similarity was 0.225. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-026 Focused new-tab address tracks documents according to user interaction (false)`.

### browser-viewer-interaction-027

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L214) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L838) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L456)

- Given A new-tab creation is pending, and the user has interacted with the automatically focused blank address before creation completes.
- When The creation completes and the new tab's document navigates first to https://first.example/ and then https://second.example/.
- Then Both document updates leave the focused address empty. After the user leaves the field, it shows https://second.example/.
- Observed A click marks the focused blank editor as touched. Both new document titles become selected, while the address remains focused and empty. Clicking the remote input exposes the second URL.
- Write-after-GWT review: freeze L838, before-first-withdrawal L688, before-second-withdrawal absent, upstream L838. The largest same-registration token similarity was 0.225. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-027 Focused new-tab address tracks documents according to user interaction (true)`.

### browser-viewer-interaction-030

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L238) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L919) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L724)

- Given The user creates a new tab, and the created blank tab's first image is delayed.
- When The first image fails, then connection recovery runs.
- Then The app reconnects and retries the image without creating another tab. Recovery leaves exactly the Example and blank New tab entries; the blank tab is selected with an empty address and browser input enabled.
- Observed The first held image carries invalid base64. The page reports Reconnecting, then a fresh screencast reaches the same created target. Input stays disabled until its image is released. Recovery ends with the same remote pages, Example and New tab in the strip, a selected blank and an empty address. A separate socket probe observed transport reuse.
- Write-after-GWT review: freeze L919, before-first-withdrawal L769, before-second-withdrawal absent, upstream L919. The largest same-registration token similarity was 0.298. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-030 Recovery retries the first image on the original blank target`.

### browser-viewer-interaction-032

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L254) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L984) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L480)

- Given The user has submitted submitted.example/path, and page navigation is still pending.
- When The user uses the keyboard to move the caret after the second character before navigation completes.
- Then The focused address retains submitted.example/path and its caret position after navigation completes. After the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.
- Observed The navigation receipt is held while the busy address receives Home then two Right presses. Once aria-busy clears, the local draft retains focus and selection [2,2]. Leaving it shows the normalized URL also found on the actual target.
- Write-after-GWT review: freeze L984, before-first-withdrawal L834, before-second-withdrawal absent, upstream L984. The largest same-registration token similarity was 0.400. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-032 Editing the caret while a navigation receipt is held preserves the local draft`.

### browser-viewer-interaction-034

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L270) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L984) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L480)

- Given The user has submitted submitted.example/path, and page navigation is still pending.
- When The user starts text composition with the caret after the second character before navigation completes.
- Then The focused address retains submitted.example/path and its caret position after navigation completes. After composition ends and the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.
- Observed Composition begins with the caret at offset 2 of the submitted draft while the address is busy. The busy state clears after receipt delivery with focus, text and caret intact. Ending composition and leaving exposes the actual normalized URL.
- Write-after-GWT review: freeze L984, before-first-withdrawal L834, before-second-withdrawal absent, upstream L984. The largest same-registration token similarity was 0.400. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-034 Editing the caret while a navigation receipt is held preserves the local draft`.

### browser-viewer-interaction-035

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L278) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1031) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L480)

- Given The user has submitted submitted.example/path, and page navigation is still pending.
- When The user moves focus to Browser settings, dismisses it, refocuses the address, and places the caret after the second character before navigation completes.
- Then The focused address retains submitted.example/path and its caret position after navigation completes. After the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.
- Observed While the address is busy, settings opens and dismisses and the user refocuses the editor and places the caret at 2. After the receipt is processed the focused draft and caret survive, and blur shows the normalized remote address.
- Write-after-GWT review: freeze L1031, before-first-withdrawal L883, before-second-withdrawal absent, upstream L1031. The largest same-registration token similarity was 0.438. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-035 Editing the caret while a navigation receipt is held preserves the local draft`.

### browser-viewer-interaction-037

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L294) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1089) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L524)

- Given A first address navigation has been sent but its receipt is still pending.
- When The user submits a second address, then the first navigation receipt arrives and the user retries.
- Then The second submission is initially rejected with a still-opening message and the first URL remains active. After the receipt, the alert clears, the second address remains focused and can be submitted, and the remote page reaches its normalized URL.
- Observed The second submission raises a still-opening message while the first URL is active on the remote target. The alert clears after the held receipt. The focused second draft then reaches the intended target on retry.
- Write-after-GWT review: freeze L1089, before-first-withdrawal L912, before-second-withdrawal absent, upstream L1089. The largest same-registration token similarity was 0.466. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-037 A held receipt rejects the second submit until its alert clears`.

### browser-viewer-interaction-042

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L334) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1233) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L663)

- Given Other is selected for attachment, and its attachment response is pending when it moves out of the assigned window.
- When The native connection closes, then the late attachment response arrives.
- Then The viewer reconnects and reports zero pending requests and one cancelled request. The late response does not restore usable input.
- Observed Other is selected with its attachment receipt outstanding, then leaves the owned window. On native close the actual Sentry breadcrumb reports 0 pending and 1 cancelled awaiting response. A new socket begins connecting. Delivering the old receipt to the closed peer leaves input disabled and no typed text reaches Other.
- Write-after-GWT review: freeze L1233, before-first-withdrawal L970, before-second-withdrawal absent, upstream L1233. The largest same-registration token similarity was 0.356. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-042 A late Other attachment cannot enable the disconnected viewer`.

### browser-viewer-interaction-043

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L342) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1276) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L544)

- Given The assigned browser window has no open tabs.
- When The user creates a new tab.
- Then The new blank tab is created in the assigned window, input becomes enabled, the empty address receives focus, and its value is empty.
- Observed From the owned window’s empty state, creating a tab focuses the empty address and enables input. The actual blank target belongs to window 0, while the pre-existing foreign target remains in window 1.
- Write-after-GWT review: freeze L1276, before-first-withdrawal L1013, before-second-withdrawal absent, upstream L1276. The largest same-registration token similarity was 0.242. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-043 The first tab belongs to the empty assigned window`.

### browser-viewer-interaction-048

[Substitute GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L382) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1409) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L713)

- Given A new-tab creation receipt is pending.
- When Another caller moves the created page to a different window before the receipt is released.
- Then Creation reports that the browser action could not be completed, but the page remains in the other window; the existing page remains active and its address is https://example.com.
- Observed The local boundary moves the identified created page to window 42 while its receipt is held. After the action-failed message, that target still exists in window 42, Example remains selected and its original URL is ready.
- Write-after-GWT review: freeze L1409, before-first-withdrawal L1092, before-second-withdrawal absent, upstream L1409. The largest same-registration token similarity was 0.137. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-048 The moved target survives a rejected create receipt`.

### browser-viewer-interaction-165

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1318) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4951) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L555)

- Given The browser viewer is open with image format settings available.
- When The user selects PNG as the image format.
- Then The remote browser capture uses PNG. Lossless is disabled, and remote input remains enabled.
- Observed Selecting PNG causes a PNG capture on the external CDP browser. The Lossless quality item is disabled and remote input stays enabled.
- Write-after-GWT review: freeze L4951, before-first-withdrawal L3488, before-second-withdrawal absent, upstream L4951. The largest same-registration token similarity was 0.554. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-165 Selecting PNG changes capture and disables Lossless quality`.

### browser-viewer-interaction-166

[Nominee GWT](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1326) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4975) · [Passing registration](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L575)

- Given The browser viewer is open and the panel display area measures 900 by 600 pixels.
- When The panel is followed by the remote browser.
- Then The remote browser viewport becomes 900 by 600 pixels; input remains enabled and the address stays https://example.com.
- Observed The native viewport begins at 1440×900 and the panel measures 900×600. The opened Window size menu identifies Follow panel as the checked mode. The remote viewport actually becomes 900×600 with usable input and the original address.
- Write-after-GWT review: freeze L4975, before-first-withdrawal L3512, before-second-withdrawal absent, upstream L4975. The largest same-registration token similarity was 0.347. Cross-file sequences and helper matches are described above.
- Vitest `browser-viewer-interaction-166 The remote viewport follows the measured 900 by 600 panel`.

## Batch 73 evidence

Opening head `641a5cc40ad46eb9a98c6df91956a77719e4971e`. Synchronized main `f0babd9a5b1d68fef595bc35d6944d3859e593f2`. Historical first acceptances rose from 1,400 to 1,430 of 2,681. Complete current coverage rose from 1,383 to 1,413. The 233 open files contain 550 covered selections of 1,813. Closed files remain 252. Withdrawal cohort 420 historical / 413 current of 506; outside it 1,010 historical / 1,000 current of 2,175. The original 86 withdrawn, 17 subsequently invalidated and 68 independent upstream scenarios retain their owners.

26 nominees and viewer 103/104/105/123 earned first acceptance. Both files retain their full BDD. The seven domain and thirty viewer rows from the opening head are whole-file regressions, including viewer 048. Viewer 010 retains the actual Example target readback from batch 72. No Escape prerequisite has been added. The seven batch 71 session probes and chat-activity-summary-002 also remain open.

[Full original GWT and passing Vitest row crosswalk](https://app.okou.ai/artifacts/9v04ntf02a.tsv) · [Mutation diffs, failure assertions and gap probes](https://app.okou.ai/artifacts/s7x3xotz9k.md)

### Batch 73 verification

Real Router and user events with a local native-browser extension, CDP transport and frame fixture. The editing-context gate identifies the external caret evaluation separately from extension RPCs. The keyboard anchor moves when that observation is consumed. Target-specific commits and key events distinguish recipients. Geometry, visibility and clock checks follow the [repository guidelines](../../../AGENTS.md), [testing guide](../../../docs/testing.md), [App testing and worker lifetime](../../../docs/app/app-testing.md) and [async ownership](../../../docs/app/platform-ccstate.md).

Post-sync targeted 30/30, full 67/67 across both files, shuffled 200/200 across 20 files (seed 73049). The shuffle includes 170 existing rows, with batch 65 quality regressions. No imported upstream App row. Three TypeScript projects, scoped ESLint, oxlint, type-aware oxlint and all changed file formatting and size checks passed. One concurrent local test run under memory pressure timed out on 096; the final suites ran serially, with default timeouts.

### Batch 73 comparison after authoring

Compared 1,794 unique historical blobs from 757 paths, including renamed paths and helpers, and inspected each frozen registration against the new entry. One four-line normalized window matched: constructing the standard cancelable, bubbling beforeinput event for deleteContentBackward. The helper issues the native event only; the old scenario orchestration was not reused. The highest same-registration token ratio was 0.507. The tests use separate external frame, native effect and recipient evidence. The two no-stop probes record the earlier stop observed during pause as well as the older registrations' narrower observation interval.

[before-zero-page-rename](https://github.com/okou-ai/okou/tree/8924f63dade934b3caa6d5629013447a6c70fc3c) · [after-zero-page-rename](https://github.com/okou-ai/okou/tree/0f0ded9b208cbeb41998c04f43db70ac1cf11d22) · [freeze](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32) · [before-first-withdrawal](https://github.com/okou-ai/okou/tree/5310dbb9ba6bd8b95507bc7293f6da3ed8aa004b) · [restored](https://github.com/okou-ai/okou/tree/b666cd050364ef31821b71fee4e14802a9e8476b) · [before-second-withdrawal](https://github.com/okou-ai/okou/tree/a445586e0483bb7e2440e60200a8deed30aa3df9) · [opening](https://github.com/okou-ai/okou/tree/641a5cc40ad46eb9a98c6df91956a77719e4971e) · [upstream](https://github.com/okou-ai/okou/tree/f0babd9a5b1d68fef595bc35d6944d3859e593f2)

### Batch 73 open evidence

- **browser-domain-initialization-018.** The Page failure probe displayed Browser view unavailable, retired the original attachment and stayed disabled with one physical connection after 31 real seconds. The explicit timer and enlarged timeout fail the repository lint rules. A second probe used the documented 31,000 ms monotonic advance after retirement; no subsequent application clock read acknowledged the advance before the default case timeout. The timing clause remains open.
- **browser-viewer-interaction-064.** Held the identified password-context evaluation, focused Address, sent same-document navigation, entered my-choice.example and delivered the old response. The draft, focus and text type survived. With the response withheld entirely the same assertions still passed. Keyboard activity on Address does not establish completion of the obsolete read.
- **browser-viewer-interaction-088.** Held the successful capture response during navigation. Paused and resumed, delivered the old success and ended navigation. The remote observed Page.stopScreencast before the replacement picture. When the observed stop was acknowledged, the original session consumed the replacement picture and received resumed text without a further stop. The unqualified no-stop clause in the frozen Then remains open.
- **browser-viewer-interaction-095.** After a previous pause and recovery, began PNG capture during navigation, delivered its navigation failure and paused and resumed again. The remote observed Page.stopScreencast before replacement paint. After acknowledging that stop, the replacement image enabled input on the original session without another stop. The old registration measured stops only from after recovery; the retained Then also requires preservation without stopping screencast.

### browser-domain-initialization-014

[Nominee BDD](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#L110) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L273) · [Passing test](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx#L173)

- Given Page enable is pending when the browser connection is lost.
- When The viewer reconnects and then the old pending response arrives.
- Then The viewer recovers with two connections, keeps input usable, and accepts entered text without reviving the old response's session.
- Observed: The old socket closes while its Page reply is held. A replacement attachment paints Report. After attempted late delivery to the closed socket, only the new session on Report receives r, with two physical connections and no delivery to either sibling.
- Expanded row: `browser-domain-initialization-014 A fresh connection takes input after the original Page reply arrives late`.
- Post-authoring comparison: freeze 273, before-first-withdrawal 260, before-second-withdrawal absent, upstream 273.

### browser-viewer-interaction-049

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L390) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1409) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L761)

- Given A new-tab creation receipt is pending.
- When Another caller starts navigation of the created page before the receipt is released.
- Then Creation reports that the browser action could not be completed, but the pending URL remains https://user-navigation.example.com; the existing page remains active and its address is https://example.com.
- Observed: The remote created target keeps its marker and pending https://user-navigation.example.com after the action-failed notice. Example stays selected and live at its original address.
- Expanded row: `browser-viewer-interaction-049 Another caller's destination survives the delayed create receipt`.
- Post-authoring comparison: freeze 1409, before-first-withdrawal 1092, before-second-withdrawal absent, upstream 1409.

### browser-viewer-interaction-050

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L398) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1448) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L801)

- Given The assigned browser contains the Example page.
- When The user creates a new tab while native tab metadata is updated before the fresh tab read.
- Then The new blank tab is selected and usable, the address is empty, and the created tab is about:blank in the assigned window.
- Observed: The external extension updates the created page title and emits its metadata event immediately before reading the created native tab. New tab becomes selected and usable, with an empty address and an about:blank target in window 0.
- Expanded row: `browser-viewer-interaction-050 Native updates before the admission read still admit the local blank`.
- Post-authoring comparison: freeze 1448, before-first-withdrawal 1131, before-second-withdrawal absent, upstream 1448.

### browser-viewer-interaction-052

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L414) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1468) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L761)

- Given A new page is being attached and the Browser.getWindowForTarget membership check is delayed.
- When Another caller starts navigation of that page before the check completes.
- Then Creation reports that the browser action could not be completed; the created page retains its pending user navigation and its creation marker URL. The existing page remains active with address https://example.com.
- Observed: The creation response precedes the held membership read on the identified target. After another caller starts navigation and that read completes, the visible failure leaves the marker and exact pending URL intact on the created target; Example is active.
- Expanded row: `browser-viewer-interaction-052 Another caller's destination survives the delayed membership`.
- Post-authoring comparison: freeze 1468, before-first-withdrawal 1151, before-second-withdrawal absent, upstream 1468.

### browser-viewer-interaction-058

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L462) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1601) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L815)

- Given The address field is open in the remote browser viewer.
- When The user submits mailto:user@example.com.
- Then The field and remote page retain mailto:user@example.com.
- Observed: A real Enter in Address leaves mailto:user@example.com on both the selected remote page and the visible editor. Changing only the outgoing CDP destination failed the actual-target assertion.
- Expanded row: `browser-viewer-interaction-058 Mailto reaches the selected remote document intact`.
- Post-authoring comparison: freeze 1594, before-first-withdrawal 1195, before-second-withdrawal absent, upstream 1594.

### browser-viewer-interaction-059

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L470) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1614) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1212)

- Given The remote page's focused editing context changes among search, email, URL, telephone, number, textarea, and password fields.
- When The user requests updated keyboard hints, then starts composing text while the remote context changes again.
- Then The input reflects the field's appropriate input mode, enter-key hint, language, capitalization, and password type without losing focus. During composition the displayed type and hints remain stable; after composition ends they update to the latest password context, and clearing the context resets defaults without disabling input.
- Observed: Search, email, URL, telephone, number, textarea and password hints are observed on the focused input. A new caret position proves delivery and processing of the password observation during composition; the displayed hints switch only after confirmation, then reset to defaults when the external context clears.
- Expanded row: `browser-viewer-interaction-059 Remote keyboard hints track the current field outside composition`.
- Post-authoring comparison: freeze 1614, before-first-withdrawal 1208, before-second-withdrawal absent, upstream 1614.

### browser-viewer-interaction-060

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L478) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1734) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1265)

- Given The remote page has a password field with numeric input, a Done hint, and Japanese language; the user is composing 中.
- When The native page title and tab metadata update during composition, then composition ends.
- Then The input stays enabled, focused, password-typed, and retains its numeric, Done, and Japanese hints and composed value through the tab update. The committed text is forwarded to the remote page.
- Observed: The selected Checkout details title confirms the native tab update during composition. The enabled focused proxy retains its numeric, done, Japanese and password attributes and 中 value. After confirmation only 中 is inserted on main.
- Expanded row: `browser-viewer-interaction-060 A tab title update preserves Japanese password composition`.
- Post-authoring comparison: freeze 1734, before-first-withdrawal 1328, before-second-withdrawal absent, upstream 1734.

### browser-viewer-interaction-066

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L526) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1969) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1291)

- Given The remote input has stale editing hints, and the next editing-context read fails.
- When The user requests refreshed hints and then enters fresh text.
- Then The input resets to default hints but remains enabled and focused; the fresh text is forwarded to the remote page.
- Observed: After a password context a failed editing read restores text/enter, empty language, text type and no capitalization. The focused enabled input forwards fresh to main.
- Expanded row: `browser-viewer-interaction-066 Failed context read restores defaults and forwards fresh input`.
- Post-authoring comparison: freeze 1969, before-first-withdrawal 1464, before-second-withdrawal absent, upstream 1969.

### browser-viewer-interaction-071

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L566) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2265) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1052)

- Given The user is composing “old” text in one browser tab while the composition update is pending, then commits it, submits Enter, and requests backward deletion. A second tab is selected before the pending update completes.
- When The user enters “fresh” text in the replacement tab and requests backward deletion there.
- Then “fresh” is sent to the replacement tab, and the only Backspace key events are one key-down and one key-up sent to that tab; queued input from the previous tab does not reach it.
- Observed: An actual pending preedit on main precedes commit, Enter and delete. With Other streaming, the old reply is released. Other receives fresh and only the rawKeyDown/keyUp Backspace pair, with no Enter or composition command. Main has no Backspace.
- Expanded row: `browser-viewer-interaction-071 A replaced composition cannot forward Enter or delete to Other`.
- Post-authoring comparison: freeze 2265, before-first-withdrawal 1510, before-second-withdrawal absent, upstream 2265.

### browser-viewer-interaction-072

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L574) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2339) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1083)

- Given The user is composing “中国” in the remote browser input and deletes backward within the active composition, leaving “中”. The composition is then committed, followed by a backward deletion and fresh text entry.
- When The input events are processed by the browser.
- Then The committed “中” and subsequent “fresh” are each sent as inserted text. Exactly one Backspace key-down and key-up are sent, and the committed composition residual does not cause an extra deletion.
- Observed: After editing 中国 to 中 the preedit is visible locally and reaches main. Main subsequently receives exactly the committed 中, fresh, and one Backspace down/up pair.
- Expanded row: `browser-viewer-interaction-072 Backward deletion distinguishes preedit from committed text`.
- Post-authoring comparison: freeze 2339, before-first-withdrawal 1584, before-second-withdrawal absent, upstream 2339.

### browser-viewer-interaction-073

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L582) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2424) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1111)

- Given The user focuses the remote browser input while keyboard metadata is still pending.
- When The user composes and confirms “中”.
- Then The composition update and one confirmed text insertion are sent while metadata remains pending, and the remote browser input stays focused.
- Observed: The local browser keeps its editing metadata reply pending until after main receives the 中 preedit and the sole 中 insertion. Keyboard focus remains on the input.
- Expanded row: `browser-viewer-interaction-073 The IME confirms text while the editing read is outstanding`.
- Post-authoring comparison: freeze 2424, before-first-withdrawal 1669, before-second-withdrawal absent, upstream 2424.

### browser-viewer-interaction-074

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L590) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2475) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1132)

- Given The user is composing “old” in the remote browser input when the browser reports that execution contexts were cleared without a payload.
- When The old composition ends, then the user focuses the input again and enters “fresh” as ordinary text.
- Then The live browser view receives focus after the reset, and only “fresh” is sent as inserted text; the retired “old” composition is not sent.
- Observed: Clearing execution contexts without params returns focus to the live surface. Completing the old composition and entering fresh yields exactly one insertion, fresh, on main. Omitting the production reset fails the focus check.
- Expanded row: `browser-viewer-interaction-074 Context reset retires old composition at the input boundary`.
- Post-authoring comparison: freeze 2475, before-first-withdrawal 1720, before-second-withdrawal absent, upstream 2475.

### browser-viewer-interaction-075

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L598) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2524) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1379)

- Given The user enters “typed” while a screenshot frame arrives, starting recovery; the original text input and screenshot-capture cleanup are both still pending.
- When The original input completes before capture cleanup, then capture cleanup completes and recovery advances by one second.
- Then The input remains disabled until both pending operations complete, then becomes enabled again with the address showing “https://example.com”.
- Observed: The original text and capture shutdown both reach their external boundaries before either reply. Reconnecting appears and input stays disabled through input completion and capture shutdown until the held new image. Example's address is restored.
- Expanded row: `browser-viewer-interaction-075 Image retry waits for input and capture shutdown`.
- Post-authoring comparison: freeze 2524, before-first-withdrawal 1769, before-second-withdrawal absent, upstream 2524.

### browser-viewer-interaction-076

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L606) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2552) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L824)

- Given Two browser tabs are open, and closing “Other” is pending.
- When The user focuses the address field and enters “draft.example” before the close completes.
- Then “Other” closes and “Example” becomes selected, while the address field retains focus and the draft value.
- Observed: Other is selected and live when its close reaches the native boundary. After editing draft.example and completing the close, Example alone remains remotely; the address retains its draft and focus.
- Expanded row: `browser-viewer-interaction-076 Draft focus survives closing Other`.
- Post-authoring comparison: freeze 2552, before-first-withdrawal 1797, before-second-withdrawal absent, upstream 2552.

### browser-viewer-interaction-078

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L622) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2574) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1309)

- Given Two tabs are open. Closing “Example” fails but remains pending; the user then closes “Other”, which succeeds, leaving “Example” temporarily disabled as the selected tab.
- When The user focuses the address field and enters “chosen.example/draft”, then the older close failure arrives.
- Then An alert is shown, “Example” is re-enabled, and the address field retains focus and the draft value.
- Observed: Example is selected and aria-disabled while its failed close is pending and Other has gone. When the older failure is released the alert appears, Example is re-enabled, and the chosen address and focus survive.
- Expanded row: `browser-viewer-interaction-078 A late failure restores Example without displacing a chosen draft`.
- Post-authoring comparison: freeze 2574, before-first-withdrawal 1819, before-second-withdrawal absent, upstream 2574.

### browser-viewer-interaction-079

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L630) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2623) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L840)

- Given The Example tab is selected, and the user moves focus to the Other tab with the right arrow. The Other page is then removed.
- When The user starts an address draft and the surviving page's title updates.
- Then Focus recovers to the Example tab once, then remains on the Address field. Its draft value is preserved.
- Observed: ArrowRight focuses Other. Target destruction restores focus to Example. Its new selected title arrives after the user enters keep-focus.example; Address still owns focus and text.
- Expanded row: `browser-viewer-interaction-079 A removed keyboard target returns focus once`.
- Post-authoring comparison: freeze 2623, before-first-withdrawal 1868, before-second-withdrawal absent, upstream 2623.

### browser-viewer-interaction-080

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L638) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2658) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L861)

- Given The Example tab is open, and the Other page's live image is delayed.
- When The user closes Example and the close completes before the Other page image arrives.
- Then Focus and selection move to Other, and the remote browser input remains disabled until its image arrives. Then input is enabled and the address shows https://other.example.com.
- Observed: Other is selected with keyboard focus after Example closes, before Other's held first picture. Remote input enables only after that picture, with the Other URL.
- Expanded row: `browser-viewer-interaction-080 Other receives tab focus before its first image`.
- Post-authoring comparison: freeze 2658, before-first-withdrawal 1903, before-second-withdrawal absent, upstream 2658.

### browser-viewer-interaction-082

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L654) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2724) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L879)

- Given The Other tab is selected in a viewer with Example and Other tabs.
- When The page becomes hidden, then visible while the selected tab's image is being refreshed.
- Then Input pauses while hidden. On return, the prior live image remains visible and the view shows an updating status; input stays disabled until the new image arrives, then enables with the Other address restored.
- Observed: Other is selected before hiding. On resume the updating notice and previous visible image coexist with disabled input. The fresh image for notes restores usable input and the Other address.
- Expanded row: `browser-viewer-interaction-082 Other retains its image while its visible page refreshes`.
- Post-authoring comparison: freeze 2724, before-first-withdrawal 1939, before-second-withdrawal absent, upstream 2724.

### browser-viewer-interaction-083

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L662) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2796) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L898)

- Given The browser viewer is open, and stopping its original screen capture is delayed.
- When The page becomes hidden, then rapidly alternates visible, hidden, and visible before the original capture stop completes.
- Then The existing preview remains visible without a connecting message, and input stays disabled until the original stop and a new image finish. Input then enables, and submitting an address draft navigates to http://after-visibility.example/ready.
- Observed: The original stop receipt stays held across alternating visibility. The live preview remains visible without a connecting label. After stop completion the new image is still required; a subsequent draft reaches main at http://recovered.example/path.
- Expanded row: `browser-viewer-interaction-083 Repeated resumes wait for the original stop and the new image`.
- Post-authoring comparison: freeze 2796, before-first-withdrawal 2011, before-second-withdrawal absent, upstream 2796.

### browser-viewer-interaction-084

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L670) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2837) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1332)

- Given The browser viewer is open, and the original screen-capture stop fails while the page is being hidden.
- When The page resumes, then recovery is advanced after the viewer reports reconnecting.
- Then Input remains disabled until a new image arrives, then enables. Hiding and resuming again also restores enabled input.
- Observed: The original stop fails during the hidden-visible transition. Reconnecting appears before the replacement picture is released; input enables at Example and survives a second hidden-visible cycle.
- Expanded row: `browser-viewer-interaction-084 Resuming after a rejected stop requires a fresh picture`.
- Post-authoring comparison: freeze 2833, before-first-withdrawal 2048, before-second-withdrawal absent, upstream 2833.

### browser-viewer-interaction-087

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L694) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2944) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1404)

- Given A browser capture fails because navigation is still in progress, and the capture remains unchanged.
- When Navigation ends.
- Then The view retries the PNG capture, keeps the input disabled until the capture arrives, then enables it without showing an unavailable-view message.
- Observed: Starting PNG during native navigation fails. After the matching frame stops loading a PNG capture reaches main; the input is disabled while its image is held and enabled afterward, without an unavailable message.
- Expanded row: `browser-viewer-interaction-087 Navigation completion permits PNG after its first capture was rejected`.
- Post-authoring comparison: freeze 2944, before-first-withdrawal 2157, before-second-withdrawal absent, upstream 2944.

### browser-viewer-interaction-096

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L766) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3050) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1430)

- Given Automatic image recovery is paused while preparation is in progress.
- When The viewer is hidden and resumed, then the replacement image and the interrupted preparation complete.
- Then Input remains disabled until the replacement image arrives, then becomes usable; the address remains https://example.com and no unavailable-view message appears.
- Observed: A held membership read intercepts preparation after corrupt image recovery. While that old reply is outstanding the resumed owner waits for a replacement picture, becomes usable at Example, and accepts recovered on main after old reply delivery.
- Expanded row: `browser-viewer-interaction-096 A resumed owner accepts input after interrupted recovery preparation`.
- Post-authoring comparison: freeze 3050, before-first-withdrawal 2258, before-second-withdrawal absent, upstream 3050.

### browser-viewer-interaction-098

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L782) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3109) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L918)

- Given The user has entered the local address draft local-draft.example/path.
- When The viewer is hidden and resumed while its replacement image is pending, and the user submits the address before that image arrives.
- Then The address remains editable with the draft preserved, and the early submission shows “The browser is not ready. Try again shortly.” It does not navigate early; after the image arrives, submitting navigates to http://local-draft.example/path.
- Observed: While the resumed image is withheld the editable draft stays intact, Enter raises the readiness notice, and main retains its original URL before and after first paint. Enter after readiness navigates main to http://local-draft.example/path.
- Expanded row: `browser-viewer-interaction-098 A paused draft only navigates on the second submission`.
- Post-authoring comparison: freeze 3109, before-first-withdrawal 2317, before-second-withdrawal absent, upstream 3109.

### browser-viewer-interaction-099

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L790) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3147) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1354)

- Given The viewer has an initialized preview, and membership proof for a newly created tab is pending.
- When The viewer is hidden and resumed, then fresh membership proof and a replacement image arrive.
- Then The initialized preview remains visible without a connecting message, and input stays disabled until both fresh proof and the image are available; it then becomes enabled.
- Observed: A duplicate tab is created at the external boundary. Its identified target's membership lookup is held across the pause. The fresh read on main and the subsequent held image independently gate enabled input; the initialized preview remains visible with no connecting label.
- Expanded row: `browser-viewer-interaction-099 Resume preserves the preview through fresh membership and paint`.
- Post-authoring comparison: freeze 3147, before-first-withdrawal 2355, before-second-withdrawal absent, upstream 3147.

### browser-viewer-interaction-100

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L798) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3180) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L946)

- Given A multi-tab viewer is hidden while a document in the background tab navigates to https://background.example/changed.
- When The viewer resumes, receives the replacement image, and the user submits after-background-navigation.example/ready.
- Then The address first reflects https://background.example/changed, and input stays disabled until the image arrives. The subsequent submission navigates to http://after-background-navigation.example/ready.
- Observed: With Other selected the hidden document navigates remotely. On resume its changed URL appears before notes receives its replacement image. Afterward the submitted ready URL reaches notes and main remains at Example.
- Expanded row: `browser-viewer-interaction-100 A document changed in the background supplies the resumed address`.
- Post-authoring comparison: freeze 3180, before-first-withdrawal 2388, before-second-withdrawal absent, upstream 3180.

### browser-viewer-interaction-101

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L806) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3228) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L973)

- Given A multi-tab viewer is resumed and its replacement picture is still pending.
- When The viewer is hidden and resumed a second time while a new screencast capture is pending.
- Then The live preview remains visible without a connecting message, and input remains disabled until the pending capture and picture finish; it then becomes enabled.
- Observed: After resuming without the first picture, the viewer pauses again. Its retained preview remains visible through the second capture response and its independently held picture, then Example becomes usable.
- Expanded row: `browser-viewer-interaction-101 A second pause before paint retains the multi-tab preview`.
- Post-authoring comparison: freeze 3228, before-first-withdrawal 2436, before-second-withdrawal absent, upstream 3228.

### browser-viewer-interaction-103

[Substitute BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L822) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3322) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1456)

- Given The browser viewer is initially hidden and its remote input is disabled.
- When The viewer becomes visible.
- Then The input becomes enabled, and the address shows https://example.com.
- Observed: Opening while hidden exposes disabled input. Revealing the viewer brings up a usable image and the Example URL.
- Expanded row: `browser-viewer-interaction-103 Revealing the initially hidden viewer enables Example`.
- Post-authoring comparison: freeze 3322, before-first-withdrawal 2530, before-second-withdrawal absent, upstream 3322.

### browser-viewer-interaction-104

[Substitute BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L830) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3337) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1464)

- Given The viewer is visible while a browser page is still initializing.
- When The viewer is hidden and then shown again before initialization finishes.
- Then The input becomes enabled after initialization, and the address shows the current page, https://example.com.
- Observed: A native Page.enable request already reached the browser before hiding and revealing the viewer. Completing it yields a live, enabled Example page.
- Expanded row: `browser-viewer-interaction-104 The initializing viewer survives a hidden-visible cycle`.
- Post-authoring comparison: freeze 3337, before-first-withdrawal 2545, before-second-withdrawal absent, upstream 3337.

### browser-viewer-interaction-105

[Substitute BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L838) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3359) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1478)

- Given The viewer is active and the user has an unfinished composition containing 旧.
- When The viewer is hidden and shown again, the pending composition completes, and the user enters fresh text.
- Then The input is disabled while the viewer is paused, then becomes enabled; the live browser view remains visible, and only “fresh text” is sent, not the abandoned composition.
- Observed: The original 旧 preedit remains outstanding while hiding disables input. On resume, completion of that preedit and its composition end leave the visible preview enabled; only fresh text reaches main.
- Expanded row: `browser-viewer-interaction-105 Resumed input commits only the new text`.
- Post-authoring comparison: freeze 3359, before-first-withdrawal 2567, before-second-withdrawal absent, upstream 3359.

### browser-viewer-interaction-123

[Substitute BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L982) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3928) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1500)

- Given Opening the viewer encounters an ordinary failure in Page.enable.
- When The viewer initializes.
- Then The browser view is unavailable and the remote-browser input is disabled.
- Observed: An ordinary Page.enable failure on route entry results in the unavailable-view message and disabled remote input.
- Expanded row: `browser-viewer-interaction-123 An ordinary Page enable failure disables the viewer`.
- Post-authoring comparison: freeze 3928, before-first-withdrawal 2907, before-second-withdrawal absent, upstream 3928.

## Batch 74 evidence

Opening head `e6d0809665c0f79b41aab881099893a044b6c25d`. Synchronized main `fa3af9d57a3c609c1e7f3f1cbea8193a88f5da58`. Historical first acceptances rose from 1,430 to 1,460 of 2,681. Current complete coverage rose from 1,413 to 1,443. Of 1,813 retained selections in 233 open files, 580 now have complete evidence. The 252 closed files still account for 868 selections, including five retirements. The original withdrawal cohort contributes 420 historical and 413 current of 506, with 1,040 historical and 1,030 current outside it. The 86 original withdrawals, 17 later historical losses and 68 independent upstream items retain their owners.

Twenty nominations and ten substitutes passed. All three partial files keep their complete BDD. Their Git blobs match the initial GWT inventory at `9f5f4ff567` byte for byte. Viewer 103, 104, 105 and 123 belong to the 59 prior viewer rows rerun this batch. Domain 018, viewer 064/088/095, viewer 010, the seven batch 71 gaps, chat-activity-summary-002 and billing-survey-004 keep their prior evidence dispositions. Batch 65's three quality repairs remain regressions.

[Original GWT, observed Then and actual expanded Vitest titles](https://app.okou.ai/artifacts/8vivlzeut1.tsv) · [Delivery versus withholding, production mutations and open probes](https://app.okou.ai/artifacts/wt29ew2nvg.md)

### Batch 74 verification

All cases enter the production Router. The fixtures simulate the external descriptor API, native browser, CDP sessions and frame transport. Input and navigation are attributed to specific remote targets. Frame presentation uses the canvas, its accessible state and the input it enables. The 180-second recovery deadline uses the scoped monotonic clock. The successor failure case checks both Sentry and the page action's rejected-promise output. [Repository instructions](../../../AGENTS.md) · [Testing practices](../../../docs/testing.md) · [App browser and SharedWorker practices](../../../docs/app/app-testing.md) · [Async ownership](../../../docs/app/platform-ccstate.md).

The targeted run passed 30/30 rows. Three complete files passed 89/89. With seed 74063, the shuffled run passed 230 rows across 22 files. The shuffle includes 200 existing rows. The affected main-sync run passed 17 rows in 5 files. App production, test and build-config TypeScript, scoped ESLint, oxlint, type-aware oxlint, Prettier and the repository file-size check cover the submitted changes.

Removing focus restoration failed viewer 164. Extending the original deadline to 360 seconds failed recovery 003. Suppressing pixel clearing failed recovery 038 while the new page frame was held. Reversing the completed Shift release disposition failed viewer 141 and 142 on the original tab. Withholding the actual successor image failed viewer 125. Its obsolete admission remains pending throughout the asserted text delivery. The controls artifact records which UI assertions still passed without their purported cause.

### Batch 74 main synchronization

Main reverted transcript virtualization in [#49915](https://github.com/okou-ai/okou/pull/49915). Of five conflicts, chat-conversation-locator keeps its open BDD and the removed historical implementation stays withdrawn. Chat-navigation-conversation-state retains its independent email-card row. The history resource test retains its mention and both attachment readbacks after the user scrolls a measured viewport to earlier messages. The two sharing-position rows and all five virtual-scroll rows were removed upstream. Their two now-empty executable files were removed here; their frozen BDD files remain. All seven deleted expanded rows were verified against the pre-revert main and the opening PR. They were independent upstream rows, with zero deductions from historical or current accepted-ID totals.

The first CI run exposed one newly unused test export, `chatScrollContainer`. Its only caller on the opening branch was the upstream scroll test removed in this merge. The unused helper was removed. All 54 rows from the 12 remaining importer suites passed with shuffle seed 74064. Deduplicating the targeted, three-file, shuffled, main-sync and importer runs by file and expanded title produced 297 rows, comprising 30 first acceptances and 267 regressions.

### Batch 74 comparison after authoring

Checked 1,791 distinct test and helper blobs from 757 paths. The search included former Zero and Platform paths, both removal parents, frozen, restored, opening and synchronized main. The 6 four-line matches involved shared imports and fixture setup, native text-event properties, or the standard per-target IME matcher. Per-ID consideration included the original registration, its called helpers and the explicit event order required by the GWT. No previous orchestration was transferred into a new helper. The rebuilt cases use target-specific external evidence, per-response gates, window-scoped inventory and direct production-route outcomes as applicable.

[before-zero-page-rename](https://github.com/okou-ai/okou/tree/8924f63dade934b3caa6d5629013447a6c70fc3c) · [after-zero-page-rename](https://github.com/okou-ai/okou/tree/0f0ded9b208cbeb41998c04f43db70ac1cf11d22) · [freeze](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32) · [before-first-withdrawal](https://github.com/okou-ai/okou/tree/5310dbb9ba6bd8b95507bc7293f6da3ed8aa004b) · [restored](https://github.com/okou-ai/okou/tree/b666cd050364ef31821b71fee4e14802a9e8476b) · [before-second-withdrawal](https://github.com/okou-ai/okou/tree/a445586e0483bb7e2440e60200a8deed30aa3df9) · [opening](https://github.com/okou-ai/okou/tree/e6d0809665c0f79b41aab881099893a044b6c25d) · [upstream](https://github.com/okou-ai/okou/tree/fa3af9d57a3c609c1e7f3f1cbea8193a88f5da58)

### Batch 74 open evidence

- **browser-viewer-interaction-102.** The native key-down and key-up reached the original target. With the key-up acknowledgement held, hiding stopped the screencast and resuming showed Updating view. Even after acknowledging capture stop, the replacement screencast did not start while the original key receipt remained outstanding. This probe cannot paint the replacement before the original key release as required.
- **browser-viewer-interaction-107.** After real Router entry and queued remote text, the DOM copy event did not reach clipboard.write. The production entry requires a trusted browser gesture. The clipboard data promise and AbortError on blur were unobserved. No test fabricated event trust.
- **browser-viewer-interaction-122.** The split viewer recovers Other and navigates after its control detach. Running the same test without delivering the held image attachment still enables input and navigates. These outcomes do not establish consumption of the obsolete image attachment.
- **browser-viewer-interaction-133.** The selected Other target's CDP membership request was observed. Interposing the native getTab or getWindow response did not establish the required simultaneous unacknowledged native proof and selection of Last before its completion. No added selection or keyboard workaround was used.
- **browser-viewer-interaction-148.** After destruction of the selected target the surviving scoped tab alone accepts navigation, and the foreign tab is excluded. Keeping the failed membership response entirely outstanding produces the same results as delivery. There is no completion signal for the old failure.
- **browser-viewer-interaction-155.** After original destruction and selection of Other, delivering the successful confirmation and withholding it both leave Other selected, enabled and unchanged. The disappearance is established by the earlier destruction event.
- **browser-viewer-interaction-158.** While a failed target-loss confirmation was outstanding for the still-existing original page, clicking Other did not commit it as the selected tab before reply delivery. The probe failed at aria-selected, so destruction-before-selection from 155 was not substituted.
- **browser-viewer-interaction-160.** Disconnecting with a pending target-loss confirmation shows Reconnecting and disables both controls. Attempted delivery on the closed peer and withholding the reply yield identical assertions; actual consumption after disconnect remains unproven.
- **browser-automatic-recovery-004.** The 409 conflict produced an unavailable view and a single final recovery-stopped record with protocol kind, HTTP status 409 and terminal outcome. A separate ordered descriptor-error record was absent in the reporting and console probes. The one combined record cannot establish both ordered effects.
- **browser-automatic-recovery-008.** An accelerated probe could exhaust the replacement viewer and reconnect after the local descriptor was made repeatable. The passing last-attempt timing depended on an arbitrary wall-clock threshold to advance from 65 to 179 seconds. With a causal capture-stop gate the last image was not reached in order. The four-second no-automatic-retry clause also lacks an independent completion signal. The timed variant was discarded.

Additional substitution probes and exact failure controls are preserved in the linked experiment record.

### browser-automatic-recovery-001

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L6) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L324) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L139)

- Given The selected tab is recovering after a failed image frame, with one image attempt already made.
- When A frame succeeds and the browser session is revalidated without changing its binding.
- Then Recovery remains pending during revalidation, then the viewer becomes ready and accepts input. A later frame failure recovers without an extra connection or error report.
- Ledger's first recovered frame arrives while the same descriptor is held. Input remains disabled until revalidation, then Ledger receives a. An independently damaged frame recovers, with one physical connection and zero reports.
- Vitest expanded `browser-automatic-recovery-001 A confirmed Ledger image survives same-binding revalidation and a second failure`.
- Post-authoring source registrations included freeze 324, before-first-withdrawal 323, before-second-withdrawal absent, upstream 324.

### browser-automatic-recovery-003

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L22) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L361) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L197)

- Given The selected tab is recovering after three failed image attempts, and a successful frame arrives near the original recovery deadline while session revalidation is pending.
- When The original 180-second deadline passes before revalidation completes.
- Then Recovery is reported exhausted and the input remains disabled. Revalidation can restore the viewer and input, but does not clear the single exhaustion report or start another connection.
- Three failed frames precede the successful frame during a held descriptor at 179 seconds. Crossing the original 180-second deadline produces one exhaustion report while input is disabled. The same descriptor restores Ledger, which receives d without a second report or connection.
- Vitest expanded `browser-automatic-recovery-003 The original deadline expires while the success descriptor is pending`.
- Post-authoring source registrations included freeze 361, before-first-withdrawal 360, before-second-withdrawal absent, upstream 361.

### browser-automatic-recovery-005

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L38) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L430) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L157)

- Given The selected tab is recovering after a successful image frame, and revalidation confirms the browser is suspended with no viewer.
- When The descriptor update completes.
- Then The Start browser button appears, the input is disabled, and the reconnecting status is removed.
- The returned descriptor specifies suspended and has no viewer. The page presents Start browser, disables remote input and removes Reconnecting.
- Vitest expanded `browser-automatic-recovery-005 A suspended descriptor retires the recovering viewer`.
- Post-authoring source registrations included freeze 430, before-first-withdrawal 429, before-second-withdrawal absent, upstream 430.

### browser-automatic-recovery-006

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L46) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L441) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L169)

- Given The selected tab is recovering after one failed image attempt.
- When A successful image frame coincides with a same-window endpoint replacement and the replacement viewer initializes.
- Then The new endpoint is used while recovery remains pending; a succeeding frame restores the viewer and input without an additional connection or error report.
- Following the first failed image, successful paint overlaps same-window endpoint replacement. The replacement socket is in use while its image is held and input disabled. Its image enables Ledger, which receives r, with only the two expected sockets and no reports.
- Vitest expanded `browser-automatic-recovery-006 A new endpoint supplies Ledger after 1 failed pictures`.
- Post-authoring source registrations included freeze 441, before-first-withdrawal 440, before-second-withdrawal absent, upstream 441.

### browser-automatic-recovery-007

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L54) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L441) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L169)

- Given The selected tab is recovering after three failed image attempts.
- When A successful image frame coincides with a same-window endpoint replacement and the replacement viewer initializes.
- Then The new endpoint is used while recovery remains pending; a succeeding frame restores the viewer and input without an additional connection or error report.
- Following the third failed image, the replacement endpoint is already connected while its image is held. That image enables Ledger and its r input. The original and replacement are the only two connections, with no report.
- Vitest expanded `browser-automatic-recovery-007 A new endpoint supplies Ledger after 3 failed pictures`.
- Post-authoring source registrations included freeze 441, before-first-withdrawal 440, before-second-withdrawal absent, upstream 441.

### browser-automatic-recovery-011

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L86) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L583) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L244)

- Given A healthy viewer has a selected tab and a sibling whose membership inventory is still pending.
- When The selected tab and another known tab are destroyed before inventory completes.
- Then The input and New tab control remain disabled, and no-tabs-open is not shown until the inventory is complete. Then New tab is enabled and creates a blank tab in the selected window without a recovery report.
- Starting healthy, two known local targets disappear while sibling membership is outstanding. New tab and input are disabled; No tabs open is absent. Resolving inventory shows the empty window, where New tab creates a ready about:blank in window 19 without a report.
- Vitest expanded `browser-automatic-recovery-011 Pending inventory delays the empty ready window`.
- Post-authoring source registrations included freeze 583, before-first-withdrawal 537, before-second-withdrawal absent, upstream 583.

### browser-automatic-recovery-012

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L94) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L583) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L244)

- Given A recovering viewer has a selected tab and a sibling whose membership inventory is still pending.
- When The selected tab and another known tab are destroyed before inventory completes.
- Then The input and New tab control remain disabled, and no-tabs-open is not shown until the inventory is complete. Then New tab is enabled and creates a blank tab in the selected window without a recovery report.
- Starting at Reconnecting, destruction of the known local targets leaves both controls disabled while membership is outstanding. Resolution admits the empty state and a ready about:blank created in window 19. No recovery report is added.
- Vitest expanded `browser-automatic-recovery-012 Pending inventory delays the empty recovering window`.
- Post-authoring source registrations included freeze 583, before-first-withdrawal 537, before-second-withdrawal absent, upstream 583.

### browser-automatic-recovery-013

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L102) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L642) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L278)

- Given Image recovery has been exhausted and reported, with no pending tab inventory.
- When The remaining tabs are closed and the user creates a new tab after the empty state appears.
- Then The no-tabs-open state appears, the new blank tab becomes ready, and the original exhaustion report remains unchanged.
- Exhaustion is reported before both local tabs disappear. No tabs open enables New tab. The resulting ready page is the only about:blank in the assigned window. The entire original report sequence remains intact.
- Vitest expanded `browser-automatic-recovery-013 The local empty window accepts a new tab after exhaustion`.
- Post-authoring source registrations included freeze 642, before-first-withdrawal 596, before-second-withdrawal absent, upstream 642.

### browser-automatic-recovery-014

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L110) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L642) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L244)

- Given Image recovery has been exhausted and reported, and a new sibling tab has been created while its membership inventory is pending.
- When The remaining tabs are closed, inventory completes, and the user creates a new tab.
- Then The connecting state appears until inventory completes, then no-tabs-open appears and the new blank tab becomes ready. The original exhaustion report remains unchanged.
- After exhaustion and background creation, destroying the local targets shows Connecting and disables the controls until the outstanding inventory completes. No tabs open then permits the ready blank tab in the assigned window. The exhaustion report is preserved.
- Vitest expanded `browser-automatic-recovery-014 Pending inventory delays the empty exhausted window`.
- Post-authoring source registrations included freeze 642, before-first-withdrawal 596, before-second-withdrawal absent, upstream 642.

### browser-automatic-recovery-017

[Nominee BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L134) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L755) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L286)

- Given Image recovery has been exhausted and its failure reported once.
- When The user selects another tab whose initialization fails with an unsupported Page.enable capability error, then reconnects.
- Then A new terminal recovery report and the corresponding promise error are recorded for the successor failure, while the original report remains. Reconnect restores the selected tab without further reports.
- After Ledger's exhaustion, selecting Other rejects its Page.enable with -32601. A distinct terminal Sentry report and a page-action promise rejection identify that same command/code. The prior report stays first. Manual Reconnect restores Other without adding another report.
- Vitest expanded `browser-automatic-recovery-017 Other's capability failure has its own report and rejected page action`.
- Post-authoring source registrations included freeze 755, before-first-withdrawal 662, before-second-withdrawal absent, upstream 755.

### browser-automatic-recovery-021

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L166) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L932) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L336)

- Given Image recovery is underway while creation of a new tab is pending.
- When The selected recovery target moves to another window and tab creation completes.
- Then The newly created blank tab in the selected window becomes ready and accepts input. No recovery report is produced.
- With creation pending, the current image fails and the selected target moves to the foreign window. Completing creation selects the ready blank tab in the assigned window. Only that tab receives b. The recovery reporter stays empty.
- Vitest expanded `browser-automatic-recovery-021 A new blank tab accepts the keystroke after Ledger leaves the window`.
- Post-authoring source registrations included freeze 932, before-first-withdrawal 839, before-second-withdrawal absent, upstream 932.

### browser-automatic-recovery-033

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L262) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1272) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L420)

- Given The user has selected a scoped sibling tab when the browser connection drops.
- When Automatic recovery encounters two transient descriptor failures, then receives a successful descriptor.
- Then The selected sibling tab is restored and accepts input; the out-of-scope sibling is not shown. No error log or recovery report is produced.
- After the selected Other loses its socket, two transient HTTP descriptor errors precede a held success. Input is disabled until recovery; Other remains selected, accepts t exclusively, and excludes Foreign. No application error log or recovery report is produced.
- Vitest expanded `browser-automatic-recovery-033 Two transient descriptor errors recover the selected tab in the assigned window`.
- Post-authoring source registrations included freeze 1272, before-first-withdrawal 1052, before-second-withdrawal absent, upstream 1272.

### browser-automatic-recovery-038

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L302) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L1470) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L356)

- Given The original browser tab is selected and its picture is visible.
- When The user selects another tab before its first frame arrives.
- Then The previous picture is cleared, the canvas is hidden, and browser input stays disabled until the new tab is ready.
- The original canvas is painted before selection. Selecting Other clears its full pixel rectangle and hides it from accessibility while the new frame remains outstanding and input is disabled. Other's own image restores display and input.
- Vitest expanded `browser-automatic-recovery-038 Selecting Other clears Ledger's picture while its first frame is withheld`.
- Post-authoring source registrations included freeze 1470, before-first-withdrawal 1109, before-second-withdrawal absent, upstream 1470.

### browser-automatic-recovery-069

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L550) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2349) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L376)

- Given The user has selected the Other tab in the assigned browser window.
- When The native worker is replaced and automatic recovery runs.
- Then The selected tab becomes ready again, text input works there, and the sibling window is not shown as a tab.
- Replacing the native worker triggers a new proof for selected Other. Input is disabled until it returns. Other remains selected, is the sole recipient of w, and the foreign-window tab is absent.
- Vitest expanded `browser-automatic-recovery-069 A replaced native worker restores Other in its own window`.
- Post-authoring source registrations included freeze 2349, before-first-withdrawal 1514, before-second-withdrawal absent, upstream 2349.

### browser-automatic-recovery-072

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L574) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2468) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L393)

- Given The remote browser is ready and a frame is missing.
- When All three local image recovery attempts fail and the user selects Retry live image.
- Then A retry button is enabled after recovery is exhausted, with one exhaustion report. The browser becomes ready again without another connection, accepts subsequent text, and does not report a second exhaustion.
- Three failed local image retries exhaust once. The enabled Retry live image restores Ledger's stream and its i keystroke on the same connection. Its original exhaustion report is the only report.
- Vitest expanded `browser-automatic-recovery-072 Retry live image restores the local stream after exhaustion`.
- Post-authoring source registrations included freeze 2468, before-first-withdrawal 1608, before-second-withdrawal absent, upstream 2468.

### browser-automatic-recovery-073

[Substitute BDD](src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#L582) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L2500) · [Passing test](src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx#L404)

- Given The connected browser loses its two existing targets and disconnects.
- When Automatic recovery runs with the authoritative window empty.
- Then The app shows “No tabs open” and enables New tab; it does not create a tab or show the sibling window’s tab.
- Two target-destruction events followed by transport loss produce Reconnecting, then No tabs open on the authoritative window. New tab is enabled, the local window contains no synthetic blank, and Foreign is absent from the tab strip.
- Vitest expanded `browser-automatic-recovery-073 An empty reconnected window offers New tab and excludes Foreign`.
- Post-authoring source registrations included freeze 2500, before-first-withdrawal 1640, before-second-withdrawal absent, upstream 2500.

### browser-discovery-startup-001

[Substitute BDD](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#L6) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L117) · [Passing test](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L67)

- Given The browser is starting discovery and its first owned tab has not yet been admitted.
- When The user enters “initial-draft.example/path” and presses Enter before admission, then releases discovery and presses Enter again.
- Then The first Enter does not change the tab URL. After admission, the address retains the draft and has focus; the second Enter navigates to http://initial-draft.example/path.
- Enter before the first assigned target's admission gives readiness feedback and leaves its external URL unchanged. The retained focused draft survives admission. A second Enter changes First's browser-side URL to http://initial-draft.example/path.
- Vitest expanded `browser-discovery-startup-001 The second Enter navigates First after its membership is confirmed`.
- Post-authoring source registrations included freeze 117, before-first-withdrawal 117, before-second-withdrawal absent, upstream 117.

### browser-discovery-startup-004

[Substitute BDD](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#L30) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L217) · [Passing test](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L93)

- Given The first owned tab is ready while discovery of a new background tab triggers a membership check for the later owned tab.
- When The user selects the later owned tab before its proof completes, then releases the proof and types “new selection after proof.”
- Then Input is disabled while the selected tab awaits proof. After admission, the address shows https://later.example.com and the text is sent to that tab.
- While Later's proof is held during background discovery, selecting Later disables input. Release displays https://later.example.com and only Later receives new selection after proof.
- Vitest expanded `browser-discovery-startup-004 Selecting Later during discovery directs subsequent text to Later`.
- Post-authoring source registrations included freeze 217, before-first-withdrawal 217, before-second-withdrawal absent, upstream 217.

### browser-discovery-startup-029

[Substitute BDD](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#L230) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L800) · [Passing test](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L108)

- Given The selected tab’s membership is being validated while the image-quality preference is available.
- When The user sets image quality to 60 before admission.
- Then After admission, capture uses quality 60 and remote browser input is enabled.
- While the first selected tab awaits admission, the user applies 60 in Browser settings. After admission the ready browser has enabled input and the capture carries quality 60.
- Vitest expanded `browser-discovery-startup-029 Image quality set before admission reaches the capture on First`.
- Post-authoring source registrations included freeze 800, before-first-withdrawal 557, before-second-withdrawal absent, upstream 800.

### browser-discovery-startup-032

[Substitute BDD](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#L254) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L885) · [Passing test](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L125)

- Given A narrow membership refresh is pending after a duplicate-tab event.
- When The first tab moves out, a sibling moves in, and another duplicate event occurs before the held refresh completes.
- Then Input is disabled while the move is unresolved; afterward the first tab is absent, sibling 0 appears and can be selected, and its address is https://sibling-0.example.com.
- The first scoped tab leaves and Sibling 0 enters during the outstanding duplicate-triggered proof. Another duplicate occurs before release. Input is disabled during the move. Sibling 0 can then be selected at https://sibling-0.example.com and First is absent.
- Vitest expanded `browser-discovery-startup-032 Moving targets during an unresolved refresh updates the window's choices`.
- Post-authoring source registrations included freeze 885, before-first-withdrawal 621, before-second-withdrawal absent, upstream 885.

### browser-viewer-interaction-110

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L878) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3561) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1538)

- Given The user holds Shift on Example, and the original text-input receipt fails.
- When They switch to Other, edit text there, then return to Example.
- Then Other accepts the fresh text. Example is unavailable and its input is disabled; the reported error retains the original Input.insertText failure attribution and excludes private input details.
- The held failure for Input.insertText precedes the tab change. Only Other receives the fresh text. Returning to Example displays Browser view unavailable and disables input. The exception identifies the failed command. Neither the serialized report nor the error description exposes the private fixture text.
- Vitest expanded `browser-viewer-interaction-110 The original text error belongs to Example and omits the input`.
- Post-authoring source registrations included freeze 3557, before-first-withdrawal 2691, before-second-withdrawal absent, upstream 3557.

### browser-viewer-interaction-113

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L902) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3717) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1567)

- Given The user enters text through an unsupported-only IME composition on Example.
- When They leave the tab and return to it.
- Then The committed text is preserved, and the Example tab is selected with its input enabled.
- Example receives the single committed 你 after an unsupported preedit. Following a visit to Other, the selected Example presents its live image and enabled input. Its committed text is intact.
- Vitest expanded `browser-viewer-interaction-113 Unsupported preedit preserves the committed text after returning to Example`.
- Post-authoring source registrations included freeze 3717, before-first-withdrawal 2847, before-second-withdrawal absent, upstream 3717.

### browser-viewer-interaction-114

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L910) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3725) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1584)

- Given The user enters a composition with mixed IME support on Example.
- When They leave the tab and return to it.
- Then Example is unavailable and its input is disabled; the reported error identifies the original Input.imeSetComposition failure with CDP code -32601.
- An n preedit reaches Example. Its ni update fails as unsupported. Returning from Other yields the unavailable view, disabled input and a Sentry exception identifying Input.imeSetComposition with code -32601.
- Vitest expanded `browser-viewer-interaction-114 A failed update after a successful preedit fences Example`.
- Post-authoring source registrations included freeze 3725, before-first-withdrawal 2855, before-second-withdrawal absent, upstream 3725.

### browser-viewer-interaction-125

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L998) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3951) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1717)

- Given The viewer uses a separate image connection, and page admission is pending for Other when the frames connection is lost.
- When Automatic recovery reconnects and Other's image frames become available before the old admission completes.
- Then Other remains selected; the input is disabled during recovery and becomes enabled after image frames are available. Text entered afterward is sent to the recovered page session.
- The old Other membership reply stays outstanding. The separate image socket disconnects, the page reports recovery and disables input. Only the fresh frames for Other enable input. Submitted text reaches its recovered session and no sibling.
- Vitest expanded `browser-viewer-interaction-125 The recovered frames connection keeps Other's input on its new session`.
- Post-authoring source registrations included freeze 3951, before-first-withdrawal 2930, before-second-withdrawal absent, upstream 3951.

### browser-viewer-interaction-136

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1086) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4236) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1618)

- Given The user holds Shift on Example when a background tab-created event triggers membership checking.
- When The held key is released and the membership check completes, then the user enters a Japanese composition.
- Then The input becomes enabled; composition text "ni" is sent as IME composition and committed text "你" is sent as inserted text.
- The key is held when a background duplicate triggers a selected-target proof. Releasing Shift and completing the proof enables input. The browser receives ni as IME composition and a single committed 你 on Example.
- Vitest expanded `browser-viewer-interaction-136 Japanese preedit and commit resume after held Shift and tab admission`.
- Post-authoring source registrations included freeze 4236, before-first-withdrawal 3038, before-second-withdrawal absent, upstream 4236.

### browser-viewer-interaction-141

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1126) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1662)

- Given The user has held Shift on the original tab, and input release and capture stop are pending; the input release will succeed.
- When The user switches to the other tab, then capture stops before input release completes and detachment is confirmed.
- Then The other tab remains usable. Returning to the original tab leaves input enabled, and the address can be changed to http://cleanup-proof.example/ready.
- While switching from Example to Other, capture stop succeeds before the held Shift release succeeds and the original detachment is delivered. Other accepts the user's text. On return the remote Example page reaches http://cleanup-proof.example/ready while Other retains its own URL.
- Vitest expanded `browser-viewer-interaction-141 A confirmed release permits navigation on the original page`.
- Post-authoring source registrations included freeze 4412, before-first-withdrawal 3113, before-second-withdrawal absent, upstream 4412.

### browser-viewer-interaction-142

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1134) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1672)

- Given The user has held Shift on the original tab, and input release and capture stop are pending; the input release will fail.
- When The user switches to the other tab, then capture stops before input release completes and detachment is confirmed.
- Then The other tab remains usable. Returning to the original tab shows the browser view as unavailable and leaves input disabled.
- With the same ordered capture stop and confirmed detach, the original key release fails. Other still receives the user's text. On return Example shows Browser view unavailable with disabled input.
- Vitest expanded `browser-viewer-interaction-142 A rejected release fences the original page after visiting Other`.
- Post-authoring source registrations included freeze 4412, before-first-withdrawal 3113, before-second-withdrawal absent, upstream 4412.

### browser-viewer-interaction-147

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1174) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4518) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1677)

- Given The user has held Shift on the original tab, and its input release is unconfirmed.
- When A capture-detachment proof arrives after the user switches to the other tab, then the user returns to the original tab.
- Then Input remains enabled on the other tab, but the original tab shows the browser view as unavailable and input remains disabled.
- The externally observed Example capture session detaches while the original Shift release remains outstanding. Other accepts its own text. On return Example shows Browser view unavailable with disabled input. Withholding the detach changes this result.
- Vitest expanded `browser-viewer-interaction-147 Detachment alone cannot prove an outstanding original release`.
- Post-authoring source registrations included freeze 4518, before-first-withdrawal 3214, before-second-withdrawal absent, upstream 4518.

### browser-viewer-interaction-154

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1230) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4638) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1694)

- Given The selected scoped tab's membership lookup is pending, and membership lookup is unsupported.
- When Membership lookup fails, then the user chooses Reconnect.
- Then The browser view is unavailable and input and the new-tab button are disabled until reconnect. Afterward the new-tab button is enabled, input is enabled, and there are two connections.
- Unsupported selected-target membership removes both input and New tab. After explicit Reconnect, Example has a live picture, enabled input and enabled creation, with two physical connections.
- Vitest expanded `browser-viewer-interaction-154 Reconnect restores controls after unsupported membership`.
- Post-authoring source registrations included freeze 4638, before-first-withdrawal 3298, before-second-withdrawal absent, upstream 4638.

### browser-viewer-interaction-164

[Nominee BDD](src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#L1310) · [Frozen registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4906) · [Passing test](src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1740)

- Given Two tabs are present; the All tabs picker has focus while the tab bar is narrow.
- When The tab bar widens, narrows again while the address field contains a draft, then widens once more.
- Then Focus returns to the committed selected Example tab when the picker disappears. On the later widening, the address field retains focus and the draft chosen.example/draft remains intact.
- A narrow local tab budget exposes the All tabs picker. With focus on the picker, widening returns focus to committed Example. After narrowing and editing Address, widening removes the picker while Address keeps focus and chosen.example/draft.
- Vitest expanded `browser-viewer-interaction-164 Widening removes the focused picker without stealing a later draft`.
- Post-authoring source registrations included freeze 4906, before-first-withdrawal 3443, before-second-withdrawal absent, upstream 4906.

## Batch 75 file intake

The unit of this batch is a distinct frozen test file. Opening head `1ad4f43948`, main `fa3af9d57a`. The first two files were requested. The third already had independent Router probes in progress. The other 27 reopen partial files with specifically documented remaining selections. Frozen retain register: `4855592c`. Counts below exclude previously accepted selections.

| Frozen test path                                                                                          | Open retain IDs at intake                                                                                                                  | Previously accepted selections |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -----------------------------: |
| `turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx`              | 002, 003, 009, 015, 017, 021, 023, 027, 030, 033, 036, 038, 040, 041, 044, 045, 046, 047, 048, 049, 051, 053, 054, 056                     |                              4 |
| `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx`             | 001, 004, 006, 007, 009, 011, 012, 014, 018, 020, 021, 022, 023, 024, 026, 029, 031, 034, 035, 036, 039, 043, 047, 050, 051, 052, 053, 054 |                              0 |
| `turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx`                     | 001, 002, 003, 004, 010, 011                                                                                                               |                              0 |
| `turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx`                 | 004                                                                                                                                        |                             40 |
| `turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.test.tsx`          | 018                                                                                                                                        |                              8 |
| `turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.test.tsx`                               | 004                                                                                                                                        |                              4 |
| `turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.test.tsx`                        | 002                                                                                                                                        |                              1 |
| `turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx`                   | 010, 011                                                                                                                                   |                              6 |
| `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx`               | 001, 006                                                                                                                                   |                              4 |
| `turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx`               | 001                                                                                                                                        |                              4 |
| `turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx`     | 009                                                                                                                                        |                              7 |
| `turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx`                        | 004, 008, 012                                                                                                                              |                              4 |
| `turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx`                  | 007                                                                                                                                        |                              7 |
| `turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.test.tsx`                           | 001, 002                                                                                                                                   |                              3 |
| `turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.test.tsx`                          | 008                                                                                                                                        |                              5 |
| `turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx`                      | 003                                                                                                                                        |                              2 |
| `turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.test.tsx`                              | 001                                                                                                                                        |                             21 |
| `turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx`                              | 004                                                                                                                                        |                              5 |
| `turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.test.tsx`                          | 014, 023, 024                                                                                                                              |                              9 |
| `turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.test.tsx`                          | 003                                                                                                                                        |                              3 |
| `turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx`                             | 001, 002, 009                                                                                                                              |                              2 |
| `turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.test.tsx`                       | 001                                                                                                                                        |                              1 |
| `turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx`                        | 005, 010                                                                                                                                   |                              3 |
| `turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.test.tsx`                            | 005                                                                                                                                        |                              2 |
| `turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx`                       | 003                                                                                                                                        |                              6 |
| `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx`    | 001                                                                                                                                        |                              3 |
| `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx`           | 005                                                                                                                                        |                              7 |
| `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx` | 012, 015, 021                                                                                                                              |                             14 |
| `turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx`                            | 001                                                                                                                                        |                              2 |
| `turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx`                                 | 005                                                                                                                                        |                              3 |

## Batch 75 evidence

35 first acceptances from 30 distinct frozen files and 97 outstanding retained IDs. Telegram OAuth closes with all seven selected IDs verified. The other 29 files retain their full BDD. 62 intake selections remain open. Historical coverage is 1,495/2,681 (+35). Current complete coverage is 1,471/2,681 (+28), after 7 additional historical losses from main. [Opening file roster](#batch-75-file-intake). [97 GWT dispositions and expanded rows](https://app.okou.ai/artifacts/xhpcarj297.tsv) · [Probe source, controls and run reports](https://app.okou.ai/artifacts/5w0ujgbeqe.zip) · [Next 30 frozen files and their retained IDs](https://app.okou.ai/artifacts/vcnxev97zp.md).

The current partition has 250 closed files (1,574 frozen executions and 851 selections including 4 retirements) and 235 open files (3,537 executions, 1,830 selections, 624 covered). The original cohort contributes 420 historical and 411 current of 506. Outside the cohort the counts are 1,075 and 1,060 of 2,175. The 86 original withdrawals, 17 earlier historical losses and 68 independent upstream pending scenarios retain their prior ownership. The newly identified losses are itemized below. File counts include each frozen file once across this batch's stages.

### Batch 75 verification

The 35 first-acceptance rows passed the targeted run. The 30 complete intake files passed 217 rows, including 180 previously accepted selections and two separate existing regressions: the completed-run activity indicator and the upstream legacy-model-to-Home redirect. The shuffled run (seed 75043) passed 386 rows in 46 files, including the other native browser fixture callers and the batch 65 quality cases. The running-regressions.tsv table identifies the ownership and exact passing title of each of those 182 rows. Two intake IDs are prior upstream retirements (org-billing-tab-001 and onboarding-progress-005), and nine have upstream changes to their prerequisites or expectations. Another 51 lack complete evidence. These 62 dispositions are separate from the 68 independently owned upstream items. The additional 169 expanded rows are regression scope. The shared test fixture transitively affects 331 App files. An additional shuffled run on seed 75111 passed all 1,502 rows in these files. After the scoped lint fixes, the three affected full files passed all 40 rows again with seed 75112; the targeted suite passed 35/35. The archive includes both pre-sync and final reports. Across the 29 partial files, all 528 opening GWT sections survived verbatim. Repository size checking, three App TypeScript configurations, scoped ESLint, both oxlint modes and formatting cover the surviving branch changes and both ledger files.

The initial pre-sync shuffled run had two failures, in the browser-history password form and the presentation-to-document gallery selection. Both passed in the post-sync full App survey. Subsequent shuffle and directed reruns are recorded independently. One archived domain-initialization diagnostic used the earlier explicit real-time wait. It received zero acceptance credit. The documented monotonic checkpoint replay still did not identify a positive post-deadline processing signal.

### Batch 75 controls and authorship review

The real Router opens the local Telegram provider. Changing only the popup-window guard or the origin guard accepts a different, deliberately named user in each run. Withholding the same-window refresh prevented deadline-012 from enabling input. Withholding the current image prevented deadline-014 from becoming ready. Deadline-018 was removed from first acceptance after both delivered and held first responses produced the same replacement result. A delivered-500 probe could not establish a visible earlier action-error message. Extending the 30-second transport deadline to 45 seconds defeats the reconnect assertions for deadline-036, 050 and 052. Withholding the first membership reply prevents the second moved-target lookup in discovery-046. The old-attachment hold for deadline-054 prevents fresh original-session text. Resetting the FPS sample on a repeated On selection defeats frame-rate-004. The restored cases are present in the final target and shuffled runs.

The delivery-versus-withholding probes for discovery-023/027, deadlines-007/009/022/023/035/039/043/053 and activity-summary-002 preserve their original open IDs. The detailed tables report any further comparisons. Distinct native sockets, browser target inventories, per-session input text, painted images, and the independent error reporter identify the receiving boundary where required. The full BDD remains for every partial file, including the existing address, shortcut, multi-tab navigation and billing survey gaps.

The authoring sources were the frozen GWT, current production entry points, `AGENTS.md`, `docs/testing.md`, `docs/app/app-testing.md`, the Platform ccstate ownership and SharedWorker guidance, and documented local browser boundaries. After authoring, the comparison covered 1,886 distinct historic test and helper blobs, 760 paths, 739 four-line windows in new code and 8 distinct shared windows. It included the freeze (`b0a10287`), both pre-withdrawal trees (`5310dbb9ba`, `a445586e04`), both sides of the path rename, restored tree, opening head, current cross-file helpers and main. Maximum same-registration token similarity was 0.627. Shared windows contain test and fixture imports, the existing example target, and the browser input event envelope. The highest similarity, frame-rate-003, follows the specified canvas sizes and expected coordinates; its Router and menu setup differs from the historical window-size orchestration. Per-ID source, comparison and line locations are in the archive. No historical registration body was imported.

### Batch 75 main synchronization

[Opening commit](https://github.com/okou-ai/okou/commit/1ad4f439480b3a69619b727495fbe221f2b5459c). Synced main `2c95e9e4b8d7a6cc6f0355c5406779465e7de022`. [Member-flow migration](https://github.com/okou-ai/okou/pull/49854) removed agent prerequisites from member-owned chat, integration, onboarding and workflow contracts. Of 171 conflict paths, 70 previously withdrawn tests remained absent. The other 101 retained the branch's tests and helpers, with fixtures adapted to the new public contracts. The member-flow survey ran 331 files and 1,504 rows. Three failures located the removed Feishu and Lark routing descriptions and the old agent Instructions bookmark. The bookmark belonged to a separate upstream regression. Its Router probe and retired registration are archived without a change to historical frozen credit. Member chat input now uses Home, thread reference payloads use the chat-thread schema, and provider fixtures omit removed executor fields. The surviving behavior of old cases with retired clauses remains a separate regression. The complete original BDD is restored for each previously closed file that lost coverage. The archive indexes upstream titles and parameter changes separately. Updated descriptor and chat-mention registrations correspond to non-selected frozen sources (api-client-bootstrap-002 and chat-composer-mentions-015/016). Project rewordings belong to the open project-chat-list-010 and projects-011/035/048/055. The older restored-attachment replacement retains the prior loss at chat-history-message-resources-001. The two workflow replacements run as member-owned regressions. None contributes first acceptance in this intake.

- `chat-list-cache-001`. The remote agent-loading service was removed. The cached rename and chat link are observable while member chat synchronization is held. The second pending source required by the frozen Given no longer exists.
- `pwa-navigation-014`. The member thread snapshot has no agent ownership. The unread conversation still marks Chats and leaves Me clear. Its ownership by a different agent cannot be constructed, including under the batch 69 amendment.
- `workflows-page-072`. A workflow has no executor-agent association. The member still sees both the shared workflow and its private override, but the fixture can no longer assign the other workflow to the agent in the stale filter.
- `workflows-page-075`. Create in chat still opens the member composer. The default-agent record required by the original Given is no longer supplied or stored.
- `integrations-feishu-005`. The Feishu card still opens the connected bot, account and uninstall options. The routing description was removed from Works. The original routing-information clause failed in the post-sync suite.
- `integrations-feishu-018`. The Lark card still opens the connected bot, account and uninstall options. The routing description was removed from Works. The original routing-information clause failed in the post-sync suite.
- `chat-list-configuration-002`. The pending conversation and its replayed configuration work from member Home. The independently rerun original agent-chat URL did not reach the required sidebar selection.

### Batch 75 file outcomes

#### browser-discovery-startup

[Routed tests](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.bdd.md). Partial file. 19 first acceptances, 4 previously accepted at intake, 5 open. Evidence in the probe archive includes disc75, setc75, setd75, sete75, seti75, held2-75 and extra75.log.

- [browser-discovery-startup-002](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L184) `browser-discovery-startup-002 First accepts text before Later appears`. Exact text reaches First with Later's lookup held. Later subsequently appears and Sibling 19 stays absent.

- [browser-discovery-startup-009](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L299) `browser-discovery-startup-009 Readiness joins the first picture, input and membership`. Layout completes with membership outstanding. After native proof and before the first picture, input remains disabled. Releasing that picture enables First and delivers input-proof-frame to its session.

- [browser-discovery-startup-015](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L299) `browser-discovery-startup-015 Readiness joins the first picture, input and membership`. The first static picture is delivered before validation. Further frames are held. Only the released membership proof enables First's viewer after input setup.

- [browser-discovery-startup-017](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L299) `browser-discovery-startup-017 Readiness joins the first picture, input and membership`. While membership is held, the first picture arrives and additional frames are blocked. Input setup alone leaves the proxy disabled. After proof, the retained picture and First's fresh text both work.

- [browser-discovery-startup-021](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L384) `browser-discovery-startup-021 Moving First retires its picture and directs input to Later`. Move First to window 19 during proof. Later becomes selected and ready, First disappears, and only Later receives the submitted text.

- [browser-discovery-startup-030](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L523) `browser-discovery-startup-030 The recovered quality setting survives a second membership check`. After the failed quality-60 capture, another membership proof disables input. Releasing proof restores First and the capture has quality 60.

- [browser-discovery-startup-033](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L252) `browser-discovery-startup-033 Closing First waits for the background survivor`. Close First with the survivor lookup held. New tab becomes selected and streaming, First disappears, and the actual assigned window contains only created-1.

- [browser-discovery-startup-036](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L196) `browser-discovery-startup-036 A tab created during a sibling lookup survives the completed scan`. Create during the foreign neighbor lookup. The created tab and Later appear in the rail, Neighbor 3 stays absent and remote input enables after inventory.

- [browser-discovery-startup-038](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L211) `browser-discovery-startup-038 Destroying First leaves the viewer connecting until Later is discovered`. Destroy First while Later's lookup is in flight. Connecting is visible and input and New tab are disabled. Later becomes selected and usable on release.

- [browser-discovery-startup-041](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L456) `browser-discovery-startup-041 A foreign candidate resolves to an empty assigned window`. Destroy both owned tabs with the foreign candidate still being checked. Connecting disables input and creation. The empty-window action creates and selects a usable blank tab.

- [browser-discovery-startup-044](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L478) `browser-discovery-startup-044 Closing both visible tabs preserves the correct final page`. Close First and the admitted sibling before the final scan. Only Later's URL survives in the assigned window, with Later selected.

- [browser-discovery-startup-045](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L478) `browser-discovery-startup-045 Closing both visible tabs preserves the correct final page`. The same two user closes without Later leave only about:blank in the assigned window, with New tab selected.

- [browser-discovery-startup-046](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L284) `browser-discovery-startup-046 Moving Later during its lookup leaves First selected`. Move the in-flight Later target to the other window. Receiving a second lookup for that target distinguishes delivery from withholding. First remains selected and usable and Later stays absent.

- [browser-discovery-startup-047](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L225) `browser-discovery-startup-047 An unsupported membership check disables the admitted viewer`. An unsupported membership reply causes the visible unsupported-operation message, disables input and keeps Later out of the rail.

- [browser-discovery-startup-048](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L239) `browser-discovery-startup-048 Publishing Later cannot enable input while First is still opening`. While the page attachment is held, releasing background inventory renders Later. Input stays disabled until the attachment is released and First is selected and ready.

- [browser-discovery-startup-049](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L344) `browser-discovery-startup-049 Leaving the viewer cancels the close awaiting Later's inventory`. Dispose the owner of the routed page while its close waits on inventory. The actual socket closes, the proxy leaves the page and both assigned-window targets survive.

- [browser-discovery-startup-051](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L400) `browser-discovery-startup-051 First can navigate on resume while Later is still being checked`. On resume, the visible live view has disabled input until First is readmitted. Enter in the address field sends the exact destination to First while Later's check is still held.

- [browser-discovery-startup-053](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L430) `browser-discovery-startup-053 A second resume waits for the surviving Later tab`. Move First while hidden and resume twice across pending inventory. Input is disabled while the second Later proof is held. It enables on Later and First is absent.

- [browser-discovery-startup-056](src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L364) `browser-discovery-startup-056 A reopened viewer selects the tab still in its window`. Pause, move First out and leave the route. After the socket closes, browser Back remounts the viewer. Later is selected and ready and First is absent.

- [browser-discovery-startup-003](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#browser-discovery-startup-003). After established streaming and duplicate, the readmission or background receipt did not arrive in the tested inventory order. No verified interval allows entering text before the background proof.

- [browser-discovery-startup-023](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#browser-discovery-startup-023). Withhold First's late image while allowing membership and the same Later selection and text assertions still pass. Image processing has no positive acknowledgement.

- [browser-discovery-startup-027](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#browser-discovery-startup-027). Keep the old Page.getFrameTree response withheld. Later still receives new text and the same readiness assertion passes.

- [browser-discovery-startup-040](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#browser-discovery-startup-040). With the final candidate in the assigned window, the expected Connecting/disabled interval could not be established. The foreign-candidate control is 041.

- [browser-discovery-startup-054](src/views/browser-session/__tests__/browser-discovery-startup.bdd.md#browser-discovery-startup-054). Hidden creation and window removal were visible at the boundary, but the pending membership lookup required by the Given never arrived before removal.

#### browser-response-deadlines

[Routed tests](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md). Partial file. 10 first acceptances, 0 previously accepted at intake, 18 open. Evidence in the probe archive includes set75 through seti75, held75, held2-75, withheld-more, hold-current-paint, extended-socket-deadline, extra75.log, sync-control-held and sync-control-delivered-error.

- [browser-response-deadlines-001](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L54) `browser-response-deadlines-001 Opening a hidden viewer defers use until it becomes visible`. A hidden initial page shows Viewing paused with disabled input. Revealing it enables Original and the local browser receives the submitted text on its sole connection.

- [browser-response-deadlines-012](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L145) `browser-response-deadlines-012 A same-window refresh joins the pending startup before its deadline`. During same-binding refresh, wait at attachment and hello for 21 seconds each. Release getWindow just before the minute. Original remains usable more than a minute later and accepts text over the same connection. Withholding the same-window service reply leaves the remote input disabled at the ready check.

- [browser-response-deadlines-014](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L123) `browser-response-deadlines-014 A successful window check waits for paint before reenabling input`. Fail the window check and advance four seconds. Successful proof alone leaves input disabled while the image is held. Delivering the frame restores Original over the same socket.

- [browser-response-deadlines-020](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L77) `browser-response-deadlines-020 A reconnected empty window can create a tab after a minute`. Reconnecting returns directly to No tabs open. After another minute the enabled empty-state action creates one selected, usable about:blank tab in the assigned window.

- [browser-response-deadlines-021](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L65) `browser-response-deadlines-021 An idle static page still receives text in its original session`. More than a minute after streaming, the original attachment still receives the submitted text with its address and connection intact.

- [browser-response-deadlines-036](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L100) `browser-response-deadlines-036 An unopened socket expires and a fresh socket restores the displayed page`. The unopened socket leaves input disabled before 30 seconds. Crossing the deadline displays Reconnecting. Opening the recovered physical socket restores the same page.

- [browser-response-deadlines-047](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L207) `browser-response-deadlines-047 Selecting a sibling recovers input on the healthy wire`. A failed native window read displays Reconnecting and disables input. Selecting the sibling restores its address and directs the text to its own page session on the existing connection.

- [browser-response-deadlines-050](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L226) `browser-response-deadlines-050 Expired text input stays with the original attachment`. Let the original x input expire and type y after recovery. The external browser receives x on the first page session and y on the distinct recovered session; x is not replayed there.

- [browser-response-deadlines-052](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L180) `browser-response-deadlines-052 Timing out a created tab preserves the original selection`. Hold the new-tab receipt through 30 seconds. On recovery the selected tab is Original and the assigned window contains just Original and created-1.

- [browser-response-deadlines-054](src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L260) `browser-response-deadlines-054 Retiring the target with a pending attachment preserves original input`. Destroy the pending replacement and advance past its original deadline. After delivering its old attachment, fresh text reaches the original session and neither the page nor the external error reporter reports an error.

- [browser-response-deadlines-004](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-004). The observer delivered an offscreen canvas and the native hello was received, but the following native window receipt or the page's paused acknowledgement did not arrive in this ordering.

- [browser-response-deadlines-006](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-006). A concealed replacement descriptor reached the local service, but revealing the page after expiry did not establish the expected Reconnecting state before replacement.

- [browser-response-deadlines-007](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-007). Retiring the hidden startup connection and typing on the new connection succeeded even when the original hello stayed withheld.

- [browser-response-deadlines-009](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-009). Both delivered and withheld descriptor controls left the replacement address and typing identical. Service ingress or serialization does not identify consumption by the page.

- [browser-response-deadlines-011](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-011). Transport phases and expiry were observable, but the remaining exact-one descriptor fetch was distinguished only by counting requests, which the testing guide excludes.

- [browser-response-deadlines-018](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-018). The replacement address, enabled New tab and absent error matched delivery even when the first descriptor reply was withheld. An independent delivered-500 probe could not observe the original action-error message before switching. Server ingress is insufficient to establish that the earlier failure was processed.

- [browser-response-deadlines-022](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-022). The replacement chat receives new input equally when the old recovery delivery is withheld.

- [browser-response-deadlines-023](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-023). Releasing or withholding the old paint after changing chats while hidden leaves the same replacement input outcome.

- [browser-response-deadlines-024](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-024). The prior image was withheld while wall time moved backwards. The retry capture needed to anchor monotonic expiry did not arrive at the required boundary.

- [browser-response-deadlines-026](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-026). The documented clock and held image did not establish both expired retries, their visible reconnecting states and restored replacement input in the original order.

- [browser-response-deadlines-029](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-029). Delaying the start receipt and holding the first picture did not produce the expected reconnecting state at the picture-relative deadline.

- [browser-response-deadlines-031](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-031). After resume and image expiry, the pending old stop-screencast acknowledgement required by the scenario did not arrive before the selection.

- [browser-response-deadlines-034](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-034). A replacement descriptor and address appeared while the transport was pending, but fresh text on its own page session was not established after release.

- [browser-response-deadlines-035](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-035). Current-transport readiness and fresh input still pass with the prior transport proof withheld. No acknowledgement distinguishes that old response.

- [browser-response-deadlines-039](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-039). The unavailable screen, explicit Reconnect and new tab all work with the old native hello withheld. None proves handling of that hello.

- [browser-response-deadlines-043](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-043). The original address and fresh input still pass when the old native scope reply is withheld.

- [browser-response-deadlines-051](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-051). Recovery reaches the accepted URL, but replay of the same destination has the same final URL. The exact-once clause was not verified via a distinct navigation effect.

- [browser-response-deadlines-053](src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-053). Switching chats shows the replacement address and delivers text with the old proof still withheld. The missing acknowledgement remains with this ID.

#### browser-frame-rate

[Routed tests](src/views/browser-session/__tests__/browser-frame-rate.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.bdd.md). Partial file. 5 first acceptances, 0 previously accepted at intake, 1 open. Evidence in the probe archive includes setg75, full and reset-on-reselect.

- [browser-frame-rate-002](src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L34) `browser-frame-rate-002 Keyboard selection opens the FPS display and restores toolbar focus`. Keyboard typeahead focuses FPS. Right, End and Enter enable the overlay and restore Browser settings focus.

- [browser-frame-rate-003](src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L125) `browser-frame-rate-003 Resizing a letterboxed image moves its FPS overlay to the image origin`. Two canvas sizes give the rendered FPS overlay coordinates (80, 0) and (0, 250). The latter follows the resize event.

- [browser-frame-rate-004](src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L66) `browser-frame-rate-004 Choosing On again keeps the original one-second sample`. Reselect On 300 ms into the original sample. Nine separately painted frames produce 9 FPS at the original one-second boundary.

- [browser-frame-rate-010](src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L85) `browser-frame-rate-010 PNG capture starts an empty FPS chart and then samples zero`. After a 9 FPS sample, selecting PNG clears the chart and shows an em dash. One second without frames produces 0 FPS.

- [browser-frame-rate-011](src/views/browser-session/__tests__/browser-frame-rate.test.tsx#L101) `browser-frame-rate-011 Tab selection resets samples and reopening FPS discards the old chart`. Switching away and back resets the displayed address, reading and graph for both tabs. Two quiet seconds yield 0 FPS. Disabling removes it; enabling again starts with an empty graph.

- [browser-frame-rate-001](src/views/browser-session/__tests__/browser-frame-rate.bdd.md#browser-frame-rate-001). The menu placement and checked states, chart dimensions, removal and focus are observable. The absence of inserted text does not establish that all browser traffic stayed idle.

#### browser-address-search

[Routed tests](src/views/browser-session/__tests__/browser-address-search.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.bdd.md). Partial file. 0 first acceptances, 40 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-browser-address-search.

- [browser-address-search-004](src/views/browser-session/__tests__/browser-address-search.bdd.md#browser-address-search-004). Open address was disabled and the draft remained ///invalid on the original remote page. Pressing Enter did not deliver a submit event or show an alert. An explicitly dispatched submit could reach the validation handler, but bypasses the disabled user action.

#### browser-domain-initialization

[Routed tests](src/views/browser-session/__tests__/browser-domain-initialization.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/browser-session/__tests__/browser-domain-initialization.bdd.md). Partial file. 0 first acceptances, 8 previously accepted at intake, 1 open. Evidence in the probe archive includes tg75 (documented clock replay); historical real-time probe excluded from acceptance.

- [browser-domain-initialization-018](src/views/browser-session/__tests__/browser-domain-initialization.bdd.md#browser-domain-initialization-018). The Page failure probe displayed Browser view unavailable, retired the original attachment and stayed disabled with one physical connection after 31 real seconds. The explicit timer and enlarged timeout fail the repository lint rules. A second probe used the documented 31,000 ms monotonic advance after retirement; no subsequent application clock read acknowledged the advance before the default case timeout. The timing clause remains open.

#### billing-survey

[Routed tests](src/views/okou-page/__tests__/billing-survey.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/billing-survey.bdd.md). Partial file. 0 first acceptances, 4 previously accepted at intake, 1 open. Evidence in the probe archive includes gaps275.

- [billing-survey-004](src/views/okou-page/__tests__/billing-survey.bdd.md#billing-survey-004). After the restored plan chooser closes the checkout feedback appears, and the answer records its session and price choice. While the chooser is open, its sibling chat action cannot confirm that the same survey-status response was already consumed. The service handler receiving a request is insufficient. Full opening BDD restored. Reserve redeem-campaign-page-003 passed independently.

#### chat-activity-summary

[Routed tests](src/views/okou-page/__tests__/chat-activity-summary.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/chat-activity-summary.bdd.md). Partial file. 0 first acceptances, 1 previously accepted at intake, 1 open. Evidence in the probe archive includes gaps475 (withheld response).

- [chat-activity-summary-002](src/views/okou-page/__tests__/chat-activity-summary.bdd.md#chat-activity-summary-002). The routed chat switches away from the completed run. With the old summary withheld, the indicator and composer still reached the same state as after delivery. No UI signal confirms processing of the late summary.

#### chat-artifact-action-group

[Routed tests](src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.bdd.md). Partial file. 0 first acceptances, 6 previously accepted at intake, 2 open. Evidence in the probe archive includes carried75 and b75check-chat-artifact-action-group.

- [chat-artifact-action-group-010](src/views/okou-page/__tests__/chat-artifact-action-group.bdd.md#chat-artifact-action-group-010). Dialog uses dispatch.pdf despite the owned artifact title. Batch 52 control retained.

- [chat-artifact-action-group-011](src/views/okou-page/__tests__/chat-artifact-action-group.bdd.md#chat-artifact-action-group-011). Sidebar uses dispatch.pdf despite the owned artifact title. Batch 52 control retained.

#### chat-composer-connector-status

[Routed tests](src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.bdd.md). Partial file. 0 first acceptances, 4 previously accepted at intake, 2 open. Evidence in the probe archive includes carried75 and b75check-chat-composer-connector-status.

- [chat-composer-connector-status-001](src/views/okou-page/__tests__/chat-composer-connector-status.bdd.md#chat-composer-connector-status-001). GitHub details and Acme Search were reachable with saved accounts requiring reconnection. The directory cannot show whether a same-state authorization write, credential read or manual grant request occurred. No request-count assertion was substituted.

- [chat-composer-connector-status-006](src/views/okou-page/__tests__/chat-composer-connector-status.bdd.md#chat-composer-connector-status-006). With 503 inventory, Accounts are unavailable and the separate Feishu card appeared; Acme Search and No accounts were absent. Browsing does not expose proof of zero authorization updates.

#### chat-private-artifact-previews

[Routed tests](src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.bdd.md). Partial file. 0 first acceptances, 4 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-chat-private-artifact-previews.

- [chat-private-artifact-previews-001](src/views/okou-page/__tests__/chat-private-artifact-previews.bdd.md#chat-private-artifact-previews-001). The rendered thumbnail points to the resolved delivery pathname under /cdn-cgi/image/ and omits the relative /artifacts reference. Clicking it opens the correct original image in the lightbox. The frozen thumbnail clause fails.

#### composer-custom-template-recommendations

[Routed tests](src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.bdd.md). Partial file. 0 first acceptances, 7 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-composer-custom-template-recommendations.

- [composer-custom-template-recommendations-009](src/views/okou-page/__tests__/composer-custom-template-recommendations.bdd.md#composer-custom-template-recommendations-009). Pasting unsupported.pdf adds a visible Remove unsupported.pdf attachment. The draft and Image action survive and the WEBP import sends its style task. The frozen Then forbids the PDF attachment.

#### directed-connect-page

[Routed tests](src/views/okou-page/__tests__/directed-connect-page.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.bdd.md). Partial file. 0 first acceptances, 4 previously accepted at intake, 3 open. Evidence in the probe archive includes opening BDD amendments #48841, #49830 and #49838, complete routed regressions and the #49854 member contract.

- [directed-connect-page-004](src/views/okou-page/__tests__/directed-connect-page.bdd.md#directed-connect-page-004). The current custom connector completion resumes the requesting chat. The old empty-permission agent grant has no verified recipient on this path after the chat-account migration (#48841 and #49838).

- [directed-connect-page-008](src/views/okou-page/__tests__/directed-connect-page.bdd.md#directed-connect-page-008). The original Given requires a chat-originated Stripe no-auth link with an agent ID. #49830 changed the originating link and the current Stripe catalog advertises OAuth, device sign-in and API key. No matching no-auth transaction was established.

- [directed-connect-page-012](src/views/okou-page/__tests__/directed-connect-page.bdd.md#directed-connect-page-012). The current GitHub OAuth start contract targets the saved connection and callback target. It does not carry the frozen directed agent ID and authorization flag after #49838. The original clause remains open.

#### discord-oauth-compatibility

[Routed tests](src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.bdd.md). Partial file. 0 first acceptances, 7 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-discord-oauth-compatibility.

- [discord-oauth-compatibility-007](src/views/okou-page/__tests__/discord-oauth-compatibility.bdd.md#discord-oauth-compatibility-007). Router probe verifies the matching signed approval was submitted, the original window closed, the consent page reported interruption, removed its proof and omitted Open Discord. The explicit exactly-one HTTP request clause remains unverified under the Platform request-count rule.

#### feishu-setup-guide

[Routed tests](src/views/okou-page/__tests__/feishu-setup-guide.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/feishu-setup-guide.bdd.md). Partial file. 0 first acceptances, 3 previously accepted at intake, 2 open. Evidence in the probe archive includes gaps275.

- [feishu-setup-guide-001](src/views/okou-page/__tests__/feishu-setup-guide.bdd.md#feishu-setup-guide-001). Feishu View setup reference and Back to fields scroll between always-mounted sections. The screenshot stayed visible after Back to fields, then after a confirmed zoom change and Escape. The values survived and a fresh bot draft started with an empty password field. Reference closure is unverified. Full provider BDD retained.

- [feishu-setup-guide-002](src/views/okou-page/__tests__/feishu-setup-guide.bdd.md#feishu-setup-guide-002). Lark View setup reference and Back to fields scroll between always-mounted sections. The screenshot stayed visible after Back to fields, then after a confirmed zoom change and Escape. The values survived and a fresh bot draft started with an empty password field. Reference closure is unverified. Full provider BDD retained.

#### integrations-wechat

[Routed tests](src/views/okou-page/__tests__/integrations-wechat.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/integrations-wechat.bdd.md). Partial file. 0 first acceptances, 5 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-integrations-wechat.

- [integrations-wechat-008](src/views/okou-page/__tests__/integrations-wechat.bdd.md#integrations-wechat-008). The remapped upstream registration still belongs to frozen 008. The signed-in account and workspace appear, but the Agent field displays Okou, not the frozen Workspace Assistant. The full confirmation scenario remains open.

#### keyboard-shortcut-hints

[Routed tests](src/views/okou-page/__tests__/keyboard-shortcut-hints.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/keyboard-shortcut-hints.bdd.md). Partial file. 0 first acceptances, 2 previously accepted at intake, 1 open. Evidence in the probe archive includes gaps475.

- [keyboard-shortcut-hints-003](src/views/okou-page/__tests__/keyboard-shortcut-hints.bdd.md#keyboard-shortcut-hints-003). Starting with the list closed, Command+B opens it and Hide chat list is visible. At the specified hover step there is no Show chat list button. A separate reordered probe found the shortcut tooltip after closing; that does not satisfy the original When.

#### org-billing-tab

[Routed tests](src/views/okou-page/__tests__/org-billing-tab.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/org-billing-tab.bdd.md). Partial file. 0 first acceptances, 21 previously accepted at intake, 1 open. Evidence in the probe archive includes #49556 permanently removed the feature switch; full iPhone settings regression 002.

- [org-billing-tab-001](src/views/okou-page/__tests__/org-billing-tab.bdd.md#org-billing-tab-001). #49556 removed the My Okou switch. Disabled iOS Given is impossible. Permanent link is 002. Original BDD retained.

#### org-general-tab

[Routed tests](src/views/okou-page/__tests__/org-general-tab.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.bdd.md). Partial file. 0 first acceptances, 5 previously accepted at intake, 1 open. Evidence in the probe archive includes gaps475; the saved result lacks an old-logo-read acknowledgement.

- [org-general-tab-004](src/views/okou-page/__tests__/org-general-tab.bdd.md#org-general-tab-004). The original read was held during the upload. This run did not reach the expected Workspace updated notice; earlier save/reload evidence established the new logo, but neither the new logo nor the refreshed organization acknowledges the old read.

#### paid-tools-settings

[Routed tests](src/views/okou-page/__tests__/paid-tools-settings.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/paid-tools-settings.bdd.md). Partial file. 0 first acceptances, 9 previously accepted at intake, 3 open. Evidence in the probe archive includes carried75 and b75check-paid-tools-settings.

- [paid-tools-settings-014](src/views/okou-page/__tests__/paid-tools-settings.bdd.md#paid-tools-settings-014). The Web search save reached the held token and displayed Saving. Switching to Second workspace left Web search checked. The second workspace was ready independently of the abandoned save, leaving its completion and the no-cross-workspace-write clause unverified.

- [paid-tools-settings-023](src/views/okou-page/__tests__/paid-tools-settings.bdd.md#paid-tools-settings-023). The original model preference read was held after selecting Ideogram 4. Second workspace became visible with a usable picker. Releasing that read had no observable completion for the old save, so absence of an update remains unproved.

- [paid-tools-settings-024](src/views/okou-page/__tests__/paid-tools-settings.bdd.md#paid-tools-settings-024). The original write token was held after the model preference read. Second workspace and its usable picker appeared on switching. Token release alone cannot prove the old save finished without an update.

#### preference-settings

[Routed tests](src/views/okou-page/__tests__/preference-settings.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/preference-settings.bdd.md). Partial file. 0 first acceptances, 3 previously accepted at intake, 1 open. Evidence in the probe archive includes whole-file Home redirect regression and original Agents route compared against #49556 and #49854.

- [preference-settings-003](src/views/okou-page/__tests__/preference-settings.bdd.md#preference-settings-003). The restored Then requires /agents?settings=model. The real legacy entry reaches /?settings=model with Use more models, Claude and ChatGPT (Codex). #49556 changed the shared route expectation. The passing Home row has separate upstream ownership.

#### preferences-page

[Routed tests](src/views/okou-page/__tests__/preferences-page.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.bdd.md). Partial file. 0 first acceptances, 2 previously accepted at intake, 3 open. Evidence in the probe archive includes carried75; 009 also uses the #48892 conflicting cookie/workspace precedence.

- [preferences-page-001](src/views/okou-page/__tests__/preferences-page.bdd.md#preferences-page-001). With a shared dark cookie and no workspace appearance, the loaded Theme panel selects System and resolves to Light. #48892 changed workspace restoration. The frozen dark initial state remains unproved.

- [preferences-page-002](src/views/okou-page/__tests__/preferences-page.bdd.md#preferences-page-002). With the light cookie and a dark workspace using Golden hour, the loaded panel selects Dark and retains Golden hour. The required initial Light is absent. #48892 replaced the cookie-first registration.

- [preferences-page-009](src/views/okou-page/__tests__/preferences-page.bdd.md#preferences-page-009). The frozen Then requires the shared dark preference to win, Light to display and Light to be written into the shared cookie. Batch 60 recorded the conflict and #48892’s replacement with a duplicate-cookie first-paint scenario. Its original BDD and ownership carry forward.

#### settings-model-loading

[Routed tests](src/views/okou-page/__tests__/settings-model-loading.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.bdd.md). Partial file. 0 first acceptances, 1 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-settings-model-loading.

- [settings-model-loading-001](src/views/okou-page/__tests__/settings-model-loading.bdd.md#settings-model-loading-001). Connect account was enabled before navigating Preference → Models. The rendered heading is “Use more models”; “Models” labels navigation. The frozen heading has no page evidence.

#### settings-wallet-cards

[Routed tests](src/views/okou-page/__tests__/settings-wallet-cards.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.bdd.md). Partial file. 0 first acceptances, 3 previously accepted at intake, 2 open. Evidence in the probe archive includes carried75 and b75check-settings-wallet-cards.

- [settings-wallet-cards-005](src/views/okou-page/__tests__/settings-wallet-cards.bdd.md#settings-wallet-cards-005). The real focus action preserved Everyday and the recent purchase. The delayed notification refresh then replaced them with the default Business card and the new purchase. The frozen focus clause also requires no extra requests, which the testing guide excludes as an assertion.

- [settings-wallet-cards-010](src/views/okou-page/__tests__/settings-wallet-cards.bdd.md#settings-wallet-cards-010). Disconnecting while the card refresh was held restored the Connect action. The section was already gone before the delayed response was released. No subsequent observable completion identifies consumption or dismissal of that response.

#### sidebar-workspace

[Routed tests](src/views/okou-page/__tests__/sidebar-workspace.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/sidebar-workspace.bdd.md). Partial file. 0 first acceptances, 2 previously accepted at intake, 1 open. Evidence in the probe archive includes #49556 removed pinned-agent controls; complete workspace-search regressions and #49854 member route.

- [sidebar-workspace-005](src/views/okou-page/__tests__/sidebar-workspace.bdd.md#sidebar-workspace-005). Upstream #49556 removed pinned agents and their per-agent chat destinations.

#### telegram-oauth-connect

[Routed tests](src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.bdd.md). All retained selections accepted. 1 first acceptances, 6 previously accepted at intake, 0 open. Evidence in the probe archive includes target, full, wrong-window and wrong-origin.

- [telegram-oauth-connect-003](src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L122) `telegram-oauth-connect-003 Works shows the identity supplied by the opened provider tab`. A local popup with an unrelated source and a message from an unrelated origin use distinct usernames. The supplied provider tab's valid callback links the third account, which Works displays after the success notice. Removing either check selects its corresponding wrong account.

#### onboarding-agentphone-tile

[Routed tests](src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.bdd.md). Partial file. 0 first acceptances, 3 previously accepted at intake, 1 open. Evidence in the probe archive includes seth75 (DOM) and earlier desktop Chromium layout evidence in the opening ledger.

- [onboarding-agentphone-tile-001](src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.bdd.md#onboarding-agentphone-tile-001). Desktop Chromium at 1280px with a fine pointer gives the issued QR a layout box. The inline SMS anchor has the matching href but no layout box because its responsive container has display:none. The desktop Then requires both to be shown.

#### onboarding-progress

[Routed tests](src/views/onboarding-sources-first/__tests__/onboarding-progress.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-progress.bdd.md). Partial file. 0 first acceptances, 7 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-onboarding-progress.

- [onboarding-progress-005](src/views/onboarding-sources-first/__tests__/onboarding-progress.bdd.md#onboarding-progress-005). Historical retirement in #49278 (4338aeeabf) for a pre-draft API rollback. On this branch a separate Router probe received a draft-service 404 and displayed the legacy launch plan at /onboarding/ready. The supported 404 now denotes a member who no longer needs onboarding. The pre-draft service is a retired deployment condition and retains zero first-acceptance credit. Its full BDD remains in the progress file. #49384 (25d468f63e) separately adds another member’s shared-browser draft isolation, tracked as upstream-25d468f6-onboarding-progress-01 among the 68.

#### onboarding-sources-first-flow

[Routed tests](src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md). Partial file. 0 first acceptances, 14 previously accepted at intake, 3 open. Evidence in the probe archive includes carried75 and b75check-onboarding-sources-first-flow.

- [onboarding-sources-first-flow-012](src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-012). The owner’s completion was held at the ready page; release allowed the first task to run. The frozen Then also requires exactly one completion. The testing guide forbids request-count assertions.

- [onboarding-sources-first-flow-015](src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-015). The invited member saw the full competitor-research preset, edited it to Draft my meeting agenda and opened chat with that task. Completion was observed from the ready step. The exact-one completion clause conflicts with the testing guide.

- [onboarding-sources-first-flow-021](src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-021). The edited EU launch prompt stayed at onboarding until the completion response was released, then reached chat with the document instructions. The frozen single-completion clause cannot be credited under the request-count rule.

#### onboarding-start

[Routed tests](src/views/onboarding/__tests__/onboarding-start.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.bdd.md). Partial file. 0 first acceptances, 2 previously accepted at intake, 1 open. Evidence in the probe archive includes carried75 and b75check-onboarding-start.

- [onboarding-start-001](src/views/onboarding/__tests__/onboarding-start.bdd.md#onboarding-start-001). The open-page probe saw the authenticated, un-aborted production POST with the onboarding-start tag and UUID while its response was held. At ingress the correct actor and workspace already had started telemetry without a status code. The industry question was visible before release. Its exact one-POST requirement conflicts with the current request-count assertion rule. Neither exact count was credited.

#### link-navigation

[Routed tests](src/views/router/__tests__/link-navigation.test.tsx) · [Complete opening BDD](https://github.com/okou-ai/okou/blob/1ad4f439480b3a69619b727495fbe221f2b5459c/turbo/apps/platform/src/views/router/__tests__/link-navigation.bdd.md). Partial file. 0 first acceptances, 3 previously accepted at intake, 1 open. Evidence in the probe archive includes gaps475 (actual default navigation in the detached browser).

- [link-navigation-005](src/views/router/__tests__/link-navigation.bdd.md#link-navigation-005). The real Home rail link received a Meta click. The detached Vitest browser followed its default action in the original frame, leaving /workflows where the GWT requires Home to remain at /. The probe cannot establish a separate native browsing context, and the full original BDD with its upstream amendment stays open.

### Batch 76 file nominations

30 distinct open frozen paths, 115 retained selections. Recheck their complete BDD, upstream amendments and history against the next head.

- `turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx` · 001, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx` · 002, 004, 006, 007, 009, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx` · 002, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-isolation.test.tsx` · 001, 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx` · 001, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx` · 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx` · 005, 006, 007, 008, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx` · 001, 003, 007, 008, 009.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx` · 001, 002, 003, 005, 008, 009.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ime.test.tsx` · 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx` · 002, 003, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx` · 003, 005, 006, 007, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx` · 001, 003, 004, 005, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx` · 001, 002, 003, 004, 007, 010, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx` · 001, 002, 003, 007, 010, 012, 013.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx` · 001, 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx` · 002, 003, 004, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx` · 001, 003, 006.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx` · 001, 003, 004, 006, 011, 013, 014.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx` · 001, 002, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx` · 003, 004, 005, 006, 007, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx` · 002, 003.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx` · 001, 003.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx` · 001, 004, 006, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx` · 001, 002, 004, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx` · 003, 004, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx` · 002, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx` · 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx` · 001, 002, 005, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx` · 001, 003.

## Batch 76 intake and main synchronization

The original 30 distinct paths below have 115 retained IDs at opening head eabfe3b5fd. The complete BDD and freeze register at 4855592c were checked against the historical ledger. All 115 enter this batch pending. No batch 75 file is repeated.

- `turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx` · 001, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx` · 002, 004, 006, 007, 009, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx` · 002, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-isolation.test.tsx` · 001, 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx` · 001, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx` · 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-accounts.test.tsx` · 005, 006, 007, 008, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx` · 001, 003, 007, 008, 009.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx` · 001, 002, 003, 005, 008, 009.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ime.test.tsx` · 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx` · 002, 003, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx` · 003, 005, 006, 007, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx` · 001, 003, 004, 005, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx` · 001, 002, 003, 004, 007, 010, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx` · 001, 002, 003, 007, 010, 012, 013.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx` · 001, 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx` · 002, 003, 004, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx` · 001, 003, 006.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx` · 001, 003, 004, 006, 011, 013, 014.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx` · 001, 002, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx` · 003, 004, 005, 006, 007, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx` · 002, 003.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx` · 001, 003.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx` · 001, 004, 006, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx` · 001, 002, 004, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx` · 003, 004, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx` · 002, 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx` · 003, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx` · 001, 002, 005, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx` · 001, 003.

Main d9f5bb7159 includes #49936 (Chats is active on a project page) and #49924 (reader-initiated scroll and two-frame alignment). Four withdrawn files keep their BDD and three independently rewritten files keep their implementations. The attachment history regression now waits for the rendered bottom, then scrolls upward with wheel input. First probe: an isolated wheel with no directional offset did not load Question 5. Restored user gesture: 19/19 rows across four complete suites, shuffled seed 76001. New upstream scroll scenarios (layout/tap, both render frames and reader motion between frames) and project rail coverage remain attributed to upstream. Historical and current counts at intake are 1,495 and 1,471.

## Batch 76 evidence

30 frozen files held 115 pending retained selections. 81 earned first acceptance. 12 files closed, 16 are partial and 2 are blocked. 33 selected scenarios remain open. #49556 explicitly retired one additional selection in a partial file. The 18 partial or blocked files retain the full BDD.

[Fixed intake](#batch-76-intake-and-main-synchronization). [All 115 GWT records and exact Vitest rows](https://app.okou.ai/artifacts/c1lrse409m.tsv) · [Probe sources, control runs, ownership and post-write comparisons](https://app.okou.ai/artifacts/gaqyhu2e0a.zip) · [Next 30 open files and their 160 IDs](https://app.okou.ai/artifacts/2q73q2h9br.md).

The opening head was `eabfe3b5fd8c1580d0b12e6573324bcaed7e905b`. [Conflict resolution and intake](https://github.com/okou-ai/okou/commit/bb37eccae21fe605a061d3abcd4557693647a44d) preserved the open BDD on four modify/delete paths and retained three independent implementations. [Batch tests and file closures](https://github.com/okou-ai/okou/commit/80a75d3c7a06758c5d49970025c1c600f1d5f5b0) were verified after synchronizing [main](https://github.com/okou-ai/okou/commit/415b071c0d59356639a0e09f43b0fa55095d2946).

### File outcomes

Each source link opens the implementation at the tested revision or the intact BDD for a wholly blocked file. One source with parameter rows can provide several different stable IDs. Each accepted ID has exactly one passing expanded title in the linked TSV.

| Frozen file                                                                                                          | Outcome                      | First accepted                    | Open or retired              |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------- | ---------------------------- |
| [chat-browser-shutdown.test.tsx](src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx)                       | Partial                      | 004                               | 001, 003                     |
| [chat-capability-phone-use.test.tsx](src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx)               | Partial                      | 002, 004, 006, 009, 011           | 007                          |
| [chat-capability-voice-forwarding.test.tsx](src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx) | Partial                      | 003, 004                          | 002                          |
| [chat-capability-voice-isolation.test.tsx](src/views/okou-page/__tests__/chat-capability-voice-isolation.bdd.md)     | Blocked                      | —                                 | 001, 002                     |
| [chat-codex-execution.test.tsx](src/views/okou-page/__tests__/chat-codex-execution.test.tsx)                         | Partial                      | 001, 004                          | 003                          |
| [chat-composer-account-selection.test.tsx](src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx)   | Partial                      | 004                               | 003                          |
| [chat-composer-connector-accounts.test.tsx](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md)   | Blocked                      | —                                 | 005, 006, 007, 008, 010      |
| [chat-composer-connector-overview.test.tsx](src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx) | Partial                      | 008                               | 001, 003, 007, 009           |
| [chat-composer-create.test.tsx](src/views/okou-page/__tests__/chat-composer-create.test.tsx)                         | Partial                      | 001, 003, 005, 008, 009           | 002                          |
| [chat-composer-ime.test.tsx](src/views/okou-page/__tests__/chat-composer-ime.test.tsx)                               | Closed                       | 002                               | —                            |
| [chat-composer-keyboard.test.tsx](src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx)                     | Partial                      | 002, 003                          | 005                          |
| [chat-composer-model-panel.test.tsx](src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx)               | Closed                       | 003, 005, 006, 007, 010           | —                            |
| [chat-composer-model-resolution.test.tsx](src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx)     | Closed                       | 001, 003, 004, 005, 007           | —                            |
| [chat-composer-model-selection.test.tsx](src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx)       | Closed                       | 001, 002, 003, 004, 007, 010, 011 | —                            |
| [chat-composer-slash-hint.test.tsx](src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx)                 | Partial                      | 002                               | 001, 003, 007, 010, 012, 013 |
| [chat-continuity-clipboard.test.tsx](src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx)               | Closed                       | 001, 002, 004                     | —                            |
| [chat-continuity-drafts.test.tsx](src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx)                     | Partial                      | 003, 004, 007                     | 002                          |
| [chat-continuity-history.test.tsx](src/views/okou-page/__tests__/chat-continuity-history.test.tsx)                   | Closed                       | 001, 003, 006                     | —                            |
| [chat-continuity-uploads.test.tsx](src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx)                   | Partial                      | 001, 004, 006, 013, 014           | 003, 011                     |
| [chat-conversation-locator.test.tsx](src/views/okou-page/__tests__/chat-conversation-locator.test.tsx)               | Partial                      | 001, 005                          | 002                          |
| [chat-emoji.test.tsx](src/views/okou-page/__tests__/chat-emoji.test.tsx)                                             | Closed                       | 003, 004, 005, 006, 007, 010      | —                            |
| [chat-engagement-telemetry.test.tsx](src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx)               | Closed                       | 002, 003                          | —                            |
| [chat-expected-failures.test.tsx](src/views/okou-page/__tests__/chat-expected-failures.test.tsx)                     | Partial                      | 001                               | 003                          |
| [chat-fork.test.tsx](src/views/okou-page/__tests__/chat-fork.test.tsx)                                               | Partial, explicit retirement | 001, 004, 006                     | 007 (retired)                |
| [chat-image-navigation-shortcuts.test.tsx](src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx)   | Partial                      | 001, 007                          | 002, 004                     |
| [chat-member-model-route.test.tsx](src/views/okou-page/__tests__/chat-member-model-route.test.tsx)                   | Closed                       | 003, 004, 005                     | —                            |
| [chat-model-projection-refresh.test.tsx](src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx)       | Closed                       | 002, 003, 004                     | —                            |
| [chat-offline-cache.test.tsx](src/views/okou-page/__tests__/chat-offline-cache.test.tsx)                             | Partial                      | 003                               | 004                          |
| [chat-rename-focus.test.tsx](src/views/okou-page/__tests__/chat-rename-focus.test.tsx)                               | Closed                       | 001, 002, 005, 007                | —                            |
| [chat-runless-delivery.test.tsx](src/views/okou-page/__tests__/chat-runless-delivery.test.tsx)                       | Closed                       | 001, 003                          | —                            |

### Case evidence

All 30 files were assessed using probes written from the frozen GWT, any recorded amendments, current production entry points and the repository’s testing guidance. Routes, editor input, browser transport and projected account identities were exercised through their user or external boundary.

#### chat-browser-shutdown

- [001](src/views/okou-page/__tests__/chat-browser-shutdown.bdd.md#chat-browser-shutdown-001). Open. Closing with Shift held disabled the reopened input until key-up. Typing reached example-page, but the native fixture observed two connections after reopening, up from one.
- [003](src/views/okou-page/__tests__/chat-browser-shutdown.bdd.md#chat-browser-shutdown-003). Open. Native key release rejected with -32001. The connection closed and Message was enabled. The Sentry boundary had no report carrying the rejection code and message.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-browser-shutdown.test.tsx#L46). Original target received mousePressed then mouseReleased. Closing hid the panel while its native connection stayed open; releasing the held acknowledgment let it close.

#### chat-capability-phone-use

- [002](https://github.com/okou-ai/okou/blob/a15b9d05370743de519c95cbdf76554eff0f78ef/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L150). Kitchen appeared alone, closing produced no list read during the close, and reopening after disconnection showed No phones online.
- [004](https://github.com/okou-ai/okou/blob/a15b9d05370743de519c95cbdf76554eff0f78ef/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L88). Switched off the checked offline Travel phone. Its row disappeared and No phones online appeared.
- [006](https://github.com/okou-ai/okou/blob/a15b9d05370743de519c95cbdf76554eff0f78ef/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L99). All three Phone setup instructions appeared; Escape dismissed the dialog and restored focus to Connectors.
- [007](src/views/okou-page/__tests__/chat-capability-phone-use.bdd.md#chat-capability-phone-use-007). Open. With both named phones online and the first grant visible in a fresh chat-grant read, clicking the second did not establish the complete replacement/deselection sequence. A switch was still checked at the negative assertion.
- [009](https://github.com/okou-ai/okou/blob/a15b9d05370743de519c95cbdf76554eff0f78ef/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L118). Held consent at the grant boundary, observed no start, then released it and received Use my phone as the Run prompt.
- [011](https://github.com/okou-ai/okou/blob/a15b9d05370743de519c95cbdf76554eff0f78ef/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-phone-use.test.tsx#L133). Rejected consent produced its error on /, preserved Use my phone without starting a Run, and reopened with Kitchen checked.

#### chat-capability-voice-forwarding

- [002](src/views/okou-page/__tests__/chat-capability-voice-forwarding.bdd.md#chat-capability-voice-forwarding-002). Open. The selected feedback note accepted Forward draft / and opened the slash menu. After ArrowUp the menu offered Workflow and Create, with no Document button for the original hover/pressed assertion.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L66). Composition Enter left the slash menu, original passage dialog and Forward draft / intact with editor focus and unchanged source notes.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx#L74). Escape closed the slash menu alone; the focused dialog draft and original notes remained visible.

#### chat-capability-voice-isolation

- [001](src/views/okou-page/__tests__/chat-capability-voice-isolation.bdd.md#chat-capability-voice-isolation-001). Open. The first recording stopped with the VAD model held. The old runtime disposed, then the second routed bootstrap raised AbortError before its composer was available. Original-session release after the new user mounted could not be verified.
- [002](src/views/okou-page/__tests__/chat-capability-voice-isolation.bdd.md#chat-capability-voice-isolation-002). Open. The failed recording exposed Use recording in the first runtime. Opening a fresh child runtime for the second identity raised AbortError before Voice input and absence of the old recording could be checked.

#### chat-codex-execution

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L15). The saved Ultra thread displayed Max; the effort slider stayed at Max at its upper boundary.
- [003](src/views/okou-page/__tests__/chat-codex-execution.bdd.md#chat-codex-execution-003). Open. The saved Ultra setting fell back to Max, and the Lab switch was operable. After returning through browser history, the probe did not observe GPT 6.1 Sol, Ultra even with Ultra in the subscription catalog.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L15). Removing Ultra from the enabled catalog left Max at the end of the slider and no Ultra option.

#### chat-composer-account-selection

- [003](src/views/okou-page/__tests__/chat-composer-account-selection.bdd.md#chat-composer-account-selection-003). Open. The GitHub account group exposes per-account access switches. It did not expose the selected-but-falling-back Personal option or the separate unselected default option required by the original Then.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-account-selection.test.tsx#L43). Work appeared in GitHub, closing restored trigger focus, and a fresh opening displayed Renamed account without Work.

#### chat-composer-connector-accounts

- [005](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md#chat-composer-connector-accounts-005). Open. The fixture supplied Work and Personal. The current GitHub group exposed access switches and no original current-account selector. The probe stopped before carrying Personal into creation.
- [006](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md#chat-composer-connector-accounts-006). Open. The fixture supplied Work and Personal. The current GitHub group exposed access switches and no original current-account selector. The probe stopped before a rejected creation preserving the original message and attachment.
- [007](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md#chat-composer-connector-accounts-007). Open. The fixture supplied Work and Personal. The current GitHub group exposed access switches and no original current-account selector. The probe stopped before an older failure preserving the newer draft and attachment.
- [008](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md#chat-composer-connector-accounts-008). Open. The fixture supplied Work and Personal. The current GitHub group exposed access switches and no original current-account selector. The probe stopped before retrying under the original client chat ID.
- [010](src/views/okou-page/__tests__/chat-composer-connector-accounts.bdd.md#chat-composer-connector-accounts-010). Open. The fixture supplied Work and Personal. The current GitHub group exposed access switches and no original current-account selector. The probe stopped before explicitly clearing the named selection with Use default.

#### chat-composer-connector-overview

- [001](src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-001). Open. All 20 distinct connector labels appeared on both openings. The selected Then also specifies exact overview/target/legacy reads. Reopening alone could not distinguish those clauses.
- [003](src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-003). Open. The correctly addressed connector:changed event made Probe 1 access off. The subsequent removal/reconnect sequence did not provide the required full refreshed overview with Probe 2.
- [007](src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-007). Open. Try again, independent Probe 2 update, retry and the later off state were observed. The original Then also requires exactly two overview and three target reads; those quantities are not established by the UI.
- [008](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L35). Details were untouched while the top panel was open. Opening GitHub resolved the exact off-page Personal ID and displayed its checked switch and Reconnect required.
- [009](src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-009). Open. The New chat link reached / and history returned to the original thread with the connector visible. Releasing the subscription while away and the exact request mix on return were not established.

#### chat-composer-create

- [001](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L50). The rendered user bubble omitted Create and slide settings. Its copied text/plain was exactly Our launch brief.
- [002](src/views/okou-page/__tests__/chat-composer-create.bdd.md#chat-composer-create-002). Open. On an active run the Create action and a Presentation choice could be reached. The probe could not reach the Remove Presentation chip and slide options, so it did not prove the two distinct queued message parts.
- [003](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L114). Starting with Our launch, the first selected template closed the picker, left one matching chip, kept Image and displayed Claude Fable 5.1.
- [005](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L130). The sent document carried Image intent, replacement style, Our launch, second style and final text in order. The old style was absent.
- [008](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L108). Add style opened the catalog with the Image tab selected.
- [009](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L186). Removing Presentation kept the text and template. The captured ordinary send carried both and no additional_info part.

#### chat-composer-ime

- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ime.test.tsx#L32). The visible weekly workflow dropped during p r123 preedit and returned after cancellation with the draft still /. Committed /pr123 details closed the menu.

#### chat-composer-keyboard

- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L15). The active-run draft retained focus and an actual line break between the two fragments, with neither send nor queue observing a prompt.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-keyboard.test.tsx#L52). Linux plain Enter retained the focused unsent draft. Control Enter delivered its exact two-line text, rendered the user turn and exposed Stop.
- [005](src/views/okou-page/__tests__/chat-composer-keyboard.bdd.md#chat-composer-keyboard-005). Open. On Android the viewport and keyboard-open indicator changed as expected. After closing the keyboard, Enter did not yield the combined two-line prompt at the send boundary. The subsequent hardware shortcut remains unproved.

#### chat-composer-model-panel

- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L118). Loading, both plan groups and the model were visible before the quota reply. Delivery showed 88% left, kept the original plan and model, and removed loading.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L21). Both model options were selectable. Effort was outside their scroll viewport; the usage endpoints and 2.5× Fast hint were visible.
- [006](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L42). The same panel survived Low, Fast and Sonnet selection. The trigger and slider reflected each value and Fast disappeared for Claude.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L62). The temporary notice appeared for Sol with Effort and Fast enabled, disappeared when Astra was reselected, and close restored trigger focus.
- [010](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L85). Selecting Ultrafast checked its radio and displayed the Codex allowance explanation.

#### chat-composer-model-resolution

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L24). Selecting Sonnet checked its option, relabeled the thread trigger and left the obsolete group absent.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L38). The picker offered GPT 6 Sol without DeepSeek; the repaired selection was null and the outgoing send omitted an explicit model.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L64). With stored null, Auto sent the message visibly with no repair observed at the model-update boundary.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L64). With stored auto, the rendered user turn appeared and the repair boundary stayed untouched.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L91). The outgoing send identified the original Opus thread and omitted an explicit model override.

#### chat-composer-model-selection

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L155). Future chats stayed unchanged during temporary selection. The update sent Sonnet/high, and the preference notification removed the temporary notice.
- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L27). A remote preference with an extra kind changed the composer from Fable to Opus.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L47). Luna selection updated the trigger and usage message. Fast enabled xHigh, and reselecting the same option kept it checked.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L67). The slider visited Low through Max, Fast preserved Max and creation carried max/priority.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L99). The sequence through Sol, Luna and back to Sonnet preserved Max, xHigh and Extra respectively.
- [010](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L120). The panel showed Max; neither the thread nor native preference update boundary received a write on opening.
- [011](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-selection.test.tsx#L155). Sol displayed Max while its future-chat preference patch carried the original Ultra value.

#### chat-composer-slash-hint

- [001](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-001). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.
- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-hint.test.tsx#L33). The bare slash displayed the hint; querying and accepting weekly-recap removed it and inserted the workflow. Escape on reopening preserved the draft and focus.
- [003](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-003). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.
- [007](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-007). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.
- [010](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-010). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.
- [012](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-012). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.
- [013](src/views/okou-page/__tests__/chat-composer-slash-hint.bdd.md#chat-composer-slash-hint-013). Open. The frozen /agents/e0000000-0000-4000-a000-000000000010/chat path rendered the missing-page surface. The agent-chat composer prerequisite is unavailable for this ID. Existing-thread 002 is counted separately.

#### chat-continuity-clipboard

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L44). The first paste inserted both lines at the caret and attached revenue.txt. A later missing-file paste retained its text and the available file.
- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L75). Pending resolution showed the text and Cancel upload. Delivering availability changed it to Remove, persisted the correct file ID and text, and enabled Send.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-clipboard.test.tsx#L107). The first paste landed between Alpha and omega. The structured second paste rendered the referenced chat as a chip between its two text lines.

#### chat-continuity-drafts

- [002](src/views/okou-page/__tests__/chat-continuity-drafts.bdd.md#chat-continuity-drafts-002). Open. An immutable older draft and file were held during local typing. Delivering them and indefinitely withholding them both preserved the local text and saved it. The checked patch did not establish that the app processed the old response.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L54). After removing the restored file, the ordered text, chat reference, template and feedback remained; the saved patch preserved the required parts.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L23). The neighboring route and title changed; returning to the first conversation restored its unsent checklist.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-drafts.test.tsx#L104). The sent message contained the revised brief and new file only. Its visible user turn and the stored empty draft followed the send.

#### chat-continuity-history

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L71). The final and latest answers were rendered, the answer before the repeated group was absent, and the final repeated answer had one anchor with Message available.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L31). The six-turn viewport moved to bottom with its control hidden, then Control+Up reached zero and restored the bottom control.
- [006](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-history.test.tsx#L114). Active main and side panes had separate IDs. The pending steer appeared in the main user turn only. Confirmation reused its client event ID, left one anchor/turn, cleared the queue copy and displayed the main answer alongside Side answer.

#### chat-continuity-uploads

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L40). Both MIME types reached prepare. The two distinct storage PUTs omitted credentials and sensitive headers, and both files became removable.
- [003](src/views/okou-page/__tests__/chat-continuity-uploads.bdd.md#chat-continuity-uploads-003). Open. A valid absolute private Artifact URL reached storage, its ID reached completion, and private.txt became removable. The once-only completion clause has no distinguishing evidence in this probe.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L88). The 503 filename appeared once; only ready.txt remained attached and reached the outgoing message.
- [006](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L237). At the XHR boundary half of part one produced 12%; completing part two started the one-byte fifth part and produced 37%. The bar stayed at 99% until finalization then was replaced by the attachment.
- [011](src/views/okou-page/__tests__/chat-continuity-uploads.bdd.md#chat-continuity-uploads-011). Open. After the finalization 404 the server message appeared once and the generic error was absent. The UI does not distinguish one completion request from a duplicate with the same outcome.
- [013](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L132). Preparing the exact five-GiB File exposed the full byte size, progress and Cancel. Cancelling removed the control.
- [014](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L273). Four specific active transfers received native abort. Progress disappeared and the fifth never started; no failure notice appeared.

#### chat-conversation-locator

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L35). With the first turn unmounted and 24 markers, the hover preview exposed Aug 1, 10:00 AM and its exact ISO datetime.
- [002](src/views/okou-page/__tests__/chat-conversation-locator.bdd.md#chat-conversation-locator-002). Open. The upstream amendment requires 30 turns. After clicking the first marker, a late answer required to be unmounted was still present. The original eight-turn fixture cannot close the amended Then.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx#L41). Leaving the first marker in the eight-turn fixture dismissed the displayed timestamp.

#### chat-emoji

- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L31). After resizing to desktop, the header retained the grinning icon and a single Emoji planning title, alongside More actions.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L111). A held rename left the new emoji visible while the picker stayed open. Delivering it dismissed the picker.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L77). Closing through Change icon returned focus inside the original chat pane.
- [006](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L46). The mobile-to-desktop move retained one focused eye query, both matching emoji, and one title.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L46). The desktop-to-mobile move retained one focused eye query, both matching emoji, and one title.
- [010](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-emoji.test.tsx#L89). ArrowRight kept the search and current category while moving focus. Enter cleared the search and displayed the newly current Smileys section with focus.

#### chat-engagement-telemetry

- [002](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L14). Expanding the completed 20-second work history revealed the hidden activity and emitted its completed-status event.
- [003](https://github.com/okou-ai/okou/blob/6c8b84946ade43564c69803c4901326691ca632d/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L58). The analytics fixture recorded the three ordered impression kinds and every selected index/kind/generation type across four clicks.

#### chat-expected-failures

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx#L14). Direct routed bootstrap rejected with status 426 from the headerless local error and displayed Update required.
- [003](src/views/okou-page/__tests__/chat-expected-failures.bdd.md#chat-expected-failures-003). Open. The local media boundary rejected getUserMedia. With expected console output captured, the denial guidance appeared and the notes remained, but the matching Sentry exception assertion failed before retry could be certified.

#### chat-fork

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L100). The created chat carried the Launch project ID; the source remained under Launch with the same route and unfinished notes after confirmation.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L40). F opened a dialog carrying the selected source passage and accepted the typed follow-up.
- [006](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-fork.test.tsx#L51). The new destination received the exact feedback quote, note and source run ID without the unrelated answer; the original composer notes remained.
- [007](src/views/okou-page/__tests__/chat-fork.bdd.md#chat-fork-007). Retired. The BDD explicitly records removal of the Forward target picker and chosen-agent path in #49556. The personal Fork behavior has its own ID 006. The complete amendment remains in the BDD.

#### chat-image-navigation-shortcuts

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L24). At the third image Next was absent; Right stayed there and Left returned to the second image.
- [002](src/views/okou-page/__tests__/chat-image-navigation-shortcuts.bdd.md#chat-image-navigation-shortcuts-002). Open. Both the authenticated web-file and the valid private Artifact reference returned a fixture 404. The middle gallery image did not display the required unavailable-artifact text.
- [004](src/views/okou-page/__tests__/chat-image-navigation-shortcuts.bdd.md#chat-image-navigation-shortcuts-004). Open. The sidebar navigation owner kept focus and the second image was hidden during private URL/decode. Releasing the actual HTMLImageElement.decode gate did not make the currently rendered image visible to the assertion.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L37). Modifier keys and menus left the stage in place. Focused lightbox and sidebar navigation changed the matching gallery, including after fullscreen exit.

#### chat-member-model-route

- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L17). Max and checked Fast appeared together with Lower usage, Higher usage and 2.5×.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L38). Sending stayed disabled and the draft was preserved. The device flow showed C342-4000 and requested the existing personal provider ID.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-member-model-route.test.tsx#L38). After the remote switch and explicit Configure, NEXT-3424 appeared and the captured reconnect named the new provider ID while preserving the draft.

#### chat-model-projection-refresh

- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L50). The local draft remained during the held read and after the app displayed the exact Routing refresh unavailable error.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L59). The Low model trigger remained before and after the error was displayed by the page.
- [004](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L66). Once the page displayed its refresh error, the original Low/Fast trigger still opened a panel with Fast checked.

#### chat-offline-cache

- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-offline-cache.test.tsx#L15). The remembered title and enabled composer appeared with confirmation pending. Absence produced Chat thread not found and removed Message with the skeleton hidden.
- [004](src/views/okou-page/__tests__/chat-offline-cache.bdd.md#chat-offline-cache-004). Open. The saved response was visible on a first real visit, and that child runtime disposed. With remote history held on the second visit, direct and message-port bootstrap encountered AbortError before cached history could be observed. No private cache entries were injected.

#### chat-rename-focus

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L47). Committing the renamed side chat with Enter closed its dialog, left focus on body, and a further Enter did not open emoji search.
- [002](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L47). Escape closed the side-pane dialog, left focus on body, and Enter did not open emoji search.
- [005](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L16). F2 from the main editor followed by Escape closed Rename and left body focused.
- [007](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-rename-focus.test.tsx#L16). Double-clicking the main title opened Rename; Escape dismissed it with body focus.

#### chat-runless-delivery

- [001](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx#L11). A standalone assistant message with no Run rendered its exact text.
- [003](https://github.com/okou-ai/okou/blob/80a75d3c7a06758c5d49970025c1c600f1d5f5b0/turbo/apps/platform/src/views/okou-page/__tests__/chat-runless-delivery.test.tsx#L27). DOM order and distinct response elements placed the unassociated delivery after the completed Run; only the earlier response owned a work-history control.

### Negative controls and attribution

- Holding the native mouse release kept its original connection open in browser-shutdown-004. Holding the clipboard file lookup prevented Remove notes.txt in clipboard-002. Holding the rename left the emoji picker open in emoji-004.
- Providing the old personal provider ID in production device-auth dispatch passed member-model-route-004 but failed 005 on its exact target. Restoring the original dispatch passed all three member-model-route cases.
- Removing IME cancellation kept weekly-recap unavailable. Giving the acknowledged steer a different event ID left duplicate main text. Reporting a quarter of a part instead of half failed the 12% progress assertion. Each original input passed after restoration.
- In the first projection-refresh probe, unchanged text or the trigger could pass with the response withheld. The final three cases wait for the page to display Routing refresh unavailable. All three failed on that marker with delivery suppressed. The older server draft in continuity-drafts-002 still lacks an equivalent completion signal. Chat-activity-summary-002 retains its prior timing gap.

The affected whole-file and shuffled runs contained 81 new rows and 44 pre-existing rows. 41 historical regression, 1 partial timing regression, 1 partial regression for an invalidated historical ID, 1 upstream replacement for an invalidated historical ID. The three batch 65 corrections retain their existing IDs. The whole-file and shuffled verification covered 37 suites and 125 rows at the default deadlines. Two earlier member regressions timed out together and their entire 15-case file passed on isolated rerun. The archive records all expanded titles and the earlier attempts.

### Main and post-write review

[Reader scroll and two-frame alignment](https://github.com/okou-ai/okou/pull/49924) changed input ownership, invalidated the old pointerdown-only reader trigger, and added [layout/tap and two render-frame scenarios](https://github.com/okou-ai/okou/blob/415b071c0d59356639a0e09f43b0fa55095d2946/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L1439). [Project rail behavior](https://github.com/okou-ai/okou/pull/49936) adds a [Chats active-state assertion](https://github.com/okou-ai/okou/blob/415b071c0d59356639a0e09f43b0fa55095d2946/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx#L971). These upstream changes are recorded independently of the 115 intake selections and the previous 68-item upstream backlog. The later main sync also included Android and Rust changes. The active chat history resource probe now waits for the rendered bottom before a real upward scroll.

The write-first audit compared frozen b0a10287, both pre-withdrawal revisions 5310dbb9 and a445586e, restored b666cd05, the zero-page rename pair, opening head, latest main and current test/helper paths. The archive contains per-ID operation comparisons and cross-path lexical and action windows for shipped code and unsuccessful probe drafts. A common pointer/mouse sequence was replaced with one user pointer press. Matching slider queries, paired enablement assertions and held rename operations were checked against the specific Then. The quota/loading sequence and storage header exclusions share generic operations or literals with other files. No earlier scenario implementation was moved into a helper.

### Accounting and handoff

Historical first acceptances total 1,576/2,681 (+81). Current complete coverage totals 1,552/2,681 (+81). The withdrawal cohort is 422 historical / 413 current of 506. The outside group is 1,154 / 1,139 of 2,175. The original 86 withdrawals, earlier 17 invalidated historical IDs, seven batch 75 invalidations and independent upstream backlog of 68 keep their prior ownership.

262 closed files contain 1,656 frozen rows and 895 retained selections including four historical retirements. The 223 open files contain 3,455 frozen rows and 1,786 retained selections, with 661 currently covered. Fork-007 is documented within an open file. [Batch 77 file and ID register](https://app.okou.ai/artifacts/2q73q2h9br.md).

### Security check and final main sync

The [first Semgrep check](https://github.com/okou-ai/okou/actions/runs/45005356662/job/137155680773) reported three non-literal regular-expression findings. [The selector correction](https://github.com/okou-ai/okou/commit/6c8b84946ade43564c69803c4901326691ca632d) removed dynamic regular expressions in three files. Phone controls match their displayed device name and offline status. Create uses its two fixed choices. Recommendation buttons match the exact prompt. The 12 affected stable IDs kept their original expanded titles. The ordinary and shuffled runs each passed all 12 and one existing home-route row. This extra home-route regression is outside the earlier 44.

[Synchronized main](https://github.com/okou-ai/okou/commit/c56a8e9ee73ebfcea289fb6a0039d613338f4ed4) included a For You illustration URL, Android chat resources and a runner refactor. [Final checks for this PR](https://github.com/okou-ai/okou/pull/48906/checks) report the App shards and required checks on the published head.

The [final phone selectors](https://github.com/okou-ai/okou/commit/a15b9d05370743de519c95cbdf76554eff0f78ef) use the complete accessible name, including the offline suffix when present. All five phone rows passed with this literal selector.

## Batch 77 intake

Opening PR head `fb333e2619`. All 160 retained registrations in the 30 fixed frozen files below had complete BDD records, open paths, and no earlier first acceptance. Batch 76 used a disjoint set of files. Opening main `8778e1d662` updated the For You artwork. Historical first acceptances are 1,576 and current complete coverage is 1,552.

- `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · 001, 002, 005, 006, 007, 008, 016, 017, 018, 019, 020, 023, 024, 025.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx` · 001, 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx` · 002, 004, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.test.tsx` · 002, 003, 004, 006, 009, 010, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx` · 001, 003, 006.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx` · 001, 004, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx` · 001, 003, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx` · 002, 003, 004, 006, 009.
- `turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx` · 001, 002, 006, 007, 011, 012, 015, 017, 018, 019.
- `turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx` · 001, 002, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx` · 001, 003, 004, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx` · 003, 004, 006, 007, 009, 010.
- `turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx` · 001, 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx` · 001, 003, 005.
- `turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx` · 001, 002, 006.
- `turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx` · 001, 002, 006, 007, 008, 009, 015, 016, 019, 021, 023, 024, 025, 027.
- `turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx` · 002, 003, 004, 005, 007, 008, 012.
- `turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx` · 001, 002, 003, 005, 006, 009, 010, 011, 015, 017, 018, 022, 023, 024, 026, 027, 033, 036, 037, 038, 042.
- `turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx` · 002, 003, 005, 007.
- `turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx` · 003, 006, 009, 010, 011, 012.
- `turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx` · 004, 005, 006.
- `turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx` · 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx` · 001, 003.
- `turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx` · 001, 007, 008, 010, 012, 015, 016, 017, 018.
- `turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx` · 002, 004.
- `turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx` · 001, 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx` · 001, 002.
- `turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx` · 002, 006, 007, 008.
- `turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx` · 001, 005, 007, 009, 010, 011.
- `turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx` · 002, 003, 006.

## Batch 77 first checkpoint

The fixed intake covers 30 files and 160 retained IDs. This checkpoint accepts 35 expanded rows in nine files, closes six files and keeps complete BDD in three partially accepted files. The remaining 21 files have no first acceptance at this checkpoint. Continue the outstanding 125 IDs in this batch. Historical first acceptances advance from 1,576 to 1,611 and current complete coverage from 1,552 to 1,587. The 40 passing rows in the main-sync regression run add zero. Prior withdrawals, invalidated historical evidence and independent upstream registrations retain their recorded ownership.

[Independent test commit](https://github.com/okou-ai/okou/commit/9969928432d6ddcc5b01524c84a0530d4c09e964). [Main synchronization](https://github.com/okou-ai/okou/commit/7a0e203fc195237dacb925f83528f6d29bf0b939). [Fixed intake](#batch-77-intake).

| Frozen file                                                                                                                                                                                                              | First accepted                                                       | Still open                                                                                              | File status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| [chat-scroll.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md)                                               | —                                                                    | 001, 002, 005, 006, 007, 008, 016, 017, 018, 019, 020, 023, 024, 025                                    | Open        |
| [chat-selection-actions.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx)                       | 001, 002, 004                                                        | —                                                                                                       | Closed      |
| [chat-send-read-status.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.bdd.md)                           | —                                                                    | 002, 004, 005                                                                                           | Open        |
| [chat-session-output-stream.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md)                 | —                                                                    | 002, 003, 004, 006, 009, 010, 011                                                                       | Open        |
| [chat-sync-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md)                                 | —                                                                    | 001, 003, 006                                                                                           | Open        |
| [chat-thread-sidebar-resize.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md)                 | —                                                                    | 001, 004, 005                                                                                           | Open        |
| [chat-whitespace-drafts.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.bdd.md)                         | —                                                                    | 001, 003, 005                                                                                           | Open        |
| [composer-pasted-text.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md)                             | —                                                                    | 002, 003, 004, 006, 009                                                                                 | Open        |
| [composer-task-chips.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md)                               | —                                                                    | 001, 002, 006, 007, 011, 012, 015, 017, 018, 019                                                        | Open        |
| [composer-tools.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md)                                         | —                                                                    | 001, 002, 005                                                                                           | Open        |
| [composer-visualization-preferences.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.bdd.md) | —                                                                    | 001, 003, 004, 007                                                                                      | Open        |
| [custom-default-reconnect.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md)                     | —                                                                    | 003, 004, 006, 007, 009, 010                                                                            | Open        |
| [debug-learning.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.bdd.md)                                         | —                                                                    | 001, 002, 004                                                                                           | Open        |
| [debug-morning-brief.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md)                               | 001, 003                                                             | 005                                                                                                     | Partial     |
| [debug-openrouter-preset.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx)                     | 001, 002, 006                                                        | —                                                                                                       | Closed      |
| [desktop-shell-authorization.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx)             | 001, 002, 006, 007, 008, 009, 015, 016, 019, 021, 023, 024, 025, 027 | —                                                                                                       | Closed      |
| [feature-guides.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md)                                         | —                                                                    | 002, 003, 004, 005, 007, 008, 012                                                                       | Open        |
| [get-started-entry.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md)                                   | —                                                                    | 001, 002, 003, 005, 006, 009, 010, 011, 015, 017, 018, 022, 023, 024, 026, 027, 033, 036, 037, 038, 042 | Open        |
| [growth-entry.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx)                                           | 002, 003, 005, 007                                                   | —                                                                                                       | Closed      |
| [ideas-page.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md)                                                 | 009, 011, 012                                                        | 003, 006, 010                                                                                           | Partial     |
| [lark-official.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx)                                         | 004, 005, 006                                                        | —                                                                                                       | Closed      |
| [markdown-parser-isolation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.bdd.md)                   | —                                                                    | 002, 004                                                                                                | Open        |
| [marketing-checkout.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.bdd.md)                                 | —                                                                    | 001, 003                                                                                                | Open        |
| [marketing-handoff-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md)                 | —                                                                    | 001, 007, 008, 010, 012, 015, 016, 017, 018                                                             | Open        |
| [paid-media-creation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.bdd.md)                               | —                                                                    | 002, 004                                                                                                | Open        |
| [proactive-learning-settings.test.tsx](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx)             | 001, 002                                                             | —                                                                                                       | Closed      |
| [proactive-suggestions-settings.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.bdd.md)         | 001                                                                  | 002                                                                                                     | Partial     |
| [project-cache.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md)                                           | —                                                                    | 002, 006, 007, 008                                                                                      | Open        |
| [project-chat-list.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md)                                   | —                                                                    | 001, 005, 007, 009, 010, 011                                                                            | Open        |
| [project-order.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-order.bdd.md)                                           | —                                                                    | 002, 003, 006                                                                                           | Open        |

### First acceptances and expanded Vitest rows

The stable-ID links contain the original Given, When, Then and amendments. Each execution link opens the corresponding assertion body at the tested revision. Shell 024 and 027 share one declaration and expand with different input and destination.

- [chat-selection-actions-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.bdd.md#chat-selection-actions-001) · [quoting after a rename preserves the unfinished draft](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L27).
- [chat-selection-actions-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.bdd.md#chat-selection-actions-002) · [Copy keeps the selected passage through native selection collapse](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L69).
- [chat-selection-actions-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.bdd.md#chat-selection-actions-004) · [Fork carries the original passage after pointer release clears selection](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx#L77).
- [debug-morning-brief-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md#debug-morning-brief-001) · [a member can run separate briefs without changing the daily schedule](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L52).
- [debug-morning-brief-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md#debug-morning-brief-003) · [a failed brief links its conversation and allows a new attempt](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx#L66).
- [debug-openrouter-preset-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.bdd.md#debug-openrouter-preset-001) · [the administrator switches organization presets and restores the default](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L49).
- [debug-openrouter-preset-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.bdd.md#debug-openrouter-preset-002) · [member Debug opens without reading the organization preset](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L81).
- [debug-openrouter-preset-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.bdd.md#debug-openrouter-preset-006) · [a saved operator preset can be viewed but not chosen in the list](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.test.tsx#L90).
- [desktop-shell-authorization-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-001) · [the chat grants Work Mac access and then revokes it](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L160).
- [desktop-shell-authorization-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-002) · [a shell update unblocks an active Run on the standalone page](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L171).
- [desktop-shell-authorization-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-006) · [the keyboard reader can focus and read the entire reason](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L187).
- [desktop-shell-authorization-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-007) · [a changed computer preserves its reason and only allows denial](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L200).
- [desktop-shell-authorization-008](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-008) · [denying the card preserves its request reason](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L207).
- [desktop-shell-authorization-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-009) · [the rejected approval releases both pending controls](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L215).
- [desktop-shell-authorization-015](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-015) · [the original grant remains usable while its host refresh is pending](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L230).
- [desktop-shell-authorization-016](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-016) · [a later shell update recovers the unavailable grant card](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L244).
- [desktop-shell-authorization-019](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-019) · [the approved short grant expires on its own deadline](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L255).
- [desktop-shell-authorization-021](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-021) · [a prior approval restores the grant after the request deadline](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L263).
- [desktop-shell-authorization-023](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-023) · [an external origin with a shell-shaped path renders an ordinary link](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L278).
- [desktop-shell-authorization-024](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-024) · [approving without a callback grants access without sending a chat prompt](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L294).
- [desktop-shell-authorization-027](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-027) · [approving without a callback grants access without sending a chat prompt](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L294).
- [desktop-shell-authorization-025](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-025) · [the approval sends its callback to the current conversation](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L307).
- [growth-entry-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-002) · [workspace credits open the matching credit balance in Settings](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L45).
- [growth-entry-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-003) · [keyboard activation of the Slack workspace link visits Works and closes the menu](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L66).
- [growth-entry-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-005) · [inviting from a disconnected installation opens People with Add member](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L81).
- [growth-entry-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-007) · [an ordinary member can compose in a workspace without the admin growth actions](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L95).
- [ideas-page-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md#ideas-page-009) · [the standup card opens its exact prompt with Enter](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L67).
- [ideas-page-011](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md#ideas-page-011) · [searching RevenueCat opens the matching subscriptions digest in chat](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L78).
- [ideas-page-012](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md#ideas-page-012) · [the Zapier idea transfers all three migration examples into chat](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L88).
- [lark-official-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.bdd.md#lark-official-004) · [keyboard reopening the official account menu allows disconnect](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L47).
- [lark-official-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.bdd.md#lark-official-005) · [the official connection is available independently of custom bots](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L61).
- [lark-official-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.bdd.md#lark-official-006) · [a blocked authorization window leaves the official connection retryable](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L66).
- [proactive-learning-settings-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.bdd.md#proactive-learning-settings-001) · [My Okou offers Morning brief before Suggestions and keeps them independent](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L46).
- [proactive-learning-settings-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.bdd.md#proactive-learning-settings-002) · [Morning brief stays available outside the Suggestions rollout](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.test.tsx#L68).
- [proactive-suggestions-settings-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.bdd.md#proactive-suggestions-settings-001) · [the member can opt in and save an explicit opt-out independently](https://github.com/okou-ai/okou/blob/9969928432d6ddcc5b01524c84a0530d4c09e964/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.test.tsx#L46).

### Controls, gaps and upstream ownership

- Shell 015 retained Work Mac, the reason and Revoke while its own host refresh was pending. Holding the response through the final assertion caused the revoked status check to fail. With delivery restored, the revoked status appeared and both actions disappeared. Shell 025 also observed the callback in the target conversation and checked its durable text appeared once.
- Selection 004 exercised the current Fork action after pointer release cleared the native selection. Substituting Copy made the captured-passage dialog assertion fail. The restored Fork rendered the selected passage. The Forward picker remains retired under [#49556](https://github.com/okou-ai/okou/pull/49556).
- Debug Morning Brief 005 completed on Enter. The probe used the cardinality of HTTP submissions for its exactly-once clause, so this ID remains open. Proactive Suggestions 002 displayed the preparing status and allowed cancellation. The available external status did not prove the missing-primary-Agent premise or the unavailable-workspace message. Both complete BDD files remain.
- Ideas 003, 006 and 010 did not reach an ideas search box from the custom Agent route. [#49838](https://github.com/okou-ai/okou/pull/49838) removed per-Agent routes, the self-update example and the custom parameter of the keyboard test. Global 009, 011 and 012 reached the exact selected prompt in the My Okou composer. Keep each unresolved ID distinct until the surviving breadcrumb mapping has been reconciled.
- [#49915](https://github.com/okou-ai/okou/pull/49915) reverted the virtual-tail change from [#49882](https://github.com/okou-ai/okou/pull/49882). The three subsequently deleted rows covered filling a tall viewport, dragging into unmounted history and scrolling between paints. Their ownership stays upstream. Scroll 023, 024 and 025 retain their own BDD. The initial layout probe lost the anchor after new output in 023 and did not reveal question six in 024 or 025. Chat continuity drafts 002 and chat activity summary 002 also retain their prior response-delivery evidence gaps.
- [#49933](https://github.com/okou-ai/okou/pull/49933) moved the draft API contracts to composer identity. The synchronization resolved 20 conflicts, kept the independent branch cases and updated the retained draft imports. Withdrawn files kept their BDD. The upstream filename change to home-chat-tagline preserved its previous independent rows. It contributes no new first acceptance.
- Post-write comparison covered the freeze, both pre-withdrawal states, main, prior paths and current test helpers. The initial nine-file scan covered 2,039 historical blobs and the final scan against updated main covered 2,042. Per-ID six-call overlaps for Shell 007 and the two Proactive 001 cases consist of role queries, enabled/disabled checks and click/wait assertions required by their GWT. No prior test body or helper-wrapped scenario was adopted.

## Batch 77 second checkpoint

The same intake contains 30 frozen files and 160 retained registrations. Ten files have closed, eleven have new rows and remaining BDD, and nine have no accepted row at this checkpoint. This stage adds 58 unique rows in twelve files to the prior 35. Historical first acceptances reach 1,669 of 2,681 and current complete coverage reaches 1,645. All 67 outstanding registrations stay with batch 77. The 40 main-sync regression rows add zero. Original withdrawals (86), historical evidence losses (17 plus 7), and the independent upstream backlog (68) retain their recorded ownership.

[Stage tests](https://github.com/okou-ai/okou/commit/e050dd2bdea0bec240c4888b1641595fd2b53fb1). [Prior 35 cases](#batch-77-first-checkpoint). [Main sync to 5fd1984c73](https://github.com/okou-ai/okou/commit/121be7c9ed56a9575be34f9157decd078d117f27). [All 160 original registrations, execution lines and outstanding evidence](https://app.okou.ai/artifacts/umc6kwvoon.tsv).

| Frozen test file                                                                                                                                                                                                                                                | Accepted in batch 77                                                      | Outstanding                                                          | File status         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| [chat-scroll.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-001)                                                                      | —                                                                         | 001, 002, 005, 006, 007, 008, 016, 017, 018, 019, 020, 023, 024, 025 | No first acceptance |
| [chat-selection-actions.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.bdd.md#chat-selection-actions-001)                                     | 001, 002, 004                                                             | —                                                                    | Closed              |
| [chat-send-read-status.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.bdd.md#chat-send-read-status-002)                                        | —                                                                         | 002, 004, 005                                                        | No first acceptance |
| [chat-session-output-stream.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-002)                         | 004, 006, 009, 011                                                        | 002, 003, 010                                                        | Partial             |
| [chat-sync-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md#chat-sync-recovery-001)                                                 | —                                                                         | 001, 003, 006                                                        | No first acceptance |
| [chat-thread-sidebar-resize.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md#chat-thread-sidebar-resize-001)                         | 001, 004, 005                                                             | —                                                                    | Closed              |
| [chat-whitespace-drafts.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.bdd.md#chat-whitespace-drafts-001)                                     | 003, 005                                                                  | 001                                                                  | Partial             |
| [composer-pasted-text.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-002)                                           | 002, 003, 004, 006, 009                                                   | —                                                                    | Closed              |
| [composer-task-chips.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-001)                                              | 001, 002, 007, 011, 012, 015, 017, 018, 019                               | 006                                                                  | Partial             |
| [composer-tools.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md#composer-tools-001)                                                             | 001, 002, 005                                                             | —                                                                    | Closed              |
| [composer-visualization-preferences.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.bdd.md#composer-visualization-preferences-001) | —                                                                         | 001, 003, 004, 007                                                   | No first acceptance |
| [custom-default-reconnect.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md#custom-default-reconnect-003)                               | —                                                                         | 003, 004, 006, 007, 009, 010                                         | No first acceptance |
| [debug-learning.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.bdd.md#debug-learning-001)                                                             | 002, 004                                                                  | 001                                                                  | Partial             |
| [debug-morning-brief.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md#debug-morning-brief-001)                                              | 001, 003                                                                  | 005                                                                  | Partial             |
| [debug-openrouter-preset.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.bdd.md#debug-openrouter-preset-001)                                  | 001, 002, 006                                                             | —                                                                    | Closed              |
| [desktop-shell-authorization.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-001)                      | 001, 002, 006, 007, 008, 009, 015, 016, 019, 021, 023, 024, 025, 027      | —                                                                    | Closed              |
| [feature-guides.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-002)                                                             | 002, 003, 004, 007, 008                                                   | 005, 012                                                             | Partial             |
| [get-started-entry.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-001)                                                    | 002, 003, 005, 009, 011, 015, 018, 023, 024, 026, 027, 033, 036, 037, 038 | 001, 006, 010, 017, 022, 042                                         | Partial             |
| [growth-entry.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-002)                                                                   | 002, 003, 005, 007                                                        | —                                                                    | Closed              |
| [ideas-page.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md#ideas-page-003)                                                                         | 009, 011, 012                                                             | 003, 006, 010                                                        | Partial             |
| [lark-official.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.bdd.md#lark-official-004)                                                                | 004, 005, 006                                                             | —                                                                    | Closed              |
| [markdown-parser-isolation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.bdd.md#markdown-parser-isolation-002)                            | —                                                                         | 002, 004                                                             | No first acceptance |
| [marketing-checkout.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.bdd.md#marketing-checkout-001)                                                 | —                                                                         | 001, 003                                                             | No first acceptance |
| [marketing-handoff-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-001)                         | —                                                                         | 001, 007, 008, 010, 012, 015, 016, 017, 018                          | No first acceptance |
| [paid-media-creation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.bdd.md#paid-media-creation-002)                                              | 004                                                                       | 002                                                                  | Partial             |
| [proactive-learning-settings.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.bdd.md#proactive-learning-settings-001)                      | 001, 002                                                                  | —                                                                    | Closed              |
| [proactive-suggestions-settings.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.bdd.md#proactive-suggestions-settings-001)             | 001                                                                       | 002                                                                  | Partial             |
| [project-cache.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-002)                                                                | 002, 006, 007, 008                                                        | —                                                                    | Closed              |
| [project-chat-list.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-001)                                                    | 001, 005, 007, 009, 011                                                   | 010                                                                  | Partial             |
| [project-order.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-order.bdd.md#project-order-002)                                                                | —                                                                         | 002, 003, 006                                                        | No first acceptance |

### New execution rows in the second checkpoint

- [chat-session-output-stream-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-004) · [the same authorization card survives added paragraphs and finalization](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.test.tsx#L85).
- [chat-session-output-stream-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-006) · [closing a Markdown link presents authorization during the active run](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.test.tsx#L102).
- [chat-session-output-stream-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-009) · [the approval destination includes its final signature underscore](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.test.tsx#L114).
- [chat-session-output-stream-011](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-011) · [completing the run ends its live subscription after displaying the durable report](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.test.tsx#L125).
- [chat-thread-sidebar-resize-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md#chat-thread-sidebar-resize-001) · [releasing the primary touch fixes the artifact width at 600 pixels](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L99).
- [chat-thread-sidebar-resize-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md#chat-thread-sidebar-resize-004) · [a second contact cannot move or release the primary resize](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L118).
- [chat-thread-sidebar-resize-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md#chat-thread-sidebar-resize-005) · [closing the artifact during a held touch releases capture before reopening](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.test.tsx#L133).
- [chat-whitespace-drafts-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.bdd.md#chat-whitespace-drafts-003) · [meaningful whitespace is preserved until the member clears the draft](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L43).
- [chat-whitespace-drafts-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.bdd.md#chat-whitespace-drafts-005) · [a pasted space retains the attached file and the link to the other chat](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L60).
- [composer-pasted-text-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-002) · [five thousand emoji stay inline at the UTF-16 threshold](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L85).
- [composer-pasted-text-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-003) · [a file over five gigabytes falls back to sending the selected replacement inline](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L93).
- [composer-pasted-text-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-004) · [the original draft and a whitespace-exact text upload are sent together](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L121).
- [composer-pasted-text-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-006) · [two large notes retain their individual filenames and exact uploaded bodies](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L145).
- [composer-pasted-text-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-009) · [chat rich copy restores its own attachment and appends long text inline](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.test.tsx#L161).
- [composer-task-chips-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-001) · [removing Presentation preserves the user's original draft](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L50).
- [composer-task-chips-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-002) · [a launch deck keeps its 16–20 slide setting on the destination conversation](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L58).
- [composer-task-chips-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-007) · [choosing an image from the catalog replaces Presentation and sends the image template](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L81).
- [composer-task-chips-011](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-011) · [opening and closing the presentation catalog preserves the draft](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L110).
- [composer-task-chips-012](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-012) · [Website presents the full recommendation shelf and attaches the chosen template](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L125).
- [composer-task-chips-015](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-015) · [Advanced workflows keeps nine ordered recommendations beside the unsent draft](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L143).
- [composer-task-chips-017](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-017) · [viewing all workflows opens their catalog and preserves the unsent draft](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L159).
- [composer-task-chips-018](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-018) · [editing the prepared morning brief keeps focus, the draft and the workflow identity](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L176).
- [composer-task-chips-019](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-019) · [the reply recommendation prepares one Gmail watch with no attached template](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L195).
- [composer-tools-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md#composer-tools-001) · [settings and the composer reflect confirmed independent changes to two tool preferences](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L29).
- [composer-tools-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md#composer-tools-002) · [the pending switch survives reopening, reports its own failure and permits retry](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L53).
- [composer-tools-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md#composer-tools-005) · [web preferences survive a catalog failure and reopening discovers the new research family](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L98).
- [debug-learning-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.bdd.md#debug-learning-002) · [a custom workflow named Learning cannot start the official learning job](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L77).
- [debug-learning-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.bdd.md#debug-learning-004) · [closing Debug aborts the pending Learning run](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L84).
- [feature-guides-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-002) · [walk the report guide, revisit each card and prepare its task](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L107).
- [feature-guides-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-003) · [only a completed horizontal gesture on the card turns the page](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L136).
- [feature-guides-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-004) · [touching the player preserves video controls and swiping its description changes cards](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L159).
- [feature-guides-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-007) · [the preview chats link opens the home composer and leaves the edition unseen](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L184).
- [feature-guides-008](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-008) · [no edition leaves the signed-in home composer available without an announcement](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L206).
- [get-started-entry-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-002) · [browser history returns to chat with the invitation closed](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L119).
- [get-started-entry-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-003) · [a denied invitation link can be retried in the open dialog](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L143).
- [get-started-entry-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-005) · [completed Slack and partially earned connector rewards remain distinguishable](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L161).
- [get-started-entry-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-009) · [a granted workflow refreshes the open rewards panel](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L177).
- [get-started-entry-015](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-015) · [Slack opens the correct installation destination while retaining the chat](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L231).
- [get-started-entry-023](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-023) · [Slack opens the correct installation destination while retaining the chat](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L231).
- [get-started-entry-024](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-024) · [Slack opens the correct installation destination while retaining the chat](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L231).
- [get-started-entry-026](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-026) · [Slack can use its previously displayed workspace URL while its refresh is held](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L273).
- [get-started-entry-027](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-027) · [reopening after a blocked Slack popup keeps the quest and uses a fresh timestamp](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L320).
- [get-started-entry-033](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-033) · [reopening refreshes Slack completion without a realtime event](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L342).
- [get-started-entry-011](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-011) · [linking the phone closes its own dialog and credits the member quest](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L390).
- [get-started-entry-018](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-018) · [browsing connectors leaves the quest dialog for the full catalog](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L413).
- [get-started-entry-036](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-036) · [the ninth daily check-in confirms its streak and credits in the menu](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L475).
- [get-started-entry-037](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-037) · [check-in stays busy until the refreshed reward and ninth day are delivered](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L489).
- [get-started-entry-038](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-038) · [a check-in awaiting financial confirmation shows its review state](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L507).
- [paid-media-creation-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.bdd.md#paid-media-creation-004) · [the disabled image category leaves Website templates available](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx#L26).
- [project-cache-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-002) · [a thread list notification discovers a chat after an empty snapshot](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L43).
- [project-cache-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-006) · [an expired persisted project cursor rebuilds the visible project from a new snapshot](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L71).
- [project-cache-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-007) · [a different account cannot inherit the previous owner's cached project](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L132).
- [project-cache-008](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-008) · [a different workspace cannot inherit the previous owner's cached project](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L132).
- [project-chat-list-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-001) · [expanding active and empty projects keeps inbox-empty and archive controls out of view](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L97).
- [project-chat-list-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-005) · [an empty Inbox opens its archived conversation](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L123).
- [project-chat-list-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-007) · [an empty project's archive reveals its own chat and preserves the current conversation](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L132).
- [project-chat-list-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-009) · [moving a project pin up and down never brings in an outside pin](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L161).
- [project-chat-list-011](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-011) · [folding Launch twice preserves the selected outside conversation and its address](https://github.com/okou-ai/okou/blob/e050dd2bdea0bec240c4888b1641595fd2b53fb1/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.test.tsx#L205).

### Response ownership, controls and verification

- Project cache 006 waited for a fake-server 410 before applying the replacement Project snapshot. Withholding the reply prevented restoration. Cache 008 received two independently named projects. Sending the update to Launch left the expected other project unchanged and the assertion failed.
- Restoring a mismatched guide edition reopened the dismissed dialog in Feature Guides 008. Ending a resize with a second touch pointer broke the original pointer's subsequent resize in Sidebar Resize 004. Substituting different uploaded note bytes broke Pasted Text 006 at its filename-specific content assertion. Each mutation was reverted.
- Withholding the check-in refresh left Rewards 037 waiting for “Checked in.” Delivering that response showed the new nine-day streak. In contrast, withholding Stream 002's late fragment still passed the original draft-preservation check. Its BDD remains complete and its ID is excluded.
- Timeouts during two concurrent validation processes affected different task-chip tests. On the same 5-second limit the 58 rows passed in full-file order and with shuffle seed 7725. Platform production, test and build-config type checks, scoped ESLint, both Oxlint configurations, formatting and changed-file size checks passed. Later main changes were Android, database or version metadata.
- Post-write comparison inspected 2,042 historical test, mock, fixture and helper blobs across the freeze, both withdrawals, opening branch and main, plus current cross-path helpers. The additional six-call match in Whitespace Drafts 005 contains the clipboard interaction and structured reference assertion required by the scenario. The probe uses target-thread filtering, two distinct chat fixtures, and a named attached file. The remaining matches were already reviewed at the first checkpoint.
- The exact row table retains the blocked preconditions, missing results and controls. In particular the retired agent identity cannot supply the distinct owners required by Project Chat List 010, and the three scroll execution rows removed in [#49915](https://github.com/okou-ai/okou/pull/49915) keep their separate upstream ownership. Chat Continuity Drafts 002 and Chat Activity Summary 002 retain their response-processing gaps.

## Batch 77 file reconciliation

Across 30 frozen files, 119 of the 160 retained scenarios have their first passing expanded row. Thirteen files closed and seventeen retain their full BDD for 41 open IDs. Every file now has at least one accepted row. The three stages added 35, 58 and 26 cases. The last ten-file rerun includes fifteen earlier cases. The forty main-sync regressions have separate ownership.

[160 original GWTs, unproven clauses, exact execution rows and tested source](https://app.okou.ai/artifacts/e2cdi1sjey.tsv). [Third-stage tests](https://github.com/okou-ai/okou/commit/4fc61715ecf6b13eee099dada6b747d88ff0cb6b). [Second checkpoint](#batch-77-second-checkpoint). [Upstream scroll change](https://github.com/okou-ai/okou/pull/49915).

| Frozen test file                                                                                                                                                                                                                                                | First accepted IDs                                                             | Open IDs                                                   | File disposition |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------- |
| [chat-scroll.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-001)                                                                      | 002, 016                                                                       | 001, 005, 006, 007, 008, 017, 018, 019, 020, 023, 024, 025 | Partial          |
| [chat-selection-actions.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.bdd.md#chat-selection-actions-001)                                     | 001, 002, 004                                                                  | —                                                          | Closed           |
| [chat-send-read-status.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.bdd.md#chat-send-read-status-002)                                        | 005                                                                            | 002, 004                                                   | Partial          |
| [chat-session-output-stream.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-session-output-stream.bdd.md#chat-session-output-stream-002)                         | 004, 006, 009, 011                                                             | 002, 003, 010                                              | Partial          |
| [chat-sync-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md#chat-sync-recovery-001)                                                 | 001, 003, 006                                                                  | —                                                          | Closed           |
| [chat-thread-sidebar-resize.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-sidebar-resize.bdd.md#chat-thread-sidebar-resize-001)                         | 001, 004, 005                                                                  | —                                                          | Closed           |
| [chat-whitespace-drafts.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.bdd.md#chat-whitespace-drafts-001)                                     | 003, 005                                                                       | 001                                                        | Partial          |
| [composer-pasted-text.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-pasted-text.bdd.md#composer-pasted-text-002)                                           | 002, 003, 004, 006, 009                                                        | —                                                          | Closed           |
| [composer-task-chips.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.bdd.md#composer-task-chips-001)                                              | 001, 002, 007, 011, 012, 015, 017, 018, 019                                    | 006                                                        | Partial          |
| [composer-tools.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.bdd.md#composer-tools-001)                                                             | 001, 002, 005                                                                  | —                                                          | Closed           |
| [composer-visualization-preferences.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.bdd.md#composer-visualization-preferences-001) | 001, 003                                                                       | 004, 007                                                   | Partial          |
| [custom-default-reconnect.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md#custom-default-reconnect-003)                               | 003, 004, 009                                                                  | 006, 007, 010                                              | Partial          |
| [debug-learning.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.bdd.md#debug-learning-001)                                                             | 002, 004                                                                       | 001                                                        | Partial          |
| [debug-morning-brief.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md#debug-morning-brief-001)                                              | 001, 003                                                                       | 005                                                        | Partial          |
| [debug-openrouter-preset.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/debug-openrouter-preset.bdd.md#debug-openrouter-preset-001)                                  | 001, 002, 006                                                                  | —                                                          | Closed           |
| [desktop-shell-authorization.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.bdd.md#desktop-shell-authorization-001)                      | 001, 002, 006, 007, 008, 009, 015, 016, 019, 021, 023, 024, 025, 027           | —                                                          | Closed           |
| [feature-guides.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.bdd.md#feature-guides-002)                                                             | 002, 003, 004, 007, 008                                                        | 005, 012                                                   | Partial          |
| [get-started-entry.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-001)                                                    | 002, 003, 005, 009, 011, 015, 018, 022, 023, 024, 026, 027, 033, 036, 037, 038 | 001, 006, 010, 017, 042                                    | Partial          |
| [growth-entry.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.bdd.md#growth-entry-002)                                                                   | 002, 003, 005, 007                                                             | —                                                          | Closed           |
| [ideas-page.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.bdd.md#ideas-page-003)                                                                         | 009, 011, 012                                                                  | 003, 006, 010                                              | Partial          |
| [lark-official.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.bdd.md#lark-official-004)                                                                | 004, 005, 006                                                                  | —                                                          | Closed           |
| [markdown-parser-isolation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.bdd.md#markdown-parser-isolation-002)                            | 002, 004                                                                       | —                                                          | Closed           |
| [marketing-checkout.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.bdd.md#marketing-checkout-001)                                                 | 001, 003                                                                       | —                                                          | Closed           |
| [marketing-handoff-recovery.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-001)                         | 001, 007, 008, 010, 015, 016, 017, 018                                         | 012                                                        | Partial          |
| [paid-media-creation.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.bdd.md#paid-media-creation-002)                                              | 004                                                                            | 002                                                        | Partial          |
| [proactive-learning-settings.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-learning-settings.bdd.md#proactive-learning-settings-001)                      | 001, 002                                                                       | —                                                          | Closed           |
| [proactive-suggestions-settings.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/proactive-suggestions-settings.bdd.md#proactive-suggestions-settings-001)             | 001                                                                            | 002                                                        | Partial          |
| [project-cache.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.bdd.md#project-cache-002)                                                                | 002, 006, 007, 008                                                             | —                                                          | Closed           |
| [project-chat-list.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-chat-list.bdd.md#project-chat-list-001)                                                    | 001, 005, 007, 009, 011                                                        | 010                                                        | Partial          |
| [project-order.test.tsx](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-order.bdd.md#project-order-002)                                                                | 003, 006                                                                       | 002                                                        | Partial          |

### Third-stage rows

- [chat-scroll-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-002) · [revealing the transcript restores the visible tail message with a single adjustment](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L44).
- [chat-scroll-016](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-016) · [the focused multiline draft and transcript tail survive three keyboard viewport cycles and layout resize](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx#L67).
- [chat-send-read-status-005](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.bdd.md#chat-send-read-status-005) · [an unauthorized mark on a completed review leaves its composer available for the next request](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx#L40).
- [chat-sync-recovery-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md#chat-sync-recovery-001) · [a hidden browser tab applies the ordinary title update before the member returns](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L73).
- [chat-sync-recovery-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md#chat-sync-recovery-003) · [reconnecting after a continuity gap retrieves both the renamed chat and its missed reply](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L84).
- [chat-sync-recovery-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.bdd.md#chat-sync-recovery-006) · [a credential gap reconciles renamed, retired and new Projects on the home route](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/chat-sync-recovery.test.tsx#L101).
- [composer-visualization-preferences-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.bdd.md#composer-visualization-preferences-001) · [a read-only chart summary tracks each selected format and chart in order](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L55).
- [composer-visualization-preferences-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.bdd.md#composer-visualization-preferences-003) · [accepting the first send consumes only its draft chart choices](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/composer-visualization-preferences.test.tsx#L101).
- [custom-default-reconnect-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md#custom-default-reconnect-003) · [replacing the default secret keeps the healthy sibling on its own account](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L87).
- [custom-default-reconnect-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md#custom-default-reconnect-004) · [the inventory gates Connect until an empty account list settles](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L60).
- [custom-default-reconnect-009](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.bdd.md#custom-default-reconnect-009) · [a saved account without a default explains why provider authorization cannot proceed](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/custom-default-reconnect.test.tsx#L147).
- [get-started-entry-022](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-022) · [selecting Gmail starts its authorization on the local browser boundary and preserves chat](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L529).
- [markdown-parser-isolation-002](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.bdd.md#markdown-parser-isolation-002) · [an unfinished reply keeps bold and literal plus signs after visiting Instructions](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L71).
- [markdown-parser-isolation-004](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.bdd.md#markdown-parser-isolation-004) · [opening the completed run's logs preserves its distinct rich text elements](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/markdown-parser-isolation.test.tsx#L105).
- [marketing-checkout-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.bdd.md#marketing-checkout-001) · [Ctrl-click opens the Stripe checkout while its authenticated marketing receipt is still pending](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx#L60).
- [marketing-checkout-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.bdd.md#marketing-checkout-003) · [confirming an expired Pro quote keeps both quoted amounts and the retry action visible](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-checkout.test.tsx#L107).
- [marketing-handoff-recovery-001](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-001) · [an unavailable prompt clears link options and leaves the member's saved draft editable](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L80).
- [marketing-handoff-recovery-007](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-007) · [a lost resolution response returns the member to their existing editable draft with one notice](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L86).
- [marketing-handoff-recovery-008](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-008) · [a rejected attachment import discards the handoff and restores the existing draft](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L94).
- [marketing-handoff-recovery-010](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-010) · [an unavailable task returns an administrator to the ordinary onboarding question](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L105).
- [marketing-handoff-recovery-015](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-015) · [failed attachment lookup leaves the member's prior agent draft editable](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L146).
- [marketing-handoff-recovery-016](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-016) · [a protected-entry response 401 keeps the original handoff link](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L130).
- [marketing-handoff-recovery-017](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-017) · [a protected-entry response 426 keeps the original handoff link](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L130).
- [marketing-handoff-recovery-018](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.bdd.md#marketing-handoff-recovery-018) · [receiving a task places the exact report and its imported notes in the agent composer](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/marketing-handoff-recovery.test.tsx#L156).
- [project-order-003](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-order.bdd.md#project-order-003) · [the project shortcut ignores composition, repeat and Meta, keeping the edited draft focused](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L138).
- [project-order-006](https://github.com/okou-ai/okou/blob/fb333e2619d767938ddc924fc3ed8a9e9ac46d9e/turbo/apps/platform/src/views/okou-page/__tests__/project-order.bdd.md#project-order-006) · [filtering to Unread prevents Research from moving out of its canonical Inbox position](https://github.com/okou-ai/okou/blob/4fc61715ecf6b13eee099dada6b747d88ff0cb6b/turbo/apps/platform/src/views/okou-page/__tests__/project-order.test.tsx#L162).

### Controls and ownership

- Chat sync 003 and 006 failed when the replacement fixture delivered the wrong missed payload or named the wrong project. Checkout 001 opened the expected new context on modified click. Removing the modifier broke its new-context assertion. Withholding the completed send in Visualization Preferences 003 prevented the expected option reset. The subsequent runs used the restored fixtures.
- Scroll 002 measured one adjustment on the visible tail. Scroll 001, 005 and 007 measured two. The scroll probe records the original fixture, target and measured coordinates. Three executable rows removed by upstream PR 49915 retain their ownership. The retained registrations with missing scroll evidence remain open.
- The custom reconnect window remained at about:blank for 006. Closing the view for 007 cancelled the lookup. Neither result supports the original terminal Then. The artifact includes the delivery and withholding probes for stream output 002 and read status 002. Chat Continuity Drafts 002 and Chat Activity Summary 002 retain their original late-response evidence gaps.
- Test design followed AGENTS.md, docs/testing.md, docs/app/app-testing.md and the applicable browser, async, mock and SharedWorker guidance. The after-writing review checked frozen sources, both pre-withdrawal trees, main, alternate paths and current helpers. The accompanying evidence contains the per-ID comparison and the matched call sequences.
- Historical first acceptances reached 1,695 of 2,681 and current complete coverage reached 1,671. The withdrawal cohort accounts for 422 historical and 413 current cases. Other files account for 1,273 and 1,258 respectively. Across the inventory, 275 files closed with 946 selections including four retirements. The 210 open files have 729 covered of 1,735 retained selections. The original 86 withdrawals, the historical losses of 17 and 7, and the 68 upstream cases retain their prior ownership.

The third checkpoint ran the ten affected files with the original five-second test deadline. Two earlier Slack regressions timed out during a competing type check. Both the restored full-file run and shuffle seed 7738 passed all 41 rows. Platform production, test and build-config types, scoped ESLint, both Oxlint configurations and changed-file formatting passed. Main synchronization through [72ecc819a9](https://github.com/okou-ai/okou/commit/72ecc819a9a20d2ad3e8df5ac5e9a89f7b748bf5) incorporated the latest iOS changes. [Next 30 open file candidates and 139 frozen registrations](https://app.okou.ai/artifacts/bw97welhyt.md).

## Batch 78 file reconciliation

Opening `1fd1340d1e`. Synchronized through `1e43c5505f`. The [fixed intake](https://app.okou.ai/artifacts/bw97welhyt.md) has 139 pending retain IDs in 30 distinct frozen files. The intake excludes batches 76 and 77. The registration-level comparison and local results are anchored to [the implementation](https://github.com/okou-ai/okou/commit/c8514079e486ad9e089641281e7fa06b7c65f5cf).

**76 first acceptances, 63 open IDs.** 13 files closed, 8 partially covered and 9 with all selected IDs still open. Vitest expanded the accepted cases to 79 rows across 28 executable files. The whole-file run and shuffled run (seed 7829) agreed on every ID and parameterized title. No existing regression contributed another first acceptance.

| Frozen test file                                                                                                                                                                                                                             | Selected | First accepted                                             | Still open                                                                                    | Expanded rows | File outcome |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------: | ------------ |
| [`__tests__/authentication-startup.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/__tests__/authentication-startup.bdd.md)                                                 |        9 | 001, 003, 011, 012, 013, 014, 015, 016, 018                | —                                                                                             |             9 | closed       |
| [`__tests__/clerk-bootstrap.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/__tests__/clerk-bootstrap.bdd.md)                                                                |        4 | 001, 003, 004, 005                                         | —                                                                                             |             4 | closed       |
| [`__tests__/platform-entrypoint.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/__tests__/platform-entrypoint.bdd.md)                                                        |       12 | 001, 002, 012, 013, 014, 015, 016, 020, 021, 022, 023, 024 | —                                                                                             |            12 | closed       |
| [`__tests__/shared-worker-failure.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/__tests__/shared-worker-failure.bdd.md)                                                   |        2 | 002, 003                                                   | —                                                                                             |             2 | closed       |
| [`__tests__/shared-worker-preload.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/__tests__/shared-worker-preload.bdd.md)                                                   |        2 | 002, 003                                                   | —                                                                                             |             2 | closed       |
| [`lib/__tests__/chat-thread-link.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/lib/__tests__/chat-thread-link.bdd.md)                                                      |        2 | 001, 002                                                   | —                                                                                             |             3 | closed       |
| [`lib/__tests__/preview-bypass-cookie.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/lib/__tests__/preview-bypass-cookie.bdd.md)                                            |        5 | 001, 004, 005, 006, 007                                    | —                                                                                             |             5 | closed       |
| [`lib/__tests__/sentry-reporting.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/lib/__tests__/sentry-reporting.bdd.md)                                                      |        5 | 003, 004, 005, 007, 008                                    | —                                                                                             |             5 | closed       |
| [`lib/__tests__/visual-viewport-keyboard.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/lib/__tests__/visual-viewport-keyboard.bdd.md)                                      |        2 | 001, 002                                                   | —                                                                                             |             2 | closed       |
| [`shared-database/__tests__/message-port.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md)                                      |       20 | 019                                                        | 002, 010, 011, 014, 015, 017, 018, 020, 022, 023, 027, 030, 032, 033, 034, 036, 037, 038, 039 |             1 | partial      |
| [`shared-database/__tests__/platform-direct-bridge.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.bdd.md)                  |        3 | 001, 006                                                   | 002                                                                                           |             2 | partial      |
| [`shared-database/__tests__/single-connection-client.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/shared-database/__tests__/single-connection-client.bdd.md)              |        2 | —                                                          | 001, 002                                                                                      |             0 | blocked      |
| [`shared-database/__tests__/worker-runtime.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md)                                  |        6 | 001, 002, 007, 012                                         | 005, 008                                                                                      |             4 | partial      |
| [`signals/__tests__/api-client-bootstrap.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.bdd.md)                                      |        1 | —                                                          | 001                                                                                           |             0 | blocked      |
| [`signals/__tests__/auth-oauth-consent.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/auth-oauth-consent.bdd.md)                                          |        2 | 001, 003                                                   | —                                                                                             |             2 | closed       |
| [`signals/__tests__/bootstrap-feature-switch.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.bdd.md)                             |        2 | 001, 002                                                   | —                                                                                             |             2 | closed       |
| [`signals/__tests__/clerk-user.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md)                                                          |        4 | —                                                          | 003, 005, 006, 007                                                                            |             0 | blocked      |
| [`signals/__tests__/command-scheduling.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md)                                          |        5 | —                                                          | 001, 002, 003, 004, 006                                                                       |             0 | blocked      |
| [`signals/__tests__/fetch.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/fetch.bdd.md)                                                                    |        2 | 002, 003                                                   | —                                                                                             |             2 | closed       |
| [`signals/__tests__/realtime.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md)                                                              |       10 | —                                                          | 001, 002, 004, 005, 006, 008, 010, 011, 019, 020                                              |             0 | blocked      |
| [`signals/__tests__/shared-database-browser.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/shared-database-browser.bdd.md)                                |        4 | 001, 002, 005                                              | 006                                                                                           |             3 | partial      |
| [`signals/__tests__/startup-diagnostics.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/__tests__/startup-diagnostics.bdd.md)                                       |        2 | 001                                                        | 003                                                                                           |             1 | partial      |
| [`signals/bootstrap/__tests__/user-timezone-initialization.test.tsx`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/bootstrap/__tests__/user-timezone-initialization.bdd.md) |        2 | 001, 003                                                   | —                                                                                             |             2 | closed       |
| [`signals/browser/__tests__/client.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md)                                                  |        7 | —                                                          | 001, 002, 003, 004, 006, 007, 008                                                             |             0 | blocked      |
| [`signals/chat-page/__tests__/session-output-stream.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/chat-page/__tests__/session-output-stream.bdd.md)                |        1 | —                                                          | 002                                                                                           |             0 | blocked      |
| [`signals/chat-page/__tests__/unread-through-at.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/chat-page/__tests__/unread-through-at.bdd.md)                        |        1 | —                                                          | 001                                                                                           |             0 | blocked      |
| [`signals/external/__tests__/chat-idb.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/external/__tests__/chat-idb.bdd.md)                                            |        1 | —                                                          | 002                                                                                           |             0 | blocked      |
| [`signals/external/__tests__/indexeddb-client.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.bdd.md)                            |        4 | 001, 006                                                   | 002, 003                                                                                      |             2 | partial      |
| [`signals/okou-page/__tests__/user-message-document.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/okou-page/__tests__/user-message-document.bdd.md)                |        9 | 006, 007, 008, 011, 012, 016, 017                          | 003, 014                                                                                      |             9 | partial      |
| [`signals/voice-io/__tests__/voice-draft-audio.test.ts`](https://github.com/okou-ai/okou/blob/1fd1340d1e91ca29a1b8dca07266eb97f80e0c71/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.bdd.md)                          |        8 | 001, 002, 003, 007, 014                                    | 010, 013, 015                                                                                 |             5 | partial      |

### Per-ID evidence

For each accepted ID the linked test is the executable entry point. Each open row records its outstanding clause. The [139-ID ledger](https://app.okou.ai/artifacts/7pfzf7e0w9.tsv) additionally includes the complete original Given, When and Then, expanded counts, diagnostic provenance, and targeted controls.

#### authentication-startup.test.tsx

- `authentication-startup-001` — [Workflows stays hidden until the current member's identity is ready](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/workspace-startup-gates.test.ts#L30).
- `authentication-startup-003` — [Workflows leaves foreground presence while the tab is hidden and keeps realtime](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L71).
- `authentication-startup-011` — [Workflows reuses the identity load already in progress](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L15).
- `authentication-startup-012` — [Unavailable identity service replaces the startup screen with an error](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L34).
- `authentication-startup-013` — [An old onboarding response cannot redirect the member after the active workspace changes](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/workspace-startup-gates.test.ts#L79).
- `authentication-startup-014` — [opens the hosted sign-in form for app.okou.ai](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L51).
- `authentication-startup-015` — [opens the hosted sign-in form for pr-30199-app.omby.ai](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L52).
- `authentication-startup-016` — [opens the hosted sign-in form for okou.ai.evil.example](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L53).
- `authentication-startup-018` — [Changing the workspace leaves Workflows for home](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts#L95).

#### clerk-bootstrap.test.ts

- `clerk-bootstrap-001` — [Agents requests the production identity resource with same-origin account URLs](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/clerk-shell-startup.test.ts#L45).
- `clerk-bootstrap-003` — [Early Clerk navigation sends sign-in to the browser](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/clerk-shell-startup.test.ts#L76).
- `clerk-bootstrap-004` — [Shell publishes the same pending load that belongs to the loaded SDK](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/clerk-shell-startup.test.ts#L60).
- `clerk-bootstrap-005` — [Each shell uses its own host for sign-in](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/clerk-shell-startup.test.ts#L89).

#### platform-entrypoint.test.ts

- `platform-entrypoint-001` — [An abandoned page preserves its original cancellation reason](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L116).
- `platform-entrypoint-002` — [Chrome 138 enters the application and shows the signed-out page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/supported-platform-startup.test.ts#L8).
- `platform-entrypoint-012` — [directs a visitor using desktop Chrome to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L12).
- `platform-entrypoint-013` — [directs a visitor using desktop Chromium to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L21).
- `platform-entrypoint-014` — [directs a visitor using desktop Edge to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L30).
- `platform-entrypoint-015` — [directs a visitor using mobile Edge to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L39).
- `platform-entrypoint-016` — [directs a visitor using desktop Opera to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L48).
- `platform-entrypoint-020` — [directs a visitor using desktop Firefox to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L57).
- `platform-entrypoint-021` — [directs a visitor using macOS Safari to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L66).
- `platform-entrypoint-022` — [directs a visitor using iPhone Chrome to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L75).
- `platform-entrypoint-023` — [The application removes Discord approval data before either analytics provider initializes](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L10).
- `platform-entrypoint-024` — [directs a visitor using Android Chrome without SharedWorker to its download page](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/browser-upgrade-guidance.test.ts#L84).

#### shared-worker-failure.test.tsx

- `shared-worker-failure-002` — [Two native worker failures interrupt the open page and flush a single report](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/workspace-worker-startup.test.ts#L125).
- `shared-worker-failure-003` — [Switching sessions releases the old worker error listener](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/workspace-worker-startup.test.ts#L173).

#### shared-worker-preload.test.tsx

- `shared-worker-preload-002` — [An early failure on the matching preload reaches the interruption dialog](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/workspace-worker-startup.test.ts#L108).
- `shared-worker-preload-003` — [A worker preloaded for another workspace stays separate](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/workspace-worker-startup.test.ts#L88).

#### chat-thread-link.test.ts

- `chat-thread-link-001` — [A transcript on localhost recognizes production, relative, and current-origin chat destinations](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/transcript-thread-destinations.test.ts#L38); [A transcript on staging-app.omby.ai recognizes production, relative, and current-origin chat destinations](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/transcript-thread-destinations.test.ts#L38).
- `chat-thread-link-002` — [Links in a reply retain both the view query and the chosen fragment](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/transcript-thread-destinations.test.ts#L52).

#### preview-bypass-cookie.test.ts

- `preview-bypass-cookie-001` — [Opening the preview shell stores its one-hour credential with browser cookie protections](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/preview-shell-cookie.test.ts#L6).
- `preview-bypass-cookie-004` — [Opening the Teams authorization link sends only the credential belonging to its destination](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/preview-authorization-destinations.test.ts#L13).
- `preview-bypass-cookie-005` — [Opening the Teams authorization link sends only the credential belonging to its destination](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/preview-authorization-destinations.test.ts#L18).
- `preview-bypass-cookie-006` — [Opening the Teams authorization link sends only the credential belonging to its destination](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/preview-authorization-destinations.test.ts#L23).
- `preview-bypass-cookie-007` — [Opening the Teams authorization link sends only the credential belonging to its destination](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/preview-authorization-destinations.test.ts#L28).

#### sentry-reporting.test.ts

- `sentry-reporting-003` — [The reporting SDK filters the callback /connectors/slack/callback from errors and navigation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L38).
- `sentry-reporting-004` — [The reporting SDK filters the callback /connectors/microsoft-365/callback from errors and navigation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L39).
- `sentry-reporting-005` — [The reporting SDK filters the callback /connectors/github/callback from errors and navigation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L40).
- `sentry-reporting-007` — [The reporting SDK filters the callback /api/integrations/teams/oauth/callback from errors and navigation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L41).
- `sentry-reporting-008` — [The reporting SDK filters the callback /api/github/app/setup/callback from errors and navigation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/entrypoint-analytics-boundaries.test.ts#L42).

#### visual-viewport-keyboard.test.ts

- `visual-viewport-keyboard-001` — [Five keyboard sessions reveal the focused standalone composer once apiece](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/mobile-keyboard-reveal.test.ts#L38).
- `visual-viewport-keyboard-002` — [An ordinary mobile tab reserves keyboard space without moving the composer](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/mobile-keyboard-reveal.test.ts#L73).

#### message-port.test.ts

- `message-port-002` — Open. The local Clerk rejection reached the native get-token exchange during registration. The Router sent no subsequent get-computed request, so the trace has no correlated computed started/error pair or application rejection with AggregateError.
- `message-port-010` — Open. The real page and visibility fixture exercise one tab. Independent visible tabs sharing one worker, including an observed last-tab disconnect, are missing. Child test runtimes share the document and each owns a worker.
- `message-port-011` — Open. The observed production subscriptions contain concrete named topics. No production interaction registers newFeature:changed, so the right-name/wrong-user matrix cannot be exercised from this Router.
- `message-port-014` — Open. The live worker processed a suspended/reconnected connection. The two-tab shared attachment, one resync for each caller, and survival after the first real tab closes require independent tab owners.
- `message-port-015` — Open. The organ­ization-scoped native subscription and exact revision were observed in the experiment. The recorded Workflows page had no visible change establishing application handling of that revision.
- `message-port-017` — Open. A held snapshot denial produces the required-update dialog. SharedDatabaseHttpError and its status were visible in an internal port reply only. The Router readiness promise for this Workflows route does not expose the snapshot read.
- `message-port-018` — Open. The indicator denial reached the update dialog. Only the diagnostic reply exposed ApiError together with REQUEST_FAILED and status 426. The generic update dialog does not distinguish these fields.
- `message-port-019` — [Split conversations receive the right rows when the second response finishes first](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/concurrent-chat-row-delivery.test.ts#L16).
- `message-port-020` — Open. One page can hold its local token provider. An independent second registered tab able to satisfy the same pending read with a different bearer was not constructed at the public boundary.
- `message-port-022` — Open. The single registered tab can reject its local provider. There is no second simultaneously live tab with an independent pending bearer on the same worker to survive the first disconnect.
- `message-port-023` — Open. The first native token-error was observed during startup. The all-providers AggregateError for a shared read needs two real token providers and the requesting caller receipt.
- `message-port-027` — Open. The child runtime experiment exercises cache reopening. Its app/worker domain is independent and its document is shared. Closing one native tab while a second tab continues reading on that same worker is unproved.
- `message-port-030` — Open. The first real browser messages include register-tab before queries. Issuing a pre-registration read would require sending a private bridge message on behalf of a tab.
- `message-port-032` — Open. The current indicator schema carries threads and unreadAt. It no longer carries the frozen agent indicators. The page cannot establish the complete two-kind initial and empty final result.
- `message-port-033` — Open. Credential-scope notifications, catch-up and rendered rows were exercised. No public handler receipt separates exactly three indicator reloads from two independent warms two seconds apart.
- `message-port-034` — Open. Background warming and later cache visibility were exercised on the Router. The failed warm, continued readable unread indicators, and recovered two-row offline history were not all observed in one lifetime.
- `message-port-036` — Open. The Router registers production user and organization template topics. It does not expose four separately owned subscriptions and independent release of two callers on the same port.
- `message-port-037` — Open. A delayed native attachment and UI replacement were exercised. Each real acquisition generated a new subscriptionId. The frozen reused-ID race requires an ID chosen by the subscriber.
- `message-port-038` — Open. The local attach gate can fail and release one native subscriber. The two independent ports sharing that pending topic, both rejection receipts, and successful reacquisition remain unproved.
- `message-port-039` — Open. Independent child worker domains are available. The Router assigns its own subscription identifiers and does not expose identical IDs or listener counts across worker stores.

#### platform-direct-bridge.test.ts

- `platform-direct-bridge-001` — [The Debug panel measures the UTF-8 bytes of the thread shown in the workspace](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-snapshot-inspection.test.ts#L19).
- `platform-direct-bridge-002` — Open. The cold-start experiment displayed cached / caught-up / notified passages. Warming via a real first Router produced service cursors [1,2,2]; explicit early owner disposal rejected with AbortError. There is no verified strict cursor advance and post-reset completion under this construction.
- `platform-direct-bridge-006` — [A second rename arrives on the live workspace list](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-snapshot-inspection.test.ts#L49).

#### single-connection-client.test.ts

- `single-connection-client-001` — Open. The native query trace shows real cache reads with afterSeqId null. The production chat cache reader does not issue the stipulated cache-only request with afterSeqId 42.
- `single-connection-client-002` — Open. At the preview origin, no query telemetry was ingested and the chat editor mounted. Only a diagnostic port result established the precise empty array of the cache-only operation. The empty editor has no distinct completed-cache signal.

#### worker-runtime.test.ts

- `worker-runtime-001` — [A worker catch-up failure propagates its HTTP status and offers an update](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/service-upgrade-responses.test.ts#L74).
- `worker-runtime-002` — [Reopening a conversation reads only rows belonging to the member's selected workspace](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-transcript-isolation.test.ts#L16).
- `worker-runtime-005` — Open. The stored conversation was displayed after delivery from the signed object and again while remote events were held. Only an internal protocol observer verified the exact empty event arrays on both reads.
- `worker-runtime-007` — [An expired transcript and thread list recover their fresh snapshots and both tails](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/expired-conversation-cursors.test.ts#L25).
- `worker-runtime-008` — Open. A genuine two-thread catch-up, changed-only invalidation, and both cache results passed in the transport experiment. The changed-ID report is internal. The returned invalidation list has no complete user-facing consumer receipt.
- `worker-runtime-012` — [A project refreshed after cursor expiration is cached at the new sequence for its owner](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/reopened-project-metadata.test.ts#L15).

#### api-client-bootstrap.test.ts

- `api-client-bootstrap-001` — Open. The Lab consumed the bootstrapped switch payload and a later user action reached the network. The local Clerk fixture sees token arguments, without the per-request lifecycle signal needed to establish the frozen ownership claim.

#### auth-oauth-consent.test.ts

- `auth-oauth-consent-001` — [Local sign-in continues to the same port's consent request](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/local-consent-origin.test.ts#L25).
- `auth-oauth-consent-003` — [A Marketing consent destination leaves the member at the local sign-in form](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/local-consent-origin.test.ts#L33).

#### bootstrap-feature-switch.test.tsx

- `bootstrap-feature-switch-001` — [Workspace features stay private while the signed-out member sees sign-in](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/signed-out-feature-startup.test.ts#L8).
- `bootstrap-feature-switch-002` — [Workspace features release the page and the feature guide request](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/auth-v1/__tests__/workspace-startup-gates.test.ts#L48).

#### clerk-user.test.ts

- `clerk-user-003` — Open. The signed-out transition probe failed at root lifecycle setup when publishing the replacement local identity. It did not capture a pending user reader that resolved to user-a.
- `clerk-user-005` — Open. A repeated user publication is observable in the Clerk fixture. No user interaction exposes JavaScript promise identity for the settled reader.
- `clerk-user-006` — Open. The page owns startup and installs its reader internally. A synchronous read ahead of owner completion and the identity of the owner-resolved promise are not exposed on this route.
- `clerk-user-007` — Open. A Clerk session switch cancels the previous real page owner. The fixture has no public read of the prior settled promise under the replacement owner or listener-observation identity.

#### command-scheduling.test.ts

- `command-scheduling-001` — Open. Successive editor edits reached only the latest persisted draft. Their call values/repetition arguments and the first returned AbortError are private to the generic command.
- `command-scheduling-002` — Open. The draft edit reached the persistence boundary. No user-facing caller observes the old running command cooperatively rejecting after release and the precise value of the new call.
- `command-scheduling-003` — Open. A production edit cannot resubmit with a deliberately cancelled caller signal, nor retrieve the two returned AbortErrors and their original reason.
- `command-scheduling-004` — Open. The worker warm and draft UI produce observable updates. Two trailing throttle callers sharing the returned latestlatest promise at the 1000 ms boundary have no user-facing equivalent.
- `command-scheduling-006` — Open. Separate runtime domains were exercised on real pages. The generic debounced command invocation, private store identity and its two completion values have no production user operation.

#### fetch.test.ts

- `fetch-002` — [An empty connector denial surfaces the thrown HTTP status in the connection page and its notification](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/connector-service-denial.test.ts#L7).
- `fetch-003` — [Searching the connector catalog reveals a required client refresh after delivery](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/service-upgrade-responses.test.ts#L27).

#### realtime.test.ts

- `realtime-001` — Open. Actual production subscribers were observed. The UI does not independently cancel two shared-topic callers and expose final detach plus later reacquisition for those two original owners.
- `realtime-002` — Open. A native subscription was registered and its payload received. The Router did not expose the stipulated one-shot waiter completing, removing itself and bypassing an app-side token request.
- `realtime-004` — Open. The organization queue visibly changed and its user-channel subscription was absent. One visible change cannot distinguish duplicate internal handler calls. The single reload receipt is available only in the transport probe.
- `realtime-005` — Open. A terminal worker failure can be injected through local Ably. The two initial callers and a later independent subscription rejecting the same failure were not publicly observable.
- `realtime-006` — Open. The route can be closed during attach. The typed cancellation reason returned to its one-shot waiting promise is not observable by the user.
- `realtime-008` — Open. The open-chat experiment suspended the existing credential connection before opening the viewer. No run-output registration was observed while suspended. Suspending after attachment starts covers a different initial condition.
- `realtime-010` — Open. A terminal loss was delivered to the active local provider. No public component exposes the original subscriber error callback and removal of that exact subscription together.
- `realtime-011` — Open. The native trace includes payload, gap and reconnect. The startup-vs-reconnect initializations with runOnSubscribe omitted and their independent application completion are not observable for the same payload consumer.
- `realtime-019` — Open. The chat registered thread-detail and automation invalidations. The current kind-specific callbacks and visible resources do not establish all the original preference/detail/automation invalidations in the stipulated order.
- `realtime-020` — Open. The live automation subscription exists. No public component accepts a failing initialization callback and returns its rejection while keeping that exact subscription active.

#### shared-database-browser.test.ts

- `shared-database-browser-001` — [Chats starts a module worker bound to its workspace and member](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/__tests__/workspace-worker-startup.test.ts#L157).
- `shared-database-browser-002` — [The connected workspace uses its locally cached default Clerk token for the worker's private read](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-token-delivery.test.ts#L8).
- `shared-database-browser-005` — [The indicator service requires the member to update](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/service-upgrade-responses.test.ts#L50).
- `shared-database-browser-006` — Open. The native SharedWorker constructor threw the local TypeError. The real startup promise rejected with the same object. The attempted consumer connection check has no independent public entry after startup fails.

#### startup-diagnostics.test.tsx

- `startup-diagnostics-001` — [A failed workspace stylesheet leaves the mounted page inert and its loading announcement active](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-stylesheet-failure.test.ts#L18).
- `startup-diagnostics-003` — Open. The signed-in missing chat emitted exactly one bounded not_found timing event. A separate real entrypoint emitted the rounded first-paint fields. The same authenticated startup and its dispatched, sanitized anonymous analytics envelope were not established together.

#### user-timezone-initialization.test.tsx

- `user-timezone-initialization-001` — [A first visit to Workflows saves the member's Shanghai timezone and English locale](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-timezone-startup.test.ts#L56).
- `user-timezone-initialization-003` — [Account preferences show the saved Pacific timezone on a Shanghai device](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/workspace-timezone-startup.test.ts#L69).

#### client.test.ts

- `client-001` — Open. The public viewer issued Browser.getVersion. Holding it and advancing the clock produced subsequent protocol traffic without a surfaced timeout of the frozen request.
- `client-002` — Open. Closing the real viewer left the remote target intact with zero later requests. Independent rejections for both outstanding requests and a new post-close notification attempt were not user-visible.
- `client-003` — Open. A genuine attach was delayed and the viewer was closed. Its connection closed; continued Browser.getVersion and late detach on that same live connection were not observed.
- `client-004` — Open. Cancelling the browser page disposed its control connection. The native startup rejection, late detached session and continued control connection were not all observable.
- `client-006` — Open. The streaming viewer used one control connection. Two independently open clients with a shared native session ID and client-specific notification delivery were not constructed.
- `client-007` — Open. The real viewer produced CDP traffic. Two Page.navigate operations, distinct session IDs, reverse replies and different returned frame IDs have no pair of simultaneous public viewer actions in this probe.
- `client-008` — Open. The public close path cancelled attachment by closing the connection. The late cleanup on the original target/connection and later successful Browser.getVersion remain unproved.

#### session-output-stream.test.ts

- `session-output-stream-002` — Open. Both live viewer attachment gates were exercised. Switching panes remounted the replacement and changed its subscription ID, and the experiment used different threads. It does not establish the same-thread replacement owner surviving the obsolete cancellation.

#### unread-through-at.test.ts

- `unread-through-at-001` — Open. The reopened conversation clears the unread dot optimistically. That visible read state cannot distinguish the newer terminal timestamp from the older marker inside the maximum calculation. Prior evidence and ownership remain in place.

#### chat-idb.test.ts

- `chat-idb-002` — Open. A legacy IndexedDB upgrade preserved the snapshot and the Debug UI listed all seven stores. Sequence 1/2/3, the index and owner notification were established by physical database/port inspection. No public route verified their complete semantics.

#### indexeddb-client.test.ts

- `indexeddb-client-001` — [Opening a workspace emits a successful duration without disclosing the member or organization](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/chat-storage-telemetry.test.ts#L39).
- `indexeddb-client-002` — Open. An externally failing native IndexedDB open emitted failure telemetry. The page intentionally recovered and its readiness promise fulfilled. The original exception did not reach that caller.
- `indexeddb-client-003` — Open. The full port test runs the worker host in the window realm. Redacted open/API diagnostics were observed, but the shared_worker transaction creation and two-request execution on the same private pair were not exposed.
- `indexeddb-client-006` — [Opening a private chat reports its event-rows route without the token, cursor or thread identity](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/chat-storage-telemetry.test.ts#L58).

#### user-message-document.test.ts

- `user-message-document-003` — Open. The current input document union omits the frozen agent mention. Restored attachments, templates and project references were exercised; the original full mixed document cannot be represented by this current public input schema.
- `user-message-document-006` — [Forwarding draft with note preserves its source and the order of its quotes](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/linked-message-representations.test.ts#L59); [Forwarding sent correspondence preserves its source and the order of its quotes](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/linked-message-representations.test.ts#L59); [Forwarding two draft excerpts preserves its source and the order of its quotes](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/linked-message-representations.test.ts#L59).
- `user-message-document-007` — [Copying the sent PDF preserves its saved attachment and empty prompt representation](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-copy.test.ts#L15).
- `user-message-document-008` — [Sending the annotated drawing preserves the original image and its marked region](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-send.test.ts#L88).
- `user-message-document-011` — [Templates embedded in the draft and in quoted feedback reach the run in order](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-send.test.ts#L119).
- `user-message-document-012` — [Saving a restored multiline draft keeps its hard break, blank paragraph and edge spaces](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-send.test.ts#L186).
- `user-message-document-014` — Open. The external-source and model cases retained rich clipboard metadata and text. The two automation render variants used their workflow action and produced no rich clipboard payload in the probe. All four frozen variants are required.
- `user-message-document-016` — [A restored suggestion keeps its feedback while the linked message shows its title](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-send.test.ts#L196).
- `user-message-document-017` — [The editor and outgoing prompt keep both mentions of the same project](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/restored-message-send.test.ts#L162).

#### voice-draft-audio.test.ts

- `voice-draft-audio-001` — [A live window one sample short stays pending until the final sample arrives](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/voice-draft-wav-windows.test.ts#L128).
- `voice-draft-audio-002` — [The first full window is delivered while the microphone is still recording](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/voice-draft-wav-windows.test.ts#L96).
- `voice-draft-audio-003` — [A live window one sample short stays pending until the final sample arrives](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/voice-draft-wav-windows.test.ts#L129).
- `voice-draft-audio-007` — [Stopping at 448000 samples retains the previous window's last two seconds](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/voice-draft-wav-windows.test.ts#L108).
- `voice-draft-audio-010` — Open. The microphone fixture with zero input never exposed an enabled Stop recording action. Neither an empty captured buffer nor no initial packet produced the finished public state in this experiment.
- `voice-draft-audio-013` — Open. The restored UI offers finalization for an existing recording. A live recovery checkpoint at exactly 960000 samples with 1168000 retained samples was not established through the recorder. The observed normal 15/13-second windows do not hit that boundary.
- `voice-draft-audio-014` — [A stopped 42-second recording transcribes four overlapping windows](https://github.com/okou-ai/okou/blob/c8514079e486ad9e089641281e7fa06b7c65f5cf/turbo/apps/platform/src/views/okou-page/__tests__/voice-draft-wav-windows.test.ts#L73).
- `voice-draft-audio-015` — Open. The full-scale PCM input traversed the actual AudioWorklet and WAV upload. The normalized positive sample was about 0.99993896, beyond the frozen four-decimal tolerance of 0.00005. The original tolerance is retained.

### Totals and earlier ownership

Historical 1,771/2,681; current fully supported 1,747/2,681. The withdrawal cohort changed by 0 to 422 historical / 413 current of 506. Outside that cohort, 1,349 historical / 1,334 current of 2,175. 288 closed files contain 1,845 frozen rows and 997 retain selections including four previously recorded retirements. 197 open files contain 3,266 frozen rows and 1,684 retain selections, with 754 fully supported selections among them.

The upstream Agents-page and feature-switch changes documented in the original BDD retain their previous attribution. The missing agent indicators and agent mention are changed prerequisites on two still-open cases. This batch records no new formal retirement. The previous 86 original withdrawal dispositions, 17 + 7 historical losses and 68 upstream-only items retain their previous attribution. Batch 77’s 41 open IDs, including chat-session-output-stream-002, keep their prior evidence status. The late-summary gap chat-activity-summary-002 and the prior chat-continuity-drafts-002 gap were not recredited. The separately owned session-output-stream-002 is still open.

### Validation

Local provider and credential fixtures drive the real Router, the bootstrapped production entrypoint or the documented browser startup boundary. Negative controls and subsequent restored runs are retained with the handoff. Copy review includes the freeze, both pre-withdrawal refs, restored version, opening branch, current main, other test paths and shared helpers. The literal matches include ordinary imports, UI selectors, and native provider/voice fixture setup. See the per-ID and full cross-path audit for the scope of that review.

[Next 30 open frozen files and their 292 pending selections](https://app.okou.ai/artifacts/3gcjjmfuii.md).

## Batch 79 checkpoint 1

The [fixed batch 79 intake](https://app.okou.ai/artifacts/3gcjjmfuii.md) selects 292 outstanding retain IDs in 30 frozen files. Opening branch `52130e9d81`. Integrated main through `23ab7eaa5b`. The batch continues on this same intake.

**99 first acceptances across 16 runnable files and 99 individual Vitest rows.** Three frozen files are complete under their current BDD, 15 are partial, five have evidence gaps for all remaining selections and seven await implementation. Of the 193 open IDs, 16 have inconclusive probes, five have changed prerequisites, and 172 await a probe or implementation. [All 292 GWT and ID-to-row mappings](https://app.okou.ai/artifacts/llar0zgtl0.tsv). [Remaining IDs by frozen file](https://app.okou.ai/artifacts/gq13l1js1r.md).

| Frozen owner                                                                                                                                                                                                                 | Disposition | Selected | Verified IDs                                                                   | Examined, open                    | Pending                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------: | ------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [my-okou.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/__tests__/my-okou.bdd.md)                                                                     | Partial     |        7 | 001, 002, 003, 005                                                             | —                                 | 007, 010, 011                                                                                                     |
| [hosted-site-sharing.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.bdd.md)                              | Partial     |       20 | 001, 002, 007, 008, 009, 010, 011, 015                                         | —                                 | 004, 014, 018, 019, 024, 025, 026, 027, 033, 034, 035, 040                                                        |
| [browser-frames-recovery.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/browser-session/__tests__/browser-frames-recovery.bdd.md)                     | Partial     |        8 | 002, 007, 016                                                                  | —                                 | 001, 004, 006, 009, 013                                                                                           |
| [browser-page-crash.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/browser-session/__tests__/browser-page-crash.bdd.md)                               | Partial     |        8 | 006, 010, 012, 013, 015                                                        | —                                 | 001, 003, 005                                                                                                     |
| [color-themes.test.ts](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/css/__tests__/color-themes.bdd.md)                                                        | Blocked     |        7 | —                                                                              | 001, 002, 008, 009, 010, 011, 012 | —                                                                                                                 |
| [safe-area.test.ts](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/css/__tests__/safe-area.bdd.md)                                                              | Blocked     |        1 | —                                                                              | 001                               | —                                                                                                                 |
| [lab-page.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.bdd.md)                                                          | Closed      |        4 | 001, 002, 005, 006                                                             | —                                 | —                                                                                                                 |
| [notification-navigation.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/notifications/__tests__/notification-navigation.bdd.md)                       | Blocked     |        1 | —                                                                              | 001                               | —                                                                                                                 |
| [capability-home-page.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.bdd.md)                                 | Closed      |       16 | 001, 002, 004, 005, 006, 008, 009, 010, 011, 012, 016, 018, 020, 025, 026, 030 | —                                 | —                                                                                                                 |
| [chat-capability-connectors.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-connectors.bdd.md)                     | Pending     |        8 | —                                                                              | —                                 | 001, 003, 004, 005, 008, 009, 011, 013                                                                            |
| [chat-composer-chat-connector-access.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.bdd.md)   | Pending     |        9 | —                                                                              | —                                 | 001, 003, 008, 011, 013, 015, 016, 017, 018                                                                       |
| [chat-composer-connector-loading.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.bdd.md)           | Blocked     |        4 | —                                                                              | 002, 003, 004, 005                | —                                                                                                                 |
| [chat-composer-connectors.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connectors.bdd.md)                         | Pending     |        8 | —                                                                              | —                                 | 001, 006, 007, 009, 011, 013, 015, 016                                                                            |
| [chat-composer-custom-templates.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-custom-templates.bdd.md)             | Pending     |       18 | —                                                                              | —                                 | 006, 009, 010, 012, 013, 014, 015, 016, 017, 019, 020, 022, 023, 026, 027, 030, 033, 036                          |
| [chat-composer-mentions.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-mentions.bdd.md)                             | Pending     |        8 | —                                                                              | —                                 | 001, 004, 005, 008, 010, 011, 012, 014                                                                            |
| [chat-composer-slash-actions.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.bdd.md)                   | Partial     |       10 | 003, 005, 008, 015                                                             | —                                 | 004, 006, 010, 011, 019, 020                                                                                      |
| [chat-composer-slash-panel.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.bdd.md)                       | Partial     |       13 | 001, 006, 007, 008                                                             | —                                 | 011, 013, 015, 016, 017, 020, 023, 024, 025                                                                       |
| [chat-composer-ssh.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.bdd.md)                                       | Partial     |        9 | 009, 012, 014                                                                  | —                                 | 004, 005, 015, 016, 017, 018                                                                                      |
| [chat-composer-vnc-dependencies.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-vnc-dependencies.bdd.md)             | Partial     |       11 | 001, 003, 011, 012, 013, 014, 015, 017, 021                                    | —                                 | 008, 009                                                                                                          |
| [chat-mentions.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-mentions.bdd.md)                                               | Blocked     |        2 | —                                                                              | 001, 003                          | —                                                                                                                 |
| [chat-metadata.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.bdd.md)                                               | Partial     |        5 | 009                                                                            | 008                               | 001, 002, 003                                                                                                     |
| [chat-navigation-browser.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.bdd.md)                           | Pending     |       18 | —                                                                              | —                                 | 001, 002, 003, 004, 005, 006, 008, 011, 012, 016, 017, 021, 023, 025, 026, 029, 032, 036                          |
| [chat-navigation-position-restoration.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-position-restoration.bdd.md) | Pending     |        6 | —                                                                              | —                                 | 001, 002, 003, 004, 007, 010                                                                                      |
| [chat-pin-shortcuts.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-pin-shortcuts.bdd.md)                                     | Closed      |        8 | 002, 003, 004, 005, 006, 008, 009, 015                                         | —                                 | —                                                                                                                 |
| [chat-resources-catalog.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.bdd.md)                             | Partial     |        7 | 005, 006, 009, 010, 011                                                        | —                                 | 001, 013                                                                                                          |
| [chat-resources-realtime.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.bdd.md)                           | Partial     |        3 | 004                                                                            | 003                               | 005                                                                                                               |
| [chat-resources.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources.bdd.md)                                             | Partial     |        5 | 001, 006, 007                                                                  | 004                               | 002                                                                                                               |
| [chat-run-models.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-models.bdd.md)                                           | Partial     |       29 | 001, 003, 005, 009, 011, 012, 017, 022, 030, 040, 041                          | 007                               | 032, 033, 034, 035, 036, 039, 042, 043, 044, 047, 048, 049, 050, 051, 052, 054, 055                               |
| [projects.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/projects.bdd.md)                                                         | Partial     |       29 | 012, 013, 014, 015, 020, 021                                                   | —                                 | 003, 006, 011, 025, 026, 027, 028, 029, 032, 033, 035, 036, 040, 042, 043, 044, 045, 046, 048, 049, 055, 056, 057 |
| [prompt-link.test.tsx](https://github.com/okou-ai/okou/blob/52130e9d813d95958c0cbc04e19d80f4026e495d/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.bdd.md)                                                   | Partial     |       10 | 002, 009, 010, 012                                                             | 001, 003                          | 005, 008, 013, 018                                                                                                |

### Evidence and attribution

Browser reload cases pair the visible selected tab and enabled remote input with the specific external CDP receipt or detached session. Image recovery holds the navigation receipt and replacement frames independently. SSH and VNC choices use local host inventory and held save and refresh responses. A two-pane metadata case starts through the real Router over the message-port transport, waits for visible startup content after the left reply, and releases the right reply separately. The sibling-only 503 case remains open because the first-content signal is still pending.

The open resource-catalog case shows a video on first open even with a foreign notification. Both possible explanations remain in its probe. Computed style is missing from the rendered palette and inset checks. The connector-list close probe received no cancellation signal. The two per-agent conversation-mention entries and prompt-link-001 have separately retained Home comparisons. Prompt-link-003 retains its original SingleAgent prerequisite. Notification navigation retains its batch 33 disposition.

The accepted revised entries are lab-page-001, capability-home-page-004, chat-composer-ssh-009 and prompt-link-002. Their original GWT and the #49556 amendment are preserved. All 29 retained BDD files match the opening revision byte for byte, including the complete Lab and home-capability files with upstream amendments. The completed pinned-shortcut BDD is archived in the opening commit. Batch 77’s 41 open items and the existing chat-activity-summary-002 and chat-session-output-stream-002 evidence keep their prior attribution.

Historical 1,870/2,681 (+99), current complete 1,846/2,681 (+99). Withdrawal cohort 422 historical / 413 current, with 1,448 / 1,433 outside it. The 291 complete owners account for 1,899 frozen rows and 1,025 retain selections, including four previous retirements. The 194 open owners account for 3,212 frozen rows and 1,656 retain selections, of which 825 are complete.

The [separate list of 30 future candidates](https://app.okou.ai/artifacts/f52pxh6o8q.md) is for selection after batch 79. The next run resumes the 193 open IDs above.

## Batch 79 checkpoint 2

The conversation-reading-position owner has six selections. Four are verified by individual Vitest rows. The original GWT and runnable diagnostic for the two open links are preserved. The case reads user-visible message offsets against the scrolling viewport and performs the actual sidebar, keyboard, send and scroll actions. The geometry fixture supplies browser layout measurements.

| Frozen ID suffix | Observed outcome                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001              | Keyboard navigation restored the same thread and the 64 px reading offset. A 128 px input offset failed the original expectation.                                                                       |
| 002              | Sidebar navigation restored the 96 px reading offset. A 144 px input offset failed that expectation.                                                                                                    |
| 003              | Scroll to bottom moved the viewport to its real maximum and removed the button. Withholding the click left the viewport above the bottom.                                                               |
| 004              | Open. An event fragment landed its intended message 168 px below the top of a 600 px viewport. The frozen result requires 0 px.                                                                         |
| 007              | Open. The Resources link navigated to the intended parent conversation and run. Its target also landed at 168 px. The original result requires 0 px.                                                    |
| 010              | Sending from an earlier position showed the sent message, cleared the composer and returned to the bottom. Disabling the production optimistic-send tail request left the viewport at its old position. |

**103 unique first acceptances, 103 expanded rows, 17 implementation files.** The 30 frozen owners now comprise 3 complete, 16 partially accepted, 5 fully blocked and 6 awaiting implementation. Of 189 open IDs, 18 have inconclusive probes, 5 have changed prerequisites and 166 await implementation. Local targeted, full-file and seed 7979 shuffled runs use the same registrations. [All 292 GWT and ID-level results](https://app.okou.ai/artifacts/7awr5yzdfq.tsv). [All 30 file-level results and 189 remaining IDs](https://app.okou.ai/artifacts/op9mfd6njv.md).

Historical **1874/2,681**, current **1850/2,681**. The withdrawn cohort is 422 historical / 413 current. Outside it, 1452 / 1437. The 194 open owners contain 829 complete selections. The file closures, preserved BDD and four upstream-amended acceptances recorded in checkpoint 1 still apply.

The next run continues batch 79 on the same PR and original 292-ID intake. [30 prospective files for a later batch](https://app.okou.ai/artifacts/f52pxh6o8q.md).

A follow-up desktop-pointer probe for `chat-resources-004` observed the closed trigger’s tooltip and its disappearance after opening the panel. It remains outside the 103 accepted registrations pending an independent failure control and normal-suite admission. The probe is retained in the handoff evidence. The Home capability chooser now uses fixed suggestion patterns after Semgrep flagged a dynamic regular expression.

## Batch 79 continuation checkpoint-3

The fixed intake remains 30 frozen owners and 292 IDs. At opening commit `24798bd2c3`, 103 IDs were already accepted. This run has verified 7 additional IDs through this checkpoint. The batch now has **110 accepted / 182 open**. Of the open IDs, 158 await implementation and 24 have recorded gaps or changed prerequisites. Main is synchronized through `541a590e84`.

| Complete owners | Partially accepted | Wholly blocked | Awaiting implementation |
| --------------: | -----------------: | -------------: | ----------------------: |
|               3 |                 17 |              5 |                       5 |

Historical first acceptances: **1,881**. Currently complete: **1,857**. New registrations are reconciled by expanded Vitest title. Previous regressions and the two existing late-evidence gaps retain their prior status.

[All 292 GWT, ID results and controls](https://app.okou.ai/artifacts/b2a9n5680z.tsv). [Remaining IDs by frozen file](https://app.okou.ai/artifacts/0kctnlgh41.md). [Runnable probes, source and raw results](https://app.okou.ai/artifacts/jo8bq74x55.zip).

## Batch 79 continuation checkpoint-4

The fixed intake remains 30 frozen owners and 292 IDs. At opening commit `24798bd2c3`, 103 IDs were already accepted. This run has verified 25 additional IDs through this checkpoint. The batch now has **128 accepted / 164 open**. Of the open IDs, 140 await implementation and 24 have recorded gaps or changed prerequisites. Main is synchronized through `541a590e84`.

| Complete owners | Partially accepted | Wholly blocked | Awaiting implementation |
| --------------: | -----------------: | -------------: | ----------------------: |
|               4 |                 17 |              5 |                       4 |

Historical first acceptances: **1,899**. Currently complete: **1,875**. New registrations are reconciled by expanded Vitest title. Previous regressions and the two existing late-evidence gaps retain their prior status.

[All 292 GWT, ID results and controls](https://app.okou.ai/artifacts/a1xmxf0orh.tsv). [Remaining IDs by frozen file](https://app.okou.ai/artifacts/vtkwnxygl9.md). [Runnable probes, source and raw results](https://app.okou.ai/artifacts/iul356abzq.zip).
