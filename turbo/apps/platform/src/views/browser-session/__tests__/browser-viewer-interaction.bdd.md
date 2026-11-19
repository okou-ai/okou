# Browser viewer interaction

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-viewer-interaction.test.tsx](browser-viewer-interaction.test.tsx).

## browser-viewer-interaction-001

Original test `A selected membership refresh preserves address selection before the first edit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L128).

- **Given** The address field shows https://example.com and the user has placed the caret after its second character.
- **When** The selected page's membership refreshes, then the user types x after the refresh completes.
- **Then** The address remains focused with its caret preserved through the refresh, and typing produces htxtps://example.com without navigating.

## browser-viewer-interaction-002

Original test `A selected membership refresh preserves local address text, focus and caret`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L159).

- **Given** The user has typed draft.example/path and placed the caret after its second character while the page is at https://example.com.
- **When** The selected page's membership refreshes; while it is pending, the user types x and submits, then releases the refresh and submits again.
- **Then** The draft and caret remain intact during the refresh, and the first submission does not navigate. After the refresh, the second submission normalizes the draft to http://drxaft.example/path and navigates there.

## browser-viewer-interaction-003

Original test `A submission blocked by native readiness explains why it did not navigate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L195).

- **Given** The user has entered native-admission.example/path while the browser is connected to https://example.com.
- **When** The page's membership refresh is held pending and the user submits the address.
- **Then** The app explains, “The browser is not ready. Try again shortly.” The address stays focused with its text intact, and the page does not navigate, even after the refresh completes. A later submission navigates to http://native-admission.example/path.

## browser-viewer-interaction-004

Original test `Address blur releases an unchanged baseline but retains an unsent edit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L231).

- **Given** The address shows https://example.com, and the user focuses it while a background navigation occurs.
- **When** The user blurs the unchanged address, edits it to unsent.example/path, blurs again, and another background navigation occurs.
- **Then** The first background URL, https://background.example/, replaces the unchanged address after blur. The later background URL does not overwrite the unsent edit, which remains visible while blurred.

## browser-viewer-interaction-005

Original test `Escape resets the address without surrendering its selected text to a document update`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L271).

- **Given** The user has replaced the address with discarded.example/path.
- **When** The user presses Escape, then the document navigates to https://background.example/ while the address remains focused.
- **Then** Escape restores and selects the full original address, https://example.com. The document update does not replace it while focused; after the user blurs the field, it shows https://background.example/.

## browser-viewer-interaction-006

Original test `An invalid local address remains a draft across membership reattachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L300).

- **Given** The user has submitted the invalid address ///invalid and received a validation alert; the page remains at https://example.com.
- **When** The selected page is detached and reattached through a membership refresh.
- **Then** The invalid draft remains focused and unchanged, and the page remains at https://example.com.

## browser-viewer-interaction-007

Original test `Creation failure preserves active editing and releases only clean interactions (editor=untouched)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L322).

- **Given** A new-tab creation is pending, and the address editor has not been interacted with.
- **When** The creation fails after the new target moves to another window.
- **Then** The existing page is restored without navigation, the address returns to https://example.com, and the browser input is usable. The user can subsequently navigate to http://after-failure.example/path.

## browser-viewer-interaction-008

Original test `Creation failure preserves active editing and releases only clean interactions (editor=focused)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L322).

- **Given** A new-tab creation is pending, and the user has focused the blank address editor without changing its text.
- **When** The creation fails after the new target moves to another window.
- **Then** The existing page is restored without navigation, while the blank address remains focused. The browser input is usable, and the user can subsequently navigate to http://after-failure.example/path.

## browser-viewer-interaction-009

Original test `Creation failure preserves active editing and releases only clean interactions (editor=blurred)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L322).

- **Given** A new-tab creation is pending, and the user focused then blurred the address editor, leaving Browser settings focused.
- **When** The creation fails after the new target moves to another window.
- **Then** The existing page is restored without navigation; the address returns to https://example.com and Browser settings remains focused. The browser input is usable, and the user can subsequently navigate to http://after-failure.example/path.

## browser-viewer-interaction-010

Original test `Creation failure preserves active editing and releases only clean interactions (editor=edited-after-failure)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L322).

- **Given** A new-tab creation is pending, and the user has focused the blank address editor.
- **When** The creation fails after the new target moves to another window, and the user then enters and submits retained.example/path.
- **Then** The existing page is not navigated by the failed creation or by that submission; the submitted draft remains visible. After leaving the field, the user can replace the draft and navigate to http://after-failure.example/path.

## browser-viewer-interaction-011

Original test `A failed creation retains its typed address without navigating the restored page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L385).

- **Given** A new-tab creation is pending from a page at https://example.com.
- **When** The user enters retained.example/path, the creation fails after its target moves to another window, and the user submits the retained draft.
- **Then** The draft remains focused and visible, and the restored page stays at https://example.com. Escape restores the page address; a subsequent chosen.example/path submission navigates to http://chosen.example/path.

## browser-viewer-interaction-012

Original test `A failed creation in an empty window cannot bind its draft to an arriving tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L419).

- **Given** The window has no open tabs, and a new-tab creation is pending.
- **When** The user enters failed-intent.example/path, the creation fails, and a different tab arrives in the window.
- **Then** The arriving https://other.example.com tab is selected, but the failed draft remains visible and cannot navigate that tab. Escape restores the arriving tab's address.

## browser-viewer-interaction-013

Original test `New tabs stay blank through creation and can be closed in window 0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L453).

- **Given** A viewer is open with an existing page in window 0 and a new-tab creation can be delayed.
- **When** The user creates a tab, enters draft.example/path and submits before creation is ready, waits for the blank tab's first image, then closes that tab.
- **Then** The new tab stays blank at about:blank in window 0; early submission reports that the browser is not ready and does not discard the draft. Once ready, the draft remains visible. Closing the blank tab selects the existing Example tab, and no created target remains.

## browser-viewer-interaction-014

Original test `New tabs stay blank through creation and can be closed in window 1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L453).

- **Given** A viewer is open with an existing page in window 1 and a new-tab creation can be delayed.
- **When** The user creates a tab, enters draft.example/path and submits before creation is ready, waits for the blank tab's first image, then closes that tab.
- **Then** The new tab stays blank at about:blank in window 1; early submission reports that the browser is not ready and does not discard the draft. Once ready, the draft remains visible. Closing the blank tab selects the existing Other tab, and no created target remains.

## browser-viewer-interaction-015

Original test `Closing the last tab retains a usable blank tab in assigned window 0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L526).

- **Given** Window 0 contains the Example page and window 1 contains the Other page.
- **When** The user closes the last tab in window 0.
- **Then** A usable blank tab at about:blank is selected in window 0, and the Other page remains unchanged in window 1. The user can navigate the blank tab to https://continued.example.com/ready.

## browser-viewer-interaction-016

Original test `Closing the last tab retains a usable blank tab in assigned window 1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L526).

- **Given** Window 0 contains the Example page and window 1 contains the Other page.
- **When** The user closes the last tab in window 1.
- **Then** A usable blank tab at about:blank is selected in window 1, and the Example page remains unchanged in window 0. The user can navigate the blank tab to https://continued.example.com/ready.

## browser-viewer-interaction-017

Original test `Closing the last established tab does not rely on an unfinished native creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L569).

- **Given** The Example page is the established tab in window 0, and a separate new-tab creation is pending.
- **When** The user closes Example, then closes the confirmed blank replacement before the pending creation finishes.
- **Then** The confirmed replacement keeps the window usable without relying on the pending creation. When that creation completes, its target is removed, leaving one usable blank tab with an empty address.

## browser-viewer-interaction-018

Original test `The last tab stays open until its blank replacement is confirmed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L604).

- **Given** Example is the last tab in its window.
- **When** The user closes it while navigation preparing its blank replacement is pending.
- **Then** Example remains open and its close control is disabled until replacement preparation completes. Afterwards, one selected blank tab remains and browser input is enabled.

## browser-viewer-interaction-019

Original test `Overlapping closes retain one blank tab in the assigned window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L623).

- **Given** Example and Other are both in window 0.
- **When** The user starts closing both tabs before either remote close completes.
- **Then** The window retains exactly one blank tab at about:blank. Once the closes finish, that tab is selected and browser input is enabled.

## browser-viewer-interaction-020

Original test `A failed final-tab replacement leaves the original page usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L650).

- **Given** Example is the last tab in its window, and preparing a blank replacement will fail.
- **When** The user closes Example.
- **Then** An alert appears, but Example remains selected and usable with its close control enabled and address https://example.com. Both original targets remain in their original windows.

## browser-viewer-interaction-021

Original test `Selecting a blank tab covers the previous page before its first image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L672).

- **Given** A blank tab exists alongside the Example page, and the blank tab's first image is delayed.
- **When** The user selects the blank tab and waits for its first image, then releases the image and navigates to https://new.example.com/page.
- **Then** The blank presentation covers the previous page before the image arrives, and browser input stays disabled until the image is ready. The blank presentation clears after navigation, and the new address is shown.

## browser-viewer-interaction-022

Original test `Selecting another tab clears a delayed creation's blank presentation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L709).

- **Given** A new-tab creation is pending while the Example page is selected.
- **When** The user selects Other, edits its address to later-choice.example/draft, and then the creation completes.
- **Then** Other stays selected; the delayed creation does not restore the blank presentation or replace the user's focused draft. No unavailable-browser presentation appears.

## browser-viewer-interaction-023

Original test `A pending creation preserves a later toolbar-control focus choice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L747).

- **Given** A new-tab creation is pending and the user opens and dismisses Browser settings.
- **When** The creation completes and the new tab's first image arrives.
- **Then** The new tab becomes selected and browser controls become enabled, but Browser settings retains focus rather than focus moving to the address field.

## browser-viewer-interaction-024

Original test `A blank tab (created) navigated before its first image does not expose the previous page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L779).

- **Given** A new tab is being created, and its first image is delayed.
- **When** Before the image arrives, the new tab's document navigates to https://destination.example.com/page.
- **Then** The previous page is not exposed. The address updates to the destination, a connecting message appears, and browser input remains disabled until the image arrives; after it arrives, the connecting message clears and input is enabled.

## browser-viewer-interaction-025

Original test `A blank tab (existing) navigated before its first image does not expose the previous page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L779).

- **Given** An existing blank tab is available, and its first image is delayed.
- **When** The user selects it, and before the image arrives its document navigates to https://destination.example.com/page.
- **Then** The previous page is not exposed. The address updates to the destination, a connecting message appears, and browser input remains disabled until the image arrives; after it arrives, the connecting message clears and input is enabled.

## browser-viewer-interaction-026

Original test `A new tab distinguishes automatic focus from interaction before its creation receipt (interaction=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L838).

- **Given** A new-tab creation is pending, and the user has not interacted with the automatically focused blank address.
- **When** The creation completes and the new tab's document navigates first to https://first.example/ and then https://second.example/.
- **Then** Each navigation updates the focused address to the latest URL, including https://second.example/. After the user leaves the field, it still shows the latest URL.

## browser-viewer-interaction-027

Original test `A new tab distinguishes automatic focus from interaction before its creation receipt (interaction=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L838).

- **Given** A new-tab creation is pending, and the user has interacted with the automatically focused blank address before creation completes.
- **When** The creation completes and the new tab's document navigates first to https://first.example/ and then https://second.example/.
- **Then** Both document updates leave the focused address empty. After the user leaves the field, it shows https://second.example/.

## browser-viewer-interaction-028

Original test `Selecting a tab waits for its first image before accepting another browser action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L881).

- **Given** Other is available in a multi-tab viewer, and its first image has not arrived.
- **When** The user selects Other while its first image is delayed.
- **Then** Other becomes selected, but browser input and the New tab button remain disabled until the image arrives. The address stays enabled; after the image arrives, it shows https://other.example.com and browser input and New tab become enabled.

## browser-viewer-interaction-029

Original test `Selecting a tab waits for its input initialization before accepting another browser action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L881).

- **Given** Other is available in a multi-tab viewer, and its browser input initialization has not completed.
- **When** The user selects Other while input initialization is delayed.
- **Then** Other becomes selected, but browser input and the New tab button remain disabled until initialization completes. The address stays enabled; afterwards it shows https://other.example.com and the controls become enabled.

## browser-viewer-interaction-030

Original test `A created tab with a failed first image retries the image without creating another tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L919).

- **Given** The user creates a new tab, and the created blank tab's first image is delayed.
- **When** The first image fails, then connection recovery runs.
- **Then** The app reconnects and retries the image without creating another tab. Recovery leaves exactly the Example and blank New tab entries; the blank tab is selected with an empty address and browser input enabled.

## browser-viewer-interaction-031

Original test `Address navigation remains usable with fallback frame decoding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L971).

- **Given** The viewer uses fallback frame decoding, and the current page is https://example.com.
- **When** The user enters example.test/path and submits it.
- **Then** Navigation succeeds, the address normalizes to http://example.test/path, and the other page remains at https://other.example.com.

## browser-viewer-interaction-032

Original test `A keyboard interaction after submission protects the still-focused address before another character`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L984).

- **Given** The user has submitted submitted.example/path, and page navigation is still pending.
- **When** The user uses the keyboard to move the caret after the second character before navigation completes.
- **Then** The focused address retains submitted.example/path and its caret position after navigation completes. After the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.

## browser-viewer-interaction-033

Original test `A pointer interaction after submission protects the still-focused address before another character`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L984).

- **Given** The user has submitted submitted.example/path, and page navigation is still pending.
- **When** The user uses a pointer to place the caret after the second character before navigation completes.
- **Then** The focused address retains submitted.example/path and its caret position after navigation completes. After the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.

## browser-viewer-interaction-034

Original test `A composition interaction after submission protects the still-focused address before another character`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L984).

- **Given** The user has submitted submitted.example/path, and page navigation is still pending.
- **When** The user starts text composition with the caret after the second character before navigation completes.
- **Then** The focused address retains submitted.example/path and its caret position after navigation completes. After composition ends and the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.

## browser-viewer-interaction-035

Original test `Refocusing a submitted address protects selection until the user leaves it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1031).

- **Given** The user has submitted submitted.example/path, and page navigation is still pending.
- **When** The user moves focus to Browser settings, dismisses it, refocuses the address, and places the caret after the second character before navigation completes.
- **Then** The focused address retains submitted.example/path and its caret position after navigation completes. After the user leaves the field, the address becomes http://submitted.example/path and the page is navigated there.

## browser-viewer-interaction-036

Original test `Leaving a clean refocus retains the pending navigation until its own receipt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1060).

- **Given** A remote page has an address submission awaiting its navigation receipt.
- **When** The user moves focus away and back without changing the address, then the receipt arrives.
- **Then** The address remains unchanged while the receipt is pending, then shows the normalized URL and Reload becomes enabled.

## browser-viewer-interaction-037

Original test `An address submission waits for its navigation receipt across its own document change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1089).

- **Given** A first address navigation has been sent but its receipt is still pending.
- **When** The user submits a second address, then the first navigation receipt arrives and the user retries.
- **Then** The second submission is initially rejected with a still-opening message and the first URL remains active. After the receipt, the alert clears, the second address remains focused and can be submitted, and the remote page reaches its normalized URL.

## browser-viewer-interaction-038

Original test `Moving another page into the window preserves the selected page and input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1126).

- **Given** The Example page is selected in the viewer.
- **When** Another page moves into the same browser window while its membership check is pending, then the check completes.
- **Then** The input is temporarily disabled, Example remains selected, and afterwards the input is enabled, Other is unselected, and the address remains https://example.com.

## browser-viewer-interaction-039

Original test `A selected page moved away automatically continues on a scoped survivor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1147).

- **Given** Example is selected and Other is also in the assigned window.
- **When** Example moves out of that window.
- **Then** Other becomes selected and usable, Example disappears from the tabs, and the address shows https://other.example.com.

## browser-viewer-interaction-040

Original test `A native close (1000) preserves the uncertain new-tab result during automatic recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1176).

- **Given** Creating a new tab has reached the remote browser but its receipt is pending; the native connection closes with code 1000 and wasClean true.
- **When** Automatic recovery begins and the creation receipt is later released.
- **Then** The viewer shows Reconnecting and disables input; the connection breadcrumb reports one pending request and zero cancelled requests. Recovery reconnects and discovers the created tab, which can be selected and used.

## browser-viewer-interaction-041

Original test `A native close (1006) preserves the uncertain new-tab result during automatic recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1176).

- **Given** Creating a new tab has reached the remote browser but its receipt is pending; the native connection closes with code 1006 and wasClean false.
- **When** Automatic recovery begins and the creation receipt is later released.
- **Then** The viewer shows Reconnecting and disables input; the connection breadcrumb reports one pending request and zero cancelled requests. Recovery reconnects and discovers the created tab, which can be selected and used.

## browser-viewer-interaction-042

Original test `A native close distinguishes cancelled late attachments from unfinished requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1233).

- **Given** Other is selected for attachment, and its attachment response is pending when it moves out of the assigned window.
- **When** The native connection closes, then the late attachment response arrives.
- **Then** The viewer reconnects and reports zero pending requests and one cancelled request. The late response does not restore usable input.

## browser-viewer-interaction-043

Original test `An empty assigned window can create a native tab without a source document`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1276).

- **Given** The assigned browser window has no open tabs.
- **When** The user creates a new tab.
- **Then** The new blank tab is created in the assigned window, input becomes enabled, the empty address receives focus, and its value is empty.

## browser-viewer-interaction-044

Original test `An unavailable required extension never admits CDP-only viewing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1303).

- **Given** The required Okou Browser extension is unavailable.
- **When** The user opens the browser viewer.
- **Then** The viewer reports that browser viewing is unavailable; remote input and New tab are disabled, and the extension-unavailable error is reported.

## browser-viewer-interaction-045

Original test `Bridge loss with unacknowledged Runtime.removeBinding still releases its page and reconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1327).

- **Given** The user has pressed Shift in the remote page, and releasing that key and removing the page binding are unacknowledged.
- **When** The browser bridge is lost and automatic recovery runs.
- **Then** The page is detached only after the Shift key-up is sent. The existing browser targets remain, and input is enabled again after recovery.

## browser-viewer-interaction-046

Original test `Bridge loss with unacknowledged Target.detachFromTarget still releases its page and reconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1327).

- **Given** The user has pressed Shift in the remote page, and releasing that key and detaching the page session are unacknowledged.
- **When** The browser bridge is lost and automatic recovery runs.
- **Then** The page is detached only after the Shift key-up is sent. The existing browser targets remain, and input is enabled again after recovery.

## browser-viewer-interaction-047

Original test `Revalidation does not wait for an unacknowledged release before another tab can be used`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1379).

- **Given** The user has pressed Shift in the selected page, and the remote has not acknowledged the key release.
- **When** The browser session is revalidated and the user selects another tab.
- **Then** The other tab becomes selected and remote input is enabled without waiting for the release acknowledgement.

## browser-viewer-interaction-048

Original test `A delayed creation receipt preserves another caller's movement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1409).

- **Given** A new-tab creation receipt is pending.
- **When** Another caller moves the created page to a different window before the receipt is released.
- **Then** Creation reports that the browser action could not be completed, but the page remains in the other window; the existing page remains active and its address is https://example.com.

## browser-viewer-interaction-049

Original test `A delayed creation receipt preserves another caller's pending navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1409).

- **Given** A new-tab creation receipt is pending.
- **When** Another caller starts navigation of the created page before the receipt is released.
- **Then** Creation reports that the browser action could not be completed, but the pending URL remains https://user-navigation.example.com; the existing page remains active and its address is https://example.com.

## browser-viewer-interaction-050

Original test `A fresh native tab read covers preceding metadata updates during creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1448).

- **Given** The assigned browser contains the Example page.
- **When** The user creates a new tab while native tab metadata is updated before the fresh tab read.
- **Then** The new blank tab is selected and usable, the address is empty, and the created tab is about:blank in the assigned window.

## browser-viewer-interaction-051

Original test `A delayed creation check (native getTab) preserves another caller's pending navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1468).

- **Given** A new page is being attached and the creation check through native getTab is delayed.
- **When** Another caller starts navigation of that page before the check completes.
- **Then** Creation reports that the browser action could not be completed; the created page retains its pending user navigation and its creation marker URL. The existing page remains active with address https://example.com.

## browser-viewer-interaction-052

Original test `A delayed creation check (Browser.getWindowForTarget) preserves another caller's pending navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1468).

- **Given** A new page is being attached and the Browser.getWindowForTarget membership check is delayed.
- **When** Another caller starts navigation of that page before the check completes.
- **Then** Creation reports that the browser action could not be completed; the created page retains its pending user navigation and its creation marker URL. The existing page remains active with address https://example.com.

## browser-viewer-interaction-053

Original test `A delayed failed-create cleanup preserves another caller's pending navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1512).

- **Given** A new page attachment is malformed and cleanup is delayed while another caller starts navigation of the created page.
- **When** The delayed cleanup completes.
- **Then** Creation reports that the browser action could not be completed; the created page retains its pending user navigation and its creation marker URL. The existing page remains active with address https://example.com.

## browser-viewer-interaction-054

Original test `A malformed new-page attachment preserves the established browser pages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1548).

- **Given** The remote browser returns a malformed attachment for a new page.
- **When** The user creates a new tab.
- **Then** The browser action fails, the established browser remains usable with address https://example.com, and its existing targets are preserved.

## browser-viewer-interaction-055

Original test `A duplicate marker during creation never takes over the other caller's page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1568).

- **Given** New-tab creation is pending while another caller duplicates the page marker.
- **When** The creation receipt arrives.
- **Then** The browser action fails and the established page remains usable at https://example.com. The targets contain the original pages and a distinct created blank page with a creation marker; creation does not take over the other caller's page.

## browser-viewer-interaction-056

Original test `The address field normalizes [::1]:8080/path for the remote page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1601).

- **Given** The address field is open in the remote browser viewer.
- **When** The user submits [::1]:8080/path.
- **Then** The field and remote page use the normalized URL http://[::1]:8080/path.

## browser-viewer-interaction-057

Original test `The address field normalizes https://例子.测试/你好 for the remote page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1601).

- **Given** The address field is open in the remote browser viewer.
- **When** The user submits https://例子.测试/你好.
- **Then** The field and remote page use https://xn--fsqu00a.xn--0zwm56d/%E4%BD%A0%E5%A5%BD.

## browser-viewer-interaction-058

Original test `The address field normalizes mailto:user@example.com for the remote page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1601).

- **Given** The address field is open in the remote browser viewer.
- **When** The user submits mailto:user@example.com.
- **Then** The field and remote page retain mailto:user@example.com.

## browser-viewer-interaction-059

Original test `Remote editing context updates keyboard hints without interrupting composition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1614).

- **Given** The remote page's focused editing context changes among search, email, URL, telephone, number, textarea, and password fields.
- **When** The user requests updated keyboard hints, then starts composing text while the remote context changes again.
- **Then** The input reflects the field's appropriate input mode, enter-key hint, language, capitalization, and password type without losing focus. During composition the displayed type and hints remain stable; after composition ends they update to the latest password context, and clearing the context resets defaults without disabling input.

## browser-viewer-interaction-060

Original test `Remote password keyboard hints survive native editing and tab updates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1734).

- **Given** The remote page has a password field with numeric input, a Done hint, and Japanese language; the user is composing 中.
- **When** The native page title and tab metadata update during composition, then composition ends.
- **Then** The input stays enabled, focused, password-typed, and retains its numeric, Done, and Japanese hints and composed value through the tab update. The committed text is forwarded to the remote page.

## browser-viewer-interaction-061

Original test `Navigation from a password field hands input focus to the viewer on Page.frameStartedNavigating`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1827).

- **Given** The user is focused in a remote password field.
- **When** The remote page starts a frame navigation.
- **Then** Focus moves to the live viewer surface and the input resets to ordinary text with an empty value. Keyboard input and paste are forwarded to the new page; a later remote editing context can focus the input again, and F8 focuses the Example tab.

## browser-viewer-interaction-062

Original test `Navigation from a password field hands input focus to the viewer on Page.frameNavigated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1827).

- **Given** The user is focused in a remote password field.
- **When** The remote page reports a completed frame navigation.
- **Then** Focus moves to the live viewer surface and the input resets to ordinary text with an empty value. Keyboard input and paste are forwarded to the new page; a later remote editing context can focus the input again, and F8 focuses the Example tab.

## browser-viewer-interaction-063

Original test `Navigation from a text field hands input focus to the viewer on Page.navigatedWithinDocument`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1827).

- **Given** The user is focused in a remote text field.
- **When** The remote page navigates within the current document.
- **Then** Focus moves to the live viewer surface and the input resets to ordinary text with an empty value. Keyboard input and paste are forwarded to the new page; a later remote editing context can focus the input again, and F8 focuses the Example tab.

## browser-viewer-interaction-064

Original test `A delayed pre-navigation editing read cannot reclaim chosen address focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1908).

- **Given** A pre-navigation read of password-field editing context is delayed while the user chooses the address field.
- **When** The page navigates within the document and the delayed read completes after an address has been entered.
- **Then** The address field retains focus and the chosen value, and stale editing information does not restore password hints to the remote input.

## browser-viewer-interaction-065

Original test `A delayed current-page editing read cannot reclaim chosen address focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1908).

- **Given** A read of the current page's password-field editing context is delayed while the user chooses the address field.
- **When** The page navigates within the document and the delayed read completes after an address has been entered.
- **Then** The address field retains focus and the chosen value, and stale editing information does not restore password hints to the remote input.

## browser-viewer-interaction-066

Original test `A failed editing-context read clears stale keyboard hints without disabling input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L1969).

- **Given** The remote input has stale editing hints, and the next editing-context read fails.
- **When** The user requests refreshed hints and then enters fresh text.
- **Then** The input resets to default hints but remains enabled and focused; the fresh text is forwarded to the remote page.

## browser-viewer-interaction-067

Original test `A retired tab's delayed success cannot alter the successor editing context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2015).

- **Given** A delayed editing-context read on the current tab is pending when the user switches to Other, whose focused field is ordinary text with numeric input, Send hint, and English language.
- **When** The old tab's read succeeds.
- **Then** The successor tab keeps its own ordinary-text, numeric, Send, and English editing context.

## browser-viewer-interaction-068

Original test `A retired tab's delayed failure cannot alter the successor editing context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2015).

- **Given** A delayed editing-context read on the current tab is pending when the user switches to Other, whose focused field is ordinary text with numeric input, Send hint, and English language.
- **When** The old tab's read fails.
- **Then** The successor tab keeps its own ordinary-text, numeric, Send, and English editing context.

## browser-viewer-interaction-069

Original test `Native form actions forward Enter once without submitting an IME candidate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2084).

- **Given** The remote input receives native Enter events, including an IME composition candidate and committed text.
- **When** The user presses Enter, submits the form, and completes composition and text entry.
- **Then** Each applicable Enter is forwarded once as a key-down/key-up pair, while the IME candidate is not submitted as Enter. Committed composition text and newline-containing text are forwarded as text, not duplicate Enter actions.

## browser-viewer-interaction-070

Original test `Soft-keyboard deletion forwards after committed text without duplicating desktop Backspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2189).

- **Given** The remote input receives committed text followed by soft-keyboard deletion events and a desktop Backspace key event.
- **When** The user deletes text and enters new text.
- **Then** Deletion is forwarded as three Backspace key-down/key-up pairs without an extra duplicate desktop Backspace, and the new text is forwarded to the remote page.

## browser-viewer-interaction-071

Original test `Queued soft-keyboard deletion and Enter cannot reach a replacement tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2265).

- **Given** The user is composing “old” text in one browser tab while the composition update is pending, then commits it, submits Enter, and requests backward deletion. A second tab is selected before the pending update completes.
- **When** The user enters “fresh” text in the replacement tab and requests backward deletion there.
- **Then** “fresh” is sent to the replacement tab, and the only Backspace key events are one key-down and one key-up sent to that tab; queued input from the previous tab does not reach it.

## browser-viewer-interaction-072

Original test `Backward deletion preserves preedit and consumes committed composition residuals`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2339).

- **Given** The user is composing “中国” in the remote browser input and deletes backward within the active composition, leaving “中”. The composition is then committed, followed by a backward deletion and fresh text entry.
- **When** The input events are processed by the browser.
- **Then** The committed “中” and subsequent “fresh” are each sent as inserted text. Exactly one Backspace key-down and key-up are sent, and the committed composition residual does not cause an extra deletion.

## browser-viewer-interaction-073

Original test `IME preedit and confirmation progress while keyboard metadata is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2424).

- **Given** The user focuses the remote browser input while keyboard metadata is still pending.
- **When** The user composes and confirms “中”.
- **Then** The composition update and one confirmed text insertion are sent while metadata remains pending, and the remote browser input stays focused.

## browser-viewer-interaction-074

Original test `A payload-less context reset retires composition before accepting new remote text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2475).

- **Given** The user is composing “old” in the remote browser input when the browser reports that execution contexts were cleared without a payload.
- **When** The old composition ends, then the user focuses the input again and enters “fresh” as ordinary text.
- **Then** The live browser view receives focus after the reset, and only “fresh” is sent as inserted text; the retired “old” composition is not sent.

## browser-viewer-interaction-075

Original test `Retrying an image waits for both original input and capture cleanup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2524).

- **Given** The user enters “typed” while a screenshot frame arrives, starting recovery; the original text input and screenshot-capture cleanup are both still pending.
- **When** The original input completes before capture cleanup, then capture cleanup completes and recovery advances by one second.
- **Then** The input remains disabled until both pending operations complete, then becomes enabled again with the address showing “https://example.com”.

## browser-viewer-interaction-076

Original test `Closing a tab preserves address focus chosen while the close is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2552).

- **Given** Two browser tabs are open, and closing “Other” is pending.
- **When** The user focuses the address field and enters “draft.example” before the close completes.
- **Then** “Other” closes and “Example” becomes selected, while the address field retains focus and the draft value.

## browser-viewer-interaction-077

Original test `An older close failure preserves the latest-close focus while its selected trigger is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2574).

- **Given** Two tabs are open. Closing “Example” fails but remains pending; the user then closes “Other”, which succeeds, leaving “Example” temporarily disabled as the selected tab.
- **When** The older close failure arrives after the newer close succeeds.
- **Then** An alert is shown, “Example” is re-enabled and focused, and the address remains “https://example.com”.

## browser-viewer-interaction-078

Original test `An older close failure preserves the address-choice focus while its selected trigger is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2574).

- **Given** Two tabs are open. Closing “Example” fails but remains pending; the user then closes “Other”, which succeeds, leaving “Example” temporarily disabled as the selected tab.
- **When** The user focuses the address field and enters “chosen.example/draft”, then the older close failure arrives.
- **Then** An alert is shown, “Example” is re-enabled, and the address field retains focus and the draft value.

## browser-viewer-interaction-079

Original test `A removed keyboard-focus origin recovers once without reclaiming a later address draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2623).

- **Given** The Example tab is selected, and the user moves focus to the Other tab with the right arrow. The Other page is then removed.
- **When** The user starts an address draft and the surviving page's title updates.
- **Then** Focus recovers to the Example tab once, then remains on the Address field. Its draft value is preserved.

## browser-viewer-interaction-080

Original test `A close receipt returns focus before the successor has a live image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2658).

- **Given** The Example tab is open, and the Other page's live image is delayed.
- **When** The user closes Example and the close completes before the Other page image arrives.
- **Then** Focus and selection move to Other, and the remote browser input remains disabled until its image arrives. Then input is enabled and the address shows https://other.example.com.

## browser-viewer-interaction-081

Original test `Shared tab controls support keyboard selection and address Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2694).

- **Given** The Example tab is selected in a viewer with Example and Other tabs.
- **When** The user presses the right arrow, Enter, edits the address, and presses Escape.
- **Then** Other receives focus and becomes selected. Escape restores https://other.example.com in the address without changing Other's URL.

## browser-viewer-interaction-082

Original test `A hidden page pauses input and resumes the selected tab when visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2724).

- **Given** The Other tab is selected in a viewer with Example and Other tabs.
- **When** The page becomes hidden, then visible while the selected tab's image is being refreshed.
- **Then** Input pauses while hidden. On return, the prior live image remains visible and the view shows an updating status; input stays disabled until the new image arrives, then enables with the Other address restored.

## browser-viewer-interaction-083

Original test `Rapid visibility changes retain the preview until original capture cleanup and a new image finish`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2796).

- **Given** The browser viewer is open, and stopping its original screen capture is delayed.
- **When** The page becomes hidden, then rapidly alternates visible, hidden, and visible before the original capture stop completes.
- **Then** The existing preview remains visible without a connecting message, and input stays disabled until the original stop and a new image finish. Input then enables, and submitting an address draft navigates to http://after-visibility.example/ready.

## browser-viewer-interaction-084

Original test `A resume after a failed original stop recovers before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2837).

- **Given** The browser viewer is open, and the original screen-capture stop fails while the page is being hidden.
- **When** The page resumes, then recovery is advanced after the viewer reports reconnecting.
- **Then** Input remains disabled until a new image arrives, then enables. Hiding and resuming again also restores enabled input.

## browser-viewer-interaction-085

Original test `A resume after a failed pending original stop recovers before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2837).

- **Given** The browser viewer is open, and the original screen-capture stop fails while the page is being hidden.
- **When** The page resumes and hides again before the pending original stop completes, then recovery is advanced after reconnecting appears.
- **Then** Input remains disabled until a new image arrives, then enables. Hiding and resuming again also restores enabled input.

## browser-viewer-interaction-086

Original test `A resume after a failed resume preparation recovers before accepting input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2837).

- **Given** The browser viewer is open, and resuming fails during preparation after the page is hidden.
- **When** The viewer reports that it is unavailable, and the user selects Reconnect.
- **Then** Input remains disabled until a new image arrives, then enables. Hiding and resuming again also restores enabled input.

## browser-viewer-interaction-087

Original test `An unchanged capture retries its navigation-related failure after navigation ends`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2944).

- **Given** A browser capture fails because navigation is still in progress, and the capture remains unchanged.
- **When** Navigation ends.
- **Then** The view retries the PNG capture, keeps the input disabled until the capture arrives, then enables it without showing an unavailable-view message.

## browser-viewer-interaction-088

Original test `A first pause before reply cancels the obsolete capture success and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A first pause occurs while a capture is in progress and its success reply has not arrived.
- **When** The page becomes hidden and visible again, then the old capture reply arrives and navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-089

Original test `A first pause after reply cancels the obsolete capture success and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A first pause occurs while a capture is in progress and its success reply has already arrived.
- **When** The page becomes hidden and visible again, then navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-090

Original test `A first pause before reply cancels the obsolete capture failure and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A first pause occurs while a capture is in progress and its failure reply has not arrived.
- **When** The page becomes hidden and visible again, then the old capture reply arrives and navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-091

Original test `A first pause after reply cancels the obsolete capture failure and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A first pause occurs while a capture is in progress and its failure reply has already arrived.
- **When** The page becomes hidden and visible again, then navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-092

Original test `A later pause before reply cancels the obsolete capture success and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A later pause occurs while a capture is in progress and its success reply has not arrived.
- **When** The page becomes hidden and visible again, then the old capture reply arrives and navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-093

Original test `A later pause after reply cancels the obsolete capture success and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A later pause occurs while a capture is in progress and its success reply has already arrived.
- **When** The page becomes hidden and visible again, then navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-094

Original test `A later pause before reply cancels the obsolete capture failure and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A later pause occurs while a capture is in progress and its failure reply has not arrived.
- **When** The page becomes hidden and visible again, then the old capture reply arrives and navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

## browser-viewer-interaction-095

Original test `A later pause after reply cancels the obsolete capture failure and preserves its session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L2976).

- **Given** A capture is underway during navigation, with either a first or later visibility pause and a successful or failed capture reply.
- **When** The viewer is hidden and resumed before or after that reply, then the replacement image arrives and the navigation finishes.
- **Then** The existing preview is retained, input stays disabled until the replacement image arrives, and input then works without reconnecting, reporting an unavailable view, attaching another target, or stopping the screencast. A later pause cancels the obsolete capture failure.

## browser-viewer-interaction-096

Original test `Pausing automatic image recovery during preparation leaves its replacement owner usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3050).

- **Given** Automatic image recovery is paused while preparation is in progress.
- **When** The viewer is hidden and resumed, then the replacement image and the interrupted preparation complete.
- **Then** Input remains disabled until the replacement image arrives, then becomes usable; the address remains https://example.com and no unavailable-view message appears.

## browser-viewer-interaction-097

Original test `Pausing automatic image recovery during first image leaves its replacement owner usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3050).

- **Given** Automatic image recovery is paused while its first replacement image is pending.
- **When** The viewer is hidden and resumed, then the replacement image and the interrupted image complete.
- **Then** Input remains disabled until the replacement image arrives, then becomes usable; the address remains https://example.com and no unavailable-view message appears.

## browser-viewer-interaction-098

Original test `A visibility pause preserves local address editing without queuing an early submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3109).

- **Given** The user has entered the local address draft local-draft.example/path.
- **When** The viewer is hidden and resumed while its replacement image is pending, and the user submits the address before that image arrives.
- **Then** The address remains editable with the draft preserved, and the early submission shows “The browser is not ready. Try again shortly.” It does not navigate early; after the image arrives, submitting navigates to http://local-draft.example/path.

## browser-viewer-interaction-099

Original test `A visibility pause during membership revalidation retains the initialized preview until fresh proof and image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3147).

- **Given** The viewer has an initialized preview, and membership proof for a newly created tab is pending.
- **When** The viewer is hidden and resumed, then fresh membership proof and a replacement image arrive.
- **Then** The initialized preview remains visible without a connecting message, and input stays disabled until both fresh proof and the image are available; it then becomes enabled.

## browser-viewer-interaction-100

Original test `A document navigated while hidden is observed before the retained viewer accepts new input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3180).

- **Given** A multi-tab viewer is hidden while a document in the background tab navigates to https://background.example/changed.
- **When** The viewer resumes, receives the replacement image, and the user submits after-background-navigation.example/ready.
- **Then** The address first reflects https://background.example/changed, and input stays disabled until the image arrives. The subsequent submission navigates to http://after-background-navigation.example/ready.

## browser-viewer-interaction-101

Original test `A resumed viewer can pause again while its replacement picture is still pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3228).

- **Given** A multi-tab viewer is resumed and its replacement picture is still pending.
- **When** The viewer is hidden and resumed a second time while a new screencast capture is pending.
- **Then** The live preview remains visible without a connecting message, and input remains disabled until the pending capture and picture finish; it then becomes enabled.

## browser-viewer-interaction-102

Original test `A retained viewer waits for its original key release before accepting resumed input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3266).

- **Given** The user has pressed Shift in the remote browser, and release of that key is pending when the viewer is hidden.
- **When** The viewer resumes and its replacement image arrives before the original key release completes, then the user enters text after the release completes.
- **Then** Input stays disabled until both the original key release and replacement image finish, then accepts text. The remote browser receives the original Shift key-down followed by its key-up.

## browser-viewer-interaction-103

Original test `An initially hidden viewer establishes usable content after becoming visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3322).

- **Given** The browser viewer is initially hidden and its remote input is disabled.
- **When** The viewer becomes visible.
- **Then** The input becomes enabled, and the address shows https://example.com.

## browser-viewer-interaction-104

Original test `Hiding during native page initialization restores only the current selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3337).

- **Given** The viewer is visible while a browser page is still initializing.
- **When** The viewer is hidden and then shown again before initialization finishes.
- **Then** The input becomes enabled after initialization, and the address shows the current page, https://example.com.

## browser-viewer-interaction-105

Original test `A visibility pause discards an unfinished composition before fresh text is accepted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3359).

- **Given** The viewer is active and the user has an unfinished composition containing 旧.
- **When** The viewer is hidden and shown again, the pending composition completes, and the user enters fresh text.
- **Then** The input is disabled while the viewer is paused, then becomes enabled; the live browser view remains visible, and only “fresh text” is sent, not the abandoned composition.

## browser-viewer-interaction-106

Original test `An old image cleanup cannot replace a newly selected tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3411).

- **Given** An image cleanup is pending on the Example tab.
- **When** The user selects Other before the cleanup finishes.
- **Then** The delayed cleanup does not replace the new selection; Other remains selected with its URL in the address field.

## browser-viewer-interaction-107

Original test `Blur cancels a queued copy without reporting a failure and permits fresh input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3435).

- **Given** The user has queued text input and starts copying it.
- **When** They blur the remote-browser input while the copy is queued, then enter fresh text.
- **Then** The copy is cancelled with an AbortError and no failure is reported. Fresh text is sent to the Example tab, and the input remains enabled.

## browser-viewer-interaction-108

Original test `Blur cancels a reading copy without reporting a failure and permits fresh input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3435).

- **Given** The user has started copying text while the copy is reading from the page.
- **When** They blur the remote-browser input before reading finishes, then enter fresh text.
- **Then** The copy is cancelled with an AbortError and no failure is reported. Fresh text is sent to the Example tab, and the input remains enabled.

## browser-viewer-interaction-109

Original test `A late modifier cleanup stays on its original tab while the successor keeps editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3507).

- **Given** The user holds Shift on Example and switches to Other while the original modifier cleanup is pending.
- **When** They press and release Shift on Other before the old cleanup completes.
- **Then** The old cleanup remains associated with Example, while Other receives its own Shift key-down and key-up and remains selected.

## browser-viewer-interaction-110

Original test `A failed original input receipt keeps its attribution and fence (later failure: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3561).

- **Given** The user holds Shift on Example, and the original text-input receipt fails.
- **When** They switch to Other, edit text there, then return to Example.
- **Then** Other accepts the fresh text. Example is unavailable and its input is disabled; the reported error retains the original Input.insertText failure attribution and excludes private input details.

## browser-viewer-interaction-111

Original test `A failed original input receipt keeps its attribution and fence (later failure: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3561).

- **Given** The user holds Shift on Example, and the original text-input receipt fails.
- **When** A later modifier-cleanup failure also occurs, and they switch to Other, edit text there, then return to Example.
- **Then** Other accepts the fresh text. Example is unavailable and its input is disabled; the reported error still attributes the failure to the original Input.insertText receipt and excludes private input details.

## browser-viewer-interaction-112

Original test `A failed original cleanup receipt keeps its attribution and fence (later failure: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3561).

- **Given** The user holds Shift on Example, and the original modifier-cleanup receipt fails.
- **When** They switch to Other, edit text there, then return to Example.
- **Then** Other accepts the fresh text. Example is unavailable and its input is disabled; the reported error retains the original Input.dispatchKeyEvent failure attribution and excludes private input details.

## browser-viewer-interaction-113

Original test `Unsupported-only IME preserves committed text and permits returning to its tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3717).

- **Given** The user enters text through an unsupported-only IME composition on Example.
- **When** They leave the tab and return to it.
- **Then** The committed text is preserved, and the Example tab is selected with its input enabled.

## browser-viewer-interaction-114

Original test `Mixed IME support retains the safe unsupported receipt and same-tab fence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3725).

- **Given** The user enters a composition with mixed IME support on Example.
- **When** They leave the tab and return to it.
- **Then** Example is unavailable and its input is disabled; the reported error identifies the original Input.imeSetComposition failure with CDP code -32601.

## browser-viewer-interaction-115

Original test `A selected CDP session detaching while its tab is closed automatically revalidates and resumes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3744).

- **Given** Example is selected and its CDP session detaches while membership admission is pending; the tab is closed.
- **When** Membership admission completes.
- **Then** The surviving Other tab is selected and its input is enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-116

Original test `A selected CDP session detaching while its tab is still open automatically revalidates and resumes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3744).

- **Given** Example is selected and its CDP session detaches while membership admission is pending; the tab remains open.
- **When** Membership admission completes.
- **Then** Example remains selected and its input is enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-117

Original test `A session detached before page initialization finishes recovers while its tab is closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3788).

- **Given** Other is selected and page initialization is pending when its session detaches; the tab is closed.
- **When** The session detaches before initialization completes, then initialization finishes.
- **Then** Example is selected and its input is enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-118

Original test `A session detached before page initialization finishes recovers while its tab is moved away`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3788).

- **Given** Other is selected and page initialization is pending when its session detaches; the tab is moved to another window.
- **When** The session detaches before initialization completes, then initialization finishes.
- **Then** Example is selected and its input is enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-119

Original test `A session detached before page initialization finishes recovers while its tab is still open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3788).

- **Given** Other is selected and page initialization is pending when its session detaches; the tab remains open.
- **When** The session detaches before initialization completes, then initialization finishes.
- **Then** Other remains selected and its input is enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-120

Original test `A received session detaching during membership admission releases its original wait`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3824).

- **Given** Other's session has been attached, and membership admission is pending.
- **When** That session detaches before admission finishes.
- **Then** The original wait is released, the input becomes enabled, and Other remains selected. The user can enter a URL and navigate to it.

## browser-viewer-interaction-121

Original test `A retired initializing session cannot revoke the newer selected tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3854).

- **Given** Example is selected, and its replacement session is initializing after Example is retired.
- **When** The user selects Last, then the retired session detaches and initialization completes.
- **Then** Last remains selected with input enabled. The user can enter a URL and navigate to it.

## browser-viewer-interaction-122

Original test `A split connection recovers if the control session detaches while its image attachment is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3895).

- **Given** The viewer uses a separate image connection, and the control session detaches while Other's image attachment is pending.
- **When** The image attachment completes.
- **Then** The input becomes enabled, and the user can enter a URL and navigate to it.

## browser-viewer-interaction-123

Original test `An ordinary initialization failure in Page.enable during opening follows recovery policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3928).

- **Given** Opening the viewer encounters an ordinary failure in Page.enable.
- **When** The viewer initializes.
- **Then** The browser view is unavailable and the remote-browser input is disabled.

## browser-viewer-interaction-124

Original test `An ordinary initialization failure in Page.getFrameTree during opening follows recovery policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3928).

- **Given** Opening the viewer encounters an ordinary failure in Page.getFrameTree.
- **When** The viewer initializes and the recovery timer advances by 1000 ms.
- **Then** The viewer first shows Reconnecting… with input disabled, then the input becomes enabled.

## browser-viewer-interaction-125

Original test `A split viewer recovers its selected image after frames loss during page admission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L3951).

- **Given** The viewer uses a separate image connection, and page admission is pending for Other when the frames connection is lost.
- **When** Automatic recovery reconnects and Other's image frames become available before the old admission completes.
- **Then** Other remains selected; the input is disabled during recovery and becomes enabled after image frames are available. Text entered afterward is sent to the recovered page session.

## browser-viewer-interaction-126

Original test `An initialization failure in Page.enable after opening selection handoff follows recovery policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4002).

- **Given** Opening selection hands off to a successor session, whose Page.enable initialization fails.
- **When** The failure occurs and recovery is attempted.
- **Then** The browser view is unavailable and the input remains disabled.

## browser-viewer-interaction-127

Original test `An initialization failure in Page.getFrameTree after opening selection handoff follows recovery policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4002).

- **Given** Opening selection hands off to a successor session, whose Page.getFrameTree initialization fails.
- **When** The failure occurs and the recovery retry is admitted after 1000 ms.
- **Then** The viewer shows Reconnecting… with input disabled until the retry completes, then the input becomes enabled.

## browser-viewer-interaction-128

Original test `A late detach from a previous visit cannot retire the current same-target session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4044).

- **Given** The user visits Example, switches to Other, then returns to Example and receives a new session for it.
- **When** A delayed detach event arrives for Example's previous session.
- **Then** The current Example session remains active, and text entered by the user is sent through it.

## browser-viewer-interaction-129

Original test `A target disappearing during membership (closed) recovers before its delayed lifecycle event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4080).

- **Given** Other disappears while membership admission is pending because its target is closed.
- **When** Admission completes before the delayed target-destroyed event arrives.
- **Then** Example is selected and enabled before that event, remains enabled afterward, and accepts navigation to a new URL.

## browser-viewer-interaction-130

Original test `A target disappearing during page initialization (closed) recovers before its delayed lifecycle event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4080).

- **Given** Other disappears during page initialization because its target is closed.
- **When** Initialization completes before the delayed target-destroyed event arrives.
- **Then** Example is selected and enabled before that event, remains enabled afterward, and accepts navigation to a new URL.

## browser-viewer-interaction-131

Original test `A target disappearing during membership (moved) recovers before its delayed lifecycle event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4080).

- **Given** Other moves to another window while membership admission is pending.
- **When** Admission completes before the delayed tab-detached and tab-attached events arrive.
- **Then** Example is selected and enabled before those events, remains enabled afterward, and accepts navigation to a new URL.

## browser-viewer-interaction-132

Original test `A target disappearing during page initialization (moved) recovers before its delayed lifecycle event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4080).

- **Given** Other moves to another window during page initialization.
- **When** Initialization completes before the delayed tab-detached and tab-attached events arrive.
- **Then** Example is selected and enabled before those events, remains enabled afterward, and accepts navigation to a new URL.

## browser-viewer-interaction-133

Original test `Cancelling a lost selection releases tab controls while its old native proof is unacknowledged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4134).

- **Given** The user selects Other while membership admission is pending, then its target closes while a native proof for the old selection is still unacknowledged.
- **When** The selection is cancelled and the user selects Last before the old proof completes.
- **Then** Tab controls are available, Last remains selected with input enabled after the proof completes, and the user can navigate to a new URL.

## browser-viewer-interaction-134

Original test `A detached session releases a held capture request without waiting for its late reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4181).

- **Given** The selected page's screencast capture request is pending when its session detaches.
- **When** The session detaches before the capture reply arrives, and the user navigates to a new URL.
- **Then** The input becomes enabled without waiting for the late capture reply, and navigation succeeds.

## browser-viewer-interaction-135

Original test `A late session-detachment receipt resolves capture-only retirement uncertainty`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4204).

- **Given** Stopping the selected page's screencast is unconfirmed after a tab replacement, and a session-detachment proof is pending.
- **When** The proof arrives and recovery advances by 1000 ms.
- **Then** The viewer recovers with input enabled and the original page URL still displayed.

## browser-viewer-interaction-136

Original test `A retained selection releases held input and accepts fresh composition after a background change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4236).

- **Given** The user holds Shift on Example when a background tab-created event triggers membership checking.
- **When** The held key is released and the membership check completes, then the user enters a Japanese composition.
- **Then** The input becomes enabled; composition text "ni" is sent as IME composition and committed text "你" is sent as inserted text.

## browser-viewer-interaction-137

Original test `A retained selection waits for its original confirmed input release before readmission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4290).

- **Given** The user holds Shift on Example when a background tab-created event triggers a native proof and the original key release is pending.
- **When** The proof completes before the key release is confirmed.
- **Then** The input remains disabled until the original release completes, then becomes enabled with Example selected.

## browser-viewer-interaction-138

Original test `A retained selection waits for its original failed input release before readmission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4290).

- **Given** The user holds Shift on Example when a background tab-created event triggers a native proof and the original key release is pending; that release will fail.
- **When** The proof completes before the failed key release is received.
- **Then** Example becomes unavailable after the failure. Selecting Other enables input on Other, whose URL is displayed.

## browser-viewer-interaction-139

Original test `An old retained input release failure cannot revoke the newly selected tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4336).

- **Given** The user holds Shift on Example when a background tab-created event triggers a pending key release and native proof; the release is set to fail.
- **When** The user selects Other and the old release then fails.
- **Then** Other remains selected with its URL displayed and input enabled.

## browser-viewer-interaction-140

Original test `A late capture-detachment proof leaves the newer selection live and allows revisiting the retired tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4392).

- **Given** A capture-detachment proof is pending after retirement of Example, and the user has selected Other.
- **When** The late proof arrives, then the user revisits Example.
- **Then** Other remains live with input enabled after the proof, and Example can be selected again with its URL displayed.

## browser-viewer-interaction-141

Original test `Original cleanup remains independent for capture-end-input (input confirmed=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will succeed.
- **When** The user switches to the other tab, then capture stops before input release completes and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab leaves input enabled, and the address can be changed to http://cleanup-proof.example/ready.

## browser-viewer-interaction-142

Original test `Original cleanup remains independent for capture-end-input (input confirmed=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will fail.
- **When** The user switches to the other tab, then capture stops before input release completes and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab shows the browser view as unavailable and leaves input disabled.

## browser-viewer-interaction-143

Original test `Original cleanup remains independent for capture-input-end (input confirmed=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will succeed.
- **When** The user switches to the other tab, then capture stops, input release completes, and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab leaves input enabled, and the address can be changed to http://cleanup-proof.example/ready.

## browser-viewer-interaction-144

Original test `Original cleanup remains independent for capture-input-end (input confirmed=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will fail.
- **When** The user switches to the other tab, then capture stops, input release completes, and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab shows the browser view as unavailable and leaves input disabled.

## browser-viewer-interaction-145

Original test `Original cleanup remains independent for input-capture-end (input confirmed=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will succeed.
- **When** The user switches to the other tab, then input release completes before capture stops and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab leaves input enabled, and the address can be changed to http://cleanup-proof.example/ready.

## browser-viewer-interaction-146

Original test `Original cleanup remains independent for input-capture-end (input confirmed=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4420).

- **Given** The user has held Shift on the original tab, and input release and capture stop are pending; the input release will fail.
- **When** The user switches to the other tab, then input release completes before capture stops and detachment is confirmed.
- **Then** The other tab remains usable. Returning to the original tab shows the browser view as unavailable and leaves input disabled.

## browser-viewer-interaction-147

Original test `A capture-detachment proof cannot clear unconfirmed input cleanup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4518).

- **Given** The user has held Shift on the original tab, and its input release is unconfirmed.
- **When** A capture-detachment proof arrives after the user switches to the other tab, then the user returns to the original tab.
- **Then** Input remains enabled on the other tab, but the original tab shows the browser view as unavailable and input remains disabled.

## browser-viewer-interaction-148

Original test `Selected target destruction before its failed membership response automatically recovers a scoped survivor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4547).

- **Given** The selected scoped tab's membership lookup is pending, and another scoped tab and a foreign tab exist.
- **When** The selected target is destroyed before the membership lookup fails.
- **Then** The surviving scoped tab is automatically selected and usable; the destroyed and foreign tabs are excluded. Navigating updates only the survivor to http://survivor.example/ready.

## browser-viewer-interaction-149

Original test `Selected target destruction after its failed membership response automatically recovers a scoped survivor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4547).

- **Given** The selected scoped tab's membership lookup is pending, and another scoped tab and a foreign tab exist.
- **When** The membership lookup fails, then the selected target is destroyed.
- **Then** The surviving scoped tab is automatically selected and usable; the destroyed and foreign tabs are excluded. Navigating updates only the survivor to http://survivor.example/ready.

## browser-viewer-interaction-150

Original test `A background window lookup failure leaves a valid scoped tab usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4602).

- **Given** A valid scoped tab is available, but looking up a background tab's window fails.
- **When** The browser viewer loads.
- **Then** Only the valid scoped tab is shown, input is enabled, and its address is https://example.com.

## browser-viewer-interaction-151

Original test `Losing the last scoped target keeps foreign tabs excluded and permits a native new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4616).

- **Given** The browser has one scoped tab and one foreign tab, and membership lookup for the scoped tab is pending.
- **When** The scoped tab is lost and its membership lookup fails, then the user opens a new tab.
- **Then** No tabs are initially shown; the foreign tab remains excluded. The new tab is selected with an empty address, input is enabled, and the browser target uses https://other.example.com.

## browser-viewer-interaction-152

Original test `A selected membership failure with present target revokes input until fresh proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4638).

- **Given** The selected scoped tab's membership lookup is pending, and its target remains present.
- **When** Membership lookup fails.
- **Then** Input and the new-tab button are disabled while reconnecting. After recovery, the new-tab button is enabled, input is enabled, and there is one connection.

## browser-viewer-interaction-153

Original test `A selected membership failure with failed inventory revokes input until fresh proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4638).

- **Given** The selected scoped tab's membership lookup is pending; the target is removed and the subsequent inventory lookup will fail.
- **When** Membership lookup fails.
- **Then** Input and the new-tab button are disabled while reconnecting. After recovery, no tabs are open, the new-tab button is enabled, input remains disabled, and there is one connection.

## browser-viewer-interaction-154

Original test `A selected membership failure with unsupported membership revokes input until fresh proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4638).

- **Given** The selected scoped tab's membership lookup is pending, and membership lookup is unsupported.
- **When** Membership lookup fails, then the user chooses Reconnect.
- **Then** The browser view is unavailable and input and the new-tab button are disabled until reconnect. Afterward the new-tab button is enabled, input is enabled, and there are two connections.

## browser-viewer-interaction-155

Original test `A late successful target-loss confirmation (destroyed=true) cannot revoke a newer selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4693).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation succeeds; the original target may or may not have been destroyed before the selection.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab is absent after its destruction is reported.

## browser-viewer-interaction-156

Original test `A late failed target-loss confirmation (destroyed=true) cannot revoke a newer selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4693).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation fails; the original target may or may not have been destroyed before the selection.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab is absent after its destruction is reported.

## browser-viewer-interaction-157

Original test `A late successful target-loss confirmation (destroyed=false) cannot revoke a newer selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4693).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation succeeds; the original target is destroyed only afterward.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab disappears when its later destruction is reported.

## browser-viewer-interaction-158

Original test `A late failed target-loss confirmation (destroyed=false) cannot revoke a newer selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4693).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation fails; the original target is destroyed only afterward.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab disappears when its later destruction is reported.

## browser-viewer-interaction-159

Original test `A pending target-loss confirmation cannot hide window removal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4753).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending.
- **When** The browser window is removed before the confirmation returns.
- **Then** The viewer shows Browser disconnected; input and the new-tab button remain disabled after the confirmation returns.

## browser-viewer-interaction-160

Original test `A pending target-loss confirmation cannot hide connection loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4753).

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending.
- **When** The browser connection is lost before the confirmation returns.
- **Then** The viewer shows Reconnecting; input and the new-tab button remain disabled after the confirmation returns.

## browser-viewer-interaction-161

Original test `A retired background membership failure cannot revoke the usable selected page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4785).

- **Given** The selected scoped tab is usable while a background tab's membership lookup is pending.
- **When** The background target is destroyed and its membership lookup fails.
- **Then** The background tab disappears, while the selected tab remains selected and usable. Text input reaches the selected page, its address remains https://example.com, and no alert appears.

## browser-viewer-interaction-162

Original test `A held initial inventory cannot resurrect a target destroyed before its reply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4828).

- **Given** The initial target inventory is pending, and a target is destroyed before the inventory reply arrives.
- **When** The inventory reply is released.
- **Then** The destroyed target does not reappear; the surviving tab is shown and selected with input enabled and address https://other.example.com.

## browser-viewer-interaction-163

Original test `The overflow menu shares favicons and keeps narrow tabs selectable and closable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4851).

- **Given** Two tabs are present, with the Example tab selected and its favicon available; the tabs are narrow enough to use the overflow menu.
- **When** The user opens All tabs, encounters a failed favicon load, selects Other, then closes Other.
- **Then** The failed favicon is replaced by a fallback icon in both the tab and menu. Other can be selected from the menu, and closing it returns selection and the address to Example.

## browser-viewer-interaction-164

Original test `Widening restores a removed focused picker only to the committed selected tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4906).

- **Given** Two tabs are present; the All tabs picker has focus while the tab bar is narrow.
- **When** The tab bar widens, narrows again while the address field contains a draft, then widens once more.
- **Then** Focus returns to the committed selected Example tab when the picker disappears. On the later widening, the address field retains focus and the draft chosen.example/draft remains intact.

## browser-viewer-interaction-165

Original test `Capture controls apply the selected format to the remote browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4951).

- **Given** The browser viewer is open with image format settings available.
- **When** The user selects PNG as the image format.
- **Then** The remote browser capture uses PNG. Lossless is disabled, and remote input remains enabled.

## browser-viewer-interaction-166

Original test `Following the panel applies its display size and leaves remote input usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx#L4975).

- **Given** The browser viewer is open and the panel display area measures 900 by 600 pixels.
- **When** The panel is followed by the remote browser.
- **Then** The remote browser viewport becomes 900 by 600 pixels; input remains enabled and the address stays https://example.com.
