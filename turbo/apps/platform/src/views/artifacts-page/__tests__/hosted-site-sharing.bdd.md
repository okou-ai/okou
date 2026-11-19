# Hosted site sharing

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [hosted-site-sharing.test.tsx](hosted-site-sharing.test.tsx).

## hosted-site-sharing-001

Original test `opening a site preloads its share URL and shows a skeleton until the current address is ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L113).

- **Given** A hosted site has a saved address that differs from its currently returned address.
- **When** The user opens Share before the current address request finishes, then copies the link after it finishes.
- **Then** Share shows a loading skeleton and disables copying until ready. Copy link writes the current address, not the stale saved address.

## hosted-site-sharing-002

Original test `published sites customize their address in Share and manually copy the saved URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L147).

- **Given** A published site is on a plan that allows address customization.
- **When** The user opens Share, edits the address to “launch-report,” validates, and saves it.
- **Then** The old-link warning appears and saving updates the site preview and saved address. The edit does not copy automatically; Copy link then copies the updated address.

## hosted-site-sharing-003

Original test `on the free plan, Customize URL and hiding the banner open the plans instead of changing the site`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L207).

- **Given** The user is on the free plan and Share offers Customize URL.
- **When** The user selects Customize URL.
- **Then** The plan chooser opens and no site URL update is made.

## hosted-site-sharing-004

Original test `on the free plan, turning off the banner opens the plans and keeps it shown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L241).

- **Given** The user is on the free plan and the site banner is shown.
- **When** The user turns off the banner in Share.
- **Then** The plan chooser opens and no banner update is made; the banner remains shown.

## hosted-site-sharing-005

Original test `on the free plan, Download opens the plans without fetching the site`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L267).

- **Given** The user is on the free plan and opens the site's download options.
- **When** The user selects Download.
- **Then** The plan chooser opens without fetching the site's files.

## hosted-site-sharing-006

Original test `invalid and occupied addresses cannot be saved and cancel discards the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L297).

- **Given** The user is editing a site's address.
- **When** The user enters an invalid reserved address, then an occupied address, and cancels the edit.
- **Then** Both addresses are marked invalid and cannot be saved. Cancel discards the draft, and Copy link still writes the original address.

## hosted-site-sharing-007

Original test `a save conflict keeps the draft and current shared address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L328).

- **Given** The user has entered an address reported as available.
- **When** Saving returns an address conflict, then the user cancels and copies the link.
- **Then** The save error is shown and the draft remains in the editor. After cancel, Copy link writes the unchanged current address.

## hosted-site-sharing-008

Original test `an unavailable address check disables saving until a new address is validated`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L359).

- **Given** The user is editing an address and the availability check fails.
- **When** The user changes the draft to a new address and its check succeeds.
- **Then** The failure is reported and Save remains disabled for the unvalidated draft. Once the revised address is confirmed available, Save becomes enabled.

## hosted-site-sharing-009

Original test `a failed save retains the draft and the current address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L392).

- **Given** The user is editing an available address.
- **When** Saving the address fails with a server error.
- **Then** The error is shown, the draft remains in the editor with Save enabled, and the preview continues using the current address.

## hosted-site-sharing-010

Original test `with share rows on, Customize URL is a row that shows the current address and opens the editor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L425).

- **Given** Share rows are enabled and the site has a saved address.
- **When** The user opens Share, copies the link, and selects Customize URL.
- **Then** The Customize URL row displays the current address; Copy link writes it, and selecting the row opens the address editor.

## hosted-site-sharing-011

Original test `A settings failure disables copying an unknown address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L452).

- **Given** The site's settings request fails, leaving its address unknown.
- **When** The user opens Share.
- **Then** The settings failure is shown, Copy link is disabled, and Customize URL is unavailable.

## hosted-site-sharing-012

Original test `restricted Site previews share the stable address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L468).

- **Given** A site is restricted and its preview uses a temporary preview address.
- **When** The user opens Share and copies the link.
- **Then** Share identifies access as Only me and copying writes the stable site address; the preview remains on its temporary address.

## hosted-site-sharing-013

Original test `Public Site previews render the anonymous URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L499).

- **Given** A site is public and has a stable site address.
- **When** The user opens its preview.
- **Then** The preview renders at the stable anonymous site address.

## hosted-site-sharing-014

Original test `Unavailable banner settings stay unknown when copying the site link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L516).

- **Given** Banner settings fail to load for a public site.
- **When** The user opens Share and copies the site link.
- **Then** Banner settings remain unavailable, no banner switch is shown, and copying writes the site address. The recorded banner preference is unknown.

## hosted-site-sharing-015

Original test `the grouped toolbar does not wait for banner settings (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L551).

- **Given** Banner settings are still loading and the grouped toolbar is shown in the dialog layout.
- **When** The user opens Share and copies the link before banner settings finish loading.
- **Then** Share and Close are available without a loading status; copying is not delayed and writes the site address. After settings load, the banner switch is off.

## hosted-site-sharing-016

Original test `the grouped toolbar does not wait for banner settings (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L551).

- **Given** Banner settings are still loading and the grouped toolbar is shown in the sidebar layout.
- **When** The user opens Share and copies the link before banner settings finish loading.
- **Then** Share and Close are available without a loading status; copying is not delayed and writes the site address. After settings load, the banner switch is off.

## hosted-site-sharing-017

Original test `Copy link snapshots a pending banner as unknown without delaying the copy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L587).

- **Given** Banner settings are pending when the user opens Share.
- **When** The user copies the link before settings resolve, then copies it again after they resolve to off.
- **Then** The first copy is immediate and records the banner preference as unknown. The second copy records the confirmed preference as off; both write the site address.

## hosted-site-sharing-018

Original test `Copy link records click intent even when the clipboard write fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L639).

- **Given** The banner is confirmed on and clipboard writes are denied.
- **When** The user selects Copy link.
- **Then** A copy failure is shown and the button remains enabled, but the click is recorded with the confirmed banner preference on.

## hosted-site-sharing-019

Original test `Copy link succeeds even when the analytics SDK throws`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L663).

- **Given** The site address is available to copy, but the analytics SDK throws when the copy is recorded.
- **When** The user selects Copy link.
- **Then** The clipboard still receives the site address and the UI reports the link copied.

## hosted-site-sharing-020

Original test `Copy link records the confirmed banner preference (sidebar: false, rows: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L696).

- **Given** The banner is confirmed on in the dialog layout with share rows off.
- **When** The user copies the link, turns the banner off and copies again, then turns it on and copies once more.
- **Then** Each copy writes the same site address and records the confirmed banner preference in order: on, off, on.

## hosted-site-sharing-021

Original test `Copy link records the confirmed banner preference (sidebar: true, rows: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L696).

- **Given** The banner is confirmed on in the sidebar layout with share rows off.
- **When** The user copies the link, turns the banner off and copies again, then turns it on and copies once more.
- **Then** Each copy writes the same site address and records the confirmed banner preference in order: on, off, on.

## hosted-site-sharing-022

Original test `Copy link records the confirmed banner preference (sidebar: false, rows: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L696).

- **Given** The banner is confirmed on in the dialog layout with share rows on.
- **When** The user copies the link, turns the banner off and copies again, then turns it on and copies once more.
- **Then** Each copy writes the same site address and records the confirmed banner preference in order: on, off, on.

## hosted-site-sharing-023

Original test `Copy link records the confirmed banner preference (sidebar: true, rows: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L696).

- **Given** The banner is confirmed on in the sidebar layout with share rows on.
- **When** The user copies the link, turns the banner off and copies again, then turns it on and copies once more.
- **Then** Each copy writes the same site address and records the confirmed banner preference in order: on, off, on.

## hosted-site-sharing-024

Original test `a stale banner edit preserves the confirmed preference when copying`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L792).

- **Given** The banner is confirmed on, but the user's attempt to turn it off conflicts with a newer server change.
- **When** The user copies the link after the conflict.
- **Then** The confirmed banner preference remains on, and the copy records it as on while writing the site address.

## hosted-site-sharing-025

Original test `owners change website visibility in the preview (sidebar: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L875).

- **Given** The site is private and its preview uses a temporary address in the dialog layout.
- **When** The owner changes visibility through Anyone at Default Org, Anyone with the link, and Only me, then copies the link.
- **Then** The preview uses the stable site address only for Anyone with the link and the temporary address for the other audiences. Copy remains available and writes the stable address.

## hosted-site-sharing-026

Original test `owners change website visibility in the preview (sidebar: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L875).

- **Given** The site is private and its preview uses a temporary address in the sidebar layout.
- **When** The owner changes visibility through Anyone at Default Org, Anyone with the link, and Only me, then copies the link.
- **Then** The preview uses the stable site address only for Anyone with the link and the temporary address for the other audiences. Copy remains available and writes the stable address.

## hosted-site-sharing-027

Original test `grouped Share stays available during a permission preview refresh (sidebar: false, failure: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L961).

- **Given** The grouped Share control is open for a private site in the dialog layout, and a visibility change is refreshing the preview successfully.
- **When** The owner changes access to Anyone with the link while the refresh is pending, then copies the link after it finishes.
- **Then** Share stays visible and open, and Copy link stays enabled during the refresh. The preview then uses the stable address, and copying writes it.

## hosted-site-sharing-028

Original test `grouped Share stays available during a permission preview refresh (sidebar: true, failure: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L961).

- **Given** The grouped Share control is open for a private site in the sidebar layout, and a visibility change is refreshing the preview successfully.
- **When** The owner changes access to Anyone with the link while the refresh is pending, then copies the link after it finishes.
- **Then** Share stays visible and open, and Copy link stays enabled during the refresh. The preview then uses the stable address, and copying writes it.

## hosted-site-sharing-029

Original test `grouped Share stays available during a permission preview refresh (sidebar: false, failure: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L961).

- **Given** The grouped Share control is open for a private site in the dialog layout, and a visibility change's preview refresh will fail.
- **When** The owner changes access to Anyone with the link while the refresh is pending, then copies the link after the failure.
- **Then** Share stays visible and open, and Copy link stays enabled during the refresh. The preview reports temporary unavailability, and copying still writes the stable address.

## hosted-site-sharing-030

Original test `grouped Share stays available during a permission preview refresh (sidebar: true, failure: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L961).

- **Given** The grouped Share control is open for a private site in the sidebar layout, and a visibility change's preview refresh will fail.
- **When** The owner changes access to Anyone with the link while the refresh is pending, then copies the link after the failure.
- **Then** Share stays visible and open, and Copy link stays enabled during the refresh. The preview reports temporary unavailability, and copying still writes the stable address.

## hosted-site-sharing-031

Original test `the grouped toolbar waits for website permissions before revealing Share (sidebar: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1045).

- **Given** Website permissions are still loading in the dialog layout with the grouped toolbar enabled.
- **When** The user opens the site before the permission request finishes.
- **Then** Share is not revealed while permissions are pending. Once they load as Only me, Share becomes available and reports that audience.

## hosted-site-sharing-032

Original test `the grouped toolbar waits for website permissions before revealing Share (sidebar: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1045).

- **Given** Website permissions are still loading in the sidebar layout with the grouped toolbar enabled.
- **When** The user opens the site before the permission request finishes.
- **Then** Share is not revealed while permissions are pending. Once they load as Only me, Share becomes available and reports that audience.

## hosted-site-sharing-033

Original test `permissions preload without claiming public access while their read is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1071).

- **Given** The site's visibility is private, but its permissions request is pending.
- **When** The user opens Share before the request resolves.
- **Then** Share shows loading permissions, with no audience choices and no claim of Anyone with the link. After loading, it reports Only me.

## hosted-site-sharing-034

Original test `Unavailable visibility settings keep permission choices disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1093).

- **Given** The request to load site visibility settings is forbidden.
- **When** The user opens Share.
- **Then** An inability-to-load message appears; all audience choices are unchecked and disabled, while Copy link remains enabled.

## hosted-site-sharing-035

Original test `a conflicting permission change preserves the last confirmed audience`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1113).

- **Given** The site is confirmed public, but its server-side visibility changes to organization access before the user acts.
- **When** The user selects Only me and the update conflicts with that newer change.
- **Then** The conflict is shown and the last confirmed audience, Anyone with the link, remains selected.

## hosted-site-sharing-036

Original test `a failed visibility save preserves the last confirmed audience`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1151).

- **Given** A hosted website is confirmed as private, and saving visibility changes fails with a server error.
- **When** The user selects “Anyone with the link.”
- **Then** The save error is shown, and the confirmed audience remains “Only me.”

## hosted-site-sharing-037

Original test `Share directly copies non-owners' website links without a settings popover (sidebar: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1179).

- **Given** A non-owner opens a hosted website in the dialog, and its URL and visibility cannot be found.
- **When** The user selects Share.
- **Then** The website URL is copied and “Link copied” appears; no share settings dialog opens.

## hosted-site-sharing-038

Original test `Share directly copies non-owners' website links without a settings popover (sidebar: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1179).

- **Given** A non-owner opens a hosted website in the sidebar, and its URL and visibility cannot be found.
- **When** The user selects Share artifact.
- **Then** The website URL is copied and “Link copied” appears; no share settings dialog opens.

## hosted-site-sharing-039

Original test `a pending Share copies the link once ownership resolves without owner settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1205).

- **Given** A non-owner opens a hosted website while its URL request is pending.
- **When** The user selects Share, then the request resolves with the website not found.
- **Then** The website URL is copied and “Link copied” appears; no share settings dialog opens.

## hosted-site-sharing-040

Original test `rapid permission choices settle on the latest audience using the refreshed revision`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/hosted-site-sharing.test.tsx#L1229).

- **Given** A hosted website is confirmed as private and its visibility changes use revisions.
- **When** The user quickly selects “Anyone at Default Org,” then “Anyone with the link,” then “Only me” while the first save is pending.
- **Then** The final audience is “Only me,” and the Copy link button is enabled after the updates settle.
