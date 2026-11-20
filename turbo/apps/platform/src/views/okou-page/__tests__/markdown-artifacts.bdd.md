# Markdown artifacts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-artifacts.test.tsx](markdown-artifacts.test.tsx).

## markdown-artifacts-001

Original test `One image keeps distinct labels for every text link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L73).

- **Given** An assistant message contains one image URL used in paragraph, list, quote, table, and reference text links, with distinct labels.
- **When** The user opens the “Key screenshot” link.
- **Then** Each text link retains its own label and context while pointing to the image URL; the link opens an image preview of that URL.

## markdown-artifacts-002

Original test `Repeated images share load state and open an image preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L90).

- **Given** An assistant message embeds the same image URL twice with different alt text.
- **When** The first embedded image finishes loading, then the user opens its image preview.
- **Then** Loading indicators disappear for both images and both are visible; the preview shows the shared image URL.

## markdown-artifacts-003

Original test `Artifact links show content-specific icons`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L111).

- **Given** An assistant message links to artifacts with image, video, website, document, spreadsheet, presentation, audio, code, archive, and generic file extensions, plus an external PNG URL.
- **When** The message is displayed.
- **Then** Artifact links show icons matching their file content: image, video, website, document, spreadsheet, presentation, audio, code, archive, or generic file. The external reference link has no artifact icon.

## markdown-artifacts-004

Original test `Artifact link icons follow the file rather than its label or URL parameters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L159).

- **Given** An assistant message links to a PPTX file with uppercase extension and URL parameters, and to an HTML artifact with a descriptive label.
- **When** The message is displayed.
- **Then** The PPTX link keeps its original URL and shows a presentation icon; the HTML link keeps its URL and shows a website icon, regardless of its label.

## markdown-artifacts-005

Original test `HTML links keep website icons for presentations and ordinary sites`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L185).

- **Given** An assistant message links to hosted and private HTML presentations, an ordinary hosted website, and an unmarked HTML file.
- **When** The message is displayed.
- **Then** All four links retain their destinations and show website icons, including both presentation links.

## markdown-artifacts-006

Original test `Bare platform URLs stay links and fenced URLs stay code`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L230).

- **Given** An assistant message contains a bare platform artifact URL and a website URL inside a fenced text block.
- **When** The message is displayed and the user opens the bare artifact URL.
- **Then** The bare platform URL is a link and opens an image preview of that URL; the fenced website URL remains code, not a link.

## markdown-artifacts-007

Original test `A platform document has both a text link and an explicit preview card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-artifacts.test.tsx#L249).

- **Given** An assistant message links to a platform PDF in its text and also embeds the same URL as an image preview.
- **When** The user opens the text link, closes the preview, and then opens the preview card.
- **Then** The text link and preview card are both visible and open a dialog containing the PDF preview at the URL with “#navpanes=0”.
