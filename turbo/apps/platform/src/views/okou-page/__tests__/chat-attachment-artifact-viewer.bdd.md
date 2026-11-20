# Chat attachment artifact viewer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-attachment-artifact-viewer.test.tsx](chat-attachment-artifact-viewer.test.tsx).

## chat-attachment-artifact-viewer-001

Original test `A private attachment reuses one URL across reopen and split view`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L107).

- **Given** A chat contains a private text attachment whose URL can be renewed.
- **When** The user opens it, closes the preview, opens it again, then opens it in split view.
- **Then** The preview shows the same private file each time, without using the renewed URL.

## chat-attachment-artifact-viewer-002

Original test `An open artifact sidebar reuses one pane`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L182).

- **Given** A chat contains a hosted site and an audio attachment.
- **When** The user opens the site in split view, selects the site again, then selects the audio attachment.
- **Then** The site remains in one sidebar pane when reselected, and the audio replaces it in that pane without opening a lightbox.

## chat-attachment-artifact-viewer-003

Original test `A public hosted site header displays its title and links to its address`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L234).

- **Given** A chat contains a public hosted site with a title and a site address.
- **When** The user opens the site preview and then opens it in split view.
- **Then** Both surfaces show the title as a link to the site address in a new tab, and show its updated time without the filename, hosted-site label, or file size.

## chat-attachment-artifact-viewer-004

Original test `A private hosted site header keeps its filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L270).

- **Given** A chat contains a private hosted site named private-site.html.
- **When** The user opens the site preview.
- **Then** The preview shows private-site.html and a hosted-site label with its updated time; the filename is not a link.

## chat-attachment-artifact-viewer-005

Original test `Private attachment access stays scoped to the chat that owns it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L297).

- **Given** Two side-by-side chats each contain a private image named shared.png, with a different private file in each chat.
- **When** The user opens the image in the left chat, closes it, then opens the image in the right chat.
- **Then** The left preview uses the left chat's private image URL, and the right preview uses the right chat's private image URL.

## chat-attachment-artifact-viewer-006

Original test `Image navigation remains inside its split-view chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L396).

- **Given** Two side-by-side chats each contain two private images, with the first image named shared.png and different second images.
- **When** The user previews and advances the right chat's image, then previews and advances the left chat's image and opens it in split view, where they go back one image.
- **Then** The right preview advances to right-second.png, and the left preview advances to left-second.png. The sidebar shows left-second.png and then returns to the left chat's shared.png; navigation does not cross between chats.

## chat-attachment-artifact-viewer-007

Original test `A user's attachment preview withholds the sharing an agent artifact offers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L555).

- **Given** A user's message contains two private image attachments, and an assistant message contains an agent image artifact.
- **When** The user opens each private attachment preview and then opens the agent image preview and selects Share.
- **Then** The private previews offer download options but no Share control. The agent image's Share action copies its image URL.

## chat-attachment-artifact-viewer-008

Original test `A private site card uses its resolved screenshot even when the thread artifact list is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L650).

- **Given** A chat contains a private hosted site with a resolved screenshot, but its thread artifact list is unavailable.
- **When** The user views the site card, waits for its screenshot to load, and opens the card.
- **Then** The card uses the resolved screenshot as its thumbnail, does not show an inline site frame after the screenshot loads, and opens the site using its resolved preview URL.

## chat-attachment-artifact-viewer-009

Original test `a hosted website uses its existing cover with public visibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L711).

- **Given** A public hosted website has an existing cover image and resolves to its original site URL.
- **When** The user views the site card, the cover loads and then fails, and the user opens the card.
- **Then** The card first uses the existing cover without showing an inline frame. After cover failure it shows a sandboxed inline frame at the original site URL, and the lightbox opens that same URL.

## chat-attachment-artifact-viewer-010

Original test `a hosted website uses its existing cover with private visibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L711).

- **Given** A private hosted website has an existing cover image and resolves to a private preview URL.
- **When** The user views the site card, the cover loads and then fails, and the user opens the card.
- **Then** The card first uses the existing cover without showing an inline frame. After cover failure it shows a sandboxed inline frame at the private preview URL, and the lightbox opens that same URL.

## chat-attachment-artifact-viewer-011

Original test `a hosted website without a cover uses its resolved iframe with public visibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L759).

- **Given** A public hosted website has no cover image and its address includes a path, query, and fragment.
- **When** The user views the site card.
- **Then** The inline frame uses the original site address, including its path, query, and fragment.

## chat-attachment-artifact-viewer-012

Original test `a hosted website without a cover uses its resolved iframe with private visibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L759).

- **Given** A private hosted website has no cover image and its original address includes a path, query, and fragment.
- **When** The user views the site card.
- **Then** The inline frame uses the private preview URL with the original path, query, and fragment appended.

## chat-attachment-artifact-viewer-013

Original test `an inaccessible restricted.png (404) shows an access card in the lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L798).

- **Given** A chat contains a restricted artifact named restricted.png, whose resolution returns 404.
- **When** The user opens the artifact preview.
- **Then** The lightbox shows an access card explaining that the artifact may not exist or may be shared with another account or organization, advises asking the sharer to check access, and offers an enabled Switch account button.

## chat-attachment-artifact-viewer-014

Original test `an inaccessible restricted.pdf (403) shows an access card in the lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L798).

- **Given** A chat contains a restricted artifact named restricted.pdf, whose resolution returns 403.
- **When** The user opens the artifact preview.
- **Then** The lightbox shows an access card explaining that the artifact may not exist or may be shared with another account or organization, advises asking the sharer to check access, and offers an enabled Switch account button.

## chat-attachment-artifact-viewer-015

Original test `an inaccessible restricted.txt (401) shows an access card in the lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L798).

- **Given** A chat contains a restricted artifact named restricted.txt, whose resolution returns 401.
- **When** The user opens the artifact preview.
- **Then** The lightbox shows an access card explaining that the artifact may not exist or may be shared with another account or organization, advises asking the sharer to check access, and offers an enabled Switch account button.

## chat-attachment-artifact-viewer-016

Original test `an artifact service failure ends loading with a preview error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L836).

- **Given** A chat contains an artifact whose resolution service returns a server error.
- **When** The user opens the artifact preview.
- **Then** Loading ends and the preview reports “Preview unavailable.”

## chat-attachment-artifact-viewer-017

Original test `a website preview failure (404, sidebar=false) shows its error inline without a toast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L861).

- **Given** A chat contains a website whose preview service returns 404.
- **When** The user opens the website preview without opening it in the sidebar.
- **Then** The lightbox shows the website-unavailable access heading inline, with no toast or inline frame.

## chat-attachment-artifact-viewer-018

Original test `a website preview failure (500, sidebar=false) shows its error inline without a toast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L861).

- **Given** A chat contains a website whose preview service returns 500.
- **When** The user opens the website preview without opening it in the sidebar.
- **Then** The lightbox shows the temporary-unavailability heading inline, with no toast or inline frame.

## chat-attachment-artifact-viewer-019

Original test `a website preview failure (404, sidebar=true) shows its error inline without a toast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L861).

- **Given** A chat contains a website whose preview service returns 404.
- **When** The user opens the website preview and then opens it in the sidebar.
- **Then** The sidebar shows the website-unavailable access heading inline, with no toast or inline frame.

## chat-attachment-artifact-viewer-020

Original test `A private video in a user message uses its absolute resolved poster without a thread artifact list and opens the original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L906).

- **Given** A user's message contains a private video with a resolved poster, using an absolute poster reference and no thread artifact list.
- **When** The user views the video card, lets the poster load, and opens the card.
- **Then** The card displays the resolved poster rather than a fallback, and the video opens using its original resolved URL.

## chat-attachment-artifact-viewer-021

Original test `A private video in a assistant message uses its relative resolved poster without a thread artifact list and opens the original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L906).

- **Given** An assistant message contains a private video with a resolved poster, using a relative poster reference and no thread artifact list.
- **When** The user views the video card, lets the poster load, and opens the card.
- **Then** The card displays the resolved poster rather than a fallback, and the video opens using its original resolved URL.

## chat-attachment-artifact-viewer-022

Original test `A private video without a poster keeps an openable video fallback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L983).

- **Given** A chat contains a private video with no poster.
- **When** The user opens the video card.
- **Then** The card displays an enabled video fallback without a thumbnail, and the video opens using its original resolved URL.

## chat-attachment-artifact-viewer-023

Original test `a multi-file hosted publication downloads as a zip of every member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L1106).

- **Given** A hosted publication contains an HTML page and a CSS file.
- **When** The user selects Download from the site's download options.
- **Then** One launch-site.zip download contains both files with their original paths and contents.

## chat-attachment-artifact-viewer-024

Original test `a publication that cannot be listed reports the failure instead of its entry page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L1136).

- **Given** A hosted publication has an entry page, but listing its files fails with a server error.
- **When** The user selects Download from the site's download options.
- **Then** The interface reports “Download failed” and does not download the entry page or another file.

## chat-attachment-artifact-viewer-025

Original test `a self-contained hosted page downloads as the page itself`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-artifact-viewer.test.tsx#L1160).

- **Given** A hosted publication contains only a self-contained HTML page.
- **When** The user selects Download from the site's download options.
- **Then** The browser downloads launch-site.html directly from the publication page URL, without creating a blob.
