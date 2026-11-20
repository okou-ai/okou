# Browser session page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-session-page.test.tsx](browser-session-page.test.tsx).

## browser-session-page-001

Original test `An accessible conversation without a browser can start one`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L250).

- **Given** A conversation is accessible but has no browser session.
- **When** The user opens its browser page.
- **Then** The page says “Browser not live,” enables “Start browser,” and does not say “Browser not found.”

## browser-session-page-002

Original test `Window size settings retain each selected mode when reopened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L260).

- **Given** An active browser viewer is open and its window-size setting initially follows the panel.
- **When** The user selects “On connection,” reopens the setting, then selects “Follow panel” and “Off,” reopening after each selection.
- **Then** Each reopened menu marks the selected mode as checked, including “Off” and “On connection.”

## browser-session-page-003

Original test `The Okou viewer shows its host blank page only while the blank tab is selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L286).

- **Given** The Okou viewer has a selected blank tab and an Example tab, with the cloud browser panel enabled on app.okou.ai.
- **When** The user selects Example and then returns to the blank tab.
- **Then** The blank tab shows “Nothing open yet” and the Okou guidance only while selected; Example shows its URL and not the blank-page message. The address field is enabled.

## browser-session-page-004

Original test `Image quality can be cleared and retyped before applying with Enter or blur`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L346).

- **Given** An active browser has image quality applied at 70.
- **When** The user clears the quality field, types 100, and presses Enter after ending composition; then types 0 and blurs the field.
- **Then** Typing alone does not change applied quality. Enter applies 100, and blur applies 0. Enter and Escape during composition do not apply or dismiss the edit; the quality menu remains open.

## browser-session-page-005

Original test `Empty and invalid image quality edits retain the applied quality`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L388).

- **Given** An active browser has applied image quality 85.
- **When** The user submits an empty edit, then submits 101, -1, and 50.5.
- **Then** The empty edit retains 85. Each invalid value remains visible, is marked invalid, and shows “Enter a whole number from 0 to 100”; the field stays enabled and applied quality remains 85.

## browser-session-page-006

Original test `Image quality presets and slider keys preserve native menu dismissal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L419).

- **Given** An active browser has the image-quality menu open with Balanced selected at 70.
- **When** The user selects Data saver, Sharper, and Balanced, adjusts the slider to its endpoints with End and Home, then edits the field and presses Escape twice.
- **Then** The presets apply 40, 90, and 70 respectively. End applies 100 and Home applies 0 while the slider keeps focus. The first Escape closes the menu without applying the draft and focuses the Image quality menu item; the second returns focus to Browser settings.

## browser-session-page-007

Original test `Dragging image quality from the numeric field commits only after release`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L474).

- **Given** An active browser has applied image quality 70, and the user has drafted 85 in the numeric field.
- **When** The user drags the quality slider to 25 and then 60, releasing at 60.
- **Then** The field follows the drag while applied quality remains 70 until release; after release, quality 60 is applied.

## browser-session-page-008

Original test `Escape cancels a quality drag despite pointer events queued during dismissal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L523).

- **Given** An active browser has applied quality 70 and its quality slider is being dragged to 25.
- **When** The user presses Escape while pointer-move and pointer-up events to 90 are queued during menu dismissal, then reopens the quality menu.
- **Then** The menu closes without applying the queued drag; reopening shows 70, and the Image quality menu item is not disabled.

## browser-session-page-009

Original test `A quality preset replaces the draft and survives a switch through lossless PNG`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L567).

- **Given** An active browser has applied quality 70, and the user has drafted 85 in the quality field.
- **When** The user selects Sharper, switches the image format to PNG, then switches it to JPEG.
- **Then** Sharper applies 90 instead of the draft 85. PNG is applied and Lossless is disabled; switching to JPEG applies JPEG at quality 90, and reopening the format menu shows JPEG selected.

## browser-session-page-010

Original test `A reclaimed connection shows an unavailable state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L628).

- **Given** A browser session exists but has no live URL, and the browser service reports that it is no longer live.
- **When** The user opens the browser page.
- **Then** The page shows “Browser view unavailable.”

## browser-session-page-011

Original test `A replacement browser url blocks input while its connection loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L644).

- **Given** An active browser viewer is usable, then its provider URL changes while a replacement connection is loading.
- **When** The browser session reports the replacement URL and the replacement request completes with a not-live failure.
- **Then** Remote browser input is disabled while loading, and the page shows “Browser view unavailable” after the failure.

## browser-session-page-012

Original test `A replacement browser instance blocks input while its connection loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L644).

- **Given** A browser with no provider URL is usable, then its browser instance changes while a replacement connection is loading.
- **When** The browser session reports the new instance and the replacement request completes with a not-live failure.
- **Then** Remote browser input is disabled while loading, and the page shows “Browser view unavailable” after the failure.

## browser-session-page-013

Original test `A replacement browser window blocks input while its connection loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L644).

- **Given** A browser with no provider URL is usable, then its primary browser window changes from window 0 to window 1 while a replacement connection is loading.
- **When** The browser session reports the new window and the replacement request completes with a not-live failure.
- **Then** Remote browser input is disabled while loading, and the page shows “Browser view unavailable” after the failure.

## browser-session-page-014

Original test `Revealing a replacement viewer synchronizes the display measured while it was concealed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L717).

- **Given** A usable viewer has a 900×600 display; its replacement connection begins loading, concealing the viewer.
- **When** The display changes to 720×480 while concealed and the replacement connection finishes.
- **Then** The replacement viewer synchronizes to the measured 720×480 display size.

## browser-session-page-015

Original test `A null-URL viewer replaces its cdp connection without reusing old input authority`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L781).

- **Given** A null-URL browser viewer is streaming through a CDP connection, and text input to the old page is pending.
- **When** The browser session replaces the CDP URL, the replacement viewer loads, and the user types fresh text.
- **Then** The fresh text reaches the replacement page, not the old connection; the address shows the replacement page URL.

## browser-session-page-016

Original test `A null-URL viewer replaces its runtime connection without reusing old input authority`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L781).

- **Given** A null-URL browser viewer is streaming through a browser runtime, and text input to the old page is pending.
- **When** The browser session replaces the runtime identity, the replacement viewer loads, and the user types fresh text.
- **Then** The fresh text reaches the replacement page, not the old connection; the address shows the replacement page URL.

## browser-session-page-017

Original test `Revalidating window 0 with provider URL https://viewer.example/live revokes old input and resumes the native browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L873).

- **Given** A healthy viewer is open in window 0 with a provider URL.
- **When** The browser session is revalidated and its replacement connection is loading, then the user attempts stale input; after it completes, the user types fresh input.
- **Then** Stale input is not sent while input is disabled. Fresh input is sent to the current page, and no alert appears.

## browser-session-page-018

Original test `Revalidating window 0 with provider URL null revokes old input and resumes the native browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L873).

- **Given** A healthy viewer is open in window 0 without a provider URL.
- **When** The browser session is revalidated and its replacement connection is loading, then the user attempts stale input; after it completes, the user types fresh input.
- **Then** Stale input is not sent while input is disabled. Fresh input is sent to the current page, and no alert appears.

## browser-session-page-019

Original test `An inaccessible conversation has no browser page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L950).

- **Given** The conversation cannot be found.
- **When** The user opens its browser page.
- **Then** The page says “Browser not found” and does not offer “Start browser.”

## browser-session-page-020

Original test `A user can restart a reclaimed browser with a measured mobile display`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L979).

- **Given** A reclaimed browser is stopped, and the measured display is 390×600 at device-pixel ratio 3.
- **When** The user starts the browser.
- **Then** One browser start succeeds, the address becomes enabled, and the start request includes the measured 390×600 display at ratio 3. “Browser not live” disappears.

## browser-session-page-021

Original test `A user can restart a reclaimed browser with an empty display`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L979).

- **Given** A reclaimed browser is stopped, and the measured display is empty (0×0).
- **When** The user starts the browser.
- **Then** One browser start succeeds, the address becomes enabled, and the start request has no initial display. “Browser not live” disappears.

## browser-session-page-022

Original test `A restarted Browser accepts searches after composition in the initial address field`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1039).

- **Given** A stopped browser page has an initial address field containing text entered during composition before the browser is restarted.
- **When** The user restarts the browser, enters “annual report,” and presses Enter.
- **Then** The Search Google button is enabled, and the address becomes the Google search URL for “annual report.”

## browser-session-page-023

Original test `A renewed viewer does not replay an earlier blocked address hint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1127).

- **Given** A browser viewer has an earlier blocked address hint, and chat authorization is renewed while another membership check is pending.
- **When** The user submits a new address during the renewed viewer session, then the pending check completes.
- **Then** The earlier blocked hint is cleared on renewal; the new address is blocked while the check is pending, the page remains at example.com, and the hint disappears when the check completes.

## browser-session-page-024

Original test `An authorization denial from the session keeps the panel with a distinct placeholder`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1179).

- **Given** A browser session request is denied because cloud browser authorization is required; a lease request is still pending.
- **When** The user opens the browser page.
- **Then** The authorization message appears within the browser panel. No remote input, “Browser not live,” “Start browser,” or removed-browser placeholder appears.

## browser-session-page-025

Original test `An authorization denial from the connection keeps the panel with a distinct placeholder`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1179).

- **Given** A browser connection request is denied because cloud browser authorization is required; a lease request is still pending.
- **When** The user opens the browser page.
- **Then** The authorization message appears within the browser panel. No remote input, “Browser not live,” “Start browser,” or removed-browser placeholder appears.

## browser-session-page-026

Original test `A granted initial snapshot revalidates an earlier authorization denial`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1228).

- **Given** The browser service initially denies access for missing authorization, while the initial chat snapshot is pending and grants authorization.
- **When** The granted snapshot arrives.
- **Then** The browser page revalidates and streams the viewer; the authorization message disappears.

## browser-session-page-027

Original test `A replacement snapshot revalidates a renewed grant with unchanged cached authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1267).

- **Given** A cached chat snapshot grants authorization, but a lease renewal is denied; a replacement chat snapshot can revalidate the grant without changing cached authorization.
- **When** The replacement snapshot arrives after the denial, with the browser service granting access again.
- **Then** The viewer resumes streaming and the authorization message disappears.

## browser-session-page-028

Original test `A denied renewal revokes a healthy viewer without waiting for native disconnection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1344).

- **Given** A healthy viewer is open while its lease renewal is pending.
- **When** The renewal is denied for missing authorization.
- **Then** The authorization message appears and the remote input and live browser view are removed, without showing “Browser not live.”

## browser-session-page-029

Original test `Losing authorization while starting replaces the stopped state with the authorization placeholder`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1369).

- **Given** A browser is stopped and its start request is denied because authorization was revoked.
- **When** The user selects Start browser.
- **Then** The authorization-required placeholder replaces the stopped state; Start browser and remote input disappear, and the raw “Browser authorization was revoked” message is not shown.

## browser-session-page-030

Original test `A renewed grant can start a stopped Browser while an older start is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1392).

- **Given** A stopped browser has an older start request pending, and chat authorization is revoked then renewed.
- **When** The user starts the browser again after the renewed grant enables the start action.
- **Then** The second start succeeds and the viewer streams without waiting for the older start request.

## browser-session-page-031

Original test `An unrelated permission failure remains an observable error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1433).

- **Given** The browser service returns a 403 error for a reason other than missing browser authorization.
- **When** The user opens the browser page.
- **Then** The specific “Access denied for another reason” error remains visible with “Browser view unavailable”; the authorization-required placeholder is absent.

## browser-session-page-032

Original test `Restoring chat authorization revalidates an existing active Browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1445).

- **Given** An active browser is denied because chat authorization is disabled.
- **When** Chat authorization is restored, then disabled again.
- **Then** The active viewer streams after restoration. Revoking authorization again removes remote input and shows the authorization placeholder, not “Browser not live.”

## browser-session-page-033

Original test `Restoring chat authorization revalidates an existing suspended Browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1445).

- **Given** A suspended browser is denied because chat authorization is disabled.
- **When** Chat authorization is restored, then disabled again.
- **Then** The stopped state appears with Start browser after restoration. Revoking authorization again removes that action and shows the authorization placeholder, not “Browser not live.”

## browser-session-page-034

Original test `A denied renewal from a previous reload cannot revoke the current same-window viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1495).

- **Given** A healthy viewer has an older lease renewal pending when the browser session is reloaded and a new renewal begins.
- **When** The older renewal is denied while the newer renewal is still pending.
- **Then** The current same-window viewer remains enabled, and no authorization-required placeholder appears.

## browser-session-page-035

Original test `A renewed grant starts renewal without waiting for an older pending lease`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1530).

- **Given** A healthy viewer has an older lease pending when chat authorization is revoked and then renewed.
- **When** The renewal attempt is denied while the older lease remains pending.
- **Then** The authorization-required placeholder appears inside the browser panel, and remote input is absent; renewal does not wait for the older lease.

## browser-session-page-036

Original test `A renewed grant revalidates a healthy viewer and ignores a previous grant's denied renewal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1569).

- **Given** A healthy shared browser viewer is open, and its initial lease renewal is pending.
- **When** The chat's browser permission is disabled and re-enabled while that renewal is later denied.
- **Then** The viewer is revalidated and remains streaming; its input is temporarily disabled during revalidation, and the stale denial message is not shown.

## browser-session-page-037

Original test `A batched disable and re-enable clears a denied lease even when cached authorization was true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1632).

- **Given** A healthy shared browser viewer is open with cached browser permission, and its initial lease renewal is pending.
- **When** The renewal is denied, then permission is disabled and re-enabled in a batch.
- **Then** The viewer becomes usable again and the authorization-denied message is cleared.

## browser-session-page-038

Original test `Confirmed expiry after a failed renewal displays the stopped state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1667).

- **Given** A healthy shared browser viewer is open and a lease renewal fails with a temporary 503 outage.
- **When** A later renewal confirms that the browser has expired and the session is suspended.
- **Then** The page shows “Browser not live” and an enabled “Start browser” button; the authorization-denied message is absent.

## browser-session-page-039

Original test `A mounted panel renews after a transient 502 lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal receives a transient HTTP 502 failure.
- **When** The panel recovers and renews its lease again.
- **Then** The failure is recorded as HTTP 502, address editing remains usable, and the viewer is streaming.

## browser-session-page-040

Original test `A mounted panel renews after a transient 503 lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal receives a transient HTTP 503 failure, followed by another 503 renewal response.
- **When** The panel recovers and renews its lease again.
- **Then** The initial failure is recorded as HTTP 503, address editing remains usable, and the viewer is streaming.

## browser-session-page-041

Original test `A mounted panel renews after a transient network lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal fails at the network level.
- **When** The panel recovers and renews its lease again.
- **Then** The failure is recorded as a network failure, address editing remains usable, and the viewer is streaming.

## browser-session-page-042

Original test `A mounted panel renews after a transient gateway lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal receives a gateway failure with status 502.
- **When** The panel recovers and renews its lease again.
- **Then** The failure is recorded as HTTP 502, address editing remains usable, and the viewer is streaming.

## browser-session-page-043

Original test `A mounted panel renews after a transient gateway-500 lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal receives a gateway failure with status 500.
- **When** The panel recovers and renews its lease again.
- **Then** The failure is recorded as HTTP 500, address editing remains usable, and the viewer is streaming.

## browser-session-page-044

Original test `A mounted panel renews after a transient gateway-504 lease failure and remains usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1711).

- **Given** A mounted browser panel is usable and its lease renewal receives a gateway failure with status 504.
- **When** The panel recovers and renews its lease again.
- **Then** The failure is recorded as HTTP 504, address editing remains usable, and the viewer is streaming.

## browser-session-page-045

Original test `An expired browser pauses after transient recovery receives 404`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1826).

- **Given** A healthy shared browser viewer is open and a lease renewal fails with a temporary capacity error.
- **When** The recovery renewal confirms the browser is expired with status 404.
- **Then** The page shows “Browser not live” and an enabled “Start browser” button; one heartbeat failure is recorded.

## browser-session-page-046

Original test `An expired browser pauses after transient recovery receives 409`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1826).

- **Given** A healthy shared browser viewer is open and a lease renewal fails with a temporary capacity error.
- **When** The recovery renewal confirms the browser is expired with status 409.
- **Then** The page shows “Browser not live” and an enabled “Start browser” button; one heartbeat failure is recorded.

## browser-session-page-047

Original test `Shared panels with provider liveUrl=https://viewer.example/live keep their own chat alive and operate only its native window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1865).

- **Given** A shared browser panel for one chat has provider liveUrl https://viewer.example/live and an open native window.
- **When** The panel renews its lease and the user navigates to next.example/path.
- **Then** Only the current chat's native window is operated; its sole tab is “Example,” the address becomes http://next.example/path, and the viewer stays streaming.

## browser-session-page-048

Original test `Shared panels with provider liveUrl=null keep their own chat alive and operate only its native window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1865).

- **Given** A shared browser panel for one chat has a null provider liveUrl and an open native window.
- **When** The panel renews its lease and the user navigates to next.example/path.
- **Then** Only the current chat's native window is operated; its sole tab is “Example,” the address becomes http://next.example/path, and the viewer stays streaming.

## browser-session-page-049

Original test `A mounted heartbeat keeps address editing usable after renewal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1913).

- **Given** A mounted browser viewer is usable and a lease renewal is pending.
- **When** The renewal completes while the user is editing the address.
- **Then** The address field remains focused and accepts the added character, showing https://example.comx.

## browser-session-page-050

Original test `A heartbeat response 200 after reopening reloads its window and keeps renewing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1960).

- **Given** A browser viewer is open with its native window at primary window 0 and a lease renewal is pending.
- **When** The renewal responds with status 200 after the browser's window changes to primary window 1.
- **Then** The tab list changes to “Other chat,” the viewer remains streaming, and another renewal starts.

## browser-session-page-051

Original test `A heartbeat response 404 after reopening reloads its window and keeps renewing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1960).

- **Given** A browser viewer is open with its native window at primary window 0 and a lease renewal is pending.
- **When** The renewal responds with status 404 after the browser's window changes to primary window 1.
- **Then** The tab list changes to “Other chat,” the viewer remains streaming, and another renewal starts.

## browser-session-page-052

Original test `A heartbeat response 409 after reopening reloads its window and keeps renewing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L1960).

- **Given** A browser viewer is open with its native window at primary window 0 and a lease renewal is pending.
- **When** The renewal responds with status 409 after the browser's window changes to primary window 1.
- **Then** The tab list changes to “Other chat,” the viewer remains streaming, and another renewal starts.

## browser-session-page-053

Original test `A late instance heartbeat after transient recovery preserves the replacement window and continues renewal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L2015).

- **Given** A browser viewer has suffered a transient lease failure and a replacement browser connection is being loaded.
- **When** A late renewal reports the original session after the replacement has a different instance ID.
- **Then** The replacement viewer becomes usable, a subsequent renewal starts, and address editing remains usable at https://example.comx; one heartbeat failure is recorded.

## browser-session-page-054

Original test `A late window heartbeat after transient recovery preserves the replacement window and continues renewal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L2015).

- **Given** A browser viewer has suffered a transient lease failure and a replacement browser connection is being loaded.
- **When** A late renewal reports the original session after the replacement has a different primary window ID.
- **Then** The replacement viewer becomes usable, a subsequent renewal starts, and address editing remains usable at https://other.example.comx; one heartbeat failure is recorded.

## browser-session-page-055

Original test `Navigating after transient recovery cancels the old heartbeat and renews only the new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx#L2110).

- **Given** A browser viewer is open and a transient lease failure has occurred; its renewal for the current chat is pending.
- **When** The user navigates to a different chat.
- **Then** The old renewal is cancelled, renewals are requested only for the old chat and then the new chat, the viewer remains streaming, and the tab list shows “Other chat.”
