# Chat navigation artifact drive

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-navigation-artifact-drive.test.tsx](chat-navigation-artifact-drive.test.tsx).

## chat-navigation-artifact-drive-001

Original test `Offer a link to the uploaded file after Upload to Google Drive`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L560).

- **Given** A connected Drive account is available for a Python file named script.py.
- **When** I upload it to Google Drive.
- **Then** The app confirms the sync and offers a “View it” link opening the returned Drive URL in a new tab. The upload uses original-file mode, and the sync is recorded as a file action.

## chat-navigation-artifact-drive-002

Original test `Offer a link to the uploaded file after Upload to Google Docs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L560).

- **Given** A connected Drive account is available for a text file named report.txt.
- **When** I upload it to Google Docs.
- **Then** The app confirms the sync and offers a “View it” link opening the returned Docs URL in a new tab. The upload uses Google conversion mode, and the sync is recorded as a document action.

## chat-navigation-artifact-drive-003

Original test `Confirm a Drive upload without a link when Drive returns no view URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L602).

- **Given** A connected Drive account is ready, but the upload response has no view URL.
- **When** I upload an artifact to Google Drive.
- **Then** The app confirms the sync and does not show a “View it” link.

## chat-navigation-artifact-drive-004

Original test `Authorize and sync an artifact during a Drive catalog and inventory outage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L623).

- **Given** Drive is connected, but the Drive catalog and account inventory requests fail.
- **When** I connect Drive for the artifact and complete authorization.
- **Then** The artifact syncs using the selected account without starting OAuth. I can still download the file after sync.

## chat-navigation-artifact-drive-005

Original test `Keep artifact download available when the response omits Drive metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L681).

- **Given** The artifact response contains no Drive metadata, and the file is downloadable.
- **When** I open the artifact’s download menu.
- **Then** The Connect Google Drive action is disabled, but downloading the file succeeds.

## chat-navigation-artifact-drive-006

Original test `Recheck Drive authorization after leaving and reopening the chat page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L707).

- **Given** A PPTX artifact is ready for Slides conversion and its preview can upload to Drive.
- **When** I sync it, leave the chat page, require a new Drive connection, then reopen the artifact and complete authorization.
- **Then** The first sync uses the existing account without OAuth. On reopening, the app requests a new account and syncs with it; the preview offers the Slides editor link.

## chat-navigation-artifact-drive-007

Original test `Connect Google Drive and sync an artifact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L783).

- **Given** No Google Drive account is connected for the chat’s agent.
- **When** I choose Connect Google Drive and complete authorization.
- **Then** The app requests a new OAuth connection authorized for the agent, then syncs the artifact using that new account. It confirms the sync.

## chat-navigation-artifact-drive-008

Original test `Recover missing Drive scope for a native upload only after explicit exact-account consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L837).

- **Given** A text file is ready for Google Docs, but its initial upload fails because Drive scope is missing.
- **When** I explicitly choose Reconnect Google Drive for the artifact’s exact account, complete authorization, and then retry the Docs upload.
- **Then** The initial failure says no file was uploaded and does not open OAuth automatically. Authorization alone does not replay the upload; the explicit retry succeeds using Google conversion mode.

## chat-navigation-artifact-drive-009

Original test `Keep one scope reconnect action beside an existing native import`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L916).

- **Given** The artifact is already imported as a Google Doc, and a subsequent original-file upload fails for missing Drive scope.
- **When** I reconnect the artifact’s exact Drive account, complete authorization, and retry the original upload.
- **Then** There is only one reconnect action, and the existing Google Docs link remains available throughout. The explicit retry succeeds without removing that link.

## chat-navigation-artifact-drive-010

Original test `Dismissed Drive scope recovery never resumes an upload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L987).

- **Given** An artifact upload fails because Drive scope is missing, and the preview offers account reconnection.
- **When** I start reconnection, close the preview before authorization completes, and then complete authorization.
- **Then** The preview is dismissed, and the upload is not resumed; no successful-sync message appears.

## chat-navigation-artifact-drive-011

Original test `Do not offer scope recovery or replay for a generic Drive 403 response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1030).

- **Given** An artifact upload receives a generic Drive 403 response rather than a missing-scope error.
- **When** I review the failed upload in the artifact menu.
- **Then** The app reports that Drive access is unavailable, leaves the upload action available, and does not offer scope recovery, start OAuth, or replay the upload.

## chat-navigation-artifact-drive-012

Original test `Sync with the artifact's ready Drive account when the default needs attention`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1059).

- **Given** The default Drive connection needs reconnection, but the artifact has a ready Drive account.
- **When** I upload the artifact to Google Drive.
- **Then** The upload succeeds using the artifact’s ready account, without OAuth or agent authorization changes.

## chat-navigation-artifact-drive-013

Original test `Keep a reopened artifact usable after cancelling the remaining Drive setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1090).

- **Given** Drive is not connected, and an artifact preview begins connecting and syncing while the sync is still pending.
- **When** I close the preview, reopen it, and cancel the remaining pending sync.
- **Then** The reopened preview remains usable and its download options can be opened. No successful-sync message appears after cancellation.

## chat-navigation-artifact-drive-014

Original test `Reuse the artifact preview for Drive OAuth (dismissed: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1154).

- **Given** A Drive artifact preview is open, and Drive is not connected.
- **When** I choose Connect Google Drive and leave the preview open until authorization completes.
- **Then** The same preview remains open and the artifact syncs. It offers the original Drive upload action and a working Download action.

## chat-navigation-artifact-drive-015

Original test `Reuse the artifact preview for Drive OAuth (dismissed: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1154).

- **Given** A Drive artifact preview is open, and Drive is not connected.
- **When** I choose Connect Google Drive, close the preview before authorization completes, and then complete authorization.
- **Then** The preview closes and the artifact is not synced.

## chat-navigation-artifact-drive-016

Original test `google editor conversion > keeps the Slides editor link when a subsequent original upload fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1237).

- **Given** A PPTX can be converted to Slides, and a later original-file upload is configured to fail.
- **When** I upload the converted Slides file, then try uploading the original to Drive.
- **Then** After the original upload fails, the Slides editor link remains available and the Slides conversion action is not offered again.

## chat-navigation-artifact-drive-017

Original test `google editor conversion > reuses a reconnected Drive account for both upload modes in the same preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1282).

- **Given** A text artifact’s Drive account requires reconnection, and its preview supports Google Docs conversion and original upload.
- **When** I reconnect once, then upload first to Google Docs and then to Google Drive from the same preview.
- **Then** Both uploads use the reconnected account, in Google-conversion then original-file order, without another OAuth request. The Google Docs link remains available.

## chat-navigation-artifact-drive-018

Original test `google editor conversion > replaces the Sheets upload action with its editor link without refreshing the preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1360).

- **Given** A CSV artifact is already synced to Drive, and Sheets conversion is available.
- **When** I upload it to Google Sheets.
- **Then** The preview remains open without a refresh, and the menu replaces the Sheets upload action with an editor link. The sync action is disabled, download remains available, and only one sync occurs.

## chat-navigation-artifact-drive-019

Original test `google editor conversion > replaces the Slides upload action with its editor link without refreshing the preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1360).

- **Given** A PPTX artifact is already synced to Drive, and Slides conversion is enabled.
- **When** I upload it to Google Slides.
- **Then** The preview remains open without a refresh, and the menu replaces the Slides upload action with an editor link. The sync action is disabled, download remains available, and only one sync occurs.

## chat-navigation-artifact-drive-020

Original test `google editor conversion > uploads a PPTX unchanged while its Slides conversion is available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1428).

- **Given** A PPTX already has a Slides editor link, and original-file upload is available.
- **When** I upload it to Google Drive without conversion.
- **Then** The upload uses original-file mode, and the existing Slides editor link remains available.

## chat-navigation-artifact-drive-021

Original test `google editor conversion > connects Drive from the document preview dialog and exposes the converted file without refreshing its snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1464).

- **Given** A text artifact’s preview is open, and Drive is not connected.
- **When** I choose Google Docs upload, complete Drive authorization, and reopen the preview’s download options.
- **Then** The same preview stays open, the converted file has a Google Docs editor link, and the upload action is no longer offered.

## chat-navigation-artifact-drive-022

Original test `google editor conversion > does not mark an unconverted response as a successful native document`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-artifact-drive.test.tsx#L1529).

- **Given** A text artifact is ready for Google Docs conversion, but the upload response returns the original file unchanged.
- **When** I upload it to Google Docs.
- **Then** The app reports that conversion could not be confirmed and advises checking Drive before retrying; it does not treat the response as a successful native document.

### Batch 42 disposition

- `chat-navigation-artifact-drive-004` remains unaccepted. During a catalog and account-list outage, the connected artifact offers direct upload using its selected account, confirms sync and downloads. There is no Connect or authorization step for this snapshot.
- `chat-navigation-artifact-drive-013` remains unaccepted. Once authorization starts a pending upload, closing its preview aborts the external request. Reopening yields a usable Download menu with no pending operation to cancel. The frozen order requires cancellation after reopening.
- `chat-navigation-artifact-drive-017` remains unaccepted. The reconnected account successfully receives Google conversion followed by original upload; the Docs link survives. A separate clause requires absence of another OAuth request. Neither link persistence nor the two uploads proves that request-level condition.
