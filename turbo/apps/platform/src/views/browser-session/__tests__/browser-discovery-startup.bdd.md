# Browser discovery startup

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-discovery-startup.test.tsx](browser-discovery-startup.test.tsx).

## browser-discovery-startup-001

Original test `An address edited before initial discovery adopts the first admitted tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L117).

- **Given** The browser is starting discovery and its first owned tab has not yet been admitted.
- **When** The user enters “initial-draft.example/path” and presses Enter before admission, then releases discovery and presses Enter again.
- **Then** The first Enter does not change the tab URL. After admission, the address retains the draft and has focus; the second Enter navigates to http://initial-draft.example/path.

## browser-discovery-startup-002

Original test `A proven page accepts input before later sibling discovery settles`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L140).

- **Given** The first owned tab is admitted while discovery of sibling tabs is still pending.
- **When** The user types “first frame input” into remote browser input before sibling discovery finishes.
- **Then** The text is sent to the browser. The later owned tab appears after discovery, while sibling 19 remains absent.

## browser-discovery-startup-003

Original test `A background creation readmits the selected page before the remaining tab proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L171).

- **Given** The first owned tab is selected and ready, and a background tab is being created while membership checks are pending.
- **When** The first tab is readmitted, then the user types “during background discovery” while the background tab’s proof remains pending.
- **Then** Input is disabled during readmission and becomes usable after the first tab is admitted; the text is sent. The background tab appears after its proof is released.

## browser-discovery-startup-004

Original test `A tab selected during background discovery becomes ready after its proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L217).

- **Given** The first owned tab is ready while discovery of a new background tab triggers a membership check for the later owned tab.
- **When** The user selects the later owned tab before its proof completes, then releases the proof and types “new selection after proof.”
- **Then** Input is disabled while the selected tab awaits proof. After admission, the address shows https://later.example.com and the text is sent to that tab.

## browser-discovery-startup-005

Original test `Background removal readmits the selected page without disturbing navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L263).

- **Given** Both owned tabs are discovered and the first tab is selected.
- **When** The later tab is removed in the background, membership is revalidated, and the user navigates to “after-removal.example/ready.”
- **Then** Input is disabled during revalidation; afterward the later tab is absent and navigation succeeds at http://after-removal.example/ready.

## browser-discovery-startup-006

Original test `A retained selection observes document navigation while membership is gated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L289).

- **Given** The selected first owned tab is retained while its membership is gated.
- **When** The tab navigates to https://navigated.example.com/after-proof before membership is released.
- **Then** After admission, the address shows https://navigated.example.com/after-proof.

## browser-discovery-startup-007

Original test `A retained selection observes same-document navigation while membership is gated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L289).

- **Given** The selected first owned tab is retained while its membership is gated.
- **When** The tab changes its same-document URL to https://first.example.com/#during-proof before membership is released.
- **Then** After admission, the address shows https://first.example.com/#during-proof.

## browser-discovery-startup-008

Original test `An initial document receipt is retained until membership is readmitted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L336).

- **Given** Initial document setup is held while the first owned tab’s membership is gated.
- **When** The initial document read completes before membership is released, then a browser frame arrives after admission.
- **Then** Input remains disabled until membership is admitted, and the address shows https://first.example.com; the browser view becomes ready when the frame arrives.

## browser-discovery-startup-009

Original test `Retained initialization joins input, proof, then frame before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order input, proof, then frame.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “input-proof-frame” sends that text to the first tab.

## browser-discovery-startup-010

Original test `Retained initialization joins input, frame, then proof before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order input, frame, then proof.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “input-frame-proof” sends that text to the first tab.

## browser-discovery-startup-011

Original test `Retained initialization joins proof, input, then frame before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order proof, input, then frame.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “proof-input-frame” sends that text to the first tab.

## browser-discovery-startup-012

Original test `Retained initialization joins proof, frame, then input before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order proof, frame, then input.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “proof-frame-input” sends that text to the first tab.

## browser-discovery-startup-013

Original test `Retained initialization joins frame, input, then proof before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order frame, input, then proof.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “frame-input-proof” sends that text to the first tab.

## browser-discovery-startup-014

Original test `Retained initialization joins frame, proof, then input before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L371).

- **Given** Initial input setup, membership proof, and the first frame are all pending for the first owned tab.
- **When** They complete in the order frame, proof, then input.
- **Then** Input remains disabled until all three complete, then becomes enabled and the browser view is ready. Typing “frame-proof-input” sends that text to the first tab.

## browser-discovery-startup-015

Original test `A retained initial picture becomes usable when input completes before the other prerequisite`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L429).

- **Given** The first frame has arrived, but initial input setup and membership proof are pending for the first owned tab.
- **When** Input setup completes before membership proof.
- **Then** Input remains disabled until membership proof completes; then the retained picture is usable and the browser view is ready without another frame.

## browser-discovery-startup-016

Original test `A retained initial picture becomes usable when proof completes before the other prerequisite`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L429).

- **Given** The first frame has arrived, but initial input setup and membership proof are pending for the first owned tab.
- **When** Membership proof completes before input setup.
- **Then** Input remains disabled until input setup completes; then the retained picture is usable and the browser view is ready without another frame.

## browser-discovery-startup-017

Original test `A static first picture delivered during membership validation survives input completion first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L458).

- **Given** A static first picture arrives while the first owned tab’s membership is being validated; input setup and proof are pending.
- **When** Input setup completes before membership proof.
- **Then** Input remains disabled until proof completes; the retained picture is usable, the browser view is ready without another frame, and remote input works.

## browser-discovery-startup-018

Original test `A static first picture delivered during membership validation survives proof completion first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L458).

- **Given** A static first picture arrives while the first owned tab’s membership is being validated; input setup and proof are pending.
- **When** Membership proof completes before input setup.
- **Then** Input remains disabled until input setup completes; the retained picture is usable, the browser view is ready without another frame, and remote input works.

## browser-discovery-startup-019

Original test `Only the latest private picture is presented after membership proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L503).

- **Given** The first owned tab has a pending membership proof and receives two pictures, an initial picture and a newer picture.
- **When** The proof is released after both pictures arrive.
- **Then** The browser view becomes ready and does not show “Browser view unavailable.”

## browser-discovery-startup-020

Original test `A picture whose decode crosses a membership gate resumes without native damage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L532).

- **Given** A first picture is being decoded while the first owned tab’s membership is gated.
- **When** Decoding finishes before membership proof is released.
- **Then** Input remains disabled during the gate; after proof is released, the browser view becomes ready without showing “Browser view unavailable.”

## browser-discovery-startup-021

Original test `A private picture cannot survive stronger move retirement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L568).

- **Given** A private picture for the first owned tab is pending behind membership proof.
- **When** The first tab moves to another window before proof is released.
- **Then** The moved tab does not replace the surviving selection; the later owned tab becomes ready, the browser view remains available, and new input is sent to the later tab.

## browser-discovery-startup-022

Original test `A private picture cannot survive stronger selection retirement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L568).

- **Given** A private picture for the first owned tab is pending behind membership proof.
- **When** The user selects the later owned tab before proof is released.
- **Then** The later tab becomes ready, the browser view remains available, and new input is sent to the later tab rather than the retired picture’s tab.

## browser-discovery-startup-023

Original test `Moving an initializing retained tab cancels its late readiness (painted: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L624).

- **Given** The first owned tab is initializing behind a membership gate, and its initial frame has not yet arrived.
- **When** The first tab moves to another window, then the proof and late frame are released.
- **Then** The first tab is absent, the later owned tab remains ready, and input is sent to the later tab.

## browser-discovery-startup-024

Original test `Moving an initializing retained tab cancels its late readiness (painted: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L624).

- **Given** The first owned tab is initializing behind a membership gate, and its initial frame has already arrived.
- **When** The first tab moves to another window, then the proof and remaining initialization are released.
- **Then** The first tab is absent, the later owned tab remains ready, and input is sent to the later tab.

## browser-discovery-startup-025

Original test `Initial document setup retains a same-document change while Page.getFrameTree is held`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L679).

- **Given** Initial document setup is pending and the first owned tab’s membership is gated.
- **When** A same-document change to https://first.example.com/#before-document-receipt occurs, followed by a child-frame same-document event, before the document read completes.
- **Then** Input stays disabled until membership is admitted; after a frame arrives, the address shows the top-level URL https://first.example.com/#before-document-receipt.

## browser-discovery-startup-026

Original test `Initial document setup retains a same-document change while Page.getLayoutMetrics is held`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L679).

- **Given** Initial document setup is pending on layout metrics and the first owned tab’s membership is gated.
- **When** A same-document change to https://first.example.com/#before-document-receipt occurs, followed by a child-frame same-document event, before layout setup completes.
- **Then** Input stays disabled until membership is admitted; after a frame arrives, the address shows the top-level URL https://first.example.com/#before-document-receipt.

## browser-discovery-startup-027

Original test `Changing selection cancels a revalidated initial document read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L724).

- **Given** Initial document setup is pending while the first owned tab’s membership is revalidated after a same-document change.
- **When** The user selects the later owned tab before the revalidated document read completes.
- **Then** The first tab’s late read does not take over: the later tab remains ready, and new input is sent to it.

## browser-discovery-startup-028

Original test `A capture change finishes when background membership is revalidated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L775).

- **Given** The selected tab is ready and a change to image quality 60 has started, with browser capture stopping in progress.
- **When** Membership is revalidated and the held capture-stop operation completes.
- **Then** Input remains disabled until membership is admitted; afterward the selected tab is ready.

## browser-discovery-startup-029

Original test `Capture preferences chosen during membership validation are applied after admission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L800).

- **Given** The selected tab’s membership is being validated while the image-quality preference is available.
- **When** The user sets image quality to 60 before admission.
- **Then** After admission, capture uses quality 60 and remote browser input is enabled.

## browser-discovery-startup-030

Original test `Automatic capture recovery survives membership validation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L824).

- **Given** Changing image quality to 60 encounters a failed capture start; automatic recovery is underway while membership is validated.
- **When** The recovery capture starts, another membership check begins, and both operations complete.
- **Then** Input remains disabled during the second membership check; after admission the browser is ready and capture uses quality 60.

## browser-discovery-startup-031

Original test `Moving a tab retires its capture change before selecting a scoped survivor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L864).

- **Given** The selected first tab has an image-quality change in progress when it moves out of the browser’s window.
- **When** Membership validation completes for the move.
- **Then** The moved tab is absent and the surviving later tab is selected and ready; the retired capture change does not prevent readiness.

## browser-discovery-startup-032

Original test `A move supersedes a held narrow refresh and cannot be downgraded by another creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L885).

- **Given** A narrow membership refresh is pending after a duplicate-tab event.
- **When** The first tab moves out, a sibling moves in, and another duplicate event occurs before the held refresh completes.
- **Then** Input is disabled while the move is unresolved; afterward the first tab is absent, sibling 0 appears and can be selected, and its address is https://sibling-0.example.com.

## browser-discovery-startup-033

Original test `Closing during a narrow refresh waits for the background survivor proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L912).

- **Given** The browser has one owned tab and a newly created background survivor whose membership proof is pending.
- **When** The user closes the owned tab before releasing the survivor’s proof.
- **Then** After proof completes, the survivor is selected and ready, the closed tab is absent, and the only tab remaining in the owned window is the background survivor.

## browser-discovery-startup-034

Original test `A background lookup failure is rechecked after a non-moving tab event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L945).

- **Given** Initial discovery’s lookup for the later owned tab fails.
- **When** A non-moving tab event occurs afterward and triggers another discovery check.
- **Then** The later owned tab, absent immediately after the failure, appears after the subsequent check; the first tab remains ready.

## browser-discovery-startup-035

Original test `Reconnect admits its preferred tab before the remaining inventory`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L963).

- **Given** The later owned tab is selected when the browser connection drops unexpectedly during discovery.
- **When** The browser reconnects while sibling discovery is still pending.
- **Then** The selected later tab is admitted before the remaining inventory settles; it stays selected and ready with address https://later.example.com.

## browser-discovery-startup-036

Original test `Creating a tab during the continuing scan retains unvisited own tabs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L985).

- **Given** A browser viewer is scanning its assigned window, with a membership check still pending for a sibling-window tab.
- **When** The user creates a tab before the scan completes.
- **Then** The new tab and the later-discovered tab in the assigned window are retained. The sibling-window tab is not shown, and browser input becomes enabled.

## browser-discovery-startup-037

Original test `A pending creation does not hide an initially unvisited survivor from close preservation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1006).

- **Given** A browser viewer is scanning its assigned window, with a membership check pending and a tab creation request in flight.
- **When** The user closes the initially visible tab before the scan completes, then the creation request settles.
- **Then** The initially visible tab closes, and the later-discovered tab becomes selected. The pending creation does not add a tab to the assigned window.

## browser-discovery-startup-038

Original test `Losing the first proven tab waits for a complete inventory (survivor: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1031).

- **Given** The first assigned-window tab is selected while inventory scanning is incomplete; the later assigned-window tab still exists.
- **When** The later tab remains alive and the selected first tab is destroyed.
- **Then** The viewer temporarily shows a connecting state and disables browser input and tab creation until inventory completes. It then selects the later tab.

## browser-discovery-startup-039

Original test `Losing the first proven tab waits for a complete inventory (survivor: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1031).

- **Given** The first assigned-window tab is selected while inventory scanning is incomplete; the later assigned-window tab has also been destroyed.
- **When** The selected first tab is destroyed.
- **Then** The viewer temporarily shows a connecting state and disables browser input and tab creation until inventory completes. It then reports no tabs open, and creating a tab selects a new blank tab.

## browser-discovery-startup-040

Original test `A newly observed page prevents an empty conclusion until its proof settles (owned: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1066).

- **Given** The two initially known assigned-window tabs are present, and a newly observed page belongs to the assigned window with its membership proof pending.
- **When** Both initially known tabs are destroyed before that proof settles.
- **Then** The viewer remains in a connecting state with browser input and tab creation disabled until the proof settles. It then selects the newly observed page.

## browser-discovery-startup-041

Original test `A newly observed page prevents an empty conclusion until its proof settles (owned: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1066).

- **Given** The two initially known assigned-window tabs are present, and a newly observed page belongs to a sibling window with its membership proof pending.
- **When** Both initially known tabs are destroyed before that proof settles.
- **Then** The viewer remains in a connecting state with browser input and tab creation disabled until the proof settles. It then reports no tabs open, and creating a tab selects a new blank tab.

## browser-discovery-startup-042

Original test `Closing the initially visible tab preserves the undiscovered survivor without an extra blank tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1107).

- **Given** The initially visible assigned-window tab is selected while scanning is incomplete, and a later assigned-window tab has not yet been discovered.
- **When** The user closes the initially visible tab before the scan completes.
- **Then** The later tab is selected after the scan. No extra blank tab is created, and it is the only tab left in the assigned window.

## browser-discovery-startup-043

Original test `A close revalidates a failed partial inventory before counting survivors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1126).

- **Given** A partial inventory scan has encountered a temporary native-window error, and the viewer shows a reconnecting state while the initially visible tab remains closable.
- **When** The user closes that tab.
- **Then** The inventory is revalidated, and the later assigned-window tab is selected. No blank tab is created.

## browser-discovery-startup-044

Original test `Overlapping closes during discovery preserve one tab (undiscovered survivor: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1147).

- **Given** The first tab and a sibling-window tab moved into the assigned window are visible during an incomplete scan; a later assigned-window tab exists but is undiscovered.
- **When** The user closes the first tab and then the moved sibling tab.
- **Then** The later assigned-window tab is selected and remains the only tab in the assigned window.

## browser-discovery-startup-045

Original test `Overlapping closes during discovery preserve one tab (undiscovered survivor: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1147).

- **Given** The first tab and a sibling-window tab moved into the assigned window are visible during an incomplete scan; no later assigned-window tab exists.
- **When** The user closes the first tab and then the moved sibling tab.
- **Then** A blank tab is selected and remains the only tab in the assigned window.

## browser-discovery-startup-046

Original test `A late membership reply cannot admit a tab moved to a sibling window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1176).

- **Given** A membership check for a later tab in the assigned window is pending while the first tab is selected.
- **When** The later tab moves to a sibling window before the membership reply arrives.
- **Then** The later tab is not admitted to the viewer or shown; the first tab remains selected and browser input stays enabled.

## browser-discovery-startup-047

Original test `A later discovery failure revokes the admitted viewer's input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1190).

- **Given** The viewer has admitted its first tab and browser input is enabled while a later inventory membership check is pending.
- **When** The membership check fails because the browser does not support the operation.
- **Then** The viewer reports that the browser does not support the operation, disables browser input, and no longer shows the later tab.

## browser-discovery-startup-048

Original test `An in-flight selection survives later inventory publication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1207).

- **Given** The viewer is discovering tabs while selection of a tab is still in progress.
- **When** The inventory scan publishes the later assigned-window tab before selection completes.
- **Then** The later tab appears, but browser input remains disabled until selection completes; afterward the first tab is ready and selected.

## browser-discovery-startup-049

Original test `Unmounting cancels discovery and a close waiting for its inventory`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1222).

- **Given** The viewer is scanning tabs, and closing the initially visible tab is waiting for inventory to complete.
- **When** The viewer is unmounted before the scan settles.
- **Then** The browser connection closes, and the pending scan does not close either assigned-window tab. No browser input remains on screen.

## browser-discovery-startup-050

Original test `Pausing cancels a close waiting for discovery without reporting a failed operation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1245).

- **Given** The viewer is scanning tabs, and closing the initially visible tab is waiting for inventory to complete.
- **When** The page becomes hidden, the scan settles while hidden, and the page becomes visible again.
- **Then** The viewer resumes without an alert, the close action is available again, and closing the first tab selects the later tab.

## browser-discovery-startup-051

Original test `A paused viewer resumes its selected page before the inventory from 1 hidden creations finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1271).

- **Given** The viewer is paused with the first tab selected and the later tab present; one hidden creation is made before the page becomes visible, with discovery checks pending for the selected and later tabs.
- **When** The selected tab's discovery check settles before the later tab's check.
- **Then** The live browser view is visible while browser input remains disabled during discovery. Once ready, the first tab is selected, and the user can navigate to the entered URL before the later discovery check settles.

## browser-discovery-startup-052

Original test `A paused viewer resumes its selected page before the inventory from 5 hidden creations finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1271).

- **Given** The viewer is paused with the first tab selected and the later tab present; five hidden creations are made before the page becomes visible, with discovery checks pending for the selected and later tabs.
- **When** The selected tab's discovery check settles before the later tab's check.
- **Then** The live browser view is visible while browser input remains disabled during discovery. Once ready, the first tab is selected, and the user can navigate to the entered URL before the later discovery check settles.

## browser-discovery-startup-053

Original test `A paused partial scan resumes with the surviving scoped page after the original selection moves away`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1307).

- **Given** The viewer is paused during a partial scan, with the first tab selected and the later assigned-window tab still present.
- **When** The first tab moves to a sibling window and the viewer resumes, pauses again, and resumes with discovery of the later tab pending.
- **Then** Browser input remains disabled until discovery settles. The later tab is then selected, and the moved first tab is absent.

## browser-discovery-startup-054

Original test `Window loss while paused cannot resume a viewer with pending discovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1338).

- **Given** The viewer is paused, and a hidden tab creation leaves discovery pending.
- **When** The assigned browser window is removed and the page becomes visible again.
- **Then** The viewer reports that the assigned browser window is unavailable, with browser input and tab creation disabled.

## browser-discovery-startup-055

Original test `An already dispatched discovery failure survives a visibility pause`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1361).

- **Given** The viewer is scanning tabs when the page becomes hidden, and the scan has already been dispatched.
- **When** The scan fails because the browser does not support the operation, then the page becomes visible.
- **Then** The unsupported-operation failure is shown and browser input is disabled.

## browser-discovery-startup-056

Original test `A new viewer owns hidden changes after the paused surface unmounts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-discovery-startup.test.tsx#L1382).

- **Given** The viewer is paused, and its selected tab moves to a sibling window while the viewer surface is mounted.
- **When** The surface unmounts and a new viewer opens.
- **Then** The new viewer selects the surviving later tab in the assigned window.
