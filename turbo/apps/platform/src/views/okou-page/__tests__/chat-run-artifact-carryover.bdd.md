# Chat run artifact carryover

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-artifact-carryover.test.tsx](chat-run-artifact-carryover.test.tsx).

## chat-run-artifact-carryover-001

Original test `Expose an artifact referenced only by history from the main result actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L127).

- **Given** A completed run has several historical outputs, including an artifact in history and a final result that references no artifact.
- **When** The user views the result actions and opens the related-artifacts list, then expands work history.
- **Then** The final result’s action bar includes a related-artifacts control labeled “1 artifact,” and the list contains the historical artifact labeled “Report.” Historical output is hidden until work history is expanded, when its PDF preview link appears.

## chat-run-artifact-carryover-002

Original test `A carried image keeps its label and opens a lightbox over the dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L206).

- **Given** A completed run’s history contains a linked image labeled “Supporting evidence,” while its final result has no artifact.
- **When** The user opens related artifacts and selects the image.
- **Then** The image keeps the label “Supporting evidence” and opens in a lightbox over the still-visible related-artifacts dialog.

## chat-run-artifact-carryover-003

Original test `Sidebar-first previews dismiss the related-artifacts dialog rather than stacking a lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L234).

- **Given** A completed run contains a carried PDF artifact and sidebar previews are enabled.
- **When** The user selects the artifact from related artifacts.
- **Then** The PDF preview opens in the artifact sidebar, the related-artifacts dialog closes, and no lightbox appears.

## chat-run-artifact-carryover-004

Original test `Open a carried generic file over an existing artifact sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L334).

- **Given** A carried ZIP file has no inline preview, and an existing artifact sidebar is showing an unavailable-artifact message.
- **When** The user opens the carried file from related artifacts and selects Download.
- **Then** A preview lightbox opens over the still-visible related-artifacts dialog and says no inline preview is available. Download initiates a browser download named “archive.zip.”

## chat-run-artifact-carryover-005

Original test `List every carried artifact without a secondary browse step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L361).

- **Given** A completed run’s history contains 12 distinct PDF artifacts and its final result contains none.
- **When** The user opens related artifacts.
- **Then** All 12 artifacts are listed without a secondary browse step, including the last entry labeled “Report 11.”

## chat-run-artifact-carryover-006

Original test `Keep completed result actions before recommended followups`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L396).

- **Given** A completed run has a historical report artifact, a final result, and a recommended follow-up prompt, “Summarize the report.”
- **When** The user views the final result and its follow-up recommendation.
- **Then** The final result’s actions, including related artifacts, appear before the “Keep going” follow-up group, which shows “Summarize the report.”

## chat-run-artifact-carryover-007

Original test `Subtract final artifacts after ordered URL deduplication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L471).

- **Given** A run has two historical outputs and a final result. The first history contains an appendix URL and a report URL; the second contains that same report URL and a source URL; the final result also contains the report URL.
- **When** The user expands work history and opens related artifacts.
- **Then** The repeated report appears once in each of the two historical outputs and once in the final result, in that order, but is excluded from the related-artifacts list. The list contains exactly the appendix followed by the source, and its control is labeled “2 artifacts.”

## chat-run-artifact-carryover-008

Original test `Keep artifacts with the same filename distinct when their URLs differ`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L533).

- **Given** A run’s two historical outputs contain different artifact URLs that share the filename “report.pdf,” while the final result contains no artifact.
- **When** The user opens related artifacts.
- **Then** The list shows both artifacts, each labeled “Report,” in their original order; the historical messages remain hidden.

## chat-run-artifact-carryover-009

Original test `Render inline media and action cards after expanding short history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L567).

- **Given** A completed run has historical output containing a Markdown heading and formatted text, an inline chart, and a plan-comparison link; its final result contains no artifacts.
- **When** The user expands work history.
- **Then** The historical heading and formatted text, inline chart, and plan-upgrade card become visible. No related-artifacts control appears.

## chat-run-artifact-carryover-010

Original test `Ignore artifacts from revoked output messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-artifact-carryover.test.tsx#L602).

- **Given** A completed run has an output containing an obsolete PDF URL, followed by a message revoking that output.
- **When** The user views the run.
- **Then** The revocation message is visible, but the obsolete PDF preview link, related-artifacts control, and work-history toggle are absent.
