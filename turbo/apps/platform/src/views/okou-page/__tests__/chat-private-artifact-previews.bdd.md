# Chat private artifact previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-private-artifact-previews.test.tsx](chat-private-artifact-previews.test.tsx).

## chat-private-artifact-previews-001

Original test `production thread resolves /artifacts/f000000000004000a000000000000941.png to a thumbnail and opens the original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L91).

- **Given** An assistant message contains the relative artifact reference `/artifacts/f000000000004000a000000000000941.png`.
- **When** The user opens the chat on the production host and opens the image preview.
- **Then** The thread image uses a thumbnail URL that preserves the reference, and the preview opens the resolved original URL.

## chat-private-artifact-previews-002

Original test `production thread resolves https://app.okou.ai/artifacts/f000000000004000a000000000000941.png to a thumbnail and opens the original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L91).

- **Given** An assistant message contains the absolute `https://app.okou.ai/artifacts/f000000000004000a000000000000941.png` reference.
- **When** The user opens the chat on the production host and opens the image preview.
- **Then** The thread image uses a thumbnail URL that preserves the reference, and the preview opens the resolved original URL.

## chat-private-artifact-previews-003

Original test `production thread resolves https://app.okou.ai/artifacts/abcxyz1234.png#detail to a thumbnail and opens the original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L91).

- **Given** An assistant message contains `https://app.okou.ai/artifacts/abcxyz1234.png#detail`.
- **When** The user opens the chat on the production host and opens the image preview.
- **Then** The thumbnail and original image URLs retain the `#detail` fragment.

## chat-private-artifact-previews-004

Original test `opening and reopening an image uses the same presign as its thread thumbnail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L119).

- **Given** A private image in a chat has a resolved original and thumbnail.
- **When** The user opens the image preview, closes it, and opens it again.
- **Then** Both previews use the same resolved original; the thread image remains a thumbnail and no preview-loading indicator remains.

## chat-private-artifact-previews-005

Original test `repeated thread images and their lightbox share one resolved original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L147).

- **Given** An assistant message contains the same private image twice.
- **When** The user opens the first image preview.
- **Then** Both thread images use the thumbnail, and the preview uses their shared resolved original.

## chat-private-artifact-previews-006

Original test `uploaded images reuse their thread presign with publicUrl=null`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L165).

- **Given** A user message contains an uploaded private image whose resolved URL response has `publicUrl` set to null.
- **When** The user opens its preview from the chat.
- **Then** The thread image uses a thumbnail, its link and preview use the resolved original URL, and the thread image remains a thumbnail.

## chat-private-artifact-previews-007

Original test `uploaded images reuse their thread presign with publicUrl=https://a.okou.io/0123456789.png`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L165).

- **Given** A user message contains an uploaded private image whose resolved URL response has `publicUrl` set to `https://a.okou.io/0123456789.png`.
- **When** The user opens its preview from the chat.
- **Then** The thread image uses a thumbnail, its link and preview use the resolved original URL, and the thread image remains a thumbnail.

## chat-private-artifact-previews-008

Original test `promoting a thread image to split view keeps the same original credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L227).

- **Given** A private image in a chat is open in the preview.
- **When** The user opens it in split view.
- **Then** The split view uses the same resolved original URL, while the thread image remains a thumbnail.

## chat-private-artifact-previews-009

Original test `navigating assistant images reuses the original already resolved by each thread card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L247).

- **Given** An assistant message contains two private images, each with its own resolved original.
- **When** The user opens the first image, moves to the next image, then returns to the previous image.
- **Then** The preview displays the first original, then the second original, then the first original again; both thread cards remain thumbnails.

## chat-private-artifact-previews-010

Original test `navigating user images reuses the original already resolved by each thread card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-private-artifact-previews.test.tsx#L247).

- **Given** A user message contains two private uploaded images, each with its own resolved original.
- **When** The user opens the first image preview, moves to the next image, then returns to the previous image.
- **Then** The preview displays the first original, then the second original, then the first original again; both thread cards remain thumbnails.
