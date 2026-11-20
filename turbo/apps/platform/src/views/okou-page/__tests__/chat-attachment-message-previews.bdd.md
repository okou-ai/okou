# Chat attachment message previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-attachment-message-previews.test.tsx](chat-attachment-message-previews.test.tsx).

## chat-attachment-message-previews-001

Original test `A rich artifact preview requires a complete address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L106).

- **Given** An assistant message contains an incomplete artifact address, a root-relative address, and a complete public video address.
- **When** The chat is opened.
- **Then** Only the complete address receives a visible rich preview button; the incomplete and root-relative addresses remain as message text.

## chat-attachment-message-previews-002

Original test `A short Okou artifact link opens as a rich preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L136).

- **Given** An assistant message contains a link to https://a.okou.io/a1b2c3d4e5.pdf.
- **When** The user opens the link preview.
- **Then** A document preview opens using that address with #navpanes=0 appended.

## chat-attachment-message-previews-003

Original test `An ordinary first-party Markdown image uses a thumbnail and opens its original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L155).

- **Given** An assistant message contains a Markdown image from static.okou.io.
- **When** The user views and opens the image.
- **Then** The displayed image uses a thumbnail, and the lightbox shows the original image address.

## chat-attachment-message-previews-004

Original test `An embedded video's poster uses a thumbnail while playback keeps its original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L174).

- **Given** An assistant message contains an embedded video with a public artifact video address and poster.
- **When** The chat renders the video.
- **Then** The video retains its original playback address while its poster uses a thumbnail address.

## chat-attachment-message-previews-005

Original test `Image navigation stays within the current message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L197).

- **Given** An assistant message contains three image artifacts, a text artifact, and a separate image artifact not in that message.
- **When** The user opens the first image, navigates right, then navigates back.
- **Then** The preview moves between the first and second images in the same message, has no previous action at the first image, and does not include the separate image artifact.

## chat-attachment-message-previews-006

Original test `Only exact trusted public links receive rich attachment previews`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L258).

- **Given** An assistant message contains links to the current site, a trusted artifact PDF, historical and preview-domain images, a forged lookalike domain, and an arbitrary Okou file host.
- **When** The user opens the trusted links and image previews.
- **Then** The current site and trusted PDF open in rich previews, and the historical and preview images open their original addresses in the image lightbox. The forged lookalike and arbitrary Okou links remain ordinary links without rich attachment preview buttons.

## chat-attachment-message-previews-007

Original test `Persisted video attachments open in the video sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L383).

- **Given** A user's persisted message includes a video attachment named demo.mp4.
- **When** The user opens its preview in split view and closes the artifact.
- **Then** The video preview appears in the sidebar and closing it removes the sidebar video preview.

## chat-attachment-message-previews-008

Original test `Persisted PDF attachments use the document sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L400).

- **Given** A user's persisted message includes a PDF attachment named brief.pdf.
- **When** The user opens its preview in split view and closes the artifact.
- **Then** The PDF preview appears in the document sidebar and closing it removes the sidebar PDF preview.

## chat-attachment-message-previews-009

Original test `Persisted Markdown attachments render without offering sharing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L414).

- **Given** A user's persisted message includes a Markdown attachment with rendered review notes and a resolved public URL.
- **When** The user opens the Markdown preview.
- **Then** The rendered notes appear with download options, but no sharing link is offered.

## chat-attachment-message-previews-010

Original test `Persisted HTML presentations open, expand and download (split view=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L426).

- **Given** A user's persisted message includes an HTML presentation named quarterly-deck.html, with split view initially off.
- **When** The user opens the presentation, enters and exits fullscreen, then downloads it.
- **Then** The presentation remains in the preview with its file address through both fullscreen states, and the download saves one file named quarterly-deck.html.

## chat-attachment-message-previews-011

Original test `Persisted HTML presentations open, expand and download (split view=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L426).

- **Given** A user's persisted message includes an HTML presentation named quarterly-deck.html, with split view initially on.
- **When** The user opens the presentation in split view, enters and exits fullscreen, then downloads it.
- **Then** The presentation remains in the sidebar with its file address through both fullscreen states, and the download saves one file named quarterly-deck.html.

## chat-attachment-message-previews-012

Original test `A Slack-originated message keeps its attachment and original source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L474).

- **Given** A Slack-originated user message includes a Markdown attachment and a link to the original Slack message.
- **When** The user views the message and opens the attachment preview.
- **Then** The message text and original Slack link remain available, and the attachment renders its Markdown content.

## chat-attachment-message-previews-013

Original test `A Lark image stored as a binary object uses a thumbnail and opens its original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L521).

- **Given** A Lark-originated user message includes an image/jpeg attachment stored at a signed binary-object address.
- **When** The user views and opens the image attachment.
- **Then** The displayed image uses a thumbnail, and the lightbox shows the original signed address.

## chat-attachment-message-previews-014

Original test `User attachments appear before their message text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L556).

- **Given** A user's message includes image, video, PDF, and text attachments followed by its text.
- **When** The chat displays the message.
- **Then** The image and video attachments appear first, the PDF and text attachments appear next, and all attachments precede the message text.

## chat-attachment-message-previews-015

Original test `A user's Markdown image syntax stays literal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx#L617).

- **Given** A user's message text consists of Markdown image syntax pointing to a public image.
- **When** The chat displays the message.
- **Then** The typed Markdown syntax remains visible in order and its destination is a link; no image or attachment preview is rendered.
