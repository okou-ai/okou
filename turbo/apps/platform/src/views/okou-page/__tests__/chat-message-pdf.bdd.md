# Chat message pdf

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-pdf.test.tsx](chat-message-pdf.test.tsx).

## chat-message-pdf-001

Original test `Generate first, then offer a native PDF download whose bytes survive repeated clicks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L114).

- **Given** A chat contains an assistant message, and PDF generation is available.
- **When** The user starts generation with Enter and then clicks the resulting download twice before leaving the chat.
- **Then** Generation is announced while pending, then a focused native PDF download named “Launch-plan.pdf” appears. Its URL serves the same PDF bytes on both clicks and is revoked when navigating away.

## chat-message-pdf-002

Original test `PDF downloads keep their default filename after empty model result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L173).

- **Given** A chat contains an assistant message and the filename service returns an empty result.
- **When** The user generates a PDF.
- **Then** A PDF download named “okou-message.pdf” appears with the generated PDF bytes.

## chat-message-pdf-003

Original test `PDF downloads keep their default filename after older API`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L173).

- **Given** A chat contains an assistant message and the filename service returns 404, as with an older API.
- **When** The user generates a PDF.
- **Then** A PDF download named “okou-message.pdf” appears with the generated PDF bytes.

## chat-message-pdf-004

Original test `PDF downloads keep their default filename after network failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L173).

- **Given** A chat contains an assistant message and the filename service has a network failure.
- **When** The user generates a PDF.
- **Then** A PDF download named “okou-message.pdf” appears with the generated PDF bytes.

## chat-message-pdf-005

Original test `A generation error is visible and the PDF action can be retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L194).

- **Given** A chat contains an assistant message and the first PDF generation attempt can fail.
- **When** The user starts generation, receives a generation failure, and retries.
- **Then** The failure is shown as “Could not generate PDF.” The retry succeeds and its PDF bytes are available from the download.

## chat-message-pdf-006

Original test `PDF generation resolves private image access again instead of reusing the preview grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L221).

- **Given** A chat message includes a private image whose preview has already resolved access to a storage URL.
- **When** The user generates a PDF after the image's export storage URL becomes available.
- **Then** PDF generation resolves access again and produces a downloadable PDF using the export resource, rather than reusing the preview grant.

## chat-message-pdf-007

Original test `Removing the message actions cancels PDF generation without leaving the page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L257).

- **Given** A chat message can generate a PDF, and font loading is in progress.
- **When** The user opens message selection, causing the message actions to be removed, then cancels selection and generates again.
- **Then** The in-progress request is aborted without leaving the chat, no download is left from that canceled attempt, and generation works after canceling selection.

## chat-message-pdf-008

Original test `PDF text and typography render CJK emphasis`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L340).

- **Given** An assistant message contains regular, bold, italic, and bold-italic text, CJK emphasis, and unmatched bold markers.
- **When** The user exports the message and reads the PDF text and typography.
- **Then** CJK emphasized text is preserved without Markdown markers and uses the matching bold, italic, or bold-italic typography. Unmatched markers remain literal text.

## chat-message-pdf-009

Original test `Whitespace-only emphasis still exports the surrounding text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L381).

- **Given** An assistant message contains text surrounding whitespace-only emphasis markup.
- **When** The user exports the message to PDF.
- **Then** The text before, between, and after the whitespace-only emphasis remains in the PDF.

## chat-message-pdf-010

Original test `Exported table text stays inside the page and merged columns preserve all cells`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L400).

- **Given** An assistant message contains long table content, right-edge sentinel text, and HTML tables with merged columns.
- **When** The user exports the message to PDF.
- **Then** All PDF text remains within 47 points of each page's horizontal edges. The right-edge sentinel, last-column text, merged group header, combined-column text, and final note are all preserved.

## chat-message-pdf-011

Original test `Exported typography preserves code alignment, emphasis, emoji and Markdown breaks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L432).

- **Given** An assistant message contains styled text, Chinese text, emoji, subscript and superscript, soft and hard Markdown line breaks, and a code block with narrow and wide characters.
- **When** The user exports the message to PDF.
- **Then** The PDF preserves the emoji, distinct italic and bold-italic styling, and subscript and superscript placement. Soft-break lines share a baseline while hard-break lines do not, and the three code strings have aligned widths.

## chat-message-pdf-012

Original test `A table row taller than a page retains every line in the exported PDF`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L494).

- **Given** An assistant message contains a table row with 75 lines of content and text following the table.
- **When** The user exports the message to PDF.
- **Then** The PDF spans multiple pages and retains every numbered line exactly once, along with the text after the table.

## chat-message-pdf-013

Original test `Exported short table rows keep their identifiers, descriptions and statuses on one page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L521).

- **Given** An assistant message contains 42 short table rows, each with an identifier, Chinese description, detail marker, and status.
- **When** The user exports the message to PDF.
- **Then** For each row, its detail marker and status appear on the same page as its identifier.

## chat-message-pdf-014

Original test `An exported heading stays with the following table at a page boundary`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-pdf.test.tsx#L554).

- **Given** An assistant message has enough preceding content to put a table heading near a page boundary, followed by a table.
- **When** The user exports the message to PDF.
- **Then** The important table heading and the table's first content appear together on page 2.
