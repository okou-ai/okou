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
