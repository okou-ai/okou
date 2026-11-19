# Chat image navigation shortcuts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-image-navigation-shortcuts.test.tsx](chat-image-navigation-shortcuts.test.tsx).

## chat-image-navigation-shortcuts-001

Original test `Arrow keys move between gallery images and stop at the boundaries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L116).

- **Given** A gallery is open on its first image, with three images in order.
- **When** The user presses Right twice, presses Right again at the last image, then presses Left.
- **Then** The preview advances to the second and third images. No Next image button is available at the last image; another Right leaves the third image displayed, and Left returns to the second.

## chat-image-navigation-shortcuts-002

Original test `An inaccessible gallery image still lets the user reach the next image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L136).

- **Given** A gallery is open on its first image, and the second image is unavailable.
- **When** The user presses Right twice.
- **Then** The second image displays an unavailable-artifact message, but pressing Right again reaches the third image.

## chat-image-navigation-shortcuts-003

Original test `Sidebar arrows navigate images and yield to text editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L164).

- **Given** The gallery is open in the sidebar on its first image.
- **When** The user presses Right, clicks Next image, then focuses the message composer and presses Left.
- **Then** Right advances to the second image and the button advances to the third. Left while editing the message leaves the third image displayed.

## chat-image-navigation-shortcuts-004

Original test `Sidebar navigation decodes a resolved private URL without replacing its focus owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L185).

- **Given** The sidebar gallery is focused on its first image, and resolving the second image’s private URL is delayed along with its image decode.
- **When** The user navigates right, the private URL resolves, and then the image decode completes.
- **Then** The focus owner remains focused while the second image is loading and hidden. After decoding, the second image becomes visible and the gallery remains focused.

## chat-image-navigation-shortcuts-005

Original test `A failed sidebar image can be skipped to a usable image preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L242).

- **Given** The sidebar gallery is on its first image; decoding the second image fails, while the third image can be decoded.
- **When** The user advances to the second image, then skips to the third and zooms in.
- **Then** The failed second preview shows “Preview unavailable.” and has no Zoom in control. The third image is visible, the alert is gone, and zoom starts at 100%; zooming in changes it to 112%.

## chat-image-navigation-shortcuts-006

Original test `A late decode failure does not replace the image the user navigated to`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L287).

- **Given** The sidebar gallery is on its first image, and decoding the second image is delayed and will fail.
- **When** The user advances to the second image, navigates to the third before the second decode fails, then completes the delayed failure and zooms in.
- **Then** The third image remains visible with no alert after the late failure. Zooming in changes the zoom level to 112%.

## chat-image-navigation-shortcuts-007

Original test `Image shortcuts yield to modifiers and toolbar menus in both fullscreen modes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L330).

- **Given** A three-image gallery is open in the lightbox, with the first image displayed.
- **When** The user presses Right with Alt, Control, Meta, and Shift separately, opens the download menu and presses Right, then enters fullscreen and presses Right before focusing the image stage and pressing Right. The user then switches to the sidebar, enters fullscreen, presses Right before focusing the image canvas and pressing Right, exits fullscreen, focuses the canvas, and presses Left.
- **Then** Modified arrows, the open menu, and unfocused fullscreen surfaces do not change the image. Focused image surfaces navigate: the lightbox reaches the second image, the sidebar reaches the third, and Left returns to the second.

## chat-image-navigation-shortcuts-008

Original test `Share permission radios own their arrows without changing the lightbox image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-image-navigation-shortcuts.test.tsx#L382).

- **Given** A lightbox gallery shows the first image, and the share permission choices are open.
- **When** The user selects the private choice, presses Right to select organization, then presses Left to return to private. After closing the choices, the user focuses the image and presses Right.
- **Then** The radio arrows change the selected and focused choice without changing the first image. Once the image is focused, Right navigates to the second image.
