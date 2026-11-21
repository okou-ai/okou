# Browser response deadlines

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-response-deadlines.test.tsx](browser-response-deadlines.test.tsx).

## browser-response-deadlines-001

Original test `A viewer initially hidden resumes through the existing native startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L280).

- **Given** The browser viewer starts while the page is hidden.
- **When** The page becomes visible.
- **Then** The viewer resumes, becomes usable on the original tab, and accepts input using one connection.

## browser-response-deadlines-002

Original test `A viewer hidden during native setup resumes through the existing native startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L280).

- **Given** The browser viewer is in native startup when the page becomes hidden.
- **When** Native setup finishes and the page becomes visible.
- **Then** The existing startup resumes, becomes usable on the original tab, and accepts input using one connection.

## browser-response-deadlines-003

Original test `A paused startup suspends its active budget and resumes without replaying old paint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L318).

- **Given** The viewer is starting and its first image has not arrived when the page becomes hidden.
- **When** More than two minutes pass and the held image is released as the page becomes visible.
- **Then** The paused startup resumes without the old image causing failure, and the viewer accepts input using one connection.

## browser-response-deadlines-004

Original test `A viewport pause during native setup keeps its DOM-owned resume path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L344).

- **Given** The viewer is in native setup when its canvas leaves the viewport.
- **When** Native setup completes, more than two minutes pass, and the canvas returns to view.
- **Then** The viewer resumes through the existing DOM-owned path, displays the original tab, and uses one connection.

## browser-response-deadlines-005

Original test `A concealed replacement becomes usable when its descriptor arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L360).

- **Given** A replacement browser binding is being fetched while the viewer is concealed, and input is disabled.
- **When** The replacement descriptor arrives.
- **Then** The replacement page becomes usable and accepts input in its own page session.

## browser-response-deadlines-006

Original test `A concealed replacement reveals descriptor timeout and permits recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L374).

- **Given** A replacement browser binding is being fetched while the viewer is concealed.
- **When** The descriptor request exceeds one minute and recovery runs before the held response arrives.
- **Then** Reconnecting is shown, then the replacement page becomes usable and accepts input in its own page session; the late response does not prevent recovery.

## browser-response-deadlines-007

Original test `A startup failure while paused retires with its native owner and can resume`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L391).

- **Given** Native startup is held while the viewer is paused.
- **When** Startup exceeds 30 seconds, then the viewer resumes and the old native setup is released.
- **Then** The failed startup connection is retired, a new startup becomes usable, and input works on the original page using two total connections.

## browser-response-deadlines-008

Original test `Acknowledged startup without a first frame reaches a bounded failure and ignores late pixels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L421).

- **Given** Startup has been acknowledged, but its first frame is held and input is disabled.
- **When** The first frame is withheld for more than 30 seconds, recovery completes, and the old frame arrives late.
- **Then** Reconnecting is shown and the viewer becomes usable; the late frame does not prevent input from working.

## browser-response-deadlines-009

Original test `A held descriptor expires and its late response cannot replace recovered authority`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L447).

- **Given** The initial browser descriptor request is held while the viewer is connecting.
- **When** It exceeds one minute, the binding changes, recovery completes, and the old descriptor response arrives late.
- **Then** The replacement page becomes usable and accepts input in its own session using one connection; the old page tab is absent.

## browser-response-deadlines-010

Original test `A whole startup budget bounds several individually timely setup phases`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L494).

- **Given** Browser attachment, native hello, and window proof are each held during startup.
- **When** Each phase takes 21 seconds, 21 seconds, and 19 seconds respectively.
- **Then** The combined startup exceeds its 60-second budget, shows reconnecting, and recovers to a usable viewer after four more seconds.

## browser-response-deadlines-011

Original test `A transport change shares the root startup budget without refreshing its descriptor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L515).

- **Given** The viewer is ready in shared connection mode with one descriptor fetched.
- **When** The user switches to a separate image connection and the successive attachment, hello, and window proof phases take 21, 21, and 19 seconds.
- **Then** The shared startup budget expires and recovery makes the viewer usable; the descriptor is not refreshed before timeout and is fetched once for recovery, with no alert.

## browser-response-deadlines-012

Original test `A same-binding refresh during native setup observes ready startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L554).

- **Given** A same-binding refresh arrives during native startup, with attachment and hello each held for 21 seconds.
- **When** Window proof is released before the startup deadline, then more than one minute passes.
- **Then** The refresh observes the successful startup; the viewer remains usable and accepts input using one connection.

## browser-response-deadlines-013

Original test `A same-binding refresh during native setup observes timeout startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L554).

- **Given** A same-binding refresh arrives during native startup, with attachment and hello each held for 21 seconds.
- **When** Window proof remains held until startup times out; recovery completes and the proof is released, then more than one minute passes.
- **Then** The viewer becomes usable after recovery and accepts input using two connections.

## browser-response-deadlines-014

Original test `Automatic recovery stays pending through native proof on a healthy shared wire and then waits for paint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L611).

- **Given** A ready viewer in shared-wire mode encounters a temporary native window proof failure.
- **When** Automatic recovery begins; after four seconds, native proof succeeds but the recovery image is held, then released.
- **Then** The viewer remains disabled through native proof and until paint arrives, then becomes usable without opening another connection.

## browser-response-deadlines-015

Original test `Automatic recovery stays pending through native proof on a healthy split wire and then waits for paint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L611).

- **Given** A ready viewer in split-wire mode encounters a temporary native window proof failure.
- **When** Automatic recovery begins; after four seconds, native proof succeeds but the recovery image is held, then released.
- **Then** The viewer remains disabled through native proof and until paint arrives, then becomes usable without opening another connection.

## browser-response-deadlines-016

Original test `A rejected recovery descriptor settles the operation and permits another recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L648).

- **Given** A ready viewer disconnects and begins recovery.
- **When** The first recovery descriptor request fails with a server error, then a later request succeeds.
- **Then** The viewer remains disabled after the rejection and becomes usable after the subsequent recovery attempt.

## browser-response-deadlines-017

Original test `A failed reconnect does not leave an error on a recovered same binding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L682).

- **Given** A ready viewer disconnects, and the first reconnect descriptor request fails with a server error.
- **When** The same browser binding is restored and the browser disconnects again.
- **Then** The original page becomes usable with its New tab action enabled, and the earlier browser-action failure message is absent during the later reconnect.

## browser-response-deadlines-018

Original test `A failed reconnect does not leave an error on a recovered replacement window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L682).

- **Given** A ready viewer disconnects, and the first reconnect descriptor request fails with a server error.
- **When** The binding changes to a replacement window and the browser disconnects again.
- **Then** The replacement page becomes usable with its New tab action enabled, and the earlier browser-action failure message is absent during the later reconnect.

## browser-response-deadlines-019

Original test `A failed reconnect does not leave an error on a recovered empty window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L682).

- **Given** A ready viewer disconnects, and the first reconnect descriptor request fails with a server error.
- **When** The window is recovered with no tabs and the browser disconnects again.
- **Then** The New tab action is enabled, the viewer reports no tabs open, and the earlier browser-action failure message is absent during the later reconnect.

## browser-response-deadlines-020

Original test `A verified empty window completes recovery without waiting for pixels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L747).

- **Given** The browser window has no tabs when the viewer starts.
- **When** The browser disconnects and reconnects.
- **Then** The viewer returns to the no-tabs state without waiting for pixels; after more than one minute, New tab remains enabled and opens a usable blank page.

## browser-response-deadlines-021

Original test `An accepted static page has no inactivity deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L766).

- **Given** The viewer is ready on a static page.
- **When** More than one minute passes and the user enters text.
- **Then** The text is delivered, the page remains usable, and the connection is not replaced.

## browser-response-deadlines-022

Original test `Changing chat cancels recovery (paused: false) without retiring the next window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L782).

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The user navigates to the next chat before releasing the old paint, then waits over one minute and releases it.
- **Then** The replacement page becomes usable and accepts input in its own session; the old recovery does not retire it.

## browser-response-deadlines-023

Original test `Changing chat cancels recovery (paused: true) without retiring the next window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L782).

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The page is hidden, then the user navigates to the next chat while paused and makes it visible before releasing the old paint.
- **Then** The replacement page becomes usable and accepts input in its own session after the old paint is released; the old recovery does not retire it.

## browser-response-deadlines-024

Original test `A shared recovery with acknowledged capture but no paint settles as a retryable failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L825).

- **Given** A ready viewer in shared-wire mode disconnects, and recovery capture is acknowledged but its image is held.
- **When** The wall clock moves back one hour and more than 30 seconds of monotonic time pass, then the image is released and recovery retries.
- **Then** The viewer shows reconnecting and remains disabled until retry succeeds, then becomes usable.

## browser-response-deadlines-025

Original test `A split recovery with acknowledged capture but no paint settles as a retryable failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L825).

- **Given** A ready viewer in split-wire mode disconnects, and recovery capture is acknowledged but its image is held.
- **When** The wall clock moves back one hour and more than 30 seconds of monotonic time pass, then the image is released and recovery retries.
- **Then** The viewer shows reconnecting and remains disabled until retry succeeds, then becomes usable.

## browser-response-deadlines-026

Original test `First-frame timeouts during tab selection and image retry preserve the healthy shared connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L857).

- **Given** A ready viewer has two tabs in the same window, and the original tab is usable in shared-wire mode.
- **When** The user selects the replacement tab while its first image is held past 30 seconds, then retries with another held image that also exceeds 30 seconds.
- **Then** Each timeout shows reconnecting without disabling the original tab; after the retry image is released and recovery completes, the replacement tab is usable and accepts input in its own session.

## browser-response-deadlines-027

Original test `First-frame timeouts during tab selection and image retry preserve the healthy split connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L857).

- **Given** A ready viewer has two tabs in the same window, and the original tab is usable in split-wire mode.
- **When** The user selects the replacement tab while its first image is held past 30 seconds, then retries with another held image that also exceeds 30 seconds.
- **Then** Each timeout shows reconnecting without disabling the original tab; after the retry image is released and recovery completes, the replacement tab is usable and accepts input in its own session.

## browser-response-deadlines-028

Original test `A display capture restart has a first-image budget without a readiness caller`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L915).

- **Given** A ready viewer has a measured 900-by-600 viewport and no pending readiness request.
- **When** A display-size change restarts capture, but the first image is held for more than 30 seconds.
- **Then** The viewer shows reconnecting without replacing its connection; after the image is released and recovery completes, the original page is usable and accepts input.

## browser-response-deadlines-029

Original test `A delayed capture acknowledgement keeps its later image timeout local`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L958).

- **Given** A ready viewer has a replacement tab in the same window, and its capture acknowledgement and first image are held.
- **When** The capture acknowledgement is delayed 20 seconds, then the image remains held for more than 30 seconds.
- **Then** The viewer shows reconnecting without replacing its connection; after the image is released and recovery completes, the replacement page is usable.

## browser-response-deadlines-030

Original test `A resumed viewer keeps a missing first frame local to capture recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L986).

- **Given** A ready viewer is paused and then resumed while the resumed capture's first image is held.
- **When** The image is withheld for more than 30 seconds, then released and recovery completes.
- **Then** The viewer shows reconnecting, remains disabled until recovery finishes, and then accepts input on the original page.

## browser-response-deadlines-031

Original test `A tab selected during timed-out capture cleanup survives the old readiness result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1021).

- **Given** A ready viewer is paused and resumed with the original tab's first image held; capture cleanup is also held after the image deadline expires.
- **When** The user selects the replacement tab before releasing cleanup and the old image.
- **Then** The replacement page remains usable after both old operations are released and accepts input in its own session.

## browser-response-deadlines-032

Original test `Selecting a ready tab cancels the old first-frame deadline without failing startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1065).

- **Given** Startup is waiting for the original tab's first image while a replacement tab is already ready.
- **When** The user selects the replacement tab and waits more than one minute before releasing the original image.
- **Then** Startup does not fail because of the old first-frame deadline, and the replacement tab accepts input in its own session.

## browser-response-deadlines-033

Original test `A changed binding supersedes held recovery paint without inheriting its failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1087).

- **Given** A ready viewer disconnects and starts recovery with its original page's paint held.
- **When** The browser binding changes to a replacement window during recovery; after the replacement becomes usable and more than one minute passes, the old paint is released.
- **Then** The replacement page accepts input in its own session, without inheriting the old recovery failure.

## browser-response-deadlines-034

Original test `A binding change cancels a pending transport operation while viewport-paused`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1117).

- **Given** A viewer is switching to separate-image mode while native startup is held, then the viewport is paused and shared mode is unavailable.
- **When** The browser binding changes and its descriptor arrives while paused; shared mode becomes available, then the viewport resumes.
- **Then** The replacement page becomes usable and accepts input in its own session after the old native operation is released.

## browser-response-deadlines-035

Original test `Changing connection mode cancels a pending recovery so a later failure can reconnect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1188).

- **Given** A ready viewer begins automatic recovery after a temporary native proof failure; the proof is held.
- **When** The user changes connection mode, another native proof failure triggers recovery, and the old proof is released after recovery completes.
- **Then** The viewer becomes usable and accepts input on the original page in its own session.

## browser-response-deadlines-036

Original test `A socket that never opens reaches automatic recovery without reloading the page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1223).

- **Given** The browser socket does not open automatically.
- **When** The opening deadline expires and recovery runs.
- **Then** The page shows reconnecting and disables browser input, then reconnects without a page reload. Opening the recovered socket restores the ready browser view.

## browser-response-deadlines-037

Original test `An unanswered attachment reaches automatic recovery without reloading the page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1244).

- **Given** The browser connection opens, but its attachment request receives no reply.
- **When** The response deadline expires and automatic recovery runs, then the late attachment reply is delivered.
- **Then** The page shows reconnecting and disables browser input, then returns to ready without reloading. A new-tab action succeeds after the late reply, creating a tab in the original window.

## browser-response-deadlines-038

Original test `An unanswered inventory reaches automatic recovery without reloading the page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1244).

- **Given** The browser connection opens and attaches, but its inventory request receives no reply.
- **When** The response deadline expires and automatic recovery runs, then the late inventory reply is delivered.
- **Then** The page shows reconnecting and disables browser input, then returns to ready without reloading. A new-tab action succeeds after the late reply, creating a tab in the original window.

## browser-response-deadlines-039

Original test `An unanswered native hello permits explicit reconnection without replaying its late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1274).

- **Given** The browser's native hello request receives no reply.
- **When** Its deadline expires, the user reconnects, and the late hello reply arrives.
- **Then** The browser view is unavailable and input is disabled until the user explicitly reconnects. The late reply is not replayed; a subsequent new-tab action creates one tab in the original window.

## browser-response-deadlines-040

Original test `A native read deadline permits queued revalidation without replacing the healthy wire`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1294).

- **Given** The browser is ready, and a native window read is pending after a tab attaches.
- **When** The read remains unanswered past its deadline while the page is hidden and shown again, then its reply arrives.
- **Then** Input is disabled while the read is pending. The browser becomes ready without replacing the healthy connection, accepts fresh input, and keeps the original address without showing the sibling tab.

## browser-response-deadlines-041

Original test `A history timeout stays local on a shared connection and ignores its late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1355).

- **Given** The browser is ready on a shared connection, and a navigation-history request is pending.
- **When** The history read passes its deadline and its late reply arrives.
- **Then** An alert appears, but the browser remains ready and accepts new input. The connection count does not change, and no browser-disconnected message appears.

## browser-response-deadlines-042

Original test `A history timeout stays local on a split connection and ignores its late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1355).

- **Given** The browser is ready with images on a separate connection, and a navigation-history request is pending.
- **When** The history read passes its deadline and its late reply arrives.
- **Then** An alert appears, but the browser remains ready and accepts new input. The connection count does not change, and no browser-disconnected message appears.

## browser-response-deadlines-043

Original test `A failed scope read on shared permits automatic recovery (binding replaced=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1400).

- **Given** The browser is ready on a shared connection, and a native window read is pending after a tab attaches.
- **When** The read times out and automatic recovery runs without replacing the browser binding; the late reply then arrives.
- **Then** Input and new-tab controls are disabled during reconnecting. Recovery returns to the original address without changing the connection count, and fresh input works after the late reply.

## browser-response-deadlines-044

Original test `A failed scope read on shared permits automatic recovery (binding replaced=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1400).

- **Given** The browser is ready on a shared connection, and a native window read is pending after a tab attaches.
- **When** The read times out, the browser binding is replaced, and automatic recovery runs; the late reply then arrives.
- **Then** Input and new-tab controls are disabled during reconnecting. Recovery returns to the replacement address and adds one connection; fresh input works after the late reply.

## browser-response-deadlines-045

Original test `A failed scope read on split permits automatic recovery (binding replaced=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1400).

- **Given** The browser is ready with images on a separate connection, and a native window read is pending after a tab attaches.
- **When** The read times out and automatic recovery runs without replacing the browser binding; the late reply then arrives.
- **Then** Input and new-tab controls are disabled during reconnecting. Recovery returns to the original address without changing the connection count, and fresh input works after the late reply.

## browser-response-deadlines-046

Original test `A failed scope read on split permits automatic recovery (binding replaced=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1400).

- **Given** The browser is ready with images on a separate connection, and a native window read is pending after a tab attaches.
- **When** The read times out, the browser binding is replaced, and automatic recovery runs; the late reply then arrives.
- **Then** Input and new-tab controls are disabled during reconnecting. Recovery returns to the replacement address and adds two connections; fresh input works after the late reply.

## browser-response-deadlines-047

Original test `Selecting another scoped tab revalidates a rejected native read on the healthy wire`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1456).

- **Given** The browser is ready with the original and replacement pages in the same window; the next native window read will fail.
- **When** A tab attaches and the native read fails, then the user selects the replacement tab.
- **Then** The browser initially shows reconnecting with input disabled, then becomes ready at the replacement address. New input works without replacing the single connection.

## browser-response-deadlines-048

Original test `A wall-clock rollback cannot extend the opening deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1482).

- **Given** The browser socket has not opened.
- **When** The wall clock moves back one hour and 31 seconds of monotonic time pass.
- **Then** The opening deadline still triggers reconnecting and a second connection; opening it restores the ready browser view.

## browser-response-deadlines-049

Original test `A wall-clock rollback cannot extend the native read deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1482).

- **Given** A native window read is pending after the browser opens.
- **When** The wall clock moves back one hour and 31 seconds of monotonic time pass.
- **Then** The read deadline still triggers reconnecting and a second connection; opening it restores the ready browser view.

## browser-response-deadlines-050

Original test `Uncertain input is not replayed after its response deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1535).

- **Given** The browser is ready and an input action is sent without receiving its response.
- **When** The action passes its response deadline and recovery completes.
- **Then** The uncertain input is not replayed: the recorded insert-text requests contain one original-session entry for “x” and one recovered-session entry for “y”.

## browser-response-deadlines-051

Original test `Uncertain navigation is not replayed after its response deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1562).

- **Given** The browser is ready and a navigation request is sent without receiving its response.
- **When** The request passes its response deadline and recovery completes.
- **Then** The navigation request is sent exactly once; it is not replayed.

## browser-response-deadlines-052

Original test `Uncertain creation is not replayed after its response deadline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1578).

- **Given** The browser is ready and a new-tab creation request is sent without receiving its response.
- **When** The request passes its response deadline and recovery completes.
- **Then** Exactly one created tab exists, and the Original tab remains selected.

## browser-response-deadlines-053

Original test `Navigating away cancels the original read deadline and keeps the next chat usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1596).

- **Given** The browser is ready on one chat, and a native window read is pending.
- **When** The user navigates to another chat before the read deadline, waits past the deadline, and then the old reply arrives.
- **Then** The next chat shows the replacement address and accepts fresh input on its page. No error is reported.

## browser-response-deadlines-054

Original test `A cancelled attachment keeps its original deadline without releasing the replacement session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1628).

- **Given** The browser is ready with the replacement page in the same window, and an attachment to that page is pending.
- **When** The replacement page is destroyed, the attachment is cancelled, and the original deadline expires before the late reply arrives.
- **Then** Recovery returns to the ready browser. The late reply does not release the current session; fresh input works on the original page, and no error is reported.

## browser-response-deadlines-055

Original test `Unacknowledged input and capture cleanup stay on their original connection after timeout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx#L1659).

- **Given** The browser is ready, Shift is held, and input acknowledgement and screencast cleanup are pending on the original connection after a tab attaches.
- **When** The requests remain unanswered past their deadline, recovery completes, and their late replies arrive.
- **Then** Fresh input works after recovery. The original connection receives the Shift key-down and key-up events, with no replay to a replacement session.
