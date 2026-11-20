# Chat hosted site download

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-hosted-site-download.test.tsx](chat-hosted-site-download.test.tsx).

## chat-hosted-site-download-001

Original test `a public alias downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a link to a public site alias with a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-002

Original test `a SPA route downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a link to a SPA route with a query and fragment on the public site, which has a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-003

Original test `a legacy HTML link downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a legacy HTML link with a query and fragment, and the site has a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-004

Original test `a immutable deployment downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a link to an immutable deployment with a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-005

Original test `a preview alias downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a link to a preview alias on sites.vm7.io and the page is opened on localhost; the publication has a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-006

Original test `a alias without immutable URL metadata downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a public alias without immutable URL metadata, and the site has a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-007

Original test `a shared alias with an owner reference downloads every published member as a zip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L182).

- **Given** The chat contains a shared alias whose publication URL metadata is an owner artifact reference, and the site has a published HTML page, stylesheet, and image.
- **When** I download the site from the link.
- **Then** A ZIP named launch-site.zip contains index.html, assets/site.css, and assets/cat.png with the published bytes.

## chat-hosted-site-download-008

Original test `a hosted-site preserves its HTML filename and reports its product type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L206).

- **Given** The chat contains a hosted-site artifact titled Quarterly launch report with an HTML page.
- **When** I download the artifact from the site link.
- **Then** The page is downloaded as launch-site.html with its HTML content, the title is shown, and download telemetry reports the website product type.

## chat-hosted-site-download-009

Original test `a presentation-html preserves its HTML filename and reports its product type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L206).

- **Given** The chat contains a presentation-html artifact titled Quarterly launch report with an HTML page.
- **When** I download the artifact from the site link.
- **Then** The page is downloaded as launch-site.html with its HTML content, the title is shown, and download telemetry reports the presentation product type.

## chat-hosted-site-download-010

Original test `a public site's unreadable listing reports failure without a partial download`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L245).

- **Given** A public site's publication listing request fails with status 500.
- **When** I download the site from the chat link.
- **Then** A Download failed message appears and no download is produced.

## chat-hosted-site-download-011

Original test `a public site's unreadable member reports failure without a partial download`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L245).

- **Given** A public site's stylesheet member request fails with status 404.
- **When** I download the site from the chat link.
- **Then** A Download failed message appears and no partial download is produced.

## chat-hosted-site-download-012

Original test `a public page remains downloadable when its publication listing returns 403`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L271).

- **Given** A public site's publication listing returns status 403, while its page remains publicly available.
- **When** I download the site from the chat link.
- **Then** The page is downloaded as launch-site.html with its HTML content.

## chat-hosted-site-download-013

Original test `a public page remains downloadable when its publication listing returns 404`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L271).

- **Given** A public site's publication listing returns status 404, while its page remains publicly available.
- **When** I download the site from the chat link.
- **Then** The page is downloaded as launch-site.html with its HTML content.

## chat-hosted-site-download-014

Original test `a direct /assets/cat.png URL downloads only that image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L292).

- **Given** The chat contains a direct image link at /assets/cat.png.
- **When** I download the image from the chat link.
- **Then** Only the image is downloaded as cat.png, with the expected image bytes.

## chat-hosted-site-download-015

Original test `a direct /image URL downloads only that image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L292).

- **Given** The chat contains a direct image link at /image.
- **When** I download the image from the chat link.
- **Then** Only the image is downloaded as cat.png, with the expected image bytes.

## chat-hosted-site-download-016

Original test `a direct /image/ URL downloads only that image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L292).

- **Given** The chat contains a direct image link at /image/.
- **When** I download the image from the chat link.
- **Then** Only the image is downloaded as cat.png, with the expected image bytes.

## chat-hosted-site-download-017

Original test `a direct /%69mage URL downloads only that image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-hosted-site-download.test.tsx#L292).

- **Given** The chat contains a direct image link at /%69mage.
- **When** I download the image from the chat link.
- **Then** Only the image is downloaded as cat.png, with the expected image bytes.
