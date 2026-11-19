# Chat official template previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-official-template-previews.test.tsx](chat-official-template-previews.test.tsx).

## chat-official-template-previews-001

Original test `An existing welcome message shows the sproutpop-launch-deck cover before opening the HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L50).

- **Given** A chat contains an existing welcome message linking to sproutpop-launch-deck.
- **When** The user views the message and opens its preview.
- **Then** The sproutpop-a826bd3d2831.png cover appears before opening, and the HTML opens at https://sproutpop-launch-deck-p9jk.okou.app/.

## chat-official-template-previews-002

Original test `An existing welcome message shows the coastal-hotel-example cover before opening the HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L50).

- **Given** A chat contains an existing welcome message linking to coastal-hotel-example.
- **When** The user views the message and opens its preview.
- **Then** The coastal-hotel-d2b4e1caa3c1.png cover appears before opening, and the HTML opens at https://coastal-hotel-example.okou.app/.

## chat-official-template-previews-003

Original test `An existing welcome message shows the Quick start cover before opening the HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L50).

- **Given** A chat contains an existing welcome message linking to Quick start.
- **When** The user views the message and opens its preview.
- **Then** The quick-start-eb0e18d9a32b.png cover appears before opening, and the HTML opens at the shared preview URL rather than the original Quick start URL.

## chat-official-template-previews-004

Original test `An existing welcome message shows the My Okou quick start (English) cover before opening the HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L50).

- **Given** A chat contains an existing welcome message linking to My Okou quick start (English).
- **When** The user views the message and opens its preview.
- **Then** The my-okou-quick-start.png cover appears before opening, and the HTML opens at https://my-okou-quickstart-20261112-review.okou.app/.

## chat-official-template-previews-005

Original test `The My Okou guide opens as HTML on an isolated App preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L101).

- **Given** A chat contains a My Okou quick start (English) link while the app is running on an isolated App preview host.
- **When** The user opens the HTML preview.
- **Then** The preview displays the guide in an iframe at https://my-okou-quickstart-20261112-review.okou.app/.

## chat-official-template-previews-006

Original test `Official image example uses an ordinary preview with runless=false and no uploaded artifacts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L185).

- **Given** A welcome message includes the official bookshop image, and its response run has completed with no uploaded artifacts.
- **When** The user opens the image link in an ordinary preview.
- **Then** The image opens in an image preview at the official image URL; the message is ready, the composer is enabled, and no assistant-thinking indicator appears.

## chat-official-template-previews-007

Original test `Official deck example uses an ordinary preview with runless=false and no uploaded artifacts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L185).

- **Given** A welcome message includes the official launch deck, and its response run has completed with no uploaded artifacts.
- **When** The user opens the deck link in an ordinary preview.
- **Then** The deck opens in an iframe at the official deck URL; the message is ready, the composer is enabled, and no assistant-thinking indicator appears.

## chat-official-template-previews-008

Original test `Official video example uses an ordinary preview with runless=false and no uploaded artifacts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L185).

- **Given** A welcome message includes the official video, and its response run has completed with no uploaded artifacts.
- **When** The user opens the video link in an ordinary preview.
- **Then** The video opens at the official video URL with playback controls; the message is ready, the composer is enabled, and no assistant-thinking indicator appears.

## chat-official-template-previews-009

Original test `Official image example uses an ordinary preview with runless=true and no uploaded artifacts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L185).

- **Given** A welcome message includes the official bookshop image, has no associated run, and has no uploaded artifacts.
- **When** The user opens the image link in an ordinary preview.
- **Then** The image opens in an image preview at the official image URL; the message is ready and the composer is enabled, but no assistant-thinking indicator is present.

## chat-official-template-previews-010

Original test `Welcome diagrams and the quick start open without uploaded artifacts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L221).

- **Given** A welcome message contains seven linked diagrams and a Quick start link, with no associated run or uploaded artifacts.
- **When** The user opens each diagram and then the Quick start link.
- **Then** Each diagram opens in an image preview at its linked URL, and Quick start opens in an iframe at the shared preview URL.

## chat-official-template-previews-011

Original test `Unlisted external HTML and altered catalog URLs keep ordinary link behavior`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-official-template-previews.test.tsx#L291).

- **Given** A chat contains links to an external HTML page, an unlisted catalog HTML file, and catalog or Quick start URLs altered by a lookalike host, query string, HTTP scheme, credentials, or extra path.
- **When** The user views the links.
- **Then** Each link retains its original URL as its href, including all altered and unlisted URLs; these links keep ordinary link behavior.
