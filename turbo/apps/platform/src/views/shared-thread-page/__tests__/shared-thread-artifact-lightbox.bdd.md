# Shared thread artifact lightbox

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-artifact-lightbox.test.tsx](shared-thread-artifact-lightbox.test.tsx).

## shared-thread-artifact-lightbox-001

Original test `a shared site keeps its screenshot, stable link and download in an independent viewer (signed in: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L167).

- **Given** A signed-out visitor views a shared site with a screenshot cover.
- **When** They open the site in the independent viewer, copy its link, download it, enter and exit fullscreen, and close the viewer.
- **Then** The card shows the cover and retains the original URL, with no embedded frame. The viewer displays the authorized site URL including its slide fragment in a sandboxed frame, offers copy, download, and fullscreen actions but no access controls, and copies the original URL. Download saves lightsite1.html without changing the displayed site; closing returns to the card. The test also verifies that artifact resolution is unauthenticated.

## shared-thread-artifact-lightbox-002

Original test `a shared site keeps its screenshot, stable link and download in an independent viewer (signed in: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L167).

- **Given** A signed-in visitor views a shared site with a screenshot cover.
- **When** They open the site in the independent viewer, copy its link, download it, enter and exit fullscreen, and close the viewer.
- **Then** The card shows the cover and retains the original URL, with no embedded frame. The viewer displays the authorized site URL including its slide fragment in a sandboxed frame, offers copy, download, and fullscreen actions but no access controls, and copies the original URL. Download saves lightsite1.html without changing the displayed site; closing returns to the card. The test also verifies that artifact resolution is authenticated.

## shared-thread-artifact-lightbox-003

Original test `a signed-in viewer downloads a public artifact regardless of their App paywall (App denied: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L256).

- **Given** A signed-in viewer opens a shared video artifact, and the app allows its download.
- **When** They open the viewer and download the video.
- **Then** The video plays at the original timestamp, and the download saves lightvid01.mp4 from the public download URL without changing the displayed video.

## shared-thread-artifact-lightbox-004

Original test `a signed-in viewer downloads a public artifact regardless of their App paywall (App denied: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L256).

- **Given** A signed-in viewer opens a shared video artifact, and the app denies its download.
- **When** They open the viewer and download the video.
- **Then** The video still downloads as lightvid01.mp4 from the public download URL, despite the app download denial, without changing the displayed video.

## shared-thread-artifact-lightbox-005

Original test `a shared video uses its generated cover and plays the original in the viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L335).

- **Given** A visitor views a shared video with a generated cover.
- **When** They open the video in the viewer, copy its link, and press Escape.
- **Then** The card uses the generated cover without showing a fallback. The viewer plays the original video at its timestamp with controls and autoplay, copies the original link, and closes on Escape.

## shared-thread-artifact-lightbox-006

Original test `a shared site with a missing cover falls back to its authorized iframe`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L382).

- **Given** A visitor views a shared site whose cover is missing.
- **When** The site preview loads.
- **Then** The card falls back to an authorized iframe showing the site URL with its slide fragment, while retaining the original destination.

## shared-thread-artifact-lightbox-007

Original test `a shared site with a failed cover falls back to its authorized iframe`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L382).

- **Given** A visitor views a shared site whose cover image fails to load.
- **When** The site preview falls back from the failed cover.
- **Then** The card shows an authorized iframe with the site URL and slide fragment, while retaining the original destination.

## shared-thread-artifact-lightbox-008

Original test `legacy shared html links open the viewer and keep their original URL when copied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L414).

- **Given** A visitor views a legacy shared HTML link with a slide fragment.
- **When** They open it in the viewer and copy its link.
- **Then** The viewer displays the original URL, and the clipboard receives that same URL.

## shared-thread-artifact-lightbox-009

Original test `an unavailable snapshot shows no private preview content: 404`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L438).

- **Given** A visitor views shared site and video artifacts whose snapshots return HTTP 404.
- **When** The artifact previews load.
- **Then** Each card shows an unavailable status and no iframe, video, or image; no viewer opens.

## shared-thread-artifact-lightbox-010

Original test `shared prompt attachments retain their covers and open the independent viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L466).

- **Given** A visitor views a shared prompt containing a video attachment and a site attachment, both with generated covers.
- **When** They open each attachment in the independent viewer and copy its link.
- **Then** Both cards retain their covers. The video viewer plays the video at its original timestamp, and the site viewer displays the authorized site URL with its slide fragment. The clipboard receives the original video URL followed by the original site URL.

## shared-thread-artifact-lightbox-011

Original test `revoked download access reports an error without downloading or leaving the shared conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L553).

- **Given** A visitor opens a shared site in the viewer, then its download access is revoked.
- **When** They try to download the site.
- **Then** The viewer reports “Download failed”; no download occurs, the browser location is not replaced, and the visitor remains on the shared conversation.

## shared-thread-artifact-lightbox-012

Original test `a shared image opens in the conversation and keeps its destination for a new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L608).

- **Given** A visitor views a shared image with a resolved preview.
- **When** They open the image from its card.
- **Then** The card links to the original destination in a new tab and shows the preview. Opening it displays the resolved image and its caption in the conversation.

## shared-thread-artifact-lightbox-013

Original test `a shared document opens in the conversation from its card and from its link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L640).

- **Given** A visitor views a shared document as both a card and a Markdown link.
- **When** They open the document from the card, close the viewer, and open it from the link.
- **Then** Both actions open the document in the conversation. The card viewer shows the resolved document and its caption; the link viewer uses the link text as its title.

## shared-thread-artifact-lightbox-014

Original test `a prompt attachment opens in the conversation instead of a new tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L682).

- **Given** A visitor views a prompt with an image attachment.
- **When** They open the attachment.
- **Then** It opens in the conversation rather than a new tab, showing the image and filename.

## shared-thread-artifact-lightbox-015

Original test `a shared note opens its Markdown body in the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-artifact-lightbox.test.tsx#L722).

- **Given** A visitor views a shared Markdown note containing text and a Mermaid diagram.
- **When** They open the note, enter fullscreen, expand the diagram, and press Escape to close each layer.
- **Then** The viewer renders the note text, title, and diagram. The expanded diagram closes first while the note remains fullscreen and focus returns to its expand control; the next Escape exits fullscreen, and the final Escape closes the note viewer.
