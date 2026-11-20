# Chat artifact sidebar preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-artifact-sidebar-preview.test.tsx](chat-artifact-sidebar-preview.test.tsx).

## chat-artifact-sidebar-preview-001

Original test `Chat artifacts open a closed sidebar directly`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-sidebar-preview.test.tsx#L19).

- **Given** A chat contains a PDF artifact and the artifact-sidebar preview feature is enabled; the sidebar is closed.
- **When** The user opens the artifact's PDF preview, closes the sidebar, and opens the preview again.
- **Then** The artifact opens directly in the sidebar with its preview URL and navigation panes hidden. Closing it removes the sidebar, and reopening it shows the sidebar again without opening an attachment lightbox.

## chat-artifact-sidebar-preview-002

Original test `Sent user attachments open in the sidebar and retain their private sharing behavior`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-sidebar-preview.test.tsx#L81).

- **Given** A chat contains a sent user attachment named upload.txt, and the artifact-sidebar preview feature is enabled. Its private file URL returns uploaded document content and no public URL.
- **When** The user opens the attachment's text preview.
- **Then** The sidebar displays the uploaded document content. It does not offer artifact sharing and does not open an attachment lightbox.

## chat-artifact-sidebar-preview-003

Original test `The CSV sidebar preserves quoted fields and duplicate records`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-sidebar-preview.test.tsx#L194).

- **Given** A chat contains a CSV attachment with quoted commas, quoted multiline fields, escaped quotes, empty fields, and two identical data records.
- **When** The user opens the CSV preview in the sidebar.
- **Then** The preview displays both records without dropping duplicates, preserving the quoted comma, multiline text, escaped quotes, and empty fields as their corresponding cell values.

## chat-artifact-sidebar-preview-004

Original test `The CSV sidebar preserves malformed content as source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-sidebar-preview.test.tsx#L231).

- **Given** A chat contains a CSV attachment with malformed content, including an unfinished quoted field.
- **When** The user opens the CSV preview in the sidebar.
- **Then** The exact source is displayed as plain text, and no table is shown.

## chat-artifact-sidebar-preview-005

Original test `The CSV sidebar preserves oversized content as source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-sidebar-preview.test.tsx#L231).

- **Given** A chat contains a CSV attachment with oversized content: 101 column headings and 100 rows, each containing 101 values.
- **When** The user opens the CSV preview in the sidebar.
- **Then** The exact source is displayed as plain text, and no table is shown.
